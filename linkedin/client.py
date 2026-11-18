#!/usr/bin/env python3
"""Python client for the vendored LinkedIn MCP app's local endpoint.

`linkedin/app/` is the Electron app (see its own README): it holds a
signed-in LinkedIn session and serves a small MCP tool catalogue
(`linkedin_search_jobs`, `linkedin_get_job`, `linkedin_list_job_alerts`,
`linkedin_list_saved_jobs`, `linkedin_search_people`, `linkedin_save_job`,
`linkedin_status`) on a local-only endpoint:

  * macOS / Linux: a 0600 UNIX socket under the app's user-data directory
  * Windows: a named pipe (`\\\\.\\pipe\\linkedin-mcp-<user>`)

This module talks to that endpoint directly (newline-delimited JSON-RPC,
exactly `app/src/server.js`'s wire format) so the rest of jobseek never has
to spawn Node at call time. The endpoint resolution mirrors
`app/src/paths.js` exactly, including the `LINKEDIN_MCP_SOCKET` /
`LINKEDIN_MCP_USER_DATA` test overrides, so pointing both the app and this
client at the same `LINKEDIN_MCP_SOCKET` is how tests exercise this file
against a real (but fake) endpoint with no live LinkedIn involved.

The app is a separate process the owner starts by hand (`npm start` in
`linkedin/app/`) and signs into once; this client never launches it
and never touches LinkedIn credentials itself. Every failure to reach the
endpoint, or any "LinkedIn needs you" result the app itself returns (sign-in
wall, security challenge), is surfaced as `LinkedInNeedsYouError` with a
specific, actionable message - never a raw socket/timeout traceback.
"""

from __future__ import annotations

import json
import os
import platform
import socket as socket_module
from pathlib import Path

APP_DIR_NAME = "LinkedIn MCP"
DEFAULT_TIMEOUT = 20.0

TOOL_NAMES = (
    "linkedin_search_jobs",
    "linkedin_get_job",
    "linkedin_list_job_alerts",
    "linkedin_list_saved_jobs",
    "linkedin_search_people",
    "linkedin_save_job",
    "linkedin_status",
)


class LinkedInError(RuntimeError):
    """Base class for every error this client raises."""


class LinkedInNeedsYouError(LinkedInError):
    """The app isn't reachable, isn't signed in, or hit a page a human must
    clear by hand - every case where the fix is "go start/use the app",
    never a retry loop."""


def _user_data_dir(env: dict | None = None, system: str | None = None) -> Path:
    env = env if env is not None else os.environ
    system = system or platform.system()
    if env.get("LINKEDIN_MCP_USER_DATA"):
        return Path(env["LINKEDIN_MCP_USER_DATA"])
    home = Path.home()
    if system == "Darwin":
        return home / "Library" / "Application Support" / APP_DIR_NAME
    if system == "Windows":
        appdata = env.get("APPDATA") or str(home / "AppData" / "Roaming")
        return Path(appdata) / APP_DIR_NAME
    return Path(env.get("XDG_CONFIG_HOME") or (home / ".config")) / "linkedin-mcp"


def _pipe_name(env: dict | None = None) -> str:
    env = env if env is not None else os.environ
    user = env.get("USERNAME") or env.get("USER") or "user"
    safe = "".join(ch if (ch.isalnum() or ch in "_-") else "_" for ch in user)
    return f"\\\\.\\pipe\\linkedin-mcp-{safe}"


def resolve_endpoint(env: dict | None = None, system: str | None = None) -> str:
    """The same endpoint path `app/bin/linkedin-mcp.js` and `app/src/paths.js`
    resolve - a UNIX socket path on macOS/Linux, a named-pipe path on
    Windows. `LINKEDIN_MCP_SOCKET` overrides either, same as upstream."""
    env = env if env is not None else os.environ
    system = system or platform.system()
    if env.get("LINKEDIN_MCP_SOCKET"):
        return env["LINKEDIN_MCP_SOCKET"]
    if system == "Windows":
        return _pipe_name(env)
    return str(_user_data_dir(env, system) / "run" / "mcp.sock")


def is_windows_pipe(endpoint: str) -> bool:
    return endpoint.startswith("\\\\.\\pipe\\")


NOT_RUNNING_HINT = (
    "LinkedIn needs you: the linkedin-mcp app isn't running (or hasn't finished signing in). "
    "Start it with `npm start` in linkedin/app, sign in to LinkedIn by hand in the "
    "window that opens, then retry."
)


class _PipeTransport:
    """A Windows named pipe opened as a byte stream (CreateFile under the
    hood via the stdlib's `open()`); POSIX code never constructs this."""

    def __init__(self, path: str, timeout: float):
        try:
            self._fh = open(path, "r+b", buffering=0)
        except OSError as exc:
            raise LinkedInNeedsYouError(f"{NOT_RUNNING_HINT} ({path}: {exc})") from exc

    def sendall(self, data: bytes) -> None:
        self._fh.write(data)

    def recv_line(self) -> bytes:
        return self._fh.readline()

    def close(self) -> None:
        self._fh.close()


