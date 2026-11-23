"""ChristianTechJobs RSS source: feed parsing and the poll-state machine.

No network: every parsing test feeds a saved RSS fixture through the pure
half of christiantechjobs_alerts (parse_feed / candidates_from_xml). The poll
tests exercise fetch_and_poll with urllib monkeypatched - still no network.
"""

import json
import urllib.error

import christiantechjobs_alerts as ctj
from conftest import FIXTURES


def load_fixture(name):
    return (FIXTURES / "christiantechjobs" / name).read_text(encoding="utf-8")


def links_by_url(result):
    return {link["url"]: link for link in result["links"]}


def test_parses_four_items_with_company_and_location():
    result = ctj.candidates_from_xml(load_fixture("feed.xml"), today="2026-11-22")
    assert result["jobs"] == 4
    assert not result["errors"]
    urls = links_by_url(result)
    remote_job = urls["https://www.christiantechjobs.io/christian-jobs/remote-oracle-cloud-applications-developer-fusion-lifeway-1901"]
    assert remote_job["title"] == "Oracle Cloud Applications Developer-Fusion"
    assert remote_job["company"] == "Lifeway"
    assert remote_job["location"] == "Remote"
    assert remote_job["source"] == "christiantechjobs"
    assert remote_job["alert_date"] == "2026-11-22"
    assert remote_job["posted_date"] == "2026-11-20"
    assert remote_job["message_id"] == "ctj:" + remote_job["url"]


def test_city_state_location_parsed():
    result = ctj.candidates_from_xml(load_fixture("feed.xml"))
    urls = links_by_url(result)
    designer = urls["https://www.christiantechjobs.io/christian-jobs/communications-designer-eastview-church-2201"]
    assert designer["company"] == "Eastview Church"
    assert designer["location"] == "Normal, IL"


def test_html_entity_in_title_and_body_decoded():
    result = ctj.candidates_from_xml(load_fixture("feed.xml"))
    urls = links_by_url(result)
    ppc = urls["https://www.christiantechjobs.io/christian-jobs/ppc-seo-specialist-grove9-3301"]
    assert ppc["title"] == "PPC & SEO Specialist"
    assert ppc["company"] == "Grove9"


def test_unrecognised_description_shape_omits_company_and_location():
    result = ctj.candidates_from_xml(load_fixture("feed.xml"))
    urls = links_by_url(result)
    odd = urls["https://www.christiantechjobs.io/christian-jobs/volunteer-coordinator-unusual-4401"]
    assert "company" not in odd
    assert "location" not in odd
    assert odd["title"] == "Volunteer Coordinator (unusual listing format)"


def test_empty_feed_is_not_an_error():
    result = ctj.candidates_from_xml(load_fixture("empty_feed.xml"))
    assert result == {"jobs": 0, "links": [], "errors": []}


def test_invalid_xml_reports_an_error_not_a_crash():
    result = ctj.candidates_from_xml("<rss><channel><item><title>broken</item></channel>")
    assert result["jobs"] == 0
    assert result["links"] == []
    assert result["errors"]


def test_parse_command_offline(capsys):
    rc = ctj.main(["parse", "--feed-xml", str(FIXTURES / "christiantechjobs" / "feed.xml")])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["jobs"] == 4


# --- poll state: minimum interval, conditional GET, graceful failure -------


class _FakeResponse:
    def __init__(self, status, body, headers):
        self.status = status
        self._body = body.encode("utf-8")
        self.headers = headers

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_first_poll_fetches_and_stores_etag(tmp_path, monkeypatch):
    def fake_urlopen(req, timeout=None, context=None):
        assert req.get_header("User-agent") == ctj.USER_AGENT
        return _FakeResponse(200, load_fixture("feed.xml"), {"ETag": '"abc123"', "Last-Modified": None})

    monkeypatch.setattr(ctj.urllib.request, "urlopen", fake_urlopen)
    state_path = tmp_path / "state.json"
    result = ctj.fetch_and_poll(state_path=state_path, now=1_000_000.0)
    assert result["fetched"] is True
    assert result["jobs"] == 4
    saved = json.loads(state_path.read_text())
    assert saved["etag"] == '"abc123"'
    assert saved["last_polled_at"] == 1_000_000.0


def test_second_poll_within_interval_is_skipped_without_a_request(tmp_path, monkeypatch):
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({"last_polled_at": 1_000_000.0}), encoding="utf-8")

    def fail_urlopen(*a, **k):
        raise AssertionError("must not fetch inside the minimum poll interval")

    monkeypatch.setattr(ctj.urllib.request, "urlopen", fail_urlopen)
    result = ctj.fetch_and_poll(state_path=state_path, now=1_000_000.0 + 60)
    assert result["fetched"] is False
    assert "waiting" in result["reason"]
    assert result["links"] == []


def test_poll_after_interval_elapses_sends_conditional_headers(tmp_path, monkeypatch):
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({
        "last_polled_at": 1_000_000.0, "etag": '"abc123"', "last_modified": "Fri, 20 Nov 2026 16:13:34 GMT",
    }), encoding="utf-8")
    seen = {}

    def fake_urlopen(req, timeout=None, context=None):
        seen["if_none_match"] = req.get_header("If-none-match")
        seen["if_modified_since"] = req.get_header("If-modified-since")
        raise urllib.error.HTTPError(req.full_url, 304, "Not Modified", {}, None)

    monkeypatch.setattr(ctj.urllib.request, "urlopen", fake_urlopen)
    result = ctj.fetch_and_poll(state_path=state_path, now=1_000_000.0 + ctj.MIN_POLL_INTERVAL_SECONDS + 1)
    assert seen["if_none_match"] == '"abc123"'
    assert seen["if_modified_since"] == "Fri, 20 Nov 2026 16:13:34 GMT"
    assert result["fetched"] is True
    assert result["jobs"] == 0
    assert "not modified" in result["reason"]


def test_network_error_is_reported_not_raised(tmp_path, monkeypatch):
    def fake_urlopen(*a, **k):
        raise OSError("name resolution failed")

    monkeypatch.setattr(ctj.urllib.request, "urlopen", fake_urlopen)
    state_path = tmp_path / "state.json"
    result = ctj.fetch_and_poll(state_path=state_path, now=1_000_000.0)
    assert result["fetched"] is False
    assert "network error" in result["reason"]
    # The failed attempt still consumes the poll slot.
    assert json.loads(state_path.read_text())["last_polled_at"] == 1_000_000.0


def test_registered_as_a_source():
    from sources import registry
    assert registry.is_registered("christiantechjobs")
