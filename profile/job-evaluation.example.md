# Job Evaluation Rubric - Director/VP AI Strategy

Example rubric (copy to `job-evaluation.md`, which is gitignored), adapted
from ai-job-search's `04-job-evaluation.md` (MIT, see ../NOTICE) and
specialized for the owner's search: Director/VP roles in AI strategy, AI
transformation, business/digital transformation, strategic initiatives, chief
of staff, and innovation - a home metro (Denver, CO in this example) or
US-remote (setup guide, phases 2-6).

The sections marked `[FILL ...]` are owner territory: fill them from the
resume, honestly. The gates below them are already decided by the search
setup and apply to every posting.

## Target role definition (decided, not a template)

Titles in scope: Director, Senior Director, VP, SVP, Head of, General Manager
of the areas above. Chief of Staff to a C-level principal is in scope.

The LinkedIn alert boolean that defines this search:
```
("AI strategy" OR "AI transformation" OR "business transformation" OR
 "digital transformation" OR "strategic initiatives" OR "chief of staff" OR
 innovation)
NOT (engineer OR engineering OR developer OR scientist OR architect OR
 "machine learning")
```

## Seniority Gate - run before scoring

Read the posting's title and seniority signals (reports-to, scope, team size,
"individual contributor" language) and classify:

| Posting seniority | Verdict |
|---|---|
| VP / SVP / Head of / GM / C-level chief of staff | **PASS** |
| Director / Senior Director | **PASS** |
| Senior Manager or equivalent, or seniority genuinely ambiguous from the posting | **FLAG** - keep in the ranking with a visible marker; the owner decides |
| Manager, IC lead, or anything clearly below Director | **FAIL** - excluded from the shortlist whatever the fit score; list under Excluded with the reason |

A FAIL or FLAG is about the *role's* level, never about whether the candidate
could do it. Quote the title or line that drove the verdict.

## Engineering-Role Gate - run before scoring

The alert boolean already excludes these, but alert matching is fuzzy; check
again at scoring time:

| Posting | Verdict |
|---|---|
| The role itself is an engineering/technical IC role: "engineer", "developer", "scientist", "architect", "machine learning" in the title, or the day-to-day is hands-on building rather than strategy/leadership | **engineering_role = true** - excluded from the shortlist; list under Excluded as "engineering/technical IC role" |
| A strategy or leadership role that *manages* engineers or requires technical fluency (AI strategy for an engineering org, transformation of a platform business) | **engineering_role = false** - technical fluency is a plus here, not a mismatch |

When genuinely unsure, `engineering_role = false` and note the ambiguity in
`gaps` - the gate exists to catch IC roles, not to veto technical leadership.

## Location Gate - run before scoring

| Posting location | Verdict |
|---|---|
| Home metro, e.g. Denver, CO (incl. hybrid in that metro) | **PASS** |
| Remote, United States | **PASS** |
| Remote restricted to named states that exclude the home state | **FAIL** |
| Hybrid or onsite outside the home metro | **FAIL** (relocation is a deal-breaker) |
| Heavy travel expectation (>50%) or "remote" with an unstated footprint | **FLAG** |

## Language Gate - run before scoring

The candidate works in English. A posting requiring another language as a job
condition is a **FAIL** (quote the requirement); an unstated or English-only
requirement is a **PASS**. This gate almost never fires on US postings, but a
"global role, fluent German required" line must not slip through.

## Scoring Dimensions (weighted)

Score each 0-100; the tool computes the weighted overall and the 1-10 score.

### 1. Domain & AI Strategy Match (30%)
How well do the posting's core requirements match the candidate's AI strategy,
transformation and innovation work?

| Score | Meaning |
|---|---|
| 80-100 | Core requirements are the candidate's primary work |
| 60-79 | Most requirements match, 1-2 learnable gaps |
| 40-59 | Partial match, significant repositioning needed |
| 0-39 | Fundamental mismatch |

- Strong match areas: [FILL: e.g. enterprise AI strategy, AI operating model, transformation program leadership]
- Moderate match areas: [FILL]
- Weak match areas: [FILL]

### 2. Leadership & Experience Match (25%)
Match on the function and nature of the work, not the literal title: P&L or
budget scope, teams led, executives advised, programs delivered.

| Score | Meaning |
|---|---|
| 80-100 | Direct experience at the same scope and domain |
| 60-79 | Related leadership experience, transferable clearly |
| 40-59 | Adjacent; the case needs making in the application |
| 0-39 | Unrelated |

- Strong: [FILL: direct experience domains]
- Moderate: [FILL: adjacent experience]

### 3. Behavioral / Culture Fit (15%)
Role and company culture vs. the behavioral profile.

- Red flags to research (post-ranking, before applying): department
  disorganization, strategy-role-in-name-only (the job is delivery or ops
  with a strategy title), poor chemistry signals with leadership, recent
  restructuring of the function.

### 4. Career Alignment & Motivation (30%)
Does the role advance the stated direction and contain energizing work?

- Career goals: [FILL]
- Tasks that energize: [FILL]
- Tasks that drain: [FILL]

## Verdict bands and thresholds

- **Strong Fit** (75+): top of the shortlist; tailor and apply this week
- **Good Fit** (60-74): apply, address gaps honestly
- **Moderate Fit** (45-59): discuss with the owner before spending effort
- **Weak Fit** (30-44): skip unless a strategic reason (target employer)
- **Poor Fit** (<30): skip

Gates override bands: a 90-point role that FAILs a gate is excluded, not
ranked first.

## Ranking output contract

Each scored posting carries, per the `run-alerts` command:

- `score` (0-100 weighted), `score_10` (the guide's 1-10), `verdict` band
- `reason`: one line, plain text, grounded in the posting
- `location_verdict`, `seniority_gate`, `engineering_role`
- `strengths` / `gaps`: 1-3 bullets each, honest, from the posting text
- `guard`: the posting_guard verdict line
