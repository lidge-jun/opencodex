# 001 - PR stack status ledger

Continuously updated during the programme. Every branch records: base SHA,
head SHA, PR number/URL, verification result, and review state.

## Programme facts

- Stack base (dev): `e44d234f08e03dd4dbf0c4aa13af43046d86b0a6` (`upstream/dev`)
- `origin/dev` (fork, stale ancestor): `be177ea501e5007f4a56d19d069ef5cd76ea24b9`
- Bun: `1.3.14`; package version: `2.10.0`
- Worktree: `D:\codex-worktrees\ocx-router-intelligence`
- Push remote: `origin` (Wibias/opencodex); PR target: `lidge-jun/opencodex:dev`
- All PRs opened as DRAFT; nothing merged by this programme.

## Related in-flight PRs (not superseded by this stack)

| PR | Branch | Note |
|---|---|---|
| #922 | `fix/914-account-neutral-network` | #914 alternative; consumed as health evidence input by RI-06 |
| #966 | `codex/260804-issue914-transport-attribution` | #914 alternative; consumed as health evidence input by RI-06 |
| #715 | `feat/priority-levels` | Pool selection order; out of scope |
| #988 | `codex/providers-copy-doctor` | GUI providers/combos; conflict-checked at RI-10 |
| #998 | `codex/260803-integration-switches` | Write substrate; rebase watch on request-log.ts |

No open PR found that implements the same vertical as any PR in this stack,
so no stale PR is closed by this programme. Both #914 drafts overlap each
other; closing one is a maintainer decision and neither is stale.

## Baseline

- Full-suite baseline on clean `upstream/dev` (worktree
  `D:\codex-worktrees\ocx-typecheck-base`, head `e44d234f0`): running in
  background; exact pass/fail counts appended here when done.
- `bun x tsc --noEmit` on clean `upstream/dev`: **PASSED** (0 errors, verified
  in the pristine base worktree).
- `bun run privacy:scan`: passed per-PR (see RI-01 below).

## Stack status

| RI | Branch | Base | Head SHA | PR | URL | Status |
|---|---|---|---|---|---|---|
| RI-01 | `feat/ri-01-route-decision-traces` | `e44d234f0` | pending | pending | pending | in progress |
| RI-02 | `feat/ri-02-request-history-index` | `feat/ri-01` head | pending | pending | pending | queued |
| RI-03 | `feat/ri-03-routing-analytics` | `feat/ri-02` head | pending | pending | pending | queued |
| RI-04 | `feat/ri-04-policy-profile-core` | `feat/ri-03` head | pending | pending | pending | queued |
| RI-05 | `feat/ri-05-capability-aware-routing` | `feat/ri-04` head | pending | pending | pending | queued |
| RI-06 | `feat/ri-06-health-aware-routing` | `feat/ri-05` head | pending | pending | pending | queued |
| RI-07 | `feat/ri-07-quota-aware-routing` | `feat/ri-06` head | pending | pending | pending | queued |
| RI-08 | `feat/ri-08-cost-aware-routing` | `feat/ri-07` head | pending | pending | pending | queued |
| RI-09 | `feat/ri-09-route-explainability-api` | `feat/ri-08` head | pending | pending | pending | queued |
| RI-10 | `feat/ri-10-routing-intelligence-ui` | `feat/ri-09` head | pending | pending | pending | queued |

## Per-PR acceptance log

### RI-01 - feat/ri-01-route-decision-traces

- Base SHA: `e44d234f08e03dd4dbf0c4aa13af43046d86b0a6`
- Reviewed commits:
  - `b5a8e7c4c` (implementation; author self-review + CodeRabbit review)
  - `2e0522b2` (privacy-scan fix after CI `gates` failure)
  - `pending` (CodeRabbit findings round; recorded after commit)
- Findings (self-review): 3 test failures caught pre-push - (1) missing value
  import for `normalizeRouteDecisionTrace` in request-log hydration,
  (2) selected combo target marked ineligible because `ComboPick.attempted`
  includes the winner, (3) account-namespace fixture missing the canonical
  ChatGPT forward `baseUrl` (test-fixture bug, not product code).
- Fixes: import fixed; `comboRouteCandidates` now excludes the selected target
  from `already-attempted`; fixture uses `https://chatgpt.com/backend-api/codex`.
- Regression tests: all three cases are covered by the final
  `tests/route-decision-trace.test.ts` (14 tests, 75 assertions).
- Findings (CodeRabbit, verified against code): 12 comments - 9 accepted
  (locale/plan docs, requestedModel bound doc, ledger SHA, combo tieBreak +
  duplicate getCombo, `truncated.requirements` flag, byte-accurate budget,
  parse-once evidence, hydration guard drops invalid traces, 2 regression
  tests, credential-test assertion hardening); 2 design-judgment comments
  (persist trace on every row - kept: bounded ~200 B single-candidate traces,
  plan mandates one trace per decision; docstring coverage - docstrings
  added to trace helpers); the privacy-scan finding was already fixed in
  `2e0522b2`.
- Final commit: recorded after commit (round applies CodeRabbit + simplify
  fixes; new head pushes to #1003)
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/route-decision-trace.test.ts`: 14/14 pass
  - Focused regression suites: 253/253 pass across combos, codex-routing,
    usage-log, request-log, combo-management-api, codex-account-namespaces
  - `tests/server-combo-failover-e2e.test.ts`: 44/44 pass
  - `bun run privacy:scan`: passed
- Remaining Low findings: none

### RI-02..RI-10

Appended as each PR is implemented.
