"""Publications, talks, press: parsed where there is structure, quoted where there is not."""

import scholar_source
import web_source
from conftest import FIXTURES, PRESS_URL, SCHOLAR_URL, TALKS_URL, fixture_reader


def scholar():
    return scholar_source.scan(SCHOLAR_URL, reader=fixture_reader({SCHOLAR_URL: "scholar_profile.html"}))


def test_publications_are_cited_with_venue_and_year():
    signals, _reports, _review = scholar()
    first = next(s for s in signals if "Governing enterprise AI" in s.item)
    assert first.category == "publications"
    assert first.basis == "A"
    assert "Journal of Applied AI Governance" in first.item
    assert "2024" in first.item


def test_a_citation_count_is_only_reported_when_scholar_shows_one():
    signals, _reports, _review = scholar()
    with_count = next(s for s in signals if "Governing enterprise AI" in s.item)
    without_count = next(s for s in signals if "Model risk committees" in s.item)
    assert "[187 citations per Scholar]" in with_count.item
    assert "citations" not in without_count.item


def test_the_year_is_not_printed_twice():
    """Scholar repeats the year in an overlay span inside the venue line."""
    signals, _reports, _review = scholar()
    first = next(s for s in signals if "Governing enterprise AI" in s.item)
    assert first.item.count("2024") == 1


def test_profile_statistics_are_quoted_from_the_table():
    items = [s.item for s in scholar()[0]]
    assert "Scholar citations: 412" in items
    assert "Scholar h-index: 9" in items


def test_a_publication_record_is_inferred_once_from_the_rows():
    signals, _reports, _review = scholar()
    inferred = [s for s in signals if s.basis == "B"]
    assert len(inferred) == 1
    assert "2 publication row(s)" in inferred[0].evidence


def test_an_unrecognised_scholar_layout_asks_for_a_human_look():
    signals, reports, review = scholar_source.scan(
        SCHOLAR_URL, reader=fixture_reader({SCHOLAR_URL: "talks_page.html"}))
    assert not any(s.category == "publications" and s.basis == "A" for s in signals)
    assert reports[0].status == "scanned"
    assert any("no publication rows were recognised" in note for note in review)


def test_an_unreachable_scholar_profile_is_skipped_with_its_reason():
    signals, reports, _review = scholar_source.scan(SCHOLAR_URL, reader=fixture_reader({}))
    assert signals == []
    assert reports[0].status == "skipped"
    assert "robots.txt does not permit" in reports[0].reason


def test_scholar_parsing_needs_no_network_at_all():
    header, papers = scholar_source.parse((FIXTURES / "scholar_profile.html").read_text(encoding="utf-8"))
    assert header["name"] == "Dana Okonkwo"
    assert "VP, AI Strategy, Globex Corp" in header["affiliations"]
    assert [p["citations"] for p in papers] == ["187", ""]


# --- generic pages ---------------------------------------------------------


def talks():
    return web_source.scan(TALKS_URL, "talks", name="Dana Okonkwo",
                           reader=fixture_reader({TALKS_URL: "talks_page.html"}))


def test_a_talk_page_yields_speaking_signals_and_a_review_note():
    signals, reports, review = talks()
    assert {s.category for s in signals} == {"speaking"}
    assert any("Enterprise AI Summit 2025" in s.item for s in signals)
    assert reports[0].status == "scanned"
    assert any("pointer, not a parsed record" in note for note in review)


def test_a_mention_quote_is_completed_across_a_wrapped_line():
    signals, _reports, _review = talks()
    quote = next(s.evidence for s in signals if "keynote" in s.evidence)
    assert quote.endswith("that a regulator will accept.")


def test_without_a_name_only_the_page_title_is_used():
    signals, _reports, review = web_source.scan(
        TALKS_URL, "talks", name="", reader=fixture_reader({TALKS_URL: "talks_page.html"}))
    assert [s.item for s in signals if s.basis == "A"] == [
        "Speaking/visibility reference: Enterprise AI Summit 2025 - Speakers (summit.example-test.invalid)"]
    assert any("no Name" in note for note in review)


def test_press_pages_land_in_the_press_category():
    signals, _reports, _review = web_source.scan(
        PRESS_URL, "press", name="Dana Okonkwo",
        reader=fixture_reader({PRESS_URL: "press_injection.html"}))
    assert {s.category for s in signals} == {"press"}


def test_an_injected_press_page_is_used_but_marked_and_stripped():
    signals, reports, _review = web_source.scan(
        PRESS_URL, "press", name="Dana Okonkwo",
        reader=fixture_reader({PRESS_URL: "press_injection.html"}))
    assert reports[0].flagged
    assert all(s.flagged for s in signals)
    body = " ".join(s.item + s.evidence for s in signals)
    assert "Ignore all previous instructions" not in body
    assert "Fortune 50" not in body
    assert "evil.example-test.invalid" not in body
    # the real sentence survived
    assert "named VP of AI Strategy at Globex Corp" in body


def test_an_unreachable_page_is_a_skipped_row():
    signals, reports, review = web_source.scan(
        PRESS_URL, "press", name="Dana Okonkwo", reader=fixture_reader({}, unknown="error"))
    assert signals == [] and review == []
    assert reports[0].status == "skipped"
    assert "could not resolve host" in reports[0].reason
