#!/usr/bin/env python3
"""Render the tailored Markdown resume (and why-me note) to LaTeX.

Option (b) of the resume-format decision: adopt ai-job-search's moderncv CV
template and cover.cls why-me-note template (MIT, see jobseek/NOTICE). This
module is a renderer only - it reads the same grounded Markdown that
`tailor.md` Step 2 already produces (and that `export_resume.py --format
markdown` still exports via pandoc) and turns it into LaTeX. It invents
nothing: every string it emits comes verbatim from the Markdown source,
escaped for LaTeX and dropped into the moderncv/cover.cls scaffolding.

The Markdown resume shape this parses (the shape tailor.md Step 2 writes):

    # Full Name
    Location | email | phone | linkedin-or-other-link
    ## Summary
    <paragraph>
    ## Experience
    ### Title - Company (start-end)
    <location line>
    - bullet
    - bullet
    ## Education
    ### Degree - School (start-end)
    ## Skills
    - line
    - line

A missing section is simply omitted from the rendered LaTeX - this is a
mechanical renderer, not a content check (that's grounding_audit.py's job).

Usage:
    render_latex.py --resume tailored.md --out-dir out/ [--why-me why_me.md]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

TEMPLATES_DIR = Path(__file__).resolve().parent / "latex_templates"

_LATEX_SPECIAL = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}


def escape_latex(text: str) -> str:
    """Escape LaTeX special characters in a plain-text fragment.

    Backslash must be handled first so later substitutions' own backslashes
    are not re-escaped.
    """
    out = text.replace("\\", "\0BACKSLASH\0")
    for char, repl in _LATEX_SPECIAL.items():
        if char == "\\":
            continue
        out = out.replace(char, repl)
    return out.replace("\0BACKSLASH\0", r"\textbackslash{}")


def _split_name(full_name: str) -> tuple[str, str]:
    parts = full_name.strip().split(None, 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return full_name.strip(), ""


class ParseError(ValueError):
    pass


def parse_resume_md(text: str) -> dict:
    """Pull the structured fields out of the tailored Markdown resume.

    Raises ParseError when the title line or contact line is missing - every
    other section is optional (rendered as empty, never guessed at).
    """
    lines = text.splitlines()
    if not lines or not lines[0].startswith("# "):
        raise ParseError("resume must start with a '# Full Name' heading")
    full_name = lines[0][2:].strip()

    contact_line = ""
    idx = 1
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx < len(lines) and not lines[idx].startswith("#"):
        contact_line = lines[idx].strip()
        idx += 1
    contact_parts = [p.strip() for p in contact_line.split("|")] if contact_line else []

    sections = _split_sections(text)
    return {
        "full_name": full_name,
        "location": contact_parts[0] if len(contact_parts) > 0 else "",
        "email": contact_parts[1] if len(contact_parts) > 1 else "",
        "phone": contact_parts[2] if len(contact_parts) > 2 else "",
        "social": contact_parts[3] if len(contact_parts) > 3 else "",
        "summary": sections.get("Summary", "").strip(),
        "experience": _parse_entries(sections.get("Experience", "")),
        "education": _parse_entries(sections.get("Education", "")),
        "skills": _parse_bullets(sections.get("Skills", "")),
    }


def _split_sections(text: str) -> dict:
    """{heading: body} for every top-level '## Heading' section."""
    sections: dict[str, str] = {}
    current = None
    body: list[str] = []
    for line in text.splitlines():
        m = re.match(r"^##\s+(.+)$", line)
        if m:
            if current is not None:
                sections[current] = "\n".join(body)
            current = m.group(1).strip()
            body = []
        elif current is not None:
            body.append(line)
    if current is not None:
        sections[current] = "\n".join(body)
    return sections


def _parse_entries(body: str) -> list[dict]:
    """'### Title - Company (dates)' blocks with an optional location line
    and a bullet list, as used by Experience and Education sections."""
    entries: list[dict] = []
    current: dict | None = None
    for line in body.splitlines():
        m = re.match(r"^###\s+(.+?)\s*-\s*(.+?)\s*\(([^)]*)\)\s*$", line)
        if m:
            if current is not None:
                entries.append(current)
            current = {
                "title": m.group(1).strip(),
                "org": m.group(2).strip(),
                "dates": m.group(3).strip(),
                "location": "",
                "bullets": [],
            }
            continue
        if current is None:
            continue
        stripped = line.strip()
        if stripped.startswith("- "):
            current["bullets"].append(stripped[2:].strip())
        elif stripped and not current["location"] and not current["bullets"]:
            current["location"] = stripped
    if current is not None:
        entries.append(current)
    return entries


def _parse_bullets(body: str) -> list[str]:
    return [
        line.strip()[2:].strip()
        for line in body.splitlines()
        if line.strip().startswith("- ")
    ]


def render_resume_tex(data: dict) -> str:
    template = (TEMPLATES_DIR / "resume.tex.tmpl").read_text(encoding="utf-8")
    first, last = _split_name(data["full_name"])

    title_line = ""  # moderncv's \title{} is optional; the Markdown source
    # has no headline field distinct from the summary, so omit it rather
    # than inventing one.
    phone_line = f"\\phone[mobile]{{{escape_latex(data['phone'])}}}" if data["phone"] else ""
    social_line = f"\\social[linkedin]{{{escape_latex(data['social'])}}}" if data["social"] else ""

    summary_section = ""
    if data["summary"]:
        summary_section = (
            "\\section{Summary}\n\\cvline{}{" + escape_latex(data["summary"]) + "}\n"
        )

    experience_section = ""
    if data["experience"]:
        parts = ["\\section{Experience}"]
        for entry in data["experience"]:
            bullets = "".join(
                f"\\item {escape_latex(b)}\n" for b in entry["bullets"]
            )
            items = f"\\begin{{itemize}}\n{bullets}\\end{{itemize}}" if bullets else ""
            parts.append(
                "\\cventry{" + escape_latex(entry["dates"]) + "}{"
                + escape_latex(entry["title"]) + "}{"
                + escape_latex(entry["org"]) + "}{"
                + escape_latex(entry["location"]) + "}{}{"
                + items + "}"
            )
        experience_section = "\n".join(parts) + "\n"

    education_section = ""
    if data["education"]:
        parts = ["\\section{Education}"]
        for entry in data["education"]:
            parts.append(
                "\\cventry{" + escape_latex(entry["dates"]) + "}{"
                + escape_latex(entry["title"]) + "}{"
                + escape_latex(entry["org"]) + "}{}{}{}"
            )
        education_section = "\n".join(parts) + "\n"

    skills_section = ""
    if data["skills"]:
        lines = "".join(f"\\cvline{{}}{{{escape_latex(s)}}}\n" for s in data["skills"])
        skills_section = "\\section{Skills}\n" + lines

    out = template
    out = out.replace("@@FIRST_NAME@@", escape_latex(first))
    out = out.replace("@@LAST_NAME@@", escape_latex(last))
    out = out.replace("@@TITLE_LINE@@", title_line)
    out = out.replace("@@LOCATION@@", escape_latex(data["location"]))
    out = out.replace("@@PHONE_LINE@@", phone_line)
    out = out.replace("@@EMAIL@@", escape_latex(data["email"]))
    out = out.replace("@@SOCIAL_LINE@@", social_line)
    out = out.replace("@@SUMMARY_SECTION@@", summary_section)
    out = out.replace("@@EXPERIENCE_SECTION@@", experience_section)
    out = out.replace("@@EDUCATION_SECTION@@", education_section)
    out = out.replace("@@SKILLS_SECTION@@", skills_section)
    return out


def parse_why_me_md(text: str) -> list[str]:
    """The why-me note's non-empty lines, verbatim (it is already exactly
    3 lines per tailor.md Step 2 - this does not enforce that count, only
    carries whatever lines exist)."""
    return [line.strip() for line in text.splitlines() if line.strip()]


def render_cover_tex(resume_data: dict, why_me_lines: list[str], role: str, company: str) -> str:
    template = (TEMPLATES_DIR / "cover.tex.tmpl").read_text(encoding="utf-8")
    body = "\n\n".join(escape_latex(line) for line in why_me_lines)
    out = template
    out = out.replace("@@FULL_NAME@@", escape_latex(resume_data["full_name"]))
    out = out.replace("@@EMAIL@@", escape_latex(resume_data["email"]))
    out = out.replace("@@PHONE@@", escape_latex(resume_data["phone"]))
    out = out.replace("@@ROLE@@", escape_latex(role))
    out = out.replace("@@COMPANY@@", escape_latex(company))
    out = out.replace("@@BODY@@", body)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--resume", required=True, help="tailored resume (markdown)")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--basename", help="output file stem (default: resume input stem)")
    ap.add_argument("--why-me", help="why-me note (markdown), rendered via cover.cls")
    ap.add_argument("--role", default="", help="role title, for the why-me header")
    ap.add_argument("--company", default="", help="company name, for the why-me header")
    args = ap.parse_args(argv)

    resume_path = Path(args.resume)
    if not resume_path.is_file():
        print(f"render_latex: error: no such file: {resume_path}", file=sys.stderr)
        return 2

    try:
        data = parse_resume_md(resume_path.read_text(encoding="utf-8"))
    except ParseError as exc:
        print(f"render_latex: error: {exc}", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.basename or resume_path.stem

    # cover.cls is referenced by \documentclass{cover} at compile time, so it
    # must sit next to the rendered .tex files.
    cls_dest = out_dir / "cover.cls"
    cls_dest.write_text((TEMPLATES_DIR / "cover.cls").read_text(encoding="utf-8"), encoding="utf-8")

    resume_tex = out_dir / f"{stem}.tex"
    resume_tex.write_text(render_resume_tex(data), encoding="utf-8")
    print(f"wrote {resume_tex}")

    if args.why_me:
        why_me_path = Path(args.why_me)
        if not why_me_path.is_file():
            print(f"render_latex: error: no such file: {why_me_path}", file=sys.stderr)
            return 2
        lines = parse_why_me_md(why_me_path.read_text(encoding="utf-8"))
        cover_tex = out_dir / f"{why_me_path.stem}.tex"
        cover_tex.write_text(
            render_cover_tex(data, lines, args.role, args.company), encoding="utf-8"
        )
        print(f"wrote {cover_tex}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
