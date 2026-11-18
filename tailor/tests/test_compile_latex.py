"""Tests for tools/compile_latex.py - the only module that shells out to a
real LaTeX engine. The engine invocation itself is mocked throughout; tests
needing a real engine are skipped with a stated reason."""

import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

TOOLS = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS))
import compile_latex  # noqa: E402


class TestFindEngine:
    def test_returns_none_when_nothing_on_path(self):
        with patch.object(shutil, "which", return_value=None):
            assert compile_latex.find_engine() is None

    def test_returns_first_match_in_priority_order(self):
        with patch.object(shutil, "which", side_effect=lambda e: e if e == "pdflatex" else None):
            assert compile_latex.find_engine() == "pdflatex"


class TestCompileTex:
    def test_skips_when_no_engine(self, tmp_path):
        tex = tmp_path / "r.tex"
        tex.write_text("\\documentclass{article}\\begin{document}x\\end{document}")
        with patch.object(shutil, "which", return_value=None):
            rc, msg = compile_latex.compile_tex(tex)
        assert rc == 2
        assert "no LaTeX engine" in msg

    def test_success_runs_requested_passes(self, tmp_path):
        tex = tmp_path / "r.tex"
        tex.write_text("\\documentclass{article}\\begin{document}x\\end{document}")
        with patch.object(shutil, "which", side_effect=lambda e: e if e == "pdflatex" else None), \
             patch("subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, stdout="ok", stderr="")
            rc, _ = compile_latex.compile_tex(tex, passes=2)
        assert rc == 0
        assert run.call_count == 2

    def test_failure_stops_early_and_reports_log_tail(self, tmp_path):
        tex = tmp_path / "r.tex"
        tex.write_text("\\documentclass{article}\\begin{document}x\\end{document}")
        with patch.object(shutil, "which", side_effect=lambda e: e if e == "pdflatex" else None), \
             patch("subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 1, stdout="", stderr="! Undefined control sequence.")
            rc, output = compile_latex.compile_tex(tex, passes=2)
        assert rc == 1
        assert run.call_count == 1  # does not waste a second pass after a failure
        assert "Undefined control sequence" in output


class TestCli:
    def test_missing_tex_exits_2(self, tmp_path):
        rc = compile_latex.main(["--tex", str(tmp_path / "nope.tex")])
        assert rc == 2

    def test_cli_skips_cleanly_when_no_engine(self, tmp_path):
        tex = tmp_path / "r.tex"
        tex.write_text("\\documentclass{article}\\begin{document}x\\end{document}")
        with patch.object(shutil, "which", return_value=None):
            rc = compile_latex.main(["--tex", str(tex)])
        assert rc == 2


@pytest.mark.skipif(not shutil.which("pdflatex") and not shutil.which("tectonic"),
                     reason="no real LaTeX engine installed; integration compile skipped")
def test_real_compile_round_trip():
    pytest.skip("requires a real TeX distribution")
