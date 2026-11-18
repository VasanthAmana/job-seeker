"""GitHub discovery: every public repo, honest attribution, no fabrication."""

import github_source
from conftest import GITHUB_PAGES, GITHUB_REPOS, GITHUB_USER, fixture_reader


def scan(pages=None):
    return github_source.scan("dokonkwo", reader=fixture_reader(pages or GITHUB_PAGES))


def items(signals, basis=None):
    return [s.item for s in signals if basis is None or s.basis == basis]


def test_profile_fields_are_cited_verbatim():
    signals, _reports, _review = scan()
    assert any(s.item.startswith("GitHub bio:") and s.basis == "A" for s in signals)
    assert "GitHub profile lists affiliation: Globex Corp" in items(signals)
    # The repo count is the number GitHub printed, never a derived one.
    assert "4 public repositories on GitHub" in items(signals)


def test_an_executive_bio_lands_in_the_leadership_category():
    signals, _reports, _review = scan()
    bio = next(s for s in signals if s.item.startswith("GitHub bio:"))
    assert bio.category == "strategic-leadership"


def test_every_non_fork_repo_is_scanned_not_just_pinned_ones():
    signals, _reports, _review = scan()
    assert 'Public repository "aurora-ledger" - Model-risk ledger' in " ".join(items(signals))
    assert 'Public repository "governance-playbook"' in " ".join(items(signals))


def test_forks_and_archived_repos_are_skipped_and_said_so():
    signals, _reports, review = scan()
    joined = " ".join(items(signals))
    assert "someone-elses-tool" not in joined
    assert "retired-experiment" not in joined
    assert any("fork(s) or archived" in note for note in review)


def test_language_and_topics_are_labelled_as_inference():
    signals, _reports, _review = scan()
    language = next(s for s in signals if s.item == "Hands-on familiarity with Python")
    assert language.basis == "B"
    assert "primary language of aurora-ledger" in language.evidence
    assert "Domain exposure: ai governance" in items(signals, "B")


def test_readme_contributes_a_quoted_summary_and_inferred_tools():
    signals, _reports, _review = scan()
    summary = next(s for s in signals if s.item.startswith('Project "aurora-ledger"'))
    assert summary.basis == "A"
    assert summary.source_url.endswith("/aurora-ledger/main/README.md")
    assert "Working familiarity with PyTorch" in items(signals, "B")
    assert "Working familiarity with MLflow" in items(signals, "B")


def test_an_injected_readme_line_never_becomes_a_proposal():
    signals, reports, _review = scan()
    # Only the README carried the payload; the repo's own metadata was clean,
    # so the flag follows the page it came from rather than the repository.
    playbook = [s for s in signals if s.source_url.endswith("governance-playbook/main/README.md")]
    assert playbook, "the README was read"
    for signal in playbook:
        assert "Ignore all previous instructions" not in signal.item
        assert "Ignore all previous instructions" not in signal.evidence
        assert "board experience" not in signal.item
        # ...and the source it came from is marked, not silently used.
        assert signal.flagged
    readme = next(r for r in reports if r.ref.endswith("governance-playbook/main/README.md"))
    assert readme.flagged and "⚠" in readme.verdict


def test_an_unreadable_profile_is_one_skipped_row_not_an_exception():
    signals, reports, _review = github_source.scan("dokonkwo", reader=fixture_reader({}))
    assert signals == []
    assert [(r.kind, r.status) for r in reports] == [("github", "skipped")]
    assert "robots.txt does not permit" in reports[0].reason


def test_a_missing_repo_list_does_not_lose_the_profile_signals():
    pages = {k: v for k, v in GITHUB_PAGES.items() if k != GITHUB_REPOS}
    signals, reports, _review = github_source.scan("dokonkwo", reader=fixture_reader(pages))
    assert any(s.item == "4 public repositories on GitHub" for s in signals)
    skipped = [r for r in reports if r.status == "skipped"]
    assert any("robots" in r.reason for r in skipped)


def test_a_non_json_response_is_reported_as_such():
    signals, reports, _review = github_source.scan(
        "dokonkwo", reader=fixture_reader({GITHUB_USER: "talks_page.html"}))
    assert signals == []
    assert "not JSON" in reports[0].reason


def test_a_github_api_error_body_is_not_read_as_an_empty_profile(tmp_path):
    """GitHub answers 404 and a rate-limit 403 with valid JSON."""
    error = tmp_path / "gh_error.json"
    error.write_text('{"message": "API rate limit exceeded for 203.0.113.7",'
                     ' "documentation_url": "https://docs.github.com/"}', encoding="utf-8")

    def reader(url, mode="html"):
        import read_source
        return read_source.read_url(url, mode, fetcher=lambda u, out: (
            out.write_bytes(error.read_bytes()), (0, "HTTP 403"))[1])

    signals, reports, _review = github_source.scan("dokonkwo", reader=reader)
    assert signals == []
    assert reports[0].status == "skipped"
    assert "API rate limit exceeded" in reports[0].reason