class _SocketTransport:
    def __init__(self, path: str, timeout: float):
        sock = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            sock.connect(path)
        except OSError as exc:
            sock.close()
            raise LinkedInNeedsYouError(f"{NOT_RUNNING_HINT} ({path}: {exc})") from exc
        self._sock = sock
        self._buf = b""

    def sendall(self, data: bytes) -> None:
        self._sock.sendall(data)

    def recv_line(self) -> bytes:
        while b"\n" not in self._buf:
            chunk = self._sock.recv(65536)
            if not chunk:
                break
            self._buf += chunk
        if b"\n" in self._buf:
            line, self._buf = self._buf.split(b"\n", 1)
            return line + b"\n"
        return self._buf

    def close(self) -> None:
        self._sock.close()


def _open_transport(endpoint: str, timeout: float):
    if is_windows_pipe(endpoint):
        return _PipeTransport(endpoint, timeout)
    if not Path(endpoint).exists():
        raise LinkedInNeedsYouError(f"{NOT_RUNNING_HINT} (no socket at {endpoint})")
    return _SocketTransport(endpoint, timeout)


_REQUEST_ID = 0


def _next_id() -> int:
    global _REQUEST_ID
    _REQUEST_ID += 1
    return _REQUEST_ID


def call_tool(name: str, arguments: dict | None = None, *, endpoint: str | None = None, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """Call one LinkedIn MCP tool and return its JSON content payload.

    Raises `LinkedInNeedsYouError` when the app isn't reachable, or when the
    app itself reports a "LinkedIn needs you" / pace-cap condition (its
    tool-call result comes back with `isError: true` and no `error:` prefix
    for those two cases specifically - see app/src/main.js `callTool`).
    Any other tool-level error (bad arguments, a genuine bug) raises
    `LinkedInError` with the app's own message.
    """
    if name not in TOOL_NAMES:
        raise ValueError(f"unknown LinkedIn tool {name!r}")
    endpoint = endpoint or resolve_endpoint()
    transport = _open_transport(endpoint, timeout)
    try:
        request = {
            "jsonrpc": "2.0",
            "id": _next_id(),
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        }
        transport.sendall((json.dumps(request) + "\n").encode("utf-8"))
        line = transport.recv_line()
    except OSError as exc:
        raise LinkedInNeedsYouError(f"{NOT_RUNNING_HINT} ({exc})") from exc
    finally:
        transport.close()

    if not line.strip():
        raise LinkedInNeedsYouError(f"{NOT_RUNNING_HINT} (the app closed the connection with no reply)")
    try:
        message = json.loads(line)
    except json.JSONDecodeError as exc:
        raise LinkedInError(f"LinkedIn MCP app sent an unparseable reply: {exc}") from exc

    if "error" in message:
        err = message["error"] or {}
        raise LinkedInError(f"LinkedIn MCP app error: {err.get('message', err)}")

    result = message.get("result") or {}
    content = result.get("content") or []
    text = "\n".join(block.get("text", "") for block in content if isinstance(block, dict))
    if result.get("isError"):
        if text.startswith("LinkedIn needs you") or "pace cap reached" in text:
            raise LinkedInNeedsYouError(text or NOT_RUNNING_HINT)
        raise LinkedInError(text or "LinkedIn MCP app reported an error with no message")

    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise LinkedInError(f"LinkedIn MCP app sent a non-JSON tool result: {exc}") from exc


def search_jobs(
    query: str,
    *,
    location: str | None = None,
    remote: bool | None = None,
    experience_levels: list[str] | None = None,
    date_posted: str | None = None,
    job_type: str | None = None,
    limit: int | None = None,
    endpoint: str | None = None,
) -> dict:
    args: dict = {"query": query}
    if location is not None:
        args["location"] = location
    if remote is not None:
        args["remote"] = remote
    if experience_levels is not None:
        args["experience_levels"] = experience_levels
    if date_posted is not None:
        args["date_posted"] = date_posted
    if job_type is not None:
        args["job_type"] = job_type
    if limit is not None:
        args["limit"] = limit
    return call_tool("linkedin_search_jobs", args, endpoint=endpoint)


def get_job(job_id: str | None = None, url: str | None = None, *, endpoint: str | None = None) -> dict:
    if not job_id and not url:
        raise ValueError("get_job needs job_id or url")
    args = {}
    if job_id:
        args["job_id"] = job_id
    if url:
        args["url"] = url
    return call_tool("linkedin_get_job", args, endpoint=endpoint)


def search_people(query: str, *, company: str | None = None, title: str | None = None, limit: int | None = None, endpoint: str | None = None) -> dict:
    args = {"query": query}
    if company is not None:
        args["company"] = company
    if title is not None:
        args["title"] = title
    if limit is not None:
        args["limit"] = limit
    return call_tool("linkedin_search_people", args, endpoint=endpoint)


def status(*, endpoint: str | None = None) -> dict:
    return call_tool("linkedin_status", {}, endpoint=endpoint)
