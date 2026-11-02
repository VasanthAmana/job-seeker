#!/usr/bin/env python3
"""Compile a .tex file to PDF with the first available engine.

Separated from render_latex.py (pure text transform, no subprocess) so the
renderer stays unit-testable without a TeX distribution installed. This
module is the only piece of the LaTeX route that shells out.

Exit codes: 0 = compiled; 1 = compile failed (log excerpt on stderr);
2 = skipped (no LaTeX engine on PATH - install a TeX distribution, see
jobseek/tailor/LATEX_SETUP.md).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ENGINES = ["tectonic", "latexmk", "pdflatex", "xelatex", "lualatex"]


def find_engine() -> str | None:
    for engine in ENGINES:
        if shutil.which(engine):
            return engine
    return None


def _engine_cmd(engine: str, tex: Path) -> list[str]:
    if engine == "tectonic":
        return ["tectonic", "-X", "compile", tex.name]
    if engine == "latexmk":
        return ["latexmk", "-pdf", "-interaction=nonstopmode", "-halt-on-error", tex.name]
    return [engine, "-interaction=nonstopmode", "-halt-on-error", tex.name]


def compile_tex(tex: Path, engine: str | None = None, passes: int = 2) -> tuple[int, str]:
    """Run `engine` against `tex` (cwd = tex's directory) `passes` times -
    moderncv's spacing needs a second pass to settle. Returns
    (returncode, combined stdout+stderr of the last pass).

    0 = compiled, 1 = engine failed, 2 = no engine available.
    """
    chosen = engine or find_engine()
    if chosen is None:
        return 2, "no LaTeX engine found on PATH (tectonic, latexmk, pdflatex, xelatex, lualatex)"
    output = ""
    for _ in range(max(1, passes)):
        proc = subprocess.run(
            _engine_cmd(chosen, tex), cwd=str(tex.parent),
            capture_output=True, text=True,
        )
        output = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            return 1, output
    return 0, output


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tex", required=True, help="path to the .tex file")
    ap.add_argument("--engine", help="force a specific engine (default: first found)")
    ap.add_argument("--passes", type=int, default=2)
    args = ap.parse_args(argv)

    tex = Path(args.tex)
    if not tex.is_file():
        print(f"compile_latex: error: no such file: {tex}", file=sys.stderr)
        return 2

    rc, output = compile_tex(tex, args.engine, args.passes)
    if rc == 2:
        print(f"skipped: {output}; install a TeX distribution - see "
              f"jobseek/tailor/LATEX_SETUP.md, or use --format markdown",
              file=sys.stderr)
        return 2
    if rc == 1:
        tail = "\n".join(output.strip().splitlines()[-25:])
        print(f"compile_latex: FAIL - engine reported errors:\n{tail}", file=sys.stderr)
        return 1

    pdf = tex.with_suffix(".pdf")
    print(f"wrote {pdf}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
