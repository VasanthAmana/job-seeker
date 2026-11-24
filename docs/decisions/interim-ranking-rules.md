# Rule ranking before criteria sets exist

- **Status:** decided (until phase 3)
- **Phase:** 1
- **Date:** 2026-11-24

## Context

Phase 1 ranks jobs by rule score (AT-1.1), but the rule ranker scores a job
against a criteria set (design 8.4), and criteria sets with their approval
records only arrive in phase 3. The legacy import also brings the
predecessor's scores, which the posting-scorer agent made by reading each
posting against the user's rubric.

## Decision

- Until criteria sets exist, the rule ranker reads its criteria from
  `ranking.rules` in `config.json` in the data directory: target titles,
  keywords, domains, seniority levels, excluded title terms, locations and a
  salary floor, with weights for the five dimensions (title, skills, domain,
  seniority, location). Empty lists are neutral (50 for a dimension, PASS for
  a gate). Rule scores are re-computed for every job when these rules change.
- Gates: an excluded title term, a seniority below the lowest target level,
  a location outside the targets, or a known salary below the floor vetoes
  the job. A title with no seniority signal, or an unknown location, is
  flagged, not vetoed.
- The predecessor's scores are imported as `assistant` scores marked
  `legacy_import`. Their gate vetoes hold (the user's earlier judgement that
  a job is out of scope stands), but the shown score is the rule score,
  because those scores were made without a profile version (design 8.6).
- Judgement scores (`rank_submit`) use the rubric weights in
  `ranking.weights` (domain, leadership, behavioral and career by default,
  as the predecessor did). A judgement never lifts a rule veto, and the
  newest judgement's own veto holds too.

## Alternatives considered

- **Creating a criteria set without an approval** - would break design 9.1's
  rule that every criteria version comes from an approved change, and would
  need migrating once approvals exist.
- **Showing the predecessor's scores as current** - they would outrank rule
  scores computed against the user's current rules, with no profile version
  to say what they were made against.

## Consequences

- Phase 3 replaces `ranking.rules` with criteria sets: `criteria_propose`
  can offer the configured rules as the first set, and the rule ranker then
  scores against the approved criteria version, recording it in
  `job_scores.criteria_version`.
- Until then, a user edits `ranking.rules` by hand; `setup` writes an empty
  template with a comment saying so.
