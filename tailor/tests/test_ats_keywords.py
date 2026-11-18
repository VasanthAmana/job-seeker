"""Tests for tools/ats_keywords.py (JD keyword coverage)."""

import json
import subprocess
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

sys.path.insert(0, str(TOOLS))
import ats_keywords  # noqa: E402

JD = FIXTURES / "jd_meridian.md"
RESUME = FIXTURES / "tailored_grounded.md"

# The keyword list an agent would derive from the fixture JD.
JD_KEYWORDS = [
    "AI strategy", "AI governance", "GenAI", "operating model",
    "executive stakeholder", "board", "roadmap", "budget ownership",
    "vendor management", "AWS", "Azure ML", "Snowflake", "MBA",
    "financial services",
]


def run_cli(*extra):
    return subprocess.run(
        [sys.executable, str(TOOLS / "ats_keywords.py"),
         "--jd", str(JD), "--resume", str(RESUME), "--json", *extra],
        capture_output=True, text=True)


class TestExplicitKeywords:
    def test_grounded_resume_covers_jd_keywords(self):
        proc = run_cli("--keywords", ",".join(JD_KEYWORDS))
        assert proc.returncode == 0, proc.stdout
        data = json.loads(proc.stdout)
        assert data["missing"] == 0
        assert data["covered"] == len(JD_KEYWORDS)

    def test_missing_keyword_exits_1(self):
        proc = run_cli("--keywords", "AI strategy,Kubernetes")
        assert proc.returncode == 1
        rows = {r["keyword"]: r["status"]
                for r in json.loads(proc.stdout)["keywords"]}
        assert rows == {"AI strategy": "covered", "Kubernetes": "missing"}

    def test_case_and_plural_inflection(self):
        folded = ats_keywords.fold("built ROADMAPS and an ai strategy")
        assert ats_keywords.covered("AI Strategy", folded)
        assert ats_keywords.covered("roadmap", folded)

    def test_no_substring_false_positive(self):
        # "AI" must not match inside "SAID" or "detail"
        folded = ats_keywords.fold("he said the detail mattered")
        assert not ats_keywords.covered("AI", folded)

    def test_keywords_file(self, tmp_path):
        kws = tmp_path / "kws.txt"
        kws.write_text("AI strategy\nKubernetes\n")
        proc = run_cli("--keywords-file", str(kws))
        assert proc.returncode == 1
        assert json.loads(proc.stdout)["covered"] == 1


class TestAutoExtraction:
    def test_auto_mode_finds_jd_terms(self):
        proc = run_cli("--auto")
        assert proc.returncode in (0, 1)
        keywords = [r["keyword"] for r in json.loads(proc.stdout)["keywords"]]
        # deterministic candidates from the fixture JD
        assert "GenAI" in keywords
        assert any("AI" in k for k in keywords)

    def test_auto_excludes_title_acronyms(self):
        found = ats_keywords.auto_extract(JD.read_text())
        assert "CEO" not in found and "MBA" not in found or "MBA" in found
        # titles like CEO/CFO are always excluded
        assert not {"CEO", "CFO", "VP"} & set(found)


class TestUsage:
    def test_no_keyword_source_exits_2(self):
        proc = run_cli()
        assert proc.returncode == 2

    def test_missing_file_exits_2(self):
        proc = subprocess.run(
            [sys.executable, str(TOOLS / "ats_keywords.py"),
             "--jd", str(JD), "--resume", "/nonexistent.md", "--auto"],
            capture_output=True, text=True)
        assert proc.returncode == 2
