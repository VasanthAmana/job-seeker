"""Ranking state machine: gates veto, score math, sweep, unreachable retry."""

import json
from datetime import date, datetime, timedelta, timezone

import pytest

import rank_state


def entry(title, company, url, **extra):
    base = {"title": title, "company": company, "url": url, "source": "linkedin",
            "first_seen": "2026-11-01", "status": "new"}
    base.update(extra)
    return base


def write_state(tmp_path, entries):
    state = tmp_path / "state" / "seen_jobs.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    from job_key import make_key
    seen = {make_key(e["company"], e["title"], e["url"]): e for e in entries}
    state.write_text(json.dumps({"seen": seen}), encoding="utf-8")
    return state, list(seen)


def result(key, **overrides):
    base = {
        "key": key,
        "scores": {"domain": 80, "leadership": 70, "behavioral": 60, "career": 90},
        "location_verdict": "PASS",
        "seniority_gate": "PASS",
        "engineering_role": False,
        "reason": "Strong AI-strategy scope at Director level.",
        "strengths": ["enterprise AI roadmap ownership"],
        "gaps": ["no banking domain named"],
        "guard": "clean",
    }
    base.update(overrides)
    return base


def apply(tmp_path, results, today="2026-11-02"):
    state = tmp_path / "state" / "seen_jobs.json"
    results_file = tmp_path / "results.json"
    results_file.write_text(json.dumps(results), encoding="utf-8")
    rc = rank_state.main(["apply", "--results", str(results_file), "--state", str(state),
                          "--today", today])
    return rc


def test_overall_score_weights_and_band():
    score = rank_state.overall_score({"domain": 80, "leadership": 70, "behavioral": 60, "career": 90})
    # 80*.3 + 70*.25 + 60*.15 + 90*.3 = 24 + 17.5 + 9 + 27 = 77.5 -> 78
    assert score == 78
    assert rank_state.band(score) == "Strong Fit"
    assert rank_state.score_10(score) == 7.8


def test_overall_score_rejects_missing_dimension():
    with pytest.raises(ValueError):
        rank_state.overall_score({"domain": 80, "leadership": 70, "behavioral": 60})
    with pytest.raises(ValueError):
        rank_state.overall_score({"domain": 101, "leadership": 70, "behavioral": 60, "career": 90})
    with pytest.raises(ValueError):
        rank_state.overall_score({"domain": True, "leadership": 70, "behavioral": 60, "career": 90})


def test_apply_ranks_and_scores(tmp_path, capsys):
    state, keys = write_state(tmp_path, [entry("Director, AI Strategy", "Acme", "https://a.example/1")])
    rc = apply(tmp_path, [result(keys[0])])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert len(out["ranked"]) == 1 and not out["vetoed"]
    row = out["ranked"][0]
    assert row["score"] == 78 and row["score_10"] == 7.8
    assert row["verdict"] == "Strong Fit"
    assert row["reason"] == "Strong AI-strategy scope at Director level."
    assert row["seniority_gate"] == "PASS" and row["engineering_role"] is False
    stored = json.loads(state.read_text(encoding="utf-8"))["seen"][keys[0]]
    assert stored["status"] == "ranked" and stored["rank_score"] == 78


def test_seniority_fail_vetoes(tmp_path, capsys):
    state, keys = write_state(tmp_path, [entry("AI Strategy Manager", "Acme", "https://a.example/1")])
    rc = apply(tmp_path, [result(keys[0], seniority_gate="FAIL",
                                 reason="Manager-level IC role, below the Director target.")])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert not out["ranked"] and len(out["vetoed"]) == 1
    assert out["vetoed"][0]["seniority_gate"] == "FAIL"


def test_engineering_role_vetoes_even_with_high_score(tmp_path, capsys):
    state, keys = write_state(tmp_path, [entry("Machine Learning Engineer", "Acme", "https://a.example/1")])
    rc = apply(tmp_path, [result(keys[0], engineering_role=True,
                                 scores={"domain": 95, "leadership": 90, "behavioral": 90, "career": 95})])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert not out["ranked"]
    assert out["vetoed"][0]["engineering_role"] is True
    assert out["vetoed"][0]["score"] >= 90  # vetoed despite the score


def test_seniority_flag_stays_ranked(tmp_path, capsys):
    state, keys = write_state(tmp_path, [entry("Senior Manager, AI Strategy", "Acme", "https://a.example/1")])
    rc = apply(tmp_path, [result(keys[0], seniority_gate="FLAG")])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert len(out["ranked"]) == 1
    assert out["ranked"][0]["seniority_gate"] == "FLAG"


