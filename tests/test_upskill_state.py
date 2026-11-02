"""The /upskill aggregate merge: dedupe, weights, skip rules, report paths.

Fixtures only - no Gmail, no network. The fixture store and tracker under
fixtures/upskill/ carry one of each case the merge has to get right:

- Acme:   ranked with recorded gaps AND a tracker row (dedupe: counts once,
          weight prefers the tracker's fit_rating)
- Beta:   ranked-only with recorded gaps
- Gamma:  ranked with an empty gaps list (a real record: no gaps found)
- Delta:  ranked before gap persistence (no gaps field: skipped + counted)
          with a tracker row (falls back to tracker-only inference)
- Epsilon: ranked below the Moderate Fit floor (excluded, counted)
- Zeta:   status "new" (not ranked: invisible to /upskill)
- Theta:  tracker-only with a fit rating (weight from fit_rating, inferred)
- Mu:     tracker row with a blank fit_rating and no ranked match
          (skipped + counted, never read as 0 = maximum weight)
"""

import json
from datetime import date
from pathlib import Path

import pytest

import upskill_state

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "upskill"
FIXTURE_SEEN = FIXTURES / "seen_jobs.json"
FIXTURE_TRACKER = FIXTURES / "tracker.csv"


def load_fixture_payload(**kwargs):
    return upskill_state.build_payload(
        state_path=FIXTURE_SEEN,
        tracker_path=FIXTURE_TRACKER,
        today=date(2026, 11, 2),
        **kwargs,
    )


# --- fit rating parsing ----------------------------------------------------


def test_parse_fit_rating_accepts_numeric_strings():
    assert upskill_state.parse_fit_rating("30") == 30.0
    assert upskill_state.parse_fit_rating(" 72.5 ") == 72.5
    assert upskill_state.parse_fit_rating(55) == 55.0


def test_parse_fit_rating_rejects_blank_garbage_and_out_of_range():
    for bad in (None, "", "  ", "n/a", "high", -1, 101, "720"):
        assert upskill_state.parse_fit_rating(bad) is None


# --- the merge over the fixtures -------------------------------------------


def test_aggregate_counts_both_sources_and_skips():
    payload = load_fixture_payload()
    assert payload["analysed"] == {"tracked": 3, "ranked": 3, "merged_total": 5}
    skipped = payload["skipped"]
    assert skipped["ranked_below_floor"] == 1  # Epsilon, score 40
    assert skipped["ranked_without_gaps"] == 1  # Delta, scored before gap persistence
    assert skipped["ranked_without_gaps_entries"][0]["company"] == "Delta"
    assert skipped["tracker_blank_fit_rating"] == 1  # Mu


def test_aggregate_dedupes_tracker_row_against_ranked_entry():
    payload = load_fixture_payload()
    acme = [j for j in payload["jobs"] if j["company"] == "Acme"]
    assert len(acme) == 1, "a job in both the tracker and the ranked pool counts once"
    job = acme[0]
    assert job["sources"] == "both"
    # The tracker's numeric fit_rating (30) beats the ranked score (80).
    assert job["weight"] == 0.7
    assert job["weight_basis"] == "fit_rating"
    # Recorded gaps from the ranked entry are the job's skill list.
    assert job["recorded_gaps"] == ["AI governance frameworks", "banking domain fluency"]
    assert job["needs_inference"] is False
    assert job["ranked"]["rank_score"] == 80


def test_aggregate_tracker_only_row_infers_and_weights_from_fit_rating():
    payload = load_fixture_payload()
    theta = next(j for j in payload["jobs"] if j["company"] == "Theta")
    assert theta["sources"] == "tracker"
    assert theta["weight"] == 0.45
    assert theta["weight_basis"] == "fit_rating"
    assert theta["needs_inference"] is True
    assert theta["recorded_gaps"] == []
    assert theta["tracker"]["sector"] == "healthcare"


def test_aggregate_ranked_only_entry_weights_from_rank_score():
    payload = load_fixture_payload()
    beta = next(j for j in payload["jobs"] if j["company"] == "Beta")
    assert beta["sources"] == "ranked"
    assert beta["weight"] == 0.5
    assert beta["weight_basis"] == "rank_score"
    assert beta["needs_inference"] is False
    assert beta["tracker"] is None


def test_aggregate_ranked_entry_whose_tracker_match_lacked_gaps_is_tracker_only():
    """Delta's ranked entry was scored before gap persistence, so it is not in
    the pool; its tracker row therefore stands alone as inference input."""
    payload = load_fixture_payload()
    delta = next(j for j in payload["jobs"] if j["company"] == "Delta")
    assert delta["sources"] == "tracker"
    assert delta["needs_inference"] is True
    assert delta["weight"] == 0.8  # (100 - 20) / 100


