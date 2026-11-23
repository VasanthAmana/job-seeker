"""The source registry (F3): a single place that registers a source id,
read by alert_state's store validation and gmail_alerts' config loading -
instead of each hard-coding its own copy of the same closed set."""

import json

import pytest

import alert_state
import gmail_alerts
from sources import registry


def test_registry_has_the_existing_sources_unchanged():
    assert registry.SOURCE_IDS == ("linkedin", "indeed", "ladders", "employer", "christiantechjobs", "other")


def test_alert_state_sources_is_the_registry_not_its_own_copy():
    assert alert_state.SOURCES is registry.SOURCE_IDS


def test_is_registered():
    assert registry.is_registered("linkedin")
    assert not registry.is_registered("naukri")


def test_store_validates_against_the_registry(tmp_path):
    """A source the registry doesn't know stays rejected (store still
    enforces a closed set - just one defined in one place, not three)."""
    job = {
        "title": "Director, AI Strategy", "company": "Acme Corp",
        "url": "https://example.com/jobs/1", "source": "naukri",
        "first_seen": "2026-11-02", "status": "new",
    }
    results = tmp_path / "results.json"
    results.write_text(json.dumps([job]), encoding="utf-8")
    rc = alert_state.main([
        "store", "--results", str(results),
        "--state", str(tmp_path / "state" / "seen_jobs.json"),
        "--tracker", str(tmp_path / "tracker.csv"),
    ])
    assert rc == 1


def test_gmail_alerts_config_no_longer_repeats_the_registered_senders():
    """alert-sources.json (fixes F3) should point at the registry rather
    than hard-coding each portal's sender addresses / host patterns."""
    raw = json.loads(gmail_alerts.DEFAULT_CONFIG.read_text(encoding="utf-8"))
    assert "senders" not in raw
    assert "posting_host_patterns" not in raw


def test_load_config_merges_registered_senders_and_patterns():
    config = gmail_alerts.load_config(gmail_alerts.DEFAULT_CONFIG)
    assert config["senders"]["linkedin"] == list(registry.REGISTRY["linkedin"].senders)
    assert config["posting_host_patterns"]["employer"] == list(
        registry.REGISTRY["employer"].posting_host_patterns
    )
    # Owner-specific fields the registry can't know still come from the file.
    assert "woodgrovebank.example" in config["employer_domains"]


def test_load_config_lets_the_file_override_a_registered_source(tmp_path):
    custom = tmp_path / "alert-sources.json"
    custom.write_text(json.dumps({
        "senders": {"indeed": ["custom@indeed.example"]},
        "subject_keywords": [], "employer_domains": [], "ignore_url_markers": [],
    }), encoding="utf-8")
    config = gmail_alerts.load_config(custom)
    assert config["senders"]["indeed"] == ["custom@indeed.example"]
    # Sources the override didn't touch still come from the registry.
    assert config["senders"]["linkedin"] == list(registry.REGISTRY["linkedin"].senders)


def test_load_config_still_requires_owner_specific_fields(tmp_path):
    incomplete = tmp_path / "alert-sources.json"
    incomplete.write_text(json.dumps({"subject_keywords": [], "ignore_url_markers": []}), encoding="utf-8")
    with pytest.raises(ValueError, match="employer_domains"):
        gmail_alerts.load_config(incomplete)
