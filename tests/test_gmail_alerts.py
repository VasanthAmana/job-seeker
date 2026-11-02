"""Link extraction and classification from fixture alert emails.

No network: every test feeds a saved messages.get resource through the pure
half of gmail_alerts (record_from_message / build_query / classify_link).
"""

import json

import pytest

import gmail_alerts
from conftest import FIXTURES


@pytest.fixture()
def config():
    return gmail_alerts.load_config(gmail_alerts.DEFAULT_CONFIG)


def load_fixture(name):
    return json.loads((FIXTURES / "gmail" / name).read_text(encoding="utf-8"))


def links_by_url(record):
    return {link["url"]: link for link in record["links"]}


def test_linkedin_alert_extracts_posting_links(config):
    record = record_from = gmail_alerts.record_from_message(load_fixture("linkedin_alert.json"), config)
    assert record["source"] == "linkedin"
    assert record["id"] == "18f2a1"
    urls = links_by_url(record)
    assert "https://www.linkedin.com/comm/jobs/view/3987654321" in urls
    assert "https://www.linkedin.com/comm/jobs/view/3987654322" in urls
    # The duplicate link to the same posting collapses to one entry.
    assert len([u for u in urls if "3987654321" in u]) == 1
    assert urls["https://www.linkedin.com/comm/jobs/view/3987654321"]["kind"] == "linkedin"
    assert urls["https://www.linkedin.com/comm/jobs/view/3987654321"]["anchor"] == "Director, AI Strategy"


def test_unsubscribe_and_help_links_dropped(config):
    record = gmail_alerts.record_from_message(load_fixture("linkedin_alert.json"), config)
    assert not any("unsubscribe" in link["url"].lower() for link in record["links"])
    assert not any("/help" in link["url"].lower() for link in record["links"])


def test_indeed_alert(config):
    record = gmail_alerts.record_from_message(load_fixture("indeed_alert.json"), config)
    assert record["source"] == "indeed"
    urls = links_by_url(record)
    assert urls["https://www.indeed.com/viewjob?jk=f1a2b3c4d5e6f708"]["kind"] == "indeed"
    assert not any("preferences" in u for u in urls)


def test_plain_text_ladders_alert(config):
    record = gmail_alerts.record_from_message(load_fixture("ladders_alert.json"), config)
    assert record["source"] == "ladders"
    urls = links_by_url(record)
    assert any(u.startswith("https://www.theladders.com/job/") for u in urls)
    assert not any("preferences" in u for u in urls)


def test_employer_alert_classifies_ats_link(config):
    record = gmail_alerts.record_from_message(load_fixture("employer_alert.json"), config)
    assert record["source"] == "employer"
    urls = links_by_url(record)
    posting = "https://fabrikam.wd1.myworkdayjobs.com/en-US/Careers/job/Denver-CO/Director-AI-Transformation_R0123456"
    assert urls[posting]["kind"] == "employer"


def test_build_query_covers_senders_domains_keywords_and_window(config):
    query = gmail_alerts.build_query(config, 7)
    assert "from:jobs-noreply@linkedin.com" in query
    assert "from:alert@indeed.com" in query
    assert "from:fabrikam.example" in query
    assert 'subject:"job alert"' in query
    assert "newer_than:7d" in query
    query14 = gmail_alerts.build_query(config, 14)
    assert "newer_than:14d" in query14


def test_build_query_rejects_empty_config():
    with pytest.raises(ValueError):
        gmail_alerts.build_query(
            {"senders": {}, "subject_keywords": [], "employer_domains": [],
             "posting_host_patterns": {}, "ignore_url_markers": []}, 7)


def test_classify_link_mailto_and_ignores(config):
    assert gmail_alerts.classify_link("mailto:jobs@example.com", config) is None
    assert gmail_alerts.classify_link("https://www.linkedin.com/legal/privacy-policy", config) is None
    assert gmail_alerts.classify_link("https://boards.greenhouse.io/acme/jobs/123", config) == "employer"
    assert gmail_alerts.classify_link("https://example.com/careers/director-ai", config) == "other"


def test_scope_refusal(monkeypatch, tmp_path):
    """A send-only token is refused before any Gmail call."""
    (tmp_path / "gcp-oauth.keys.json").write_text(json.dumps(
        {"installed": {"client_id": "x", "client_secret": "y"}}), encoding="utf-8")
    (tmp_path / "credentials.json").write_text(json.dumps(
        {"refresh_token": "z", "scope": "https://www.googleapis.com/auth/gmail.send"}), encoding="utf-8")
    with pytest.raises(RuntimeError, match="read-only"):
        gmail_alerts._access_token(tmp_path)


def test_extract_command_offline(config, tmp_path, capsys):
    rc = gmail_alerts.main(["extract", "--message-json", str(FIXTURES / "gmail" / "linkedin_alert.json")])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["source"] == "linkedin"
    assert out["links"]
