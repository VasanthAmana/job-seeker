"""jobseek MCP server: tool schemas and read-only tool behavior.

No live Gmail access: run_alerts is only exercised against a fixture
account directory with no OAuth files, so it fails fast on the same
"cannot read Gmail OAuth files" check gmail_alerts.py already has -
never reaching the network.
"""

import json
import sys
from pathlib import Path

import pytest

MCP_DIR = Path(__file__).resolve().parent.parent / "mcp"
if str(MCP_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_DIR))

import tools as mcp_tools  # the jobseek/mcp/tools.py module
import config as jobseek_config
from job_key import make_key


@pytest.fixture()
def jobseek_config_file(tmp_path, monkeypatch):
    """Point the whole config system at an isolated state/tracker/last_run
    under tmp_path, so tests never touch the real jobseek/state."""
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
        },
        "ranking": {"top_n": 2},
    }), encoding="utf-8")
    monkeypatch.setenv("JOBSEEK_CONFIG", str(cfg_path))
    return cfg_path, state_dir


def write_seen(state_dir, entries):
    seen = {make_key(e["company"], e["title"], e["url"]): e for e in entries}
    (state_dir / "seen_jobs.json").write_text(json.dumps({"seen": seen}), encoding="utf-8")
    return list(seen)


def ranked_entry(title, company, url, score, **extra):
    base = {
        "title": title, "company": company, "url": url, "source": "linkedin",
        "first_seen": "2026-11-01", "status": "ranked", "rank_score": score,
        "rank_verdict": "Strong Fit", "location_verdict": "PASS",
        "seniority_gate": "PASS", "engineering_role": False,
        "reason": "Director-level AI strategy scope.",
    }
    base.update(extra)
    return base


# --- tool registry / schema shape ------------------------------------------


def test_tool_registry_has_exactly_the_six_required_tools():
    assert set(mcp_tools.TOOLS) == {
        "run_alerts", "rank", "list_shortlist", "get_posting", "search_seen", "tailor",
    }


@pytest.mark.parametrize("name", list(mcp_tools.TOOLS))
def test_every_tool_has_a_json_schema_object(name):
    _func, schema = mcp_tools.TOOLS[name]
    assert schema["type"] == "object"
    assert "properties" in schema
    assert mcp_tools.TOOL_DESCRIPTIONS[name]


def test_get_posting_schema_requires_id():
    _func, schema = mcp_tools.TOOLS["get_posting"]
    assert schema["required"] == ["id"]


def test_search_seen_schema_requires_query():
    _func, schema = mcp_tools.TOOLS["search_seen"]
    assert schema["required"] == ["query"]


def test_tailor_schema_requires_job_id():
    _func, schema = mcp_tools.TOOLS["tailor"]
    assert schema["required"] == ["job_id"]


def test_run_alerts_and_rank_and_shortlist_have_no_required_fields():
    for name in ("run_alerts", "rank", "list_shortlist"):
        _func, schema = mcp_tools.TOOLS[name]
        assert "required" not in schema


# --- call_tool dispatch ------------------------------------------------------


def test_call_tool_rejects_unknown_tool_name():
    with pytest.raises(mcp_tools.ToolError):
        mcp_tools.call_tool("delete_everything", {})


def test_call_tool_rejects_non_object_arguments():
    with pytest.raises(mcp_tools.ToolError):
        mcp_tools.call_tool("rank", ["not", "a", "dict"])


def test_call_tool_rejects_unknown_argument(jobseek_config_file):
    with pytest.raises(TypeError):
        mcp_tools.call_tool("rank", {"bogus_arg": 1})


# --- rank / list_shortlist / get_posting / search_seen (pure state reads) --


def test_rank_empty_state_returns_no_results(jobseek_config_file):
    result = mcp_tools.rank()
    assert result == {"top_n": 2, "count": 0, "results": []}


def test_rank_sorts_by_score_and_respects_top_n(jobseek_config_file):
    _cfg, state_dir = jobseek_config_file
    write_seen(state_dir, [
        ranked_entry("Director AI Strategy", "Acme", "https://acme.example/1", 60),
        ranked_entry("VP AI Strategy", "Beta", "https://beta.example/1", 90),
        ranked_entry("Head of AI", "Gamma", "https://gamma.example/1", 75),
    ])
    result = mcp_tools.rank()
    assert result["top_n"] == 2
    assert [r["company"] for r in result["results"]] == ["Beta", "Gamma"]


