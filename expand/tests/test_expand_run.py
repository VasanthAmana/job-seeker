"""The whole run: one clean discovery pass, and the rules it must never break."""

import json

import expand_profile
import pytest
from competency_map import CATEGORY_HEADINGS, CompetencyMap, cited, inferred
from conftest import ALL_PAGES, FIXTURES, GITHUB_PAGES, fixture_reader

PROFILE = FIXTURES / "candidate-profile.md"


def no_linkedin_client():
    """Stand in for a checkout without linkedin/client.py.

    The default loader reads that file off disk and would then try the live
    app's local socket, which makes the result depend on whether the owner
    happens to have the app running. Every whole-run test here pins the
    LinkedIn path instead; test_expand_linkedin.py covers both real paths.
    """
    return None


def run(tmp_path, **kwargs):
    kwargs.setdefault("reader", fixture_reader(ALL_PAGES))
    kwargs.setdefault("cfg", {})
    kwargs.setdefault("linkedin_client_loader", no_linkedin_client)
    return expand_profile.run(profile=PROFILE, out=tmp_path,
                              generated_at="2026-11-02T00:00:00Z", **kwargs)


def proposals(summary):
    from pathlib import Path
    return Path(summary["proposals_path"]).read_text(encoding="utf-8")


# --- the clean run ---------------------------------------------------------


def test_a_clean_run_writes_a_proposals_file_with_every_category_used(tmp_path):
    summary = run(tmp_path)
    text = proposals(summary)
    assert summary["proposals_path"].endswith("expand-proposals.md")
    assert text.startswith("# Profile expansion proposals - PROPOSED, NOT YET APPLIED")
    assert "2026-11-02T00:00:00Z" in text
    for key, heading in CATEGORY_HEADINGS.items():
        if summary["signals_by_category"].get(key):
            assert f"## {heading}" in text


def test_every_proposal_carries_a_basis_label_and_a_source_url(tmp_path):
    text = proposals(run(tmp_path))
    bullets = [line for line in text.splitlines() if line.startswith("- **[")]
    assert bullets
    for bullet in bullets:
        assert bullet.startswith(("- **[A]**", "- **[B]**", "- **[A+B]**"))
    # every bullet is followed, within its block, by a source line
    assert text.count("  - source: ") == len(bullets)


def test_signals_are_grouped_by_the_executive_categories(tmp_path):
    summary = run(tmp_path)
    assert set(summary["signals_by_category"]) <= set(CATEGORY_HEADINGS)
    assert summary["signals_by_category"]["publications"] >= 2
    assert summary["signals_by_category"]["technical-depth"] >= 5
    assert summary["signals_by_category"]["press"] >= 1


def test_the_summary_reports_what_each_source_yielded(tmp_path):
    summary = run(tmp_path)
    scanned = {row["ref"]: row for row in summary["sources_scanned"]}
    assert scanned["https://github.com/dokonkwo"]["signals"] == 3
    assert all("integrity_gate" in row for row in summary["sources_scanned"])
    assert sum(row["signals"] for row in summary["sources_scanned"]) >= summary["signals_total"]


def test_the_summary_is_json_serialisable_like_the_other_mcp_tools(tmp_path):
    summary = run(tmp_path)
    assert json.loads(json.dumps(summary)) == summary
    # the map itself is the file, not the return value
    assert "signals" not in summary


# --- what it must never do ------------------------------------------------


def test_the_candidate_profile_is_never_written(tmp_path):
    before = PROFILE.read_bytes()
    run(tmp_path)
    assert PROFILE.read_bytes() == before


def test_writing_anywhere_but_the_proposals_filename_is_refused(tmp_path):
    for name in ("candidate-profile.md", "job-evaluation.md", "writing-style.md", "notes.md"):
        with pytest.raises(expand_profile.ExpandError) as exc:
            expand_profile.run(profile=PROFILE, out=tmp_path / name, cfg={},
                               reader=fixture_reader(ALL_PAGES))
        assert "never edits candidate-profile.md" in str(exc.value)
        assert not (tmp_path / name).exists()


def test_a_refused_target_is_refused_before_anything_is_fetched(tmp_path):
    def explode(url, mode="html"):
        raise AssertionError("no source may be read once the target is refused")

    with pytest.raises(expand_profile.ExpandError):
        expand_profile.run(profile=PROFILE, out=tmp_path / "candidate-profile.md",
                           cfg={}, reader=explode)


def test_no_hidden_payload_reaches_the_proposals_file(tmp_path):
    text = proposals(run(tmp_path))
    assert "Ignore all previous instructions" not in text
    assert "evil.example-test.invalid" not in text
    assert "Fortune 50" not in text
    assert "board of a Fortune" not in text
    # the flagged source is still named, with the gate's own verdict
    assert "⚠ flagged source" in text
    assert "instruction-like lines" in text


def test_a_flagged_source_is_listed_in_the_summary(tmp_path):
    summary = run(tmp_path)
    flagged = {row["ref"] for row in summary["flagged_sources"]}
    assert "https://news.example-test.invalid/dana-okonkwo-ai-strategy" in flagged


# --- skipped sources -------------------------------------------------------


def test_an_unreachable_source_is_reported_not_silently_dropped(tmp_path):
    summary = run(tmp_path, reader=fixture_reader(GITHUB_PAGES))
    skipped = {row["kind"]: row["reason"] for row in summary["sources_skipped"]}
    assert "robots.txt does not permit" in skipped["scholar"]
    assert "robots.txt does not permit" in skipped["press"]
    assert "robots.txt does not permit" in skipped["talks"]
    text = proposals(summary)
    assert "## Sources skipped" in text
    for kind in ("scholar", "press", "talks"):
        assert f"| {kind} |" in text


