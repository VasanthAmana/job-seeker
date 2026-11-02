"""Tests for tools/export_resume.py (Markdown -> docx/PDF export)."""

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent.parent / "tools"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

sys.path.insert(0, str(TOOLS))
import export_resume  # noqa: E402

RESUME = FIXTURES / "tailored_grounded.md"

pandoc = pytest.mark.skipif(not shutil.which("pandoc"), reason="pandoc absent")


def run_cli(*extra):
    return subprocess.run(
        [sys.executable, str(TOOLS / "export_resume.py"), *extra],
        capture_output=True, text=True)


class TestNoPandoc:
    def test_missing_input_exits_2(self):
        proc = run_cli("--in", "/nonexistent.md", "--out-dir", "/tmp/x")
        assert proc.returncode == 2


@pandoc
class TestDocxExport:
    def test_docx_written_and_valid(self, tmp_path):
        proc = run_cli("--in", str(RESUME), "--out-dir", str(tmp_path),
                       "--formats", "docx")
        assert proc.returncode == 0, proc.stderr
        docx = tmp_path / "tailored_grounded.docx"
        assert docx.is_file()
        with zipfile.ZipFile(docx) as z:  # a .docx is a zip of XML parts
            assert "word/document.xml" in z.namelist()
        xml = zipfile.ZipFile(docx).read("word/document.xml").decode()
        assert "Jordan Reyes" in xml and "GenAI" in xml

    def test_basename_and_reference_doc(self, tmp_path):
        # a real reference doc: export the master resume itself, then use it
        ref = tmp_path / "ref.docx"
        run_cli("--in", str(FIXTURES / "master_resume.md"),
                "--out-dir", str(tmp_path), "--formats", "docx",
                "--basename", "ref")
        assert ref.is_file()
        proc = run_cli("--in", str(RESUME), "--out-dir", str(tmp_path),
                       "--formats", "docx", "--basename", "tailored",
                       "--reference-doc", str(ref))
        assert proc.returncode == 0, proc.stderr
        assert (tmp_path / "tailored.docx").is_file()

    def test_missing_reference_doc_exits_2(self, tmp_path):
        proc = run_cli("--in", str(RESUME), "--out-dir", str(tmp_path),
                       "--formats", "docx",
                       "--reference-doc", "/nonexistent.docx")
        assert proc.returncode == 2


@pandoc
class TestPdfExport:
    def test_pdf_export_or_clean_skip(self, tmp_path):
        proc = run_cli("--in", str(RESUME), "--out-dir", str(tmp_path),
                       "--formats", "pdf", "--max-pages", "2")
        if proc.returncode == 2:
            assert "skipped: no PDF engine" in proc.stderr
            return
        assert proc.returncode == 0, proc.stderr
        pdf = tmp_path / "tailored_grounded.pdf"
        assert pdf.is_file()
        pages = export_resume.pdf_page_count(pdf)
        if pages is not None:  # pdftotext present
            assert 1 <= pages <= 2

    def test_page_budget_enforced(self, tmp_path):
        if not any(shutil.which(e) for e in export_resume.PDF_ENGINES):
            pytest.skip("no PDF engine")
        long_md = tmp_path / "long.md"
        long_md.write_text("# T\n\n" + "A line of resume content.\n\n" * 400)
        proc = run_cli("--in", str(long_md), "--out-dir", str(tmp_path),
                       "--formats", "pdf", "--max-pages", "2")
        if not shutil.which("pdftotext"):
            pytest.skip("pdftotext absent; budget not verifiable")
        assert proc.returncode == 1
        assert "exceeds the 2-page budget" in proc.stderr
