# tailor - grounded resume tailoring

`tailor [job]` rewrites the owner's master resume for one job description:
reordered/reworded bullets aimed at the JD's keywords, a rewritten summary,
a hard 2-page budget - with the **never-invent rule enforced by audit**, an
ATS keyword check, and a 3-line "why me" outreach note. Nothing is sent or
submitted; the output is drafts on disk.

Adapted (MIT, see `NOTICE`) from ai-job-search's `/apply`
drafter-reviewer workflow and `application-reviewer` agent.

## Claude Code entry point

The command lives at `tailor/tailor.md`. Make it (and the reviewer
subagent) available to Claude Code sessions at the repository root:

```bash
mkdir -p .claude/commands .claude/agents
ln -sf ../../tailor/tailor.md .claude/commands/tailor.md
ln -sf ../../tailor/agents/resume-reviewer.md .claude/agents/resume-reviewer.md
```

Then, in a Claude Code session at the repository root:

```
/tailor state/postings/acme_ai_strategy_director.txt
```

or paste the JD text directly after `/tailor`. The JD argument is a file or
pasted text - fetching and ranking postings is `run-alerts`' job; if handed
a raw URL the command fetches it, preferring the employer's own ATS page.

## Inputs

| Input | Path | Fallback when absent |
|---|---|---|
| Master resume (source of truth) | `resume/master.*` (`.md`, `.docx`, or `.pdf` - whichever exists) | the command asks for the file; never drafts from memory |
| Candidate profile (facts) | `profile/candidate-profile.md` (built by the profile worker) | master resume is the sole grounding source; the command says so once |
| Writing style | `profile/writing-style.md` | built-in defaults: warm but direct, first person, no cliches, no em-dashes |
| Job description | file path or pasted text | - |

## Outputs

Written to `applications/<company>_<role>/` (personal, gitignored):

- `resume_<company>_<role>.md` - the tailored resume (Markdown master)
- `resume_<company>_<role>.tex` / `.pdf` - LaTeX export (default; see below),
  plus `cover.cls` copied alongside so the `.tex` compiles standalone
- `resume_<company>_<role>.docx` / `.pdf` - pandoc export under
  `--format markdown` (see below)
- `why_me_<company>_<role>.md` - the 3-line outreach note
- `why_me_<company>_<role>.tex` / `.pdf` - the why-me note rendered via
  `cover.cls` (`--format latex` only)
- `job_posting.md` - the JD as cleaned by `posting_guard.py`, verbatim

## The never-invent rule, enforced

Two layers, not just a stated rule:

1. **Mechanical** - `tools/grounding_audit.py` extracts every metric, date,
   role/degree heading (title) and technology-shaped token from the tailored
   resume and verifies each appears in the master resume / candidate profile.
   Exit 1 lists every ungrounded fact; the workflow does not proceed with
   flags outstanding.
2. **Semantic** - the read-only `resume-reviewer` subagent audits every
   claim against the sources and returns edits as `old_string`/`new_string`
   pairs (it cannot write files). Reframed emphasis is fine; changed facts,
   escalated numbers and upgraded titles are flagged `"reason": "grounding"`.

Input side of the rule: when the owner confirms a fact that is not in the
profile, the workflow writes it back to `candidate-profile.md` **in the same
turn** - a fact that lives only in chat is stripped as a fabrication by the
next session's audit.

