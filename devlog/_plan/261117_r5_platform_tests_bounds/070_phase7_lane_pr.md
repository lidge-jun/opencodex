# wp7 — lane PR and report

- Final head: `bun run typecheck`, the focused files of every carry, `bun run test:changed`,
  `bun run structure:check`, `bun run privacy:scan`; full `bun run test` if the host allows,
  otherwise the AGENTS.md resource exception recorded in the PR.
- Push `triage/r5-platform-tests-bounds`, open one PR to `dev` with every template section, link
  it in GOAT, wait for the exact-head PR checks, fix real failures.
- Report to origin: outcome, base SHA, PR URL, head SHA and checks, the per-item table, NOT RUN,
  subagent models, residual risk.

