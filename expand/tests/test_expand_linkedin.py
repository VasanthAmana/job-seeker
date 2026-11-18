"""LinkedIn: the jobseek tool path when it is there, the web path when it is not.

`linkedin/client.py` ships on a different branch, so both paths are
exercised with stand-ins here: a fake client module for path 1, and the
fixture fetcher for path 2. No test imports the real client or runs the app.
"""

import types

import linkedin_source
from conftest import LINKEDIN_URL, fixture_reader

PEOPLE = {
    "count": 2,
    "people": [
        {"name": "Dana Okonkwo", "headline": "VP, AI Strategy at Globex Corp",
         "location": "Denver, CO", "profileUrl": "https://www.linkedin.com/in/dana-okonkwo/"},
        {"name": "Dana Okonkwo", "headline": "Barista", "location": "Elsewhere",
         "profileUrl": "https://www.linkedin.com/in/dana-okonkwo-2/"},
    ],
}


class _NeedsYou(RuntimeError):
    pass


def fake_client(people=PEOPLE, status_error=None, search_error=None):
    def status():
        if status_error:
            raise status_error
        return {"signedIn": True}

    def search_people(query, limit=None):
        if search_error:
            raise search_error
        return people

    return types.SimpleNamespace(status=status, search_people=search_people)


def no_client():
    return None


def test_the_tool_path_is_preferred_when_the_client_is_present():
    signals, reports, _review = linkedin_source.scan(
        LINKEDIN_URL, name="Dana Okonkwo", client=fake_client(),
        reader=fixture_reader({LINKEDIN_URL: "linkedin_wall.html"}))
    assert reports[0].status == "scanned"
    assert "jobseek LinkedIn tool" in reports[0].verdict
    assert "LinkedIn headline: VP, AI Strategy at Globex Corp" in [s.item for s in signals]


def test_the_match_is_made_on_the_profile_slug_not_the_first_namesake():
    signals, _reports, _review = linkedin_source.scan(
        LINKEDIN_URL, name="Dana Okonkwo", client=fake_client(
            {"people": list(reversed(PEOPLE["people"]))}),
        reader=fixture_reader({}))
    assert any("VP, AI Strategy at Globex Corp" in s.item for s in signals)
    assert not any("Barista" in s.item for s in signals)


def test_an_executive_headline_is_labelled_as_inference_not_as_a_title():
    signals, _reports, _review = linkedin_source.scan(
        LINKEDIN_URL, name="Dana Okonkwo", client=fake_client(), reader=fixture_reader({}))
    inferred = next(s for s in signals if s.basis == "B")
    assert inferred.item == "Publicly positioned at executive/leadership level"
    assert "VP, AI Strategy at Globex Corp" in inferred.evidence


def test_a_sign_in_wall_falls_back_to_the_web_path_and_says_why():
    signals, reports, review = linkedin_source.scan(
        LINKEDIN_URL, name="Dana Okonkwo",
        client=fake_client(status_error=_NeedsYou("LinkedIn needs you: app not running")),
        reader=fixture_reader({}))
    assert signals == []
    assert reports[0].status == "skipped"
    assert "LinkedIn needs you" in reports[0].reason
    assert "robots.txt does not permit" in reports[0].reason
    assert any("blocks unauthenticated fetching" in note for note in review)


def test_no_match_in_the_people_search_is_not_guessed_around():
    signals, reports, _review = linkedin_source.scan(
        LINKEDIN_URL, name="Dana Okonkwo",
        client=fake_client({"people": [{"name": "Someone Else",
                                        "profileUrl": "https://www.linkedin.com/in/someone-else/"}]}),
        reader=fixture_reader({}))
    assert signals == []
    assert "none matching the profile URL" in reports[0].reason


def test_without_the_client_file_the_reason_says_so():
    _signals, reports, _review = linkedin_source.scan(
        LINKEDIN_URL, name="Dana Okonkwo", client_loader=no_client, reader=fixture_reader({}))
    assert "client.py is not present in this checkout" in reports[0].reason


def test_a_readable_public_page_is_marked_as_a_logged_out_teaser():
    signals, reports, review = linkedin_source.scan(
        LINKEDIN_URL, name="Dana Okonkwo", client_loader=no_client,
        reader=fixture_reader({LINKEDIN_URL: "linkedin_wall.html"}))
    assert reports[0].status == "scanned"
    assert any("logged-out teaser" in note for note in review)
    assert all(s.source_label == "LinkedIn (public page fetch)" for s in signals)


def test_load_client_returns_none_when_the_branch_is_absent(monkeypatch, tmp_path):
    monkeypatch.setattr(linkedin_source, "CLIENT_PATH", tmp_path / "client.py")
    assert linkedin_source.load_client() is None
