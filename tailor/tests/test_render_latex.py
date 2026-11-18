"""Tests for tools/render_latex.py (Markdown -> LaTeX, no subprocess)."""

import re
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

sys.path.insert(0, str(TOOLS))
import render_latex  # noqa: E402

RESUME_MD = (FIXTURES / "tailored_grounded.md").read_text(encoding="utf-8")


def test_escape_latex_handles_special_characters():
    raw = r"100% & $5M budget_line #1 ~tilde ^caret {braces} back\slash"
    out = render_latex.escape_latex(raw)
    assert r"\%" in out
    assert r"\&" in out
    assert r"\$" in out
    assert r"\_" in out
    assert r"\#" in out
    assert r"\textasciitilde{}" in out
    assert r"\textasciicircum{}" in out
    assert r"\{" in out and r"\}" in out
    assert r"\textbackslash{}" in out


def test_parse_resume_md_extracts_contact_and_sections():
    data = render_latex.parse_resume_md(RESUME_MD)
    assert data["full_name"] == "Jordan Reyes"
    assert data["location"] == "Denver, CO"
    assert data["email"] == "jordan.reyes@example.com"
    assert data["phone"] == "303-555-0142"
    assert "GenAI" in data["summary"]
    assert len(data["experience"]) == 3
    first = data["experience"][0]
    assert first["title"] == "Director, AI & Innovation"
    assert first["org"] == "Helios Bank"
    assert first["dates"] == "2019-2026"
    assert first["location"] == "Denver, CO"
    assert len(first["bullets"]) == 5
    assert len(data["education"]) == 2
    assert data["education"][0]["title"] == "MBA"
    assert any("AWS" in s for s in data["skills"])


def test_parse_resume_md_requires_title_heading():
    try:
        render_latex.parse_resume_md("no heading here\n")
        assert False, "expected ParseError"
    except render_latex.ParseError:
        pass


def test_parse_resume_md_tolerates_missing_optional_sections():
    minimal = "# Pat Lee\nRemote | pat@example.com\n## Summary\nA strategist.\n"
    data = render_latex.parse_resume_md(minimal)
    assert data["full_name"] == "Pat Lee"
    assert data["experience"] == []
    assert data["education"] == []
    assert data["skills"] == []
    assert data["summary"] == "A strategist."


def test_render_resume_tex_contains_moderncv_scaffolding_and_content():
    data = render_latex.parse_resume_md(RESUME_MD)
    tex = render_latex.render_resume_tex(data)
    assert "\\documentclass" in tex and "moderncv" in tex
    assert "Jordan" in tex and "Reyes" in tex
    assert "jordan.reyes@example.com" in tex
    assert "Helios Bank" in tex
    assert "\\cventry" in tex
    assert "\\section{Skills}" in tex
    # no stray placeholder token left unfilled (the template's own leading
    # comment mentions the @@...@@ convention by name, so check for actual
    # unfilled tokens rather than the bare substring)
    assert not re.search(r"@@[A-Z_]+@@", tex)


def test_render_resume_tex_escapes_ampersand_in_org_name():
    data = render_latex.parse_resume_md(RESUME_MD)
    tex = render_latex.render_resume_tex(data)
    assert "AI \\& Innovation" in tex


def test_parse_why_me_md_keeps_nonempty_lines():
    text = "\nLine one.\n\nLine two.\n   \nLine three.\n"
    assert render_latex.parse_why_me_md(text) == ["Line one.", "Line two.", "Line three."]


def test_render_cover_tex_fills_placeholders():
    data = render_latex.parse_resume_md(RESUME_MD)
    tex = render_latex.render_cover_tex(
        data, ["I built the program.", "I scaled it.", "I'd start with X."],
        role="AI Strategy Director", company="Acme Corp",
    )
    assert "\\documentclass{cover}" in tex
    assert "Jordan Reyes" in tex
    assert "AI Strategy Director" in tex
    assert "Acme Corp" in tex
    assert "I built the program." in tex
    assert not re.search(r"@@[A-Z_]+@@", tex)


def test_cli_renders_resume_and_why_me(tmp_path):
    why_me = tmp_path / "why_me.md"
    why_me.write_text("First line.\nSecond line.\nThird line.\n", encoding="utf-8")
    rc = render_latex.main([
        "--resume", str(FIXTURES / "tailored_grounded.md"),
        "--out-dir", str(tmp_path),
        "--why-me", str(why_me),
        "--role", "AI Strategy Director",
        "--company", "Acme Corp",
    ])
    assert rc == 0
    assert (tmp_path / "tailored_grounded.tex").is_file()
    assert (tmp_path / "why_me.tex").is_file()
    assert (tmp_path / "cover.cls").is_file()


def test_cli_missing_resume_exits_2(tmp_path):
    rc = render_latex.main(["--resume", str(tmp_path / "nope.md"), "--out-dir", str(tmp_path)])
    assert rc == 2
