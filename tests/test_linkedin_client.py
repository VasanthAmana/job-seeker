"""jobseek/linkedin/client.py: endpoint resolution and the wire protocol.

No live LinkedIn, no Electron. The "real app" side of the wire is a tiny
fake UNIX-socket JSON-RPC server started in-process (mirrors
jobseek/linkedin/app/src/server.js's framing exactly: newline-delimited
JSON-RPC, {"content": [...], "isError": bool} tool results) - offline, no
network. Windows named-pipe behavior is exercised only at the path-string
level (resolve_endpoint), since a POSIX test runner cannot open one.
"""

from __future__ import annotations

import json
import socket
import threading

import pytest

import client as linkedin_client  # jobseek/linkedin/client.py


# --- endpoint resolution -----------------------------------------------------


def test_resolve_endpoint_honors_explicit_override():
    assert linkedin_client.resolve_endpoint({"LINKEDIN_MCP_SOCKET": "/tmp/x.sock"}, "Linux") == "/tmp/x.sock"


def test_resolve_endpoint_windows_is_a_named_pipe():
    endpoint = linkedin_client.resolve_endpoint({"USERNAME": "jane"}, "Windows")
    assert endpoint == "\\\\.\\pipe\\linkedin-mcp-jane"
    assert linkedin_client.is_windows_pipe(endpoint)


def test_resolve_endpoint_windows_sanitizes_username():
    endpoint = linkedin_client.resolve_endpoint({"USERNAME": "ja ne!"}, "Windows")
    assert endpoint == "\\\\.\\pipe\\linkedin-mcp-ja_ne_"


def test_resolve_endpoint_macos_uses_application_support():
    endpoint = linkedin_client.resolve_endpoint({}, "Darwin")
    assert "Library/Application Support/LinkedIn MCP/run/mcp.sock" in endpoint


def test_resolve_endpoint_linux_uses_xdg_config():
    endpoint = linkedin_client.resolve_endpoint({"XDG_CONFIG_HOME": "/home/x/.config"}, "Linux")
    assert endpoint == "/home/x/.config/linkedin-mcp/run/mcp.sock"


# --- "the app isn't running" --------------------------------------------------


def test_call_tool_gives_a_clear_error_when_no_socket_exists(tmp_path):
    missing = tmp_path / "does-not-exist.sock"
    with pytest.raises(linkedin_client.LinkedInNeedsYouError, match="LinkedIn needs you"):
        linkedin_client.call_tool("linkedin_status", endpoint=str(missing))


def test_call_tool_gives_a_clear_error_when_socket_refuses(tmp_path):
    # A path that exists but is not a listening socket: connect() itself fails.
    dead_path = tmp_path / "dead.sock"
    dead_path.touch()
    with pytest.raises(linkedin_client.LinkedInNeedsYouError, match="LinkedIn needs you"):
        linkedin_client.call_tool("linkedin_status", endpoint=str(dead_path))


def test_call_tool_rejects_unknown_tool_name():
    with pytest.raises(ValueError):
        linkedin_client.call_tool("linkedin_delete_everything")


# --- a fake server speaking the real wire format -----------------------------


class FakeLinkedInServer:
    """A minimal stand-in for app/src/server.js on a real UNIX socket:
    newline-delimited JSON-RPC, one reply per line, same tools/call result
    shape. `responder(name, arguments) -> dict` decides each reply."""

    def __init__(self, socket_path, responder):
        self.socket_path = str(socket_path)
        self._responder = responder
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(self.socket_path)
        self._server.listen(1)
        self._thread = threading.Thread(target=self._serve_one, daemon=True)
        self._thread.start()

    def _serve_one(self):
        conn, _ = self._server.accept()
        with conn:
            buf = b""
            while b"\n" not in buf:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buf += chunk
            line, _ = buf.split(b"\n", 1)
            request = json.loads(line)
            params = request.get("params") or {}
            result = self._responder(params.get("name"), params.get("arguments") or {})
            reply = {"jsonrpc": "2.0", "id": request["id"], "result": result}
            conn.sendall((json.dumps(reply) + "\n").encode("utf-8"))

    def close(self):
        self._server.close()


def _ok_result(payload: dict, text: str | None = None) -> dict:
    return {"content": [{"type": "text", "text": text if text is not None else json.dumps(payload)}], "isError": False}


def _needs_you_result(reason: str) -> dict:
    return {"content": [{"type": "text", "text": f"LinkedIn needs you: {reason}."}], "isError": True}


@pytest.fixture()
def fake_server(tmp_path):
    socket_path = tmp_path / "mcp.sock"
    servers = []

    def start(responder):
        server = FakeLinkedInServer(socket_path, responder)
        servers.append(server)
        return str(socket_path)

    yield start
    for server in servers:
        server.close()


def test_call_tool_returns_the_payload_on_success(fake_server):
    endpoint = fake_server(lambda name, args: _ok_result({"query": args["query"], "jobs": []}))
    result = linkedin_client.call_tool("linkedin_search_jobs", {"query": "AI strategy director"}, endpoint=endpoint)
    assert result == {"query": "AI strategy director", "jobs": []}


def test_call_tool_raises_needs_you_when_app_reports_sign_in_wall(fake_server):
    endpoint = fake_server(lambda name, args: _needs_you_result("a sign-in page appeared"))
    with pytest.raises(linkedin_client.LinkedInNeedsYouError, match="sign-in page appeared"):
        linkedin_client.call_tool("linkedin_search_jobs", {"query": "x"}, endpoint=endpoint)


def test_call_tool_raises_needs_you_on_pace_cap(fake_server):
    endpoint = fake_server(
        lambda name, args: {"content": [{"type": "text", "text": "pace cap reached: 40 page loads in the last hour. Try again in ~120s."}], "isError": True}
    )
    with pytest.raises(linkedin_client.LinkedInNeedsYouError, match="pace cap reached"):
        linkedin_client.call_tool("linkedin_search_jobs", {"query": "x"}, endpoint=endpoint)


def test_call_tool_raises_plain_error_for_other_failures(fake_server):
    endpoint = fake_server(lambda name, args: {"content": [{"type": "text", "text": "error: could not parse a LinkedIn job id from the input"}], "isError": True})
    with pytest.raises(linkedin_client.LinkedInError) as excinfo:
        linkedin_client.call_tool("linkedin_get_job", {"job_id": "not-an-id"}, endpoint=endpoint)
    assert "could not parse" in str(excinfo.value)
    assert not isinstance(excinfo.value, linkedin_client.LinkedInNeedsYouError)


def test_search_jobs_helper_passes_through_filters(fake_server):
    captured = {}

    def responder(name, args):
        captured["name"] = name
        captured["args"] = args
        return _ok_result({"jobs": []})

    endpoint = fake_server(responder)
    linkedin_client.search_jobs(
        "AI strategy", location="Denver Metropolitan Area", remote=False,
        experience_levels=["director", "executive"], limit=10, endpoint=endpoint,
    )
    assert captured["name"] == "linkedin_search_jobs"
    assert captured["args"] == {
        "query": "AI strategy", "location": "Denver Metropolitan Area", "remote": False,
        "experience_levels": ["director", "executive"], "limit": 10,
    }


def test_get_job_requires_job_id_or_url():
    with pytest.raises(ValueError):
        linkedin_client.get_job()


def test_search_people_helper(fake_server):
    endpoint = fake_server(lambda name, args: _ok_result({"people": []}))
    result = linkedin_client.search_people("recruiter", company="Acme", endpoint=endpoint)
    assert result == {"people": []}
