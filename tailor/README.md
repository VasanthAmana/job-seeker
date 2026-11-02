# jobseek/tailor - grounded resume tailoring

`tailor [job]` rewrites the owner's master resume for one job description:
reordered/reworded bullets aimed at the JD's keywords, a rewritten summary,
a hard 2-page budget - with the **never-invent rule enforced by audit**, an
ATS keyword check, and a 3-line "why me" outreach note. Nothing is sent or
submitted; the output is drafts on disk.

Adapted (MIT, see `jobseek/NOTICE`) from ai-job-search's `/apply`
drafter-reviewer workflow and `application-reviewer` agent.

## Claude Code entry point

The command lives at `jobseek/tailor/tailor.md`. Make it (and the reviewer
subagent) available to Claude Code sessions at the workie root:

```bash
mkdir -p .claude/commands .claude/agents
ln -sf ../../jobseek/tailor/tailor.md .claude/commands/tailor.md
ln -sf ../../jobseek/tailor/agents/resume-reviewer.md .claude/agents/resume-reviewer.md
```

Then, in a Claude Code session at the workie root:

```
/tailor jobseek/state/postings/acme_ai_strategy_director.txt
```

or paste the JD text directly after `/tailor`. The JD argument is a file or
pasted text - fetching and ranking postings is `run-alerts`' job; if handed
a raw URL the command fetches it, preferring the employer's own ATS page.

## Inputs

| Input | Path | Fallback when absent |
|---|---|---|
| Master resume (source of truth) | `jobseek/resume/master.*` (`.md`, `.docx`, or `.pdf` - whichever exists) | the command asks for the file; never drafts from memory |
| Candidate profile (facts) | `jobseek/profile/candidate-profile.md` (built by the profile worker) | master resume is the sole grounding source; the command says so once |
| Writing style | `jobseek/profile/writing-style.md` | built-in defaults: warm but direct, first person, no cliches, no em-dashes |
| Job description | file path or pasted text | - |

## Outputs

Written to `jobseek/applications/<company>_<role>/` (personal, gitignored):

- `resume_<company>_<role>.md` - the tailored resume (Markdown master)
- `resume_<company>_<role>.docx` / `.pdf` - exports (see below)
- `why_me_<company>_<role>.md` - the 3-line outreach note
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

## Resume format: option (a), with (b) noted

The format decision is still open with the owner. This builds **option (a):
keep his look** - the tailored resume is authored in Markdown and exported
by `tools/export_resume.py`:

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

**Option (b), later**: adopt ai-job-search's LaTeX moderncv templates with
its `verify_pdf.py`/`verify_layout.py` compile-and-inspect loop - the best
ATS text-layer checking, at the cost of rebuilding his look in LaTeX. Only
worth it if ATS rejections become a concern.

## Tools

| Tool | Purpose |
|---|---|
| `tools/posting_guard.py` | integrity gate for untrusted JD text (copied, MIT): strips hidden HTML/invisible characters, flags instruction-shaped lines |
| `tools/grounding_audit.py` | deterministic never-invent audit (metrics, dates, titles, tools vs sources) |
| `tools/ats_keywords.py` | JD keyword coverage: covered vs missing |
| `tools/export_resume.py` | Markdown -> .docx (owner's styles via reference-doc) and PDF, 2-page budget |

All tools are Python 3.10+ stdlib-only; export needs `pandoc` (and a PDF
engine for PDF).

## Tests

```bash
cd jobseek/tailor && python3 -m pytest tests/ -q
```

Fixtures are a fictional persona (`tests/fixtures/`) - no personal data is
committed. The export test skips when pandoc is absent.

## Security posture

- The JD is untrusted third-party data, never instructions - gated by
  `posting_guard.py` whatever its origin, and every prompt that carries it
  restates the boundary.
- The reviewer subagent is read-only (Read/Glob/Grep; no Edit/Write).
- Personal data (master resume, tailored outputs, application archive) stays
  out of git: `jobseek/applications/` and `jobseek/resume/` are gitignored
  (see `jobseek/.gitignore`, owned by the profile worker; `tailor/.gitignore`
  covers this folder's own scratch).
- Sending, applying and recruiter messaging are out of scope - the why-me
  note is a draft the owner sends himself.
