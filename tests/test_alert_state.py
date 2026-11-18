"""Dedupe and store behaviour of alert_state.py against temp state."""

import json

import pytest

import alert_state
from job_key import make_key


def job(url, title="Director, AI Strategy", company="Acme Corp", **extra):
    base = {"url": url, "source": "linkedin"}
    if title is not None:
        base["title"] = title
    if company is not None:
        base["company"] = company
    base.update(extra)
    return base


def store_ready(j):
    return {**j, "title": j.get("title") or "Director, AI Strategy",
            "company": j.get("company") or "Acme Corp",
            "first_seen": "2026-11-02", "status": "new"}


def run_tool(tmp_path, command, jobs, tracker=None):
    results = tmp_path / "results.json"
    results.write_text(json.dumps(jobs), encoding="utf-8")
    state = tmp_path / "state" / "seen_jobs.json"
    tracker_path = tmp_path / "tracker.csv"
    if tracker is not None:
        tracker_path.write_text(tracker, encoding="utf-8")
    args = alert_state.main([command, "--results", str(results),
                             "--state", str(state), "--tracker", str(tracker_path)])
    return args, state


def test_candidates_require_only_a_valid_url(tmp_path, capsys):
    jobs = [job("https://example.com/jobs/1", title=None, company=None)]
    rc, _ = run_tool(tmp_path, "candidates", jobs)
    out = json.loads(capsys.readouterr().out)
    assert rc == 0 and len(out["selected"]) == 1


def test_candidates_reject_invalid_urls(tmp_path, capsys):
    jobs = [job("ftp://example.com/x"), job(""), {"title": "no url"}]
    rc, _ = run_tool(tmp_path, "candidates", jobs)
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert out["selected"] == []
    assert len(out["invalid"]) == 3


def test_dedupe_against_seen_by_url_and_pair(tmp_path, capsys):
    existing = store_ready(job("https://example.com/jobs/1"))
    state = tmp_path / "state" / "seen_jobs.json"
    state.parent.mkdir(parents=True)
    state.write_text(json.dumps({"seen": {
        make_key(existing["company"], existing["title"], existing["url"]): existing,
        make_key("Beta LLC", "VP Transformation", "https://beta.example/j/9"):
            store_ready(job("https://beta.example/j/9", "VP Transformation", "Beta LLC")),
    }}), encoding="utf-8")

    jobs = [
        job("https://example.com/jobs/1"),                       # same URL
        job("https://beta.example/other", "VP Transformation", "Beta LLC"),  # same pair
        job("https://gamma.example/j/3", "Head of AI", "Gamma"),
    ]
    rc, _ = run_tool(tmp_path, "candidates", jobs)
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert out["already_seen"] == 2
    assert [j["url"] for j in out["selected"]] == ["https://gamma.example/j/3"]


def test_dedupe_against_tracker(tmp_path, capsys):
    tracker = "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source,deadline\n2026-10-30,Acme Corp,Banking,Director AI Strategy,,referral,applied,,,8,,,linkedin,\n"
    jobs = [job("https://new.example/j/1", "Director, AI Strategy", "Acme Corp")]
    rc, _ = run_tool(tmp_path, "candidates", jobs, tracker=tracker)
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert out["already_applied"] == 1
    assert out["selected"] == []


def test_dedupe_ignores_tracking_params(tmp_path, capsys):
    existing = store_ready(job("https://www.linkedin.com/jobs/view/123?currentJobId=123&trk=flagship3_search"))
    state = tmp_path / "state" / "seen_jobs.json"
    state.parent.mkdir(parents=True)
    state.write_text(json.dumps({"seen": {
        make_key(existing["company"], existing["title"], existing["url"]): existing,
    }}), encoding="utf-8")

    jobs = [job("https://www.linkedin.com/jobs/view/123?currentJobId=123&trk=nav_responsive&trkEmail=abc")]
    rc, _ = run_tool(tmp_path, "candidates", jobs)
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert out["already_seen"] == 1
    assert out["selected"] == []


def test_batch_internal_duplicates_ignores_tracking_params(tmp_path, capsys):
    jobs = [
        job("https://www.indeed.com/viewjob?jk=abc&tk=one&from=serp"),
        job("https://www.indeed.com/viewjob?jk=abc&tk=two&from=email"),
    ]
    rc, _ = run_tool(tmp_path, "candidates", jobs)
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert len(out["selected"]) == 1
    assert out["repeated_in_batch"] == 1


def test_batch_internal_duplicates(tmp_path, capsys):
    jobs = [job("https://example.com/jobs/1"), job("https://example.com/jobs/1/")]
    rc, _ = run_tool(tmp_path, "candidates", jobs)
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert len(out["selected"]) == 1
    assert out["repeated_in_batch"] == 1


def test_store_persists_atomically_and_keys_canonically(tmp_path, capsys):
    jobs = [store_ready(job("https://example.com/jobs/1", "Director, AI Strategy", "Acme Corp"))]
    rc, state = run_tool(tmp_path, "store", jobs)
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    key = make_key("Acme Corp", "Director, AI Strategy", "https://example.com/jobs/1")
    assert out["added"] == [key]
    stored = json.loads(state.read_text(encoding="utf-8"))["seen"]
    assert stored[key]["status"] == "new"
    assert stored[key]["source"] == "linkedin"


def test_store_requires_full_identity(tmp_path):
    jobs = [job("https://example.com/jobs/1", title=None)]  # url-only is not storable
    rc, state = run_tool(tmp_path, "store", jobs)
    assert rc == 1
    assert not state.exists()


def test_restore_of_seen_url_is_a_noop(tmp_path, capsys):
    jobs = [store_ready(job("https://example.com/jobs/1"))]
    rc, state = run_tool(tmp_path, "store", jobs)
    assert rc == 0
    capsys.readouterr()
    rc, _ = run_tool(tmp_path, "store", jobs)
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert out["added"] == [] and out["already_seen"] == 1
    stored = json.loads(state.read_text(encoding="utf-8"))["seen"]
    assert len(stored) == 1


def test_store_rejects_bad_status_and_source(tmp_path):
    bad_status = store_ready(job("https://example.com/jobs/1"))
    bad_status["status"] = "ranked"  # ranking owns that transition
    bad_source = store_ready(job("https://example.com/jobs/2"))
    bad_source["source"] = "portal"
    rc, state = run_tool(tmp_path, "store", [bad_status])
    assert rc == 1
    rc, state = run_tool(tmp_path, "store", [bad_source])
    assert rc == 1
    assert not state.exists()
