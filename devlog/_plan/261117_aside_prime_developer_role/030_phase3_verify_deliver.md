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


## wp3 cycle record

- Previous D (wp2): C3 landed in 48c7ce6bee; 605 focused tests, structure:check and privacy:scan pass; a count_tokens flake in `tests/claude-integration/messages-error-normalization.test.ts` reproduces on `origin/dev` `c36793a933` (1-2 of 6 runs), so it is pre-existing. Direction: final gates, fresh independent review of the whole diff, then PR.
- `test:changed` selects most of the suite for this diff (`config-export.ts` and the registry are hubs) and hit its 900s cap at load ~23 in wp1; it is retried here at lower load, and PR CI's `test changed` job is the authoritative run if it cannot finish locally.
- Final review: a fresh Morph reviewer (no continueFrom) audits the full `origin/dev...HEAD` diff before the PR is marked ready.

