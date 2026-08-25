# 030 — wp5: hygiene-blocked and draft PRs

Two distinct gate failures, not one.

### #2567 — `missing_regression_test` (satisfiable)
The change sets `timeout: 0` on upstream fetches. The gate objects because the PR
changes source files and adds no test.
Fix: add propagation coverage in `tests/fetch-header-timeout.test.ts` and
`tests/claude-messages-endpoint.test.ts`.

### #2490 — `unsponsored_surface` only
Quota-window preservation. Code was reviewed and found sound; CodeRabbit's one finding
was resolved by the author. The failing gate is a maintainer-sponsorship requirement on
the quota surface, not a defect.
Action: sponsor, verify at exact head, merge.

### #2497 — `unsponsored_surface`, credential boundary
Native-main token refresh and replay. This is the authentication/credential surface that
`AGENTS.md` places under explicit security review, and the change is unmerged, so its
analysis is pre-disclosure material. Per `AGENTS.md` §"Security working notes" the
review notes live in scratch (`.tmp/260825_backlog_scratch/`), not here.
Action: rebase, exact-head security review, then sponsor. HIGH risk; do not shortcut.

### #2488 — two correctness blockers
1. `adapterFailureFromEvent` overwrites the classified policy code before testing it
   (`src/bridge.ts:131`), so a conflicting-code policy failure stays 502/retryable —
   a retry across a safety boundary.
2. `normalizeUpstreamErrorText` takes the first field-bearing envelope
   (`src/server/responses/core.ts:694`) whereas passthrough scans every candidate
   (`src/server/responses/passthrough-error.ts:15`), so a generic outer envelope can
   hide a nested `cyber_policy`.
Both need regressions in `tests/cyber-policy-error-fidelity.test.ts`.
Serialization: this PR touches `core.ts` and `src/lab/` — see 001 §H2.

### #2542 — stale catalog during refresh
All code-review findings addressed at head `e30a0cfd`, but 51 commits behind and the
focused file still reports one failure at
`tests/codex-app-server-processes.test.ts:925`.
Action: rebase, then dispose of that failure at exact head.

