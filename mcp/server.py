#!/usr/bin/env python3
"""jobseek MCP server: read-only query access to jobseek's state over stdio.

Exposes six tools - run_alerts, rank, list_shortlist, get_posting,
search_seen, tailor - documented in jobseek/mcp/tools.py. Transport is the
MCP stdio protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout, one
message per line, no embedded newlines. Stdlib only (json, no `mcp` package
dependency) so it needs nothing installed beyond Python 3.10+ on either
Windows or macOS - no POSIX-only paths or shell calls.

Run directly:
  python3 jobseek/mcp/server.py

Register with Claude Code (see jobseek/mcp/README.md for the full section):
  claude mcp add jobseek -- python3 /absolute/path/to/jobseek/mcp/server.py
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tools import TOOL_DESCRIPTIONS, TOOLS, ToolError, call_tool  # noqa: E402

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "jobseek"
SERVER_VERSION = "0.1.0"


def _force_utf8_io() -> None:
    """stdio MCP messages are UTF-8 JSON; a non-UTF-8 console code page on
    Windows would otherwise corrupt anything outside ASCII."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8")


def _tool_list() -> list:
    return [
        {
            "name": name,
            "description": TOOL_DESCRIPTIONS.get(name, ""),
            "inputSchema": schema,
        }
        for name, (_func, schema) in sorted(TOOLS.items())
    ]


def _result(request_id, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _handle_initialize(request_id, _params: dict) -> dict:
    return _result(request_id, {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {"tools": {}},
        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
    })


def _handle_tools_list(request_id, _params: dict) -> dict:
    return _result(request_id, {"tools": _tool_list()})


def _handle_tools_call(request_id, params: dict) -> dict:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    try:
        output = call_tool(name, arguments)
        text = json.dumps(output, ensure_ascii=False)
        return _result(request_id, {"content": [{"type": "text", "text": text}], "isError": False})
    except (ToolError, TypeError, ValueError) as exc:
        return _result(request_id, {"content": [{"type": "text", "text": str(exc)}], "isError": True})


HANDLERS = {
    "initialize": _handle_initialize,
    "tools/list": _handle_tools_list,
    "tools/call": _handle_tools_call,
}

# Notifications (no "id", no response expected) that are safe to ignore.
IGNORED_NOTIFICATIONS = {"notifications/initialized", "notifications/cancelled"}


def handle_message(message: dict) -> dict | None:
    """One JSON-RPC request -> one JSON-RPC response, or None for a
    notification / unrecognized shape that needs no reply."""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return None
    method = message.get("method")
    request_id = message.get("id")
    if method in IGNORED_NOTIFICATIONS:
        return None
    if request_id is None:
        return None  # a notification for a method we don't special-case
    handler = HANDLERS.get(method)
    if handler is None:
        return _error(request_id, -32601, f"method not found: {method}")
    params = message.get("params") or {}
    try:
        return handler(request_id, params)
    except Exception as exc:  # noqa: BLE001 - never let one bad request kill the server
        traceback.print_exc(file=sys.stderr)
        return _error(request_id, -32603, f"internal error: {exc}")


def serve(in_stream=None, out_stream=None) -> None:
    _force_utf8_io()
    in_stream = in_stream or sys.stdin
    out_stream = out_stream or sys.stdout
    for line in in_stream:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            response = _error(None, -32700, "parse error: not valid JSON")
        else:
            response = handle_message(message)
        if response is not None:
            out_stream.write(json.dumps(response, ensure_ascii=False) + "\n")
            out_stream.flush()


def main(argv=None) -> int:
    serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
