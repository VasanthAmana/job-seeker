"""jobseek MCP server: JSON-RPC framing and the initialize/tools/list/call
handshake, independent of the tool logic (see test_mcp_tools.py) and of a
real stdio subprocess."""

import importlib
import json
import sys
from pathlib import Path

import pytest

MCP_DIR = Path(__file__).resolve().parent.parent / "mcp"
if str(MCP_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_DIR))

import server  # jobseek/mcp/server.py


def test_initialize_reports_protocol_and_server_info():
    response = server.handle_message({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert response["id"] == 1
    assert response["result"]["protocolVersion"] == server.PROTOCOL_VERSION
    assert response["result"]["serverInfo"]["name"] == "jobseek"
    assert response["result"]["capabilities"] == {"tools": {}}


def test_tools_list_matches_the_tool_registry():
    import tools as mcp_tools

    response = server.handle_message({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    names = {t["name"] for t in response["result"]["tools"]}
    assert names == set(mcp_tools.TOOLS)
    for tool in response["result"]["tools"]:
        assert "inputSchema" in tool
        assert "description" in tool


def test_tools_call_wraps_tool_result_as_text_content():
    response = server.handle_message({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "search_seen", "arguments": {"query": "nonexistent-xyz"}},
    })
    result = response["result"]
    assert result["isError"] is False
    payload = json.loads(result["content"][0]["text"])
    assert payload == {"query": "nonexistent-xyz", "count": 0, "results": []}


def test_tools_call_unknown_tool_is_an_error_result_not_a_protocol_error():
    response = server.handle_message({
        "jsonrpc": "2.0", "id": 4, "method": "tools/call",
        "params": {"name": "delete_everything", "arguments": {}},
    })
    assert response["result"]["isError"] is True
    assert "unknown tool" in response["result"]["content"][0]["text"]


def test_unknown_method_returns_json_rpc_error():
    response = server.handle_message({"jsonrpc": "2.0", "id": 5, "method": "not/a/method", "params": {}})
    assert response["error"]["code"] == -32601


def test_notification_without_id_gets_no_response():
    assert server.handle_message({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    assert server.handle_message({"jsonrpc": "2.0", "method": "some/notification", "params": {}}) is None


def test_non_jsonrpc_message_is_ignored():
    assert server.handle_message({"id": 1, "method": "initialize"}) is None
    assert server.handle_message({"jsonrpc": "1.0", "id": 1, "method": "initialize"}) is None


def test_serve_reads_newline_delimited_json_and_writes_newline_delimited_responses():
    import io

    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    ]
    in_stream = io.StringIO("\n".join(json.dumps(r) for r in requests) + "\n")
    out_stream = io.StringIO()
    server.serve(in_stream, out_stream)
    lines = [line for line in out_stream.getvalue().splitlines() if line.strip()]
    assert len(lines) == 2  # the notification produced no line
    ids = [json.loads(line)["id"] for line in lines]
    assert ids == [1, 2]


def test_serve_recovers_from_malformed_json_line():
    import io

    in_stream = io.StringIO('not json at all\n{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}\n')
    out_stream = io.StringIO()
    server.serve(in_stream, out_stream)
    lines = [json.loads(line) for line in out_stream.getvalue().splitlines() if line.strip()]
    assert lines[0]["error"]["code"] == -32700
    assert lines[1]["id"] == 1


# --- F1 + F2: a corrupt seen_jobs.json or a bad config must not kill the
# server - they must come back as one failed tool call, and the server must
# keep answering every request after that (jobseek-mcp-resilience F1, F2).


@pytest.fixture()
def jobseek_config_file(tmp_path, monkeypatch):
    """A minimal valid config pointing at an isolated seen_jobs.json, so a
    deliberately corrupted state file never touches the real jobseek state."""
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "accounts": [{"name": "test", "account_dir": str(tmp_path / "gmail-missing")}],
        "default_account": "test",
        "paths": {
            "state_dir": "state",
            "seen_jobs": str(state_dir / "seen_jobs.json"),
            "last_run": str(state_dir / "last_run.json"),
            "tracker": str(tmp_path / "tracker.csv"),
            "upskill_reports": str(tmp_path / "upskill-reports"),
        },
    }), encoding="utf-8")
    monkeypatch.setenv("JOBSEEK_CONFIG", str(cfg_path))
    return cfg_path, state_dir


def test_corrupt_seen_jobs_json_is_an_error_result_and_server_keeps_serving(jobseek_config_file):
    """F1: rank_state.load_state used to call sys.exit() on bad JSON, and
    SystemExit isn't an Exception - it skips every `except Exception` on the
    way out (including server.py's catch-all) and takes the whole process
    down. A truncated seen_jobs.json must instead come back as one failed
    `rank` call, with later requests still answered normally."""
    _cfg_path, state_dir = jobseek_config_file
    (state_dir / "seen_jobs.json").write_text('{"seen": {truncated', encoding="utf-8")

    response = server.handle_message({
        "jsonrpc": "2.0", "id": 10, "method": "tools/call",
        "params": {"name": "rank", "arguments": {}},
    })
    assert response["result"]["isError"] is True
    assert "not valid JSON" in response["result"]["content"][0]["text"]

    # The server is still alive: it answers the very next request too.
    follow_up = server.handle_message({"jsonrpc": "2.0", "id": 11, "method": "tools/list", "params": {}})
    assert {t["name"] for t in follow_up["result"]["tools"]}


def test_bad_config_does_not_crash_the_server_at_startup(monkeypatch, tmp_path):
    """F2: rank_state.py used to load and validate config as soon as it was
    imported, and jobseek/mcp/tools.py imports it for `load_state` alone -
    so a bad config.json (here, an empty accounts list) used to raise
    ConfigError from that import, before the server served a single
    request. Reload the server's module chain under the bad config to
    exercise that exact startup path."""
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({"accounts": []}), encoding="utf-8")
    monkeypatch.setenv("JOBSEEK_CONFIG", str(cfg_path))

    import rank_state
    import tools as mcp_tools

    # Re-run each module's body under the bad config, as a fresh process
    # import would: this must not raise.
    importlib.reload(rank_state)
    importlib.reload(mcp_tools)
    importlib.reload(server)

    response = server.handle_message({
        "jsonrpc": "2.0", "id": 20, "method": "tools/call",
        "params": {"name": "rank", "arguments": {}},
    })
    assert response["result"]["isError"] is True
    assert "accounts" in response["result"]["content"][0]["text"]

    # The server is still alive: it answers the very next request too.
    follow_up = server.handle_message({"jsonrpc": "2.0", "id": 21, "method": "tools/list", "params": {}})
    assert {t["name"] for t in follow_up["result"]["tools"]}

    monkeypatch.delenv("JOBSEEK_CONFIG", raising=False)
    importlib.reload(rank_state)
    importlib.reload(mcp_tools)
    importlib.reload(server)
