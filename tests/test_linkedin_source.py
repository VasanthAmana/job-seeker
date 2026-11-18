"""jobseek/linkedin/source.py: LinkedIn saved searches -> alert_state.py
candidate shape. No live LinkedIn - the client is monkeypatched to a fake
that returns fixture job lists or raises LinkedInError, the same contract
test_linkedin_client.py verifies against a real (fake) socket."""

from __future__ import annotations

import json

import pytest

import source as linkedin_source  # jobseek/linkedin/source.py
import client as linkedin_client
from alert_state import select
from job_key import make_key


def test_to_candidate_prefers_explicit_url():
    job = {"url": "https://www.linkedin.com/jobs/view/123/", "jobId": "123", "title": "Director, AI Strategy", "company": "Acme"}
    candidate = linkedin_source._to_candidate(job, {"name": "test"}, "2026-11-02")
    assert candidate["url"] == "https://www.linkedin.com/jobs/view/123/"
    assert candidate["source"] == "linkedin"
    assert candidate["title"] == "Director, AI Strategy"
    assert candidate["company"] == "Acme"
    assert candidate["message_id"] == "linkedin:123"
    assert candidate["alert_date"] == "2026-11-02"


def test_to_candidate_builds_url_from_job_id_when_missing():
    job = {"jobId": "999", "title": "VP AI", "company": "Beta"}
    candidate = linkedin_source._to_candidate(job, {}, "2026-11-02")
    assert candidate["url"] == "https://www.linkedin.com/jobs/view/999/"


def test_to_candidate_returns_none_without_any_identity():
    assert linkedin_source._to_candidate({"title": "x"}, {}, "2026-11-02") is None


def test_run_search_requires_a_query():
    _found, error = linkedin_source.run_search({"name": "broken"})
    assert error and "query" in error


def test_run_search_collects_jobs_across_locations(monkeypatch):
    calls = []

    def fake_search_jobs(query, *, location=None, **kwargs):
        calls.append(location)
        return {"jobs": [{"jobId": f"{location}-1", "title": "Director", "company": "Acme", "location": location}]}

    monkeypatch.setattr(linkedin_client, "search_jobs", fake_search_jobs)
    search = {"name": "test", "query": "AI strategy", "locations": ["Denver", "Remote"]}
    found, error = linkedin_source.run_search(search)
    assert error is None
    assert calls == ["Denver", "Remote"]
    assert len(found) == 2
    assert {c["location"] for c in found} == {"Denver", "Remote"}


def test_run_search_reports_a_needs_you_error_without_raising(monkeypatch):
    def fake_search_jobs(query, **kwargs):
        raise linkedin_client.LinkedInNeedsYouError("LinkedIn needs you: the app isn't running.")

    monkeypatch.setattr(linkedin_client, "search_jobs", fake_search_jobs)
    found, error = linkedin_source.run_search({"name": "test", "query": "x", "locations": ["Remote"]})
    assert found == []
    assert "LinkedIn needs you" in error


def test_candidates_aggregates_across_saved_searches_and_keeps_going_after_an_error(monkeypatch):
    def fake_search_jobs(query, *, location=None, **kwargs):
        if query == "broken-query":
            raise linkedin_client.LinkedInNeedsYouError("LinkedIn needs you: pace cap reached.")
        return {"jobs": [{"jobId": "1", "title": "Director", "company": "Acme", "location": location}]}

    monkeypatch.setattr(linkedin_client, "search_jobs", fake_search_jobs)
    cfg = {
        "linkedin": {
            "saved_searches": [
                {"name": "a", "query": "AI strategy", "locations": ["Denver"]},
                {"name": "b", "query": "broken-query", "locations": ["Remote"]},
            ]
        }
    }
    result = linkedin_source.candidates(cfg)
    assert result["searches"] == 2
    assert result["jobs"] == 1
    assert len(result["errors"]) == 1
    assert result["errors"][0]["saved_search"] == "b"


def test_candidates_with_no_saved_searches_is_a_clean_empty_result():
    result = linkedin_source.candidates({})
    assert result == {"searches": 0, "jobs": 0, "links": [], "errors": []}


# --- integration with the SAME dedupe store the Gmail source feeds ----------


def test_linkedin_candidates_feed_the_same_job_key_dedupe_as_gmail(monkeypatch):
    """A LinkedIn-sourced candidate and a Gmail-sourced candidate for the
    SAME job (same company+title, or same URL) must dedupe against each
    other through tools/alert_state.py's existing `select()` - no parallel
    identity scheme."""

    def fake_search_jobs(query, *, location=None, **kwargs):
        return {"jobs": [{"jobId": "42", "title": "Director, AI Strategy", "company": "Acme Corp",
                           "url": "https://www.linkedin.com/jobs/view/42/", "location": location}]}

    monkeypatch.setattr(linkedin_client, "search_jobs", fake_search_jobs)
    cfg = {"linkedin": {"saved_searches": [{"name": "a", "query": "AI strategy", "locations": ["Denver"]}]}}
    linkedin_candidates = linkedin_source.candidates(cfg)["links"]
    assert len(linkedin_candidates) == 1

    # Already seen via the Gmail path under the canonical job_key.
    seen_entry = {"title": "Director, AI Strategy", "company": "Acme Corp", "url": "https://jobs.acme.example/42"}
    key = make_key(seen_entry["company"], seen_entry["title"], seen_entry["url"])
    seen = {key: seen_entry}

    selected, counts = select(linkedin_candidates, seen, tracker=set())
    assert selected == []
    assert counts["already_seen"] == 1


def test_linkedin_candidates_are_selected_when_genuinely_new():
    candidate = {
        "url": "https://www.linkedin.com/jobs/view/777/", "source": "linkedin",
        "title": "VP, AI Transformation", "company": "Globex", "message_id": "linkedin:777",
        "alert_date": "2026-11-02",
    }
    selected, counts = select([candidate], seen={}, tracker=set())
    assert len(selected) == 1
    assert counts["already_seen"] == 0
