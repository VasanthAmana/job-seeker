# jobseek/expand - profile expansion from public sources

`expand` finds the things about the owner that are **already public** and not
yet written down in `jobseek/profile/candidate-profile.md`: what they have
built on GitHub, what they have published, where they have spoken, which
boards and committees name them, who has written about them. It proposes
those as profile additions - each one quoting the page it came from - and
never touches the profile itself.

Adapted (MIT, see `jobseek/NOTICE`) from ai-job-search's `/expand`.

## Two entry points

**The MCP tool** - non-interactive, deterministic, the one a script or a
non-Claude-Code client calls:

```
expand_profile(sources?: ["github", "scholar", "linkedin", "talks", "press", "board", "site"])
```

**The CLI**, which is the same code:

```bash
python3 jobseek/expand/tools/expand_profile.py --json
python3 jobseek/expand/tools/expand_profile.py --sources github,scholar
python3 jobseek/expand/tools/expand_profile.py --url press=https://example.com/article
```

**The Claude Code command** - `jobseek/expand/expand.md`, for the fuller
version: web-searching for talks and press the profile does not link, richer
reasoning, and the `all`/`review`/`skip` confirmation before anything is
written. Make it available at the workie root:

```bash
mkdir -p .claude/commands
ln -sf ../../jobseek/expand/expand.md .claude/commands/expand.md
```

## What it reads, and when

Only the sources `candidate-profile.md` itself names. No handle in the
profile means no scan - nothing is guessed from a name, and a source type
with nothing to scan is reported as skipped with that as the reason.

| Source | Needs | Read via |
|---|---|---|
| GitHub | a `github.com/<user>` URL or a `- **GitHub:** <handle>` line | the public REST API: the profile, every public repo (not just pinned), each README |
| Google Scholar | a `scholar.google.*` URL | the profile page's publication table: titles, venues, years, the citation counts Scholar shows |
| LinkedIn | a `linkedin.com/in/<slug>` URL | `jobseek/linkedin`'s read-only `linkedin_search_people` when the vendored app is running and signed in; otherwise a plain fetch, which LinkedIn normally refuses |
| Talks / board / press / site | any other URL in the profile, classified by its label (`- **Press:** ...`) or its path (`/speakers/`, `/advisory-board/`) | a gated fetch, quoted as pointers |

A URL the profile does not list can be added per run with `--url kind=URL`,
or permanently in the gitignored `config.json`:

```json
{
  "expand": {
    "extra_sources": [
      {"kind": "board", "url": "https://foundation.example.org/advisory-board"},
      {"kind": "press", "url": "https://example.com/2026/ai-strategy-interview"}
    ]
  }
}
```

## What it writes

One file: `jobseek/profile/expand-proposals.md` (gitignored - it is derived
from the owner's public identity and is personal by definition). It is
**overwritten on every run**, carries a "proposed - not yet applied" header,
and every line carries its basis and its source:

```markdown
## Publications & Thought Leadership

- **[A]** Publication: "Governing enterprise AI: an operating-model view"
  (Journal of Applied AI Governance 12 (3), 44-61 - 2024) [187 citations per Scholar]
  - evidence: "D Okonkwo, R Vance | Journal of Applied AI Governance 12 (3), 44-61 | 2024"
  - source: Google Scholar - https://scholar.google.com/citations?user=...
```

`[A]` is a direct citation - the page literally says it. `[B]` is a reasoned
inference, and never states a title, a number or a date that no source
showed. `[A+B]` is the same item reached both ways.

**Nothing is ever written to `candidate-profile.md`.** The only path this
code will write to is a file named `expand-proposals.md`; any other target is
refused before a single page is fetched. The owner applies what survives by
hand.

## Categories

Six, aimed at a Director/VP AI-strategy profile rather than at the
individual-contributor shape the original `/expand` uses:

| Category | What lands there |
|---|---|
| Strategic & Leadership Scope | programme and organisational scope, operating models, who is advised |
| Board & Advisory Roles | board seats, advisory boards, trustee and committee roles |
| Publications & Thought Leadership | papers, venues, Scholar's own citation counts, standards work |
| Speaking & Public Visibility | talks, keynotes, panels, the public professional footprint |
| Press & Media Mentions | named coverage in press and trade publications |
| Technical & Domain Depth | what was actually built or shipped, and the domains it sits in |

## Safety

- **Every page is untrusted.** A README, a Scholar page and a press article
  go through the same stack a job posting does:
  `tools/robots_check.py` -> `tools/fetch_page.py` -> `tools/posting_guard.py`.
  Hidden text is removed; instruction-shaped lines are skipped rather than
  quoted; a page that trips the gate is still used, but the verdict is
  printed in the source table and every line derived from it is marked
  **⚠ flagged source**.
- **Read-only everywhere.** GET only, robots.txt enforced on the first hop
  and on every redirect, no token read or sent, nothing posted, no LinkedIn
  write tool ever called.
- **One bad source is a skipped row**, with its reason, not a failed run.
- **Fetched bytes never land in the repo**: they go to a temporary directory
  and are deleted when the read returns.

## Layout

```
jobseek/expand/
├── README.md                  # this file
├── expand.md                  # the Claude Code /expand workflow
└── tools/
    ├── profile_sources.py     # read candidate-profile.md -> the sources it names
    ├── read_source.py         # the one gated, guarded fetch path
    ├── github_source.py       # profile + every public repo + READMEs
    ├── scholar_source.py      # publications, venues, citation counts
    ├── linkedin_source.py     # jobseek LinkedIn tool, else the web path
    ├── web_source.py          # talks / board / press / site pages
    ├── competency_map.py      # categories, dedupe, the proposals file
    └── expand_profile.py      # the orchestrator and the CLI
```

## Tests

```bash
cd jobseek/expand && python3 -m pytest tests/ -q
```

Fixtures only. No test touches the network: every read goes through the real
`read_source.read_url()` with a fetcher that serves a saved fixture, so the
integrity gate under test is the shipped `posting_guard.py` rather than a
stub. Every person, company and host in the fixtures is invented.
