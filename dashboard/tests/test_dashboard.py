"""Offline tests for dashboard (fixtures only, no network, no browser)."""

import json
import re
import shutil
import sys
from datetime import date
from pathlib import PureWindowsPath, Path

import pytest

JOBSEEK = Path(__file__).resolve().parents[2]
for p in (JOBSEEK / "tools", JOBSEEK / "mcp", JOBSEEK):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import dashboard as dash  # noqa: E402
from dashboard import build  # noqa: E402
import tools as mcp_tools  # noqa: E402

FIX = Path(__file__).parent / "fixtures"
TODAY = date(2026, 11, 2)


def seen_doc():
    base = {"first_seen": "2026-10-28", "status": "ranked", "rank_date": "2026-10-29",
            "rank_verdict": "Strong Fit", "location_verdict": "PASS", "seniority_gate": "PASS",
            "engineering_role": False, "reason": "Fits."}
    return {"seen": {
        "k1": {**base, "title": "VP AI", "company": "LinkedCo", "url": "https://l.example/1", "source": "linkedin", "rank_score": 82},
        "k2": {**base, "title": "Dir Strategy", "company": "MailCo", "url": "https://m.example/2", "source": "indeed",
               "rank_score": 61, "deadline": "2026-11-04", "engineering_role": True},
        "k3": {**base, "title": "Skipped", "company": "NewCo", "url": "https://n.example/3", "source": "ladders", "status": "new"},
    }}


@pytest.fixture()
def cfg(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    shutil.copy(FIX / "tracker_sample.csv", tmp_path / "tracker.csv")
    (state / "seen_jobs.json").write_text(json.dumps(seen_doc()), encoding="utf-8")
    (state / "last_run.json").write_text(json.dumps({"ranked": [{"key": "k1"}]}), encoding="utf-8")
    return {"paths": {"state_dir": str(state), "seen_jobs": str(state / "seen_jobs.json"),
                      "last_run": str(state / "last_run.json"), "tracker": str(tmp_path / "tracker.csv")}}


def test_counts_by_stage_exclude_drafted_from_stats(cfg):
    s = dash.collect(cfg, TODAY)["stats"]
    sc = s["stage_counts"]
    assert sc["Active"] == 3 and sc["Interview"] == 1 and sc["Hired"] == 1
    assert sc["Drafted"] == 1 and sc["Rejected/Closed"] == 3 and sc["Ranked"] == 2
    assert s["sent"] == 8  # drafted excluded
    assert s["funnel"] == {"Applied": 8, "Interview": 2, "Offer": 1, "Hired": 1}
    # 1 true rejection (rejected) of 4 final-outcome rows (3 closed + 1 hired)
    assert s["rejection_rate"] == 25


def test_unknown_status_named_and_short_row_kept(cfg):
    data = dash.collect(cfg, TODAY)
    assert data["unknown_statuses"] == ["mystery"]
    assert any(r["company"] == "Iota" for r in data["rows"])


def test_followup_due_logic(cfg):
    rows = {r["company"]: r for r in dash.collect(cfg, TODAY)["rows"]}
    assert rows["Acme <Corp>"]["due_kind"] == "follow-up" and rows["Acme <Corp>"]["due"] == "2026-10-27"
    assert rows["Acme <Corp>"]["due_state"] == "overdue"
    # applied 10-30 -> follow-up 11-06, deadline 11-05 is earlier and within a week
    assert (rows["Beta Inc"]["due_kind"], rows["Beta Inc"]["due_state"]) == ("deadline", "soon")
    assert rows["Gamma"]["due"] == ""            # interview: no follow-up
    assert rows["Iota"]["due"] == ""             # bare year: nothing inferred
    assert rows["Eta"]["due"] == "2026-11-03"    # drafted keeps its deadline


def test_posting_rows_scores_flags_shortlist(cfg):
    rows = {r["company"]: r for r in dash.collect(cfg, TODAY)["rows"]}
    assert rows["LinkedCo"]["origin"] == "shortlist" and rows["LinkedCo"]["score"] == 8.2
    assert rows["MailCo"]["origin"] == "ranked" and rows["MailCo"]["flags"] == ["engineering role"]
    assert rows["MailCo"]["due_state"] == "soon"
    assert "NewCo" not in rows


def test_html_table_filters_sources_and_escaping(cfg):
    html = dash.render_html(dash.collect(cfg, TODAY))
    assert len(re.findall(r"<tr data-q=", html)) == 11
    for needle in ('id="q"', 'id="f-stage"', 'id="f-source"', 'value="linkedin"', 'value="indeed"', 'value="email"'):
        assert needle in html
    assert "Acme &lt;Corp&gt;" in html and "Acme <Corp>" not in html
    assert "&quot;quietly&quot;" in html
    assert "<svg" in html and 'role="img"' in html


def test_html_has_no_network_references(cfg):
    html = dash.render_html(dash.collect(cfg, TODAY))
    assert not re.search(r'(src|href)="https?://(?!example\.com|[lmn]\.example)', html)
    assert "<script src" not in html and "<link" not in html and "@import" not in html and "fetch(" not in html


def test_empty_state_renders(tmp_path):
    c = {"paths": {"state_dir": str(tmp_path), "seen_jobs": str(tmp_path / "a.json"),
                   "last_run": str(tmp_path / "b.json"), "tracker": str(tmp_path / "t.csv")}}
    assert "Job Search Dashboard" in dash.render_html(dash.collect(c, TODAY))


def test_default_output_path_and_windows_style_paths(tmp_path):
    assert dash.default_output_path({"paths": {"state_dir": "state"}}) == build.jobseek_config.ROOT / "state" / "dashboard.html"
    out = dash.default_output_path({"paths": {"state_dir": "state", "dashboard": str(tmp_path / "x" / "d.html")}})
    assert out == tmp_path / "x" / "d.html"
    # Windows-style strings must not break path handling on any platform.
    win = PureWindowsPath(r"C:\Users\me\jobseek\state\dashboard.html")
    assert win.name == "dashboard.html" and win.parent.name == "state"
    written = dash.write_dashboard({"today": "2026-11-02", "rows": [], "unknown_statuses": [],
                                    "stats": build.compute_stats([], [])}, str(tmp_path / "new dir" / "d.html"))
    assert written.read_bytes().startswith(b"<!doctype html>") and b"\r\n" not in written.read_bytes()


def test_dashboard_tool_returns_path_without_opening(cfg, tmp_path, monkeypatch):
    out = tmp_path / "out" / "d.html"
    cfg["paths"]["dashboard"] = str(out)
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({**cfg, "accounts": [{"name": "t", "account_dir": str(tmp_path)}]}), encoding="utf-8")
    monkeypatch.setenv("JOBSEEK_CONFIG", str(cfg_file))
    opened = []
    monkeypatch.setattr(build.webbrowser, "open", lambda *a, **k: opened.append(a))
    result = mcp_tools.call_tool("dashboard", {})
    assert result["path"] == str(out) and out.is_file() and opened == []
    mcp_tools.call_tool("dashboard", {"open": True})
    assert len(opened) == 1 and opened[0][0].startswith("file:")
