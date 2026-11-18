#!/usr/bin/env python3
"""The LaTeX compile-and-inspect loop: render, compile, verify - re-render
on a failed check rather than shipping a broken PDF.

Option (b) of the resume-format decision (ai-job-search's moderncv route,
MIT, see NOTICE), ties together:

  1. render_latex.py   - Markdown -> .tex (pure text transform, no subprocess)
  2. compile_latex.py  - .tex -> .pdf (first available engine)
  3. verify_pdf.py      - page count + ATS text layer
  4. verify_layout.py   - overflow/holes from the compile log

A verify failure does not retry blindly - LaTeX output is deterministic
given the same .tex, so re-running the same compile would just fail the
same way. "Re-render" here means: recompile up to `--retries` times (moderncv
occasionally needs an extra pass to resolve its own spacing), and on a real
content problem (page budget, overflow), fail with a clear, actionable
reason instead of shipping the PDF - exactly like export_resume.py's
existing page-budget-exceeded contract - so the caller (tailor.md Step 6)
knows to cut content and call this again.

Exit codes: 0 = compiled and verified; 1 = failed (a specific, actionable
reason on stderr); 2 = skipped (no LaTeX engine / no pdftotext - install a
TeX distribution, see tailor/LATEX_SETUP.md, or use
--format markdown).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compile_latex  # noqa: E402
import render_latex  # noqa: E402
import verify_layout  # noqa: E402
import verify_pdf  # noqa: E402


def run(
    resume_md: Path,
    out_dir: Path,
    *,
    basename: str | None = None,
    why_me_md: Path | None = None,
    role: str = "",
    company: str = "",
    max_pages: int | None = 2,
    retries: int = 1,
) -> tuple[int, list[str]]:
    """Returns (exit_code, messages)."""
    messages: list[str] = []

    try:
        data = render_latex.parse_resume_md(resume_md.read_text(encoding="utf-8"))
    except render_latex.ParseError as exc:
        return 1, [f"render failed: {exc}"]

    render_argv = ["--resume", str(resume_md), "--out-dir", str(out_dir)]
    if basename:
        render_argv += ["--basename", basename]
    if why_me_md:
        render_argv += ["--why-me", str(why_me_md), "--role", role, "--company", company]
    rc = render_latex.main(render_argv)
    if rc != 0:
        return rc, ["render_latex failed"]

    stem = basename or resume_md.stem
    tex_path = out_dir / f"{stem}.tex"
    log_path = tex_path.with_suffix(".log")
    pdf_path = tex_path.with_suffix(".pdf")

    expect = [data["full_name"], data["email"]] if data["email"] else [data["full_name"]]

    attempts = max(1, retries + 1)
    for attempt in range(1, attempts + 1):
        compile_rc, compile_out = compile_latex.compile_tex(tex_path)
        if compile_rc == 2:
            return 2, [f"skipped: {compile_out}"]
        if compile_rc == 1:
            if attempt < attempts:
                messages.append(f"attempt {attempt}: compile failed, retrying")
                continue
            tail = "\n".join(compile_out.strip().splitlines()[-25:])
            return 1, [f"compile failed after {attempt} attempt(s):\n{tail}"]

        pdf_rc, pdf_problems = verify_pdf.verify(pdf_path, max_pages, expect)
        if pdf_rc == 2:
            return 2, [f"skipped: {pdf_problems[0]}"]

        layout_problems: list[str] = []
        if log_path.is_file():
            layout_problems = verify_layout.analyze(
                log_path.read_text(encoding="utf-8", errors="replace")
            )

        if not pdf_problems and not layout_problems:
            messages.append(f"wrote {pdf_path}")
            return 0, messages

        if attempt < attempts:
            messages.append(f"attempt {attempt}: verify failed, recompiling")
            continue

        for p in pdf_problems:
            messages.append(f"verify_pdf: {p}")
        for p in layout_problems:
            messages.append(f"verify_layout: {p}")
        messages.append(
            "cut content by relevance and re-run - never squeeze margins/fonts"
        )
        return 1, messages

    return 1, messages or ["exhausted retries"]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--resume", required=True, help="tailored resume (markdown)")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--basename")
    ap.add_argument("--why-me", help="why-me note (markdown)")
    ap.add_argument("--role", default="")
    ap.add_argument("--company", default="")
    ap.add_argument("--max-pages", type=int, default=2)
    ap.add_argument("--retries", type=int, default=1)
    args = ap.parse_args(argv)

    resume_md = Path(args.resume)
    if not resume_md.is_file():
        print(f"latex_pipeline: error: no such file: {resume_md}", file=sys.stderr)
        return 2

    rc, messages = run(
        resume_md,
        Path(args.out_dir),
        basename=args.basename,
        why_me_md=Path(args.why_me) if args.why_me else None,
        role=args.role,
        company=args.company,
        max_pages=args.max_pages,
        retries=args.retries,
    )
    stream = sys.stdout if rc == 0 else sys.stderr
    for m in messages:
        print(m, file=stream)
    if rc == 0:
        print("latex_pipeline: PASS")
    elif rc == 1:
        print("latex_pipeline: FAIL", file=sys.stderr)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
