"""job_key.audit's duplicate-URL detection, across tracking-param variants."""

import json

from job_key import audit


def write_state(tmp_path, seen):
    path = tmp_path / "seen.json"
    path.write_text(json.dumps({"seen": seen}), encoding="utf-8")
    return path


def test_audit_catches_duplicate_urls_that_differ_only_by_tracking_params(tmp_path, capsys):
    seen = {
        "acme_director-ai-strategy": {
            "company": "Acme", "title": "Director, AI Strategy",
            "url": "https://www.linkedin.com/jobs/view/123?currentJobId=123&trk=flagship3_search",
        },
        "acme_director-ai-strategy-2": {
            "company": "Acme", "title": "Director, AI Strategy",
            "url": "https://www.linkedin.com/jobs/view/123?currentJobId=123&trk=nav_responsive",
        },
    }
    path = write_state(tmp_path, seen)
    rc = audit(path)
    out = json.loads(capsys.readouterr().out)
    assert rc == 1
    assert len(out["duplicate_urls"]) == 1


def test_audit_does_not_flag_distinct_postings(tmp_path, capsys):
    seen = {
        "acme_director-ai-strategy": {
            "company": "Acme", "title": "Director, AI Strategy",
            "url": "https://www.linkedin.com/jobs/view/123?currentJobId=123",
        },
        "beta_vp-transformation": {
            "company": "Beta", "title": "VP Transformation",
            "url": "https://www.linkedin.com/jobs/view/456?currentJobId=456",
        },
    }
    path = write_state(tmp_path, seen)
    rc = audit(path)
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert out["duplicate_urls"] == {}
