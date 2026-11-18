# wp5 — verify, publish, observe CI

1. On the final head: `bun run typecheck`, the focused files from 010–040, `bun run test:changed`,
   `bun run structure:check`, `bun run privacy:scan`, `bun test tests/ci-workflows/file-size-ratchet.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts`.
   Full `bun run test` if the host allows (4 cores); otherwise record the AGENTS.md resource exception.
2. Push `triage/r3-provider-adapters`; open one PR to `dev` using `.github/PULL_REQUEST_TEMPLATE.md`
   (Summary, Verification, Checklist), with `Supersedes #8703`, `Supersedes #8827`, `Supersedes #8591`,
   `Supersedes #8861` (partial, catalog hunk excluded), `Closes #8558`, `Closes #8702`. Link it with
   goat_pull_request_link.
3. Observe the required PR checks (`gates`, `test changed`, `ci`) on the exact head; fix real failures.
4. origin.report with the per-item table, NOT RUN list, subagent models and residual risk.
