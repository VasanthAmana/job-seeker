# LaTeX install - `tailor --format latex`

`tailor`'s default export route (`tools/export_resume.py --format latex`,
via `tools/latex_pipeline.py`) compiles a moderncv resume (and, when a
why-me note is passed, a `cover.cls` note) to PDF and inspects the result -
page count, ATS text-layer, layout overflow/holes - before calling it done.
That needs a TeX distribution and the `pdftotext` utility (for the
ATS-text-layer check) on `PATH`. Nothing here needs network access at
tailor-time - the distribution itself is a one-time local install.

If you'd rather skip this entirely, pass `--format markdown` (see
`tailor/README.md`) - the owner's original .docx/PDF pandoc route,
no TeX distribution required.

## macOS

**Full install (simplest, ~5GB):**

```bash
brew install --cask mactex
```

**Minimal install (smaller, a few extra packages on first use):**

```bash
brew install --cask basictex
# BasicTeX ships tlmgr but not every package; moderncv needs a few more:
sudo tlmgr update --self
sudo tlmgr install moderncv fontawesome5 xcolor geometry parskip hyperref \
    marvosym academicons
```

Either way, also install the ATS-text-layer checker's dependency:

```bash
brew install poppler   # provides pdftotext
```

Open a new terminal afterward so the updated `PATH` (MacTeX/BasicTeX adds
`/Library/TeX/texbin`) takes effect, then confirm:

```bash
which pdflatex pdftotext
```

## Windows

**Install [MiKTeX](https://miktex.org/download)** (the installer; or
`winget install MiKTeX.MiKTeX`). During first run, set "Install missing
packages on-the-fly" to **Yes** - moderncv and its dependencies
(`fontawesome5`, `xcolor`, `geometry`, `parskip`, `hyperref`, `marvosym`,
`academicons`) then install automatically the first time `tailor` compiles
a resume, instead of needing to be listed up front.

**Install poppler for `pdftotext`** (MiKTeX does not include it):

```powershell
winget install oschwartz10612.Poppler
```

or download a poppler-for-Windows release and put its `bin/` on `PATH`.

Confirm from a new terminal:

```powershell
where pdflatex
where pdftotext
```

## What gets used

`tools/compile_latex.py` tries engines in this order and uses the first one
found: `tectonic`, `latexmk`, `pdflatex`, `xelatex`, `lualatex`. `tectonic`
(a self-contained, dependency-fetching LaTeX engine - `brew install
tectonic` / `winget install tectonic-typesetting.tectonic`) is the lowest-
friction option if you'd rather not manage package installs at all, since it
downloads missing packages (including moderncv) automatically and needs no
separate TeX distribution.

## No engine installed?

`tailor --format latex` skips cleanly (exit 2, a `skipped:` line naming what's
missing) rather than failing noisily - the Markdown resume is still written,
and you can re-run with `--format markdown` for the pandoc/.docx route in
the meantime.
