# 030 Phase 3: verify and deliver (C4, C5)

Depends on: 020. Criteria: C4, C5.

## Gates on the final head

1. `bun run typecheck`
2. Focused files from 010 and 020
3. `bun run test:changed`
4. `bun run structure:check`
5. `bun run privacy:scan`
6. `bun run test` unless disproportionate under concurrent worktree load; then record the AGENTS.md exception with the commands that did run.

## Delivery

- Commit per phase locally; push `fix/8864-aside-prime-developer-role`.
- `gh pr create --base dev --body-file <mktemp>` using `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist), `Closes #8864`, residual risks (alibaba Coding Plan unrecorded, OMP compat follow-up, translations of integrations.md absent).
- `goat_pull_request_link` with the full URL; add no labels except as the template requires; no lane=all dispatch.
- Wait for required PR checks on the exact head; report pass/fail with run links.