def test_aggregate_empty_gaps_list_is_a_record_not_a_missing_field():
    payload = load_fixture_payload()
    gamma = next(j for j in payload["jobs"] if j["company"] == "Gamma")
    assert gamma["sources"] == "ranked"
    assert gamma["recorded_gaps"] == []
    assert gamma["needs_inference"] is False, "the scorer found no gaps; do not invent any"


def test_aggregate_sorts_by_weight_descending():
    payload = load_fixture_payload()
    companies = [j["company"] for j in payload["jobs"]]
    assert companies == ["Delta", "Acme", "Beta", "Theta", "Gamma"]


def test_aggregate_blank_fit_rating_falls_back_to_matched_rank_score(tmp_path):
    """A blank fit_rating with a ranked match uses the rank_score - the one
    job the framework knows nothing about must not get the maximum weight."""
    seen = {
        "k1": {"title": "VP AI Strategy", "company": "Acme", "url": "https://a.example/1",
               "status": "ranked", "rank_score": 60, "gaps": ["board reporting"]},
    }
    rows = [{"company": "Acme", "role": "VP AI Strategy", "fit_rating": ""}]
    result = upskill_state.aggregate(seen, rows)
    job = result["jobs"][0]
    assert job["sources"] == "both"
    assert job["weight"] == 0.4
    assert job["weight_basis"] == "rank_score"
    assert result["skipped"]["tracker_blank_fit_rating"] == 0


def test_aggregate_unmatched_blank_fit_rating_is_skipped_never_zero():
    rows = [{"company": "Acme", "role": "VP AI Strategy", "fit_rating": "n/a"}]
    result = upskill_state.aggregate({}, rows)
    assert result["jobs"] == []
    assert result["skipped"]["tracker_blank_fit_rating"] == 1


# --- state file handling ----------------------------------------------------


def test_missing_state_files_are_empty_not_errors(tmp_path):
    payload = upskill_state.build_payload(
        state_path=tmp_path / "nope.json",
        tracker_path=tmp_path / "nope.csv",
        reports_dir=tmp_path,
        today=date(2026, 11, 2),
    )
    assert payload["analysed"] == {"tracked": 0, "ranked": 0, "merged_total": 0}
    assert payload["jobs"] == []
    assert payload["previous_report"] is None


def test_malformed_seen_jobs_is_an_error(tmp_path):
    bad = tmp_path / "seen_jobs.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(upskill_state.UpskillStateError):
        upskill_state.load_seen(bad)


# --- report paths ------------------------------------------------------------


def test_find_previous_report_picks_latest_aggregate_only(tmp_path):
    (tmp_path / "report-2026-09-01.md").write_text("old", encoding="utf-8")
    (tmp_path / "report-2026-10-05.md").write_text("newer", encoding="utf-8")
    # A targeted-mode report (slug suffix) never counts as the aggregate base.
    (tmp_path / "report-2026-10-20-acme-director-ai-strategy.md").write_text("targeted", encoding="utf-8")
    previous = upskill_state.find_previous_report(tmp_path)
    assert previous is not None and previous.name == "report-2026-10-05.md"


def test_build_payload_report_paths(tmp_path):
    reports = tmp_path / "upskill"
    reports.mkdir()
    (reports / "report-2026-10-01.md").write_text("previous", encoding="utf-8")
    payload = load_fixture_payload(reports_dir=reports)
    assert payload["report_path"] == str(reports / "report-2026-11-02.md")
    assert payload["previous_report"].endswith("report-2026-10-01.md")
    assert payload["profile"].endswith("profile/candidate-profile.md")
    assert payload["state_file"] == str(FIXTURE_SEEN)
    assert payload["tracker_file"] == str(FIXTURE_TRACKER)


# --- CLI ----------------------------------------------------------------------


def test_cli_aggregate_prints_the_payload(tmp_path, capsys):
    rc = upskill_state.main([
        "aggregate",
        "--state", str(FIXTURE_SEEN),
        "--tracker", str(FIXTURE_TRACKER),
        "--reports-dir", str(tmp_path),
        "--today", "2026-11-02",
    ])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["analysed"]["merged_total"] == 5
    assert payload["report_path"] == str(tmp_path / "report-2026-11-02.md")


def test_cli_floor_flag_moves_the_cutoff(tmp_path, capsys):
    rc = upskill_state.main([
        "aggregate",
        "--state", str(FIXTURE_SEEN),
        "--tracker", str(tmp_path / "empty.csv"),  # absent: no tracker rows
        "--reports-dir", str(tmp_path),
        "--floor", "55",
    ])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    companies = {j["company"] for j in payload["jobs"]}
    assert companies == {"Acme", "Gamma"}, "Beta (50) drops out at floor 55; Delta has no gaps"
    assert payload["skipped"]["ranked_below_floor"] == 2
