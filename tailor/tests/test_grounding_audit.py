"""Tests for tools/grounding_audit.py (the never-invent rule, mechanical half)."""

import json
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

sys.path.insert(0, str(TOOLS))
import grounding_audit  # noqa: E402

SOURCES = [FIXTURES / "master_resume.md", FIXTURES / "candidate-profile.md"]


def run_audit(resume: Path):
    return subprocess.run(
        [sys.executable, str(TOOLS / "grounding_audit.py"),
         "--resume", str(resume),
         *[arg for s in SOURCES for arg in ("--source", str(s))],
         "--json"],
        capture_output=True, text=True)


class TestGroundedResume:
    def test_fully_grounded_resume_passes(self):
        proc = run_audit(FIXTURES / "tailored_grounded.md")
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert json.loads(proc.stdout)["ungrounded"] == []

    def test_reordered_reworded_bullets_stay_grounded(self):
        """Reordering/rewording must not trip the audit when facts are kept."""
        text = (FIXTURES / "tailored_grounded.md").read_text()
        ungrounded = grounding_audit.audit(
            text, [s.read_text() for s in SOURCES])
        assert ungrounded == []


class TestFabricatedResume:
    def setup_method(self):
        self.proc = run_audit(FIXTURES / "tailored_fabricated.md")
        self.flags = json.loads(self.proc.stdout)["ungrounded"]

    def test_exit_1(self):
        assert self.proc.returncode == 1

    def test_invented_metric_flagged(self):
        metrics = [f for f in self.flags if f["kind"] == "metric"]
        assert any(f["text"].startswith("47") for f in metrics), self.flags

    def test_invented_date_flagged(self):
        dates = [f for f in self.flags if f["kind"] == "date"]
        assert any(f["text"] == "2010" for f in dates), self.flags

    def test_upgraded_title_flagged(self):
        titles = [f for f in self.flags if f["kind"] == "title"]
        assert any("Vice President" in f["text"] for f in titles), self.flags

    def test_invented_tool_flagged(self):
        tools = [f for f in self.flags if f["kind"] == "tool"]
        assert any(f["text"] == "TensorFlow" for f in tools), self.flags


class TestExtractionDetails:
    def audit_text(self, resume_text, source_text):
        return grounding_audit.audit(resume_text, [source_text])

    def test_comma_grouping_folded(self):
        assert self.audit_text("served 14,000 users", "served 14000 users") == []

    def test_markdown_formatting_ignored(self):
        assert self.audit_text("**$18M** budget", "an $18M budget") == []

    def test_fenced_blocks_ignored(self):
        text = "```\nTensorFlow demo, 99%\n```\n"
        assert self.audit_text(text, "nothing here") == []

    def test_prose_abbreviations_not_tools(self):
        assert self.audit_text("several platforms, e.g. dashboards",
                               "several platforms and dashboards") == []

    def test_month_names_not_tools(self):
        assert self.audit_text("Mar 2016 - Jul 2016", "2016") == []

    def test_bare_one_not_audited(self):
        # "1" is too noisy to audit (list markers etc.)
        assert self.audit_text("1 team of note", "no digits") == []
