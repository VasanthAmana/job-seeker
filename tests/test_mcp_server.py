"""jobseek MCP server: JSON-RPC framing and the initialize/tools/list/call
handshake, independent of the tool logic (see test_mcp_tools.py) and of a
real stdio subprocess."""

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