def test_bad_gate_values_and_types_are_errors(tmp_path, capsys):
    state, keys = write_state(tmp_path, [entry("Director, AI Strategy", "Acme", "https://a.example/1")])
    rc = apply(tmp_path, [result(keys[0], seniority_gate="MEH")])
    out = json.loads(capsys.readouterr().out)
    assert rc == 1 and out["errors"]
    rc = apply(tmp_path, [result(keys[0], engineering_role="yes")])
    out = json.loads(capsys.readouterr().out)
    assert rc == 1 and out["errors"]
    rc = apply(tmp_path, [result("no_such_key")])
    out = json.loads(capsys.readouterr().out)
    assert rc == 1 and out["errors"][0]["key"] == "no_such_key"


def test_expired_status_and_passed_deadline(tmp_path, capsys):
    state, keys = write_state(tmp_path, [
        entry("Director, AI Strategy", "Acme", "https://a.example/1", deadline="2026-10-01"),
        entry("VP Transformation", "Beta", "https://b.example/2"),
    ])
    rc = apply(tmp_path, [result(keys[0]), {"key": keys[1], "status": "expired"}])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert len(out["expired"]) == 2
    stored = json.loads(state.read_text(encoding="utf-8"))["seen"]
    assert stored[keys[0]]["status"] == "expired"
    assert stored[keys[1]]["status"] == "expired"


def test_unreachable_retries_then_gives_up(tmp_path, capsys):
    state, keys = write_state(tmp_path, [entry("Director, AI Strategy", "Acme", "https://a.example/1")])
    results_file = tmp_path / "results.json"
    results_file.write_text(json.dumps(
        [{"key": keys[0], "status": "unreachable", "fetch_error": "403 after curl retry"}]), encoding="utf-8")

    def run(now):
        capsys.readouterr()
        rc = rank_state.main(["apply", "--results", str(results_file), "--state", str(state), "--now", now])
        return rc, json.loads(capsys.readouterr().out)

    t0 = datetime(2026, 11, 2, 9, 0, tzinfo=timezone.utc)
    _, out = run(t0.isoformat())
    assert out["unreachable"][0]["fetch_attempts"] == 1
    # Third attempt but only hours later: still retrying (48h floor).
    _, out = run(t0.isoformat())
    _, out = run(t0.isoformat())
    assert len(out["unreachable"]) == 1 and not out["gave_up"]
    # Third attempt after 48h: gives up to expired.
    _, out = run((t0 + timedelta(hours=49)).isoformat())
    assert len(out["gave_up"]) == 1
    stored = json.loads(state.read_text(encoding="utf-8"))["seen"][keys[0]]
    assert stored["status"] == "expired" and stored["expired_reason"] == "unreachable"


def test_sweep_expires_and_reports_closing(tmp_path, capsys):
    state, keys = write_state(tmp_path, [
        entry("Old Role", "Acme", "https://a.example/1", status="ranked", deadline="2026-10-01"),
        entry("Closing Role", "Beta", "https://b.example/2", status="ranked", deadline="2026-11-05"),
        entry("Open Role", "Gamma", "https://c.example/3", status="ranked", deadline="2026-12-31"),
        entry("No Deadline", "Delta", "https://d.example/4", status="ranked"),
        entry("Bad Deadline", "Epsilon", "https://e.example/5", status="ranked", deadline="ASAP"),
    ])
    capsys.readouterr()
    rc = rank_state.main(["sweep", "--write", "--state", str(state), "--today", "2026-11-02"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert [r["key"] for r in out["newly_expired"]] == [keys[0]]
    assert [r["key"] for r in out["closing_soon"]] == [keys[1]]
    assert out["unparseable_deadlines"][0]["deadline"] == "ASAP"
    stored = json.loads(state.read_text(encoding="utf-8"))["seen"]
    assert stored[keys[0]]["status"] == "expired"
    assert stored[keys[3]]["status"] == "ranked"  # absent deadline left alone


def test_candidates_status_filter_and_tracker_exclusion(tmp_path, capsys):
    tracker = tmp_path / "tracker.csv"
    tracker.write_text(
        "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source,deadline\n"
        "2026-10-30,Beta,Banking,VP Transformation,,referral,applied,,,8,,,linkedin,\n", encoding="utf-8")
    state, keys = write_state(tmp_path, [
        entry("Director, AI Strategy", "Acme", "https://a.example/1"),
        entry("VP Transformation", "Beta", "https://b.example/2"),
        entry("Old", "Gamma", "https://c.example/3", status="ranked"),
    ])
    capsys.readouterr()
    rc = rank_state.main(["candidates", "--state", str(state), "--tracker", str(tracker)])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert out["eligible"] == 1 and out["excluded_by_tracker"] == 1
    assert out["selected"][0]["key"] == keys[0]
    assert out["selected"][0]["source"] == "linkedin"