def test_rank_excludes_vetoed_entries(jobseek_config_file):
    _cfg, state_dir = jobseek_config_file
    write_seen(state_dir, [
        ranked_entry("ML Engineer", "Acme", "https://acme.example/1", 95, engineering_role=True),
        ranked_entry("Director AI Strategy", "Beta", "https://beta.example/1", 50),
    ])
    result = mcp_tools.rank(top_n=5)
    assert result["count"] == 1
    assert result["results"][0]["company"] == "Beta"


def test_rank_rejects_non_positive_top_n(jobseek_config_file):
    with pytest.raises(mcp_tools.ToolError):
        mcp_tools.rank(top_n=0)


def test_list_shortlist_falls_back_to_rank_without_last_run(jobseek_config_file):
    _cfg, state_dir = jobseek_config_file
    write_seen(state_dir, [ranked_entry("Director AI Strategy", "Acme", "https://acme.example/1", 70)])
    result = mcp_tools.list_shortlist()
    assert result["source"] == "seen_jobs"
    assert result["count"] == 1


def test_list_shortlist_reads_last_run_when_present(jobseek_config_file):
    _cfg, state_dir = jobseek_config_file
    last_run = {"ranked": [{"key": "a", "title": "X"}, {"key": "b", "title": "Y"}]}
    (state_dir / "last_run.json").write_text(json.dumps(last_run), encoding="utf-8")
    result = mcp_tools.list_shortlist()
    assert result["source"] == "last_run"
    assert result["count"] == 2
    assert result["results"][0]["key"] == "a"


def test_get_posting_returns_stored_entry(jobseek_config_file):
    _cfg, state_dir = jobseek_config_file
    keys = write_seen(state_dir, [ranked_entry("Director AI Strategy", "Acme", "https://acme.example/1", 70)])
    posting = mcp_tools.get_posting(keys[0])
    assert posting["company"] == "Acme"
    assert posting["key"] == keys[0]


def test_get_posting_missing_key_raises_tool_error(jobseek_config_file):
    with pytest.raises(mcp_tools.ToolError):
        mcp_tools.get_posting("no-such-key")


def test_get_posting_rejects_empty_id(jobseek_config_file):
    with pytest.raises(mcp_tools.ToolError):
        mcp_tools.get_posting("")


def test_search_seen_matches_title_company_and_location(jobseek_config_file):
    _cfg, state_dir = jobseek_config_file
    write_seen(state_dir, [
        ranked_entry("Director AI Strategy", "Acme Bank", "https://acme.example/1", 70, location="Denver, CO"),
        ranked_entry("VP Engineering", "Beta Corp", "https://beta.example/1", 60, location="Remote"),
    ])
    result = mcp_tools.search_seen("acme")
    assert result["count"] == 1
    assert result["results"][0]["company"] == "Acme Bank"

    result = mcp_tools.search_seen("denver")
    assert result["count"] == 1


def test_search_seen_rejects_empty_query(jobseek_config_file):
    with pytest.raises(mcp_tools.ToolError):
        mcp_tools.search_seen("")


# --- tailor: read-only prep, not execution ----------------------------------


def test_tailor_returns_paths_and_invoke_without_running_anything(jobseek_config_file):
    _cfg, state_dir = jobseek_config_file
    keys = write_seen(state_dir, [ranked_entry("Director AI Strategy", "Acme", "https://acme.example/1", 70)])
    result = mcp_tools.tailor(keys[0])
    assert result["job"]["company"] == "Acme"
    assert result["tailor_command_file"].endswith("tailor.md")
    assert "acme.example" in result["invoke"]


def test_tailor_missing_job_raises_tool_error(jobseek_config_file):
    with pytest.raises(mcp_tools.ToolError):
        mcp_tools.tailor("no-such-key")


# --- run_alerts: no live Gmail access ---------------------------------------


def test_run_alerts_fails_closed_without_oauth_files_no_network(jobseek_config_file):
    """account_dir points at a directory with no gcp-oauth.keys.json /
    credentials.json, so this must fail during the local file read - before
    any HTTP request is attempted."""
    with pytest.raises(RuntimeError, match="cannot read Gmail OAuth files"):
        mcp_tools.run_alerts()


def test_run_alerts_unknown_account_raises_config_error(jobseek_config_file):
    with pytest.raises(jobseek_config.ConfigError):
        mcp_tools.run_alerts(account="does-not-exist")
