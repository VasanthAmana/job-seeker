"""Tests for tools/verify_layout.py - overfull/underfull box analysis on a
LaTeX engine log. Uses synthetic log text (the real format engines emit),
not a real compiler run."""

import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS))
import verify_layout  # noqa: E402

CLEAN_LOG = """
This is pdfTeX, Version 3.14
Document Class: moderncv
Overfull \\hbox (2.3pt too wide) in paragraph at lines 10--12
Output written on resume.pdf (2 pages, 45000 bytes).
"""

OVERFULL_HBOX_LOG = """
Overfull \\hbox (87.5pt too wide) in paragraph at lines 20--21
Output written on resume.pdf (2 pages, 45000 bytes).
"""

OVERFULL_VBOX_LOG = """
Overfull \\vbox (120.0pt too high) detected at line 30
Output written on resume.pdf (2 pages, 45000 bytes).
"""

UNDERFULL_HOLE_LOG = """
Underfull \\vbox (badness 10000) has occurred while \\output is active []
Output written on resume.pdf (2 pages, 45000 bytes).
"""

COMPILE_ERROR_LOG = """
! Undefined control sequence.
l.12 \\cvbadmacro
Output written on resume.pdf (1 page, 10000 bytes).
"""


def test_clean_log_passes():
    assert verify_layout.analyze(CLEAN_LOG) == []


def test_minor_overfull_hbox_is_ignored():
    assert verify_layout.analyze(CLEAN_LOG) == []


def test_severe_overfull_hbox_fails():
    problems = verify_layout.analyze(OVERFULL_HBOX_LOG)
    assert any("overfull hbox" in p for p in problems)


def test_severe_overfull_vbox_fails():
    problems = verify_layout.analyze(OVERFULL_VBOX_LOG)
    assert any("overfull vbox" in p for p in problems)


def test_underfull_vbox_hole_reported():
    problems = verify_layout.analyze(UNDERFULL_HOLE_LOG)
    assert any("underfull vbox" in p for p in problems)


def test_latex_error_reported_without_box_warnings():
    problems = verify_layout.analyze(COMPILE_ERROR_LOG)
    assert any("Undefined control sequence" in p for p in problems)


def test_cli_missing_log_exits_2(tmp_path):
    rc = verify_layout.main(["--log", str(tmp_path / "nope.log")])
    assert rc == 2


def test_cli_clean_log_exits_0(tmp_path):
    log = tmp_path / "r.log"
    log.write_text(CLEAN_LOG, encoding="utf-8")
    rc = verify_layout.main(["--log", str(log)])
    assert rc == 0


def test_cli_bad_log_exits_1(tmp_path):
    log = tmp_path / "r.log"
    log.write_text(OVERFULL_HBOX_LOG, encoding="utf-8")
    rc = verify_layout.main(["--log", str(log)])
    assert rc == 1
