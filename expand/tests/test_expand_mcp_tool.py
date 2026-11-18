"""The `expand_profile` MCP tool: registration, schema, wiring and error mapping.

The scanning itself is covered by test_expand_run.py; what matters here is
that the tool is visible to an MCP client with a well-formed schema, hands
its arguments to `expand` unchanged, and turns an ExpandError into a
tool-level error rather than a transport failure.
"""

import json
import sys
from pathlib import Path

import pytest

MCP_DIR = Path(__file__).resolve().parent.parent.parent / "mcp"
if str(MCP_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_DIR))

import server  # noqa: E402  - mcp/server.py
import tools as mcp_tools  # noqa: E402  - mcp/tools.py


def test_expand_profile_is_registered():
    assert "expand_profile" in mcp_tools.TOOLS
    assert mcp_tools.TOOL_DESCRIPTIONS["expand_profile"]


def test_its_schema_is_well_formed():
    _func, schema = mcp_tools.TOOLS["expand_profile"]
    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    assert schema.get("required") in (None, [])  # sources is optional
    sources = schema["properties"]["sources"]
    assert sources["type"] == "array"
    assert sources["items"]["type"] == "string"
    assert set(sources["items"]["enum"]) == set(mcp_tools.EXPAND_SOURCE_KINDS)
    json.dumps(schema)  # an MCP client receives it as JSON


def test_the_schema_enum_matches_the_implementation():
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
    import profile_sources

    assert set(mcp_tools.EXPAND_SOURCE_KINDS) == set(profile_sources.SOURCE_KINDS)


def test_it_shows_up_in_the_servers_tool_list():
    listed = {entry["name"]: entry for entry in server._tool_list()}
    assert "expand_profile" in listed
    assert listed["expand_profile"]["description"]
    assert listed["expand_profile"]["inputSchema"]["type"] == "object"


def test_the_server_lists_it_over_json_rpc():
    response = server.handle_message(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    names = {tool["name"] for tool in response["result"]["tools"]}
    assert "expand_profile" in names


def test_the_registered_six_are_still_registered():
    assert {"run_alerts", "rank", "list_shortlist", "get_posting",
            "search_seen", "tailor"} <= set(mcp_tools.TOOLS)


def test_arguments_reach_the_implementation_unchanged(monkeypatch):
    seen = {}

    def fake_run(*, sources=None, cfg=None):
        seen["sources"] = sources
        seen["cfg_is_a_dict"] = isinstance(cfg, dict)
        return {"proposals_path": "/tmp/expand-proposals.md", "signals_total": 0}

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
    import expand_profile

    monkeypatch.setattr(expand_profile, "run", fake_run)
    result = mcp_tools.call_tool("expand_profile", {"sources": ["github"]})
    assert seen == {"sources": ["github"], "cfg_is_a_dict": True}
    assert result["proposals_path"].endswith("expand-proposals.md")


def test_omitting_sources_means_every_source(monkeypatch):
    seen = {}

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
    import expand_profile

    monkeypatch.setattr(expand_profile, "run",
                        lambda *, sources=None, cfg=None: seen.setdefault("sources", sources) or {})
    mcp_tools.call_tool("expand_profile", {})
    assert seen["sources"] is None


def test_a_bad_source_type_is_a_tool_error_not_a_crash():
    with pytest.raises(mcp_tools.ToolError) as exc:
        mcp_tools.call_tool("expand_profile", {"sources": ["myspace"]})
    assert "unknown source type" in str(exc.value)


def test_an_unknown_argument_is_rejected_by_dispatch():
    with pytest.raises(TypeError):
        mcp_tools.call_tool("expand_profile", {"nope": 1})
