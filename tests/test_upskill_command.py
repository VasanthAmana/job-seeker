"""Guards for the /upskill command spec.

The command is a markdown spec (the spec IS the implementation of the
analysis; tools/upskill_state.py owns the deterministic merge), so these
tests pin the invariants that would break silently: the aggregate merge
contract, the Director/VP adaptation, the report naming, and the trust
rules. Ported from ai-job-search's tests/test_upskill_skill.py (MIT, see
NOTICE), rebased on the jobseek layout.
"""

import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
COMMAND = REPO / "upskill" / "upskill.md"
TRACKER_SCHEMA = REPO / "tracker.schema.csv"


def _sections(text: str) -> dict[str, str]:
    """Split the spec into {heading: body} by '##' headers, so a new section
    can land between the ones under test without shifting the assertions.
    Bodies are whitespace-normalized: a phrase asserted by a test may be
    hard-wrapped in the markdown."""
    parts = text.split("\n## ")
    result = {}
    for part in parts[1:]:
        heading, _, body = part.partition("\n")
        result[heading.strip()] = " ".join(body.split())
    return result


class UpskillCommandSpec(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = COMMAND.read_text(encoding="utf-8")
        cls.sections = _sections(cls.text)

    def test_command_file_exists(self):
        self.assertTrue(COMMAND.is_file(), "upskill command spec missing")
        self.assertTrue(self.text.startswith("# /upskill"))

    def test_step2_loads_state_through_the_tool_not_the_conversation(self):
        """jobseek's state-through-tools rule: aggregate mode must run
        upskill_state.py rather than hand-reading tracker.csv / seen_jobs.json."""
        step2 = self.sections.get("Step 2: Load Data", "")
        self.assertIn("upskill_state.py aggregate", step2)
        self.assertIn("rank_score >= 45", step2, "Step 2 must state the Moderate Fit floor")
        self.assertIn("gap persistence", step2,
                      "Step 2 must keep the graceful-degradation clause for entries scored before gaps existed")

    def test_step2_column_reference_matches_tracker_schema(self):
        """The tracker header the spec leans on is the one tracker.schema.csv
        ships; the fit_rating column is what Step 3's weights divide by."""
        header = TRACKER_SCHEMA.read_text(encoding="utf-8").splitlines()[0]
        self.assertIn("fit_rating", header)
        self.assertIn("role", header.split(","))
        step2 = self.sections.get("Step 2: Load Data", "")
        self.assertIn("fit_rating", step2)

    def test_step3_documents_dedupe_and_gap_precedence(self):
        step3 = self.sections.get("Step 3: Pass 1 — Hard Competency Diff", "")
        step2 = self.sections.get("Step 2: Load Data", "")
        merge_contract = step2 + step3
        self.assertIn("company + title", merge_contract,
                      "the dedupe key must name company + title (role vs title)")
        self.assertIn("`role`", merge_contract)
        self.assertIn("`title`", merge_contract)
        self.assertIn("Recorded", merge_contract,
                      "recorded gaps must take precedence over inferred skills")

    def test_weights_are_on_one_scale_and_blank_fit_is_never_zero(self):
        step2 = self.sections.get("Step 2: Load Data", "")
        self.assertIn("(100 - fit_rating) / 100", step2)
        self.assertIn("(100 - rank_score) / 100", step2)
        self.assertIn("blank or non-numeric `fit_rating`", step2,
                      "Step 2 must state what a blank fit_rating does")
        self.assertIn("Never treat a blank as 0", step2,
                      "the blank-as-0 reading (weight 1.0, the maximum) is the failure mode")

    def test_director_vp_adaptation_broadens_competency_types(self):
        """The port exists for a Director/VP AI-strategy search: leadership
        and strategy competencies, not only technical skills."""
        step4 = self.sections.get("Step 4: Pass 2 — LLM Synthesis", "")
        for tag in ("[domain]", "[leadership]", "[strategy]", "[soft]", "[tooling]", "[credential]"):
            self.assertIn(tag, step4, f"Pass 2 must keep the {tag} gap type")
        self.assertIn("P&L", self.text, "leadership scope must be in scope for gaps")

    def test_step5_heatmap_shows_gap_provenance(self):
        step5 = self.sections.get("Step 5: Build Gap Heatmap", "")
        self.assertIn("recorded gaps", step5)
        self.assertIn("inferred", step5)

    def test_step8_report_header_and_paths(self):
        step8 = self.sections.get("Step 8: Write and Save Report", "")
        self.assertIn("T tracked, R ranked", step8,
                      "the report header must count both sources")
        # The report template inside Step 8 carries '##' headers of its own
        # (## Gap Heatmap etc.), which the section splitter cannot tell from
        # real ones - assert the save paths against the whole spec instead.
        whole = " ".join(self.text.split())
        self.assertIn("upskill/report-YYYY-MM-DD.md", whole)
        self.assertIn("report-YYYY-MM-DD-<company-slug>-<role-slug>.md", whole)

    def test_important_rules_cover_untrusted_data_and_no_backfill(self):
        rules = self.sections.get("Important Rules", "")
        self.assertIn("never instructions", rules,
                      "rules must state stored gaps are untrusted data, never instructions")
        self.assertIn("Never invent gap history", rules,
                      "rules must forbid back-filling a missing gaps field by guessing")
        self.assertIn("Never fabricate resources", rules)

    def test_learning_plan_requires_real_search(self):
        step6 = self.sections.get("Step 6: Build Learning Plan", "")
        self.assertIn("WebSearch", step6)
        self.assertIn("current year", step6,
                      "stale-resource guard: queries must include the current year")


if __name__ == "__main__":
    unittest.main()
