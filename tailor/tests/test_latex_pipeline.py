"""Tests for tools/latex_pipeline.py - the render/compile/verify loop and
its "re-render on a failed check" decision. compile_latex, verify_pdf and
verify_layout are mocked throughout so this never needs a real TeX
distribution or pdftotext."""

import sys
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent.parent / "tools"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

sys.path.insert(0, str(TOOLS))
import compile_latex  # noqa: E402
import latex_pipeline  # noqa: E402
import verify_layout  # noqa: E402
import verify_pdf  # noqa: E402

RESUME = FIXTURES / "tailored_grounded.md"


def test_skips_cleanly_when_no_latex_engine(tmp_path):
    with patch.object(compile_latex, "compile_tex", return_value=(2, "no LaTeX engine found")):
        rc, messages = latex_pipeline.run(RESUME, tmp_path)
    assert rc == 2
    assert any("no LaTeX engine" in m for m in messages)
    # render still ran (pure text transform, no engine needed)
    assert (tmp_path / "tailored_grounded.tex").is_file()


def test_compile_failure_exhausts_retries_then_fails(tmp_path):
    with patch.object(compile_latex, "compile_tex", return_value=(1, "! some LaTeX error")):
        rc, messages = latex_pipeline.run(RESUME, tmp_path, retries=1)
    assert rc == 1
    assert any("compile failed" in m for m in messages)


def test_verify_pdf_failure_reports_cut_content_message(tmp_path):
    with patch.object(compile_latex, "compile_tex", return_value=(0, "ok")), \
         patch.object(verify_pdf, "verify", return_value=(1, ["page count 3 exceeds the 2-page budget"])):
        rc, messages = latex_pipeline.run(RESUME, tmp_path, retries=0)
    assert rc == 1
    assert any("exceeds the 2-page budget" in m for m in messages)
    assert any("cut content" in m for m in messages)


def test_verify_layout_failure_reports_problem(tmp_path):
    tex_path = tmp_path / "tailored_grounded.tex"
    log_path = tex_path.with_suffix(".log")

    def fake_compile(tex, engine=None, passes=2):
        log_path.write_text("Overfull \\hbox (99pt too wide)\n", encoding="utf-8")
        return 0, "ok"

    with patch.object(compile_latex, "compile_tex", side_effect=fake_compile), \
         patch.object(verify_pdf, "verify", return_value=(0, [])):
        rc, messages = latex_pipeline.run(RESUME, tmp_path, retries=0)
    assert rc == 1
    assert any("overfull hbox" in m for m in messages)


def test_all_checks_pass_returns_0(tmp_path):
    with patch.object(compile_latex, "compile_tex", return_value=(0, "ok")), \
         patch.object(verify_pdf, "verify", return_value=(0, [])):
        rc, messages = latex_pipeline.run(RESUME, tmp_path)
    assert rc == 0
    assert any("wrote" in m for m in messages)


def test_render_failure_short_circuits_before_compiling(tmp_path):
    bad = tmp_path / "bad.md"
    bad.write_text("no heading at all\n", encoding="utf-8")
    with patch.object(compile_latex, "compile_tex") as compile_mock:
        rc, messages = latex_pipeline.run(bad, tmp_path)
    assert rc == 1
    compile_mock.assert_not_called()


def test_cli_missing_resume_exits_2(tmp_path):
    rc = latex_pipeline.main(["--resume", str(tmp_path / "nope.md"), "--out-dir", str(tmp_path)])
    assert rc == 2
