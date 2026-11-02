"""Reading the candidate profile: what counts as a source, and what never does."""

import profile_sources
from conftest import FIXTURES


def facts():
    return profile_sources.load_profile(FIXTURES / "candidate-profile.md")


def test_profile_is_only_read_never_written():
    before = (FIXTURES / "candidate-profile.md").read_bytes()
    facts()
    assert (FIXTURES / "candidate-profile.md").read_bytes() == before


def test_name_and_affiliations_come_from_the_profile():
    parsed = facts()
    assert parsed.name == "Dana Okonkwo"
    assert parsed.affiliations == ("Globex Corp", "Initech")


def test_every_declared_source_is_classified():
    kinds = {ref.kind: ref.ref for ref in facts().sources}
    assert kinds["github"] == "dokonkwo"
    assert kinds["linkedin"] == "https://www.linkedin.com/in/dana-okonkwo/"
    assert kinds["scholar"].startswith("https://scholar.example-test.invalid/")
    assert kinds["press"] == "https://news.example-test.invalid/dana-okonkwo-ai-strategy"
    # /speakers/ in the path is enough to file an unlabelled URL as a talk.
    assert kinds["talks"] == "https://summit.example-test.invalid/speakers/dana-okonkwo"
    assert "site" not in kinds


def test_a_labelled_url_is_not_also_filed_as_a_generic_site():
    refs = [ref for ref in facts().sources
            if ref.ref == "https://news.example-test.invalid/dana-okonkwo-ai-strategy"]
    assert [ref.kind for ref in refs] == ["press"]


def test_fill_placeholders_are_not_sources():
    parsed = profile_sources.parse_profile(
        "- **Name:** [FILL]\n- **GitHub:** [FILL - handle]\n- **LinkedIn:** [FILL]\n")
    assert parsed.name == ""
    assert parsed.sources == ()


def test_a_missing_profile_is_empty_facts_not_an_error(tmp_path):
    parsed = profile_sources.load_profile(tmp_path / "nope.md")
    assert parsed.sources == ()
    assert parsed.name == ""


def test_an_unlabelled_url_with_no_hint_is_a_generic_site():
    ref = profile_sources.classify_url("https://dana.example-test.invalid/about")
    assert (ref.kind, ref.ref) == ("site", "https://dana.example-test.invalid/about")


def test_board_pages_are_recognised_from_the_path():
    ref = profile_sources.classify_url("https://foundation.example-test.invalid/advisory-board")
    assert ref.kind == "board"


def test_github_org_paths_are_not_read_as_usernames():
    assert profile_sources.classify_url("https://github.com/topics/ai") is None
    ref = profile_sources.classify_url("https://github.com/dokonkwo/aurora-ledger")
    assert (ref.kind, ref.ref) == ("github", "dokonkwo")
