# Client checks

Each phase ends with its MCP acceptance scenarios (`AT-<phase>.<n>`) passing
in CI, then repeated **by hand** in Claude Desktop and in Codex (execution
plan section 3). The checklist for a phase lives here as `phase-<n>.md`;
copy [TEMPLATE.md](TEMPLATE.md) for a new phase.

Rules for these files:

- The steps use plain requests a user would type, not test commands; the
  point is to prove the flow works from a real client.
- A check that touches a real account is named `MC-<phase>.<n>` and refuses
  to run when `CI=true`. Its notes record **outcomes only**, never personal
  data - this repository is public.
- Client differences discovered while running a check (for example,
  elicitation support) are written up in
  `docs/decisions/mcp-clients.md` (created by the first such finding).
