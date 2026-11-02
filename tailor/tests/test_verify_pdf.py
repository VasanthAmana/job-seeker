"""Tests for tools/verify_pdf.py - page count + ATS text layer.

No real PDF/pdftotext is required: pdftotext's subprocess call is mocked so
this exercises the pass/fail decision logic deterministically. Tests that
genuinely need a real `pdftotext` binary are marked and skipped with a
stated reason when it's absent.
"""

import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

TOOLS = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS))
import verify_pdf  # noqa: E402


class TestRunPdftotext:
    def test_returns_none_when_pdftotext_absent(self, tmp_path):
        with patch.object(shutil, "which", return_value=None):
            assert verify_pdf.run_pdftotext(tmp_path / "x.pdf") is None

    def test_returns_none_on_nonzero_exit(self, tmp_path):
        with patch.object(shutil, "which", return_value="/usr/bin/pdftotext"), \
             patch("subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 1, stdout="", stderr="bad pdf")
            assert verify_pdf.run_pdftotext(tmp_path / "x.pdf") is None

    def test_returns_text_on_success(self, tmp_path):
        with patch.object(shutil, "which", return_value="/usr/bin/pdftotext"), \
             patch("subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, stdout="Jordan Reyes\nSummary text here.\f", stderr="")
            assert verify_pdf.run_pdftotext(tmp_path / "x.pdf") == "Jordan Reyes\nSummary text here.\f"


class TestPageCount:
    def test_counts_form_feeds(self):
        assert verify_pdf.page_count("page one\fpage two\fpage three") == 2
        assert verify_pdf.page_count("only page, no form feed") == 1
        assert verify_pdf.page_count("") == 0


class TestVerify:
    def test_skips_when_pdftotext_missing(self, tmp_path):
        pdf = tmp_path / "r.pdf"
        pdf.write_bytes(b"%PDF-fake")
        with patch.object(shutil, "which", return_value=None):
            rc, problems = verify_pdf.verify(pdf, max_pages=2, expect=[])
        assert rc == 2
        assert "pdftotext" in problems[0]

    def test_passes_with_good_text_layer_and_expected_strings(self, tmp_path):
        pdf = tmp_path / "r.pdf"
        pdf.write_bytes(b"%PDF-fake")
        text = ("Jordan Reyes\njordan.reyes@example.com\n" + "Director of AI strategy. " * 10 + "\f")
        with patch.object(verify_pdf, "run_pdftotext", return_value=text):
            rc, problems = verify_pdf.verify(pdf, max_pages=2, expect=["Jordan Reyes", "jordan.reyes@example.com"])
        assert rc == 0
        assert problems == []

    def test_fails_on_page_budget_exceeded(self, tmp_path):
        pdf = tmp_path / "r.pdf"
        pdf.write_bytes(b"%PDF-fake")
        text = ("Some substantial resume content here. " * 5 + "\f") * 3
        with patch.object(verify_pdf, "run_pdftotext", return_value=text):
            rc, problems = verify_pdf.verify(pdf, max_pages=2, expect=[])
        assert rc == 1
        assert any("exceeds the 2-page budget" in p for p in problems)

    def test_fails_on_missing_ats_text_layer(self, tmp_path):
        pdf = tmp_path / "r.pdf"
        pdf.write_bytes(b"%PDF-fake")
        with patch.object(verify_pdf, "run_pdftotext", return_value="\f"):
            rc, problems = verify_pdf.verify(pdf, max_pages=2, expect=[])
        assert rc == 1
        assert any("no extractable ATS text layer" in p for p in problems)

    def test_fails_on_missing_expected_string(self, tmp_path):
        pdf = tmp_path / "r.pdf"
        pdf.write_bytes(b"%PDF-fake")
        text = "Director of AI strategy with fifteen years experience. " * 5 + "\f"
        with patch.object(verify_pdf, "run_pdftotext", return_value=text):
            rc, problems = verify_pdf.verify(pdf, max_pages=2, expect=["Taylor Example"])
        assert rc == 1
        assert any("Taylor Example" in p for p in problems)


class TestCli:
    def test_missing_pdf_exits_2(self, tmp_path):
        rc = verify_pdf.main(["--pdf", str(tmp_path / "nope.pdf")])
        assert rc == 2


@pytest.mark.skipif(not shutil.which("pdftotext"), reason="pdftotext not installed; integration check skipped")
def test_real_pdftotext_round_trip(tmp_path):
    pytest.skip("requires a real PDF fixture with a text layer")