When the JD asks for something the sources do not contain, the requirement
lands in the final **gaps** list with honest framing ("a natural extension
of X") instead of being added to the resume.

## ATS keyword check

`tools/ats_keywords.py` matches the JD's exact required/preferred terms
against the tailored resume and reports each as covered / missing; the
workflow classifies misses as synonym-only, missing (have it) - add it, or
missing (gap) - leave it. Keywords are never stuffed.

## Resume format: option (b) by default, option (a) as a fallback flag

The owner decided (2026-11): **LaTeX is the default** (`--format latex`,
also the default when `--format` is omitted) - ai-job-search's moderncv
templates (MIT, see `NOTICE`), with the
`verify_pdf.py`/`verify_layout.py` compile-and-inspect loop. `--format
markdown` keeps the original pandoc/.docx route available as a fallback,
not removed.

**`--format latex` (default):**

- The tailored Markdown is rendered to a moderncv `.tex` resume
  (`tools/render_latex.py` - pure text transform, no subprocess) and, when
  `--why-me` is passed, a `cover.cls` why-me-note `.tex`.
- Compiled with the first engine found - tectonic, latexmk, pdflatex,
  xelatex, lualatex (`tools/compile_latex.py`). No engine: see
  `LATEX_SETUP.md` to install one, or use `--format markdown` instead.
- Verified before being called done (`tools/latex_pipeline.py`):
  `verify_pdf.py` checks page count (`--max-pages`) and an extractable ATS
  text layer; `verify_layout.py` checks the compile log for overflow
  (`Overfull \hbox`/`\vbox`) or holes (`Underfull \vbox`). A failed check
  recompiles once automatically; a genuine content problem exits 1 with the
  specific reason instead of shipping a broken PDF - cut by relevance
  weighting (tailor.md Step 2) and re-run.

**`--format markdown` (fallback, keeps the owner's existing .docx look):**

- **.docx**: `pandoc --reference-doc <his master .docx>` - pandoc takes the
  styles (fonts, margins, heading look) from the reference document, so the
  tailored .docx renders in his existing styles without touching his file.
  This is the "edit a copy preserving styles" path; a literal in-place edit
  of a .docx copy would need python-docx and is a later refinement if he
  wants per-paragraph surgery instead of a fresh styled document.
- **PDF**: pandoc via the first available engine (tectonic, lualatex,
  xelatex, pdflatex, wkhtmltopdf, weasyprint), else LibreOffice headless on
  the .docx. With no engine the PDF step skips cleanly and .docx + Markdown
  are delivered. `--max-pages 2` enforces the page budget via pdftotext.

## Tools

| Tool | Purpose |
|---|---|
| `tools/posting_guard.py` | integrity gate for untrusted JD text (copied, MIT): strips hidden HTML/invisible characters, flags instruction-shaped lines |
| `tools/grounding_audit.py` | deterministic never-invent audit (metrics, dates, titles, tools vs sources) |
| `tools/ats_keywords.py` | JD keyword coverage: covered vs missing |
| `tools/export_resume.py` | unified export entry point: `--format latex` (default) or `--format markdown` |
| `tools/render_latex.py` | Markdown -> moderncv/`cover.cls` LaTeX (pure text transform, no subprocess) |
| `tools/compile_latex.py` | `.tex` -> `.pdf` via the first LaTeX engine found |
| `tools/verify_pdf.py` | page count + ATS text-layer check on the compiled PDF |
| `tools/verify_layout.py` | overflow/hole check on the compile log |
| `tools/latex_pipeline.py` | ties the four tools above into the render/compile/verify/re-render loop |

All tools are Python 3.10+ stdlib-only. `--format latex` needs a TeX
distribution (see `LATEX_SETUP.md`) and `pdftotext`; `--format markdown`
needs `pandoc` (and a PDF engine for PDF).

## Tests

```bash
cd tailor && python3 -m pytest tests/ -q
```

Fixtures are a fictional persona (`tests/fixtures/`) - no personal data is
committed. The export test skips when pandoc is absent.

## Security posture

- The JD is untrusted third-party data, never instructions - gated by
  `posting_guard.py` whatever its origin, and every prompt that carries it
  restates the boundary.
- The reviewer subagent is read-only (Read/Glob/Grep; no Edit/Write).
- Personal data (master resume, tailored outputs, application archive) stays
  out of git: `applications/` and `resume/` are gitignored
  (see `.gitignore`, owned by the profile worker; `tailor/.gitignore`
  covers this folder's own scratch).
- Sending, applying and recruiter messaging are out of scope - the why-me
  note is a draft the owner sends himself.