def test_a_source_type_with_no_handle_in_the_profile_says_so(tmp_path):
    summary = run(tmp_path)
    board = next(row for row in summary["sources_skipped"] if row["kind"] == "board")
    assert "no handle or URL for this source type" in board["reason"]


def test_linkedin_without_the_client_is_skipped_honestly(tmp_path):
    summary = run(tmp_path)
    linkedin = next(row for row in summary["sources_skipped"] if row["kind"] == "linkedin")
    assert "client.py is not present in this checkout" in linkedin["reason"]
    assert "robots.txt does not permit" in linkedin["reason"]


def test_linkedin_with_the_client_but_no_running_app_is_skipped_honestly(tmp_path):
    """The shipped path: linkedin/client.py exists, the app does not."""
    import types

    def loader():
        def status():
            raise RuntimeError("LinkedIn needs you: the linkedin-mcp app isn't running")
        return types.SimpleNamespace(status=status, search_people=None)

    summary = run(tmp_path, linkedin_client_loader=loader)
    linkedin = next(row for row in summary["sources_skipped"] if row["kind"] == "linkedin")
    assert "LinkedIn needs you" in linkedin["reason"]
    assert "robots.txt does not permit" in linkedin["reason"]
    # the rest of the run is unaffected
    assert summary["signals_total"] > 0


def test_linkedin_through_the_jobseek_tool_lands_in_the_proposals(tmp_path):
    import types

    def loader():
        return types.SimpleNamespace(
            status=lambda: {"signedIn": True},
            search_people=lambda query, limit=None: {"people": [{
                "name": "Dana Okonkwo",
                "headline": "VP, AI Strategy at Globex Corp",
                "profileUrl": "https://www.linkedin.com/in/dana-okonkwo/",
            }]})

    summary = run(tmp_path, linkedin_client_loader=loader)
    scanned = {row["kind"]: row for row in summary["sources_scanned"]}
    assert "linkedin" in scanned
    assert "jobseek LinkedIn tool" in scanned["linkedin"]["integrity_gate"]
    assert "LinkedIn headline: VP, AI Strategy at Globex Corp" in proposals(summary)


def test_one_exploding_source_does_not_fail_the_run(tmp_path, monkeypatch):
    def boom(url, reader=None):
        raise RuntimeError("scholar parser fell over")

    monkeypatch.setattr(expand_profile.scholar_source, "scan", boom)
    summary = run(tmp_path)
    scholar = next(row for row in summary["sources_skipped"] if row["kind"] == "scholar")
    assert "scholar parser fell over" in scholar["reason"]
    assert summary["signals_total"] > 0


# --- narrowing and re-runs -------------------------------------------------


def test_sources_narrows_the_scan(tmp_path):
    summary = run(tmp_path, sources=["github"])
    assert summary["sources_requested"] == ["github"]
    assert {row["kind"] for row in summary["sources_scanned"]} == {"github"}
    assert summary["sources_skipped"] == []


def test_an_unknown_source_type_is_rejected(tmp_path):
    with pytest.raises(expand_profile.ExpandError) as exc:
        run(tmp_path, sources=["twitter"])
    assert "unknown source type 'twitter'" in str(exc.value)


def test_a_rerun_overwrites_rather_than_appending(tmp_path):
    first = proposals(run(tmp_path))
    second = proposals(run(tmp_path))
    assert first == second


def test_extra_urls_from_config_are_scanned(tmp_path):
    url = "https://news.example-test.invalid/dana-okonkwo-ai-strategy"
    summary = run(tmp_path, sources=["board"],
                  cfg={"expand": {"extra_sources": [{"kind": "board", "url": url}]}})
    assert [row["kind"] for row in summary["sources_scanned"]] == ["board"]
    assert "Board & Advisory Roles" in proposals(summary)


def test_extra_urls_from_the_cli_are_scanned(tmp_path):
    url = "https://summit.example-test.invalid/speakers/dana-okonkwo"
    summary = run(tmp_path, sources=["board"], extra_urls=[("board", url)])
    assert [row["kind"] for row in summary["sources_scanned"]] == ["board"]


# --- the map itself --------------------------------------------------------


def test_the_same_item_seen_both_ways_merges_into_one_a_plus_b_entry():
    cmap = CompetencyMap()
    cmap.add(cited("publications", "Keynote at the AI Summit", "quoted", "https://x.invalid", "x"))
    cmap.add(inferred("publications", "Keynote at the AI Summit", "reasoned", "https://x.invalid", "x"))
    assert len(cmap.signals) == 1
    assert cmap.signals[0].basis == "A+B"
    assert cmap.signals[0].evidence == "quoted"


def test_duplicate_items_are_not_repeated():
    cmap = CompetencyMap()
    for _ in range(3):
        cmap.add(cited("press", "Named in the Review", "quoted", "https://x.invalid", "x"))
    assert len(cmap.signals) == 1


def test_a_signal_cannot_name_a_category_that_does_not_exist():
    with pytest.raises(Exception):
        cited("vibes", "something", "evidence", "https://x.invalid", "x")


# --- the CLI ---------------------------------------------------------------


def test_the_cli_refuses_a_bad_target_with_exit_2(tmp_path, capsys):
    code = expand_profile.main(["--profile", str(PROFILE), "--out", str(tmp_path / "candidate-profile.md")])
    assert code == 2
    assert "refusing to write" in capsys.readouterr().err
