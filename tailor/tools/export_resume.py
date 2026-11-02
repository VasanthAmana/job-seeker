#!/usr/bin/env python3
"""Export a tailored resume from Markdown to the owner's format.

Option (a) of the open resume-format decision: keep the owner's existing
look. The tailored resume is authored in Markdown; this tool exports it.

  * .docx export - pandoc with `--reference-doc <master.docx>`: pandoc takes
    styles (fonts, margins, colors, heading look) from the reference document,
    so the output keeps the owner's look without editing his file. When the
    owner's master resume is a .docx, pass it as --reference-doc and the
    tailored .docx renders in his styles. (A true in-place edit of a copy of
    his .docx needs python-docx; the reference-doc route needs nothing beyond
    pandoc and preserves the same styles - see jobseek/tailor/README.md.)
  * PDF export - pandoc via the first available engine (tectonic, lualatex,
    xelatex, pdflatex, wkhtmltopdf, weasyprint), else LibreOffice
    (`soffice --headless --convert-to pdf`) on the .docx. With no engine the
    PDF step skips cleanly (exit 2 with a `skipped:` line), like the
    ai-job-search verify tools.

With --max-pages the PDF page count is enforced via pdftotext form feeds
(the owner's resume budget is 2 pages); exit 1 when exceeded.

Exit codes: 0 = all requested formats produced (and page budget met);
1 = page budget exceeded or a requested export failed; 2 = skipped
(prerequisite missing - pandoc absent, or no PDF engine for a PDF request).

Usage:
    export_resume.py --in tailored.md --out-dir out/ [--basename name] \
        [--formats docx,pdf] [--reference-doc master.docx] [--max-pages 2]
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

PDF_ENGINES = ["tectonic", "pdflatex", "xelatex", "lualatex",
               "wkhtmltopdf", "weasyprint"]


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def pdf_page_count(pdf: Path) -> int | None:
    """Page count via pdftotext form feeds; None when unavailable."""
    if not shutil.which("pdftotext"):
        return None
    proc = run(["pdftotext", "-enc", "UTF-8", str(pdf), "-"])
    if proc.returncode != 0:
        return None
    return proc.stdout.count("\f") or 1


def export_docx(md: Path, out: Path, reference_doc: Path | None) -> bool:
    cmd = ["pandoc", "-f", "markdown", "-t", "docx", str(md), "-o", str(out)]
    if reference_doc is not None:
        cmd.append(f"--reference-doc={reference_doc}")
    proc = run(cmd)
    if proc.returncode != 0:
        print(f"export_resume: pandoc docx failed: {proc.stderr.strip()}",
              file=sys.stderr)
        return False
    print(f"wrote {out}")
    return True


def export_pdf(md: Path, out: Path, docx: Path | None) -> int:
    """0 = written, 1 = failed, 2 = skipped (no engine)."""
    errors = []
    for engine in PDF_ENGINES:
        if shutil.which(engine):
            proc = run(["pandoc", "-f", "markdown", str(md), "-o", str(out),
                        f"--pdf-engine={engine}"])
            if proc.returncode == 0:
                print(f"wrote {out} (engine: {engine})")
                return 0
            errors.append(f"{engine}: {proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else 'failed'}")
    if errors:
        print("export_resume: every PDF engine on PATH failed:\n  "
              + "\n  ".join(errors), file=sys.stderr)
        return 1
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if soffice and docx is not None and docx.exists():
        proc = run([soffice, "--headless", "--convert-to", "pdf",
                    "--outdir", str(out.parent), str(docx)])
        produced = out.parent / (docx.stem + ".pdf")
        if proc.returncode == 0 and produced.exists():
            if produced != out:
                produced.rename(out)
            print(f"wrote {out} (engine: libreoffice)")
            return 0
    print("skipped: no PDF engine found (install tectonic, a LaTeX engine, "
          "wkhtmltopdf, weasyprint, or LibreOffice); .docx export unaffected",
          file=sys.stderr)
    return 2


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Export a tailored markdown resume to .docx and/or PDF, "
                    "keeping the owner's look via --reference-doc.")
    ap.add_argument("--in", dest="input", required=True,
                    help="tailored resume (markdown)")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--basename", help="output file stem "
                                       "(default: input stem)")
    ap.add_argument("--formats", default="docx,pdf",
                    help="comma list: docx,pdf (default: both)")
    ap.add_argument("--reference-doc",
                    help="owner's master .docx - pandoc takes its styles")
    ap.add_argument("--max-pages", type=int,
                    help="enforce a PDF page budget (resume: 2)")
    args = ap.parse_args(argv)

    md = Path(args.input)
    if not md.is_file():
        print(f"export_resume: error: no such file: {md}", file=sys.stderr)
        return 2
    if not shutil.which("pandoc"):
        print("skipped: pandoc not found (brew install pandoc); "
              "the markdown resume is still final and can be exported later",
              file=sys.stderr)
        return 2

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.basename or md.stem
    formats = {f.strip() for f in args.formats.split(",") if f.strip()}
    reference_doc = Path(args.reference_doc) if args.reference_doc else None
    if reference_doc is not None and not reference_doc.is_file():
        print(f"export_resume: error: no such reference doc: {reference_doc}",
              file=sys.stderr)
        return 2

    docx_path = out_dir / f"{stem}.docx"
    pdf_path = out_dir / f"{stem}.pdf"
    status = 0

    if "docx" in formats:
        if not export_docx(md, docx_path, reference_doc):
            status = 1

    if "pdf" in formats:
        rc = export_pdf(md, pdf_path, docx_path if docx_path.exists() else None)
        if rc == 1:
            status = 1
        elif rc == 2:
            return 2  # clean skip, like verify tools' exit 2

    if args.max_pages and pdf_path.exists():
        pages = pdf_page_count(pdf_path)
        if pages is None:
            print("export_resume: note: pdftotext unavailable; page budget "
                  "not verified", file=sys.stderr)
        else:
            print(f"page count: {pages} (budget: {args.max_pages})")
            if pages > args.max_pages:
                print(f"export_resume: FAIL - {pages} pages exceeds the "
                      f"{args.max_pages}-page budget; cut by relevance, "
                      f"never by squeezing layout", file=sys.stderr)
                status = 1

    return status


if __name__ == "__main__":
    raise SystemExit(main())
