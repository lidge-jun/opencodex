# 001 — Branch inventory against `dev` `87e3ff9f6`

Every one of the seven heads was fetched to a local `pr/<n>` ref and checked
with `git merge-tree --write-tree dev pr/<n>`.

## Clean-apply results

| PR | Head | merge-tree | Conflicts |
|---|---|---|---|
| #1460 | `7bf8b84a1` | tree `0ebfed59c` | none |
| #1462 | `2f9225915` | tree `3c14d646e` | none |
| #1465 | `681c8821f` | (directly on tip) | none |
| #1461 | `9e5cc13f5` | — | none |
| #1452 | `47271935f` | tree `393a07acd` | none |
| #1434 | `89a96ce0e` | tree `81807d7b3` | none |
| #1441 | see 070 | — | none |

All seven apply without conflict. Being behind `dev` and conflicting are
different things: #1452 is 8 commits behind and still applies cleanly.

## Diff shape

| PR | Files | +/- | Production files touched |
|---|---|---|---|
| #1460 | 4 | +104/-5 | `src/codex/catalog/sync.ts` |
| #1462 | 2 | +120/-18 | `src/config.ts` |
| #1465 | 6 | +408/-4 | `src/service.ts`, `src/server/startup-action-control.ts` |
| #1461 | 6 | +142/-4 | `src/codex/sync.ts`, `src/codex/inject.ts` |
| #1452 | 3 | +135/-1 | `src/lib/windows-user-principal.ts` |
| #1434 | 8 | +572/-25 | `src/adapters/google-antigravity-replay.ts`, `src/server/lifecycle.ts` |
| #1441 | 9 | +1859/-26 | `src/codex/shim.ts` |

No two production files collide across the seven, so the work-phases are
genuinely independent and can land in any order that respects risk.

## Baseline facts established this session

- `bun run typecheck` on clean `dev`: passes.
- `bun test tests/windows-user-principal.test.ts tests/windows-elevation.test.ts`
  on `pr/1452`: 23 pass / 0 fail.
- `bun test tests/google-antigravity-replay.test.ts tests/shutdown-drain.test.ts`
  on `pr/1434`: 70 pass / 0 fail.
- `bun test tests/codex-catalog-sync-hardening.test.ts tests/codex-convergence-account-selectors.test.ts`
  on `pr/1460`: 42 pass / 0 fail.
- `bun test tests/config-user-edits.test.ts` on `pr/1462`: 34 pass / 0 fail;
  the same file against unfixed `dev`: 32 pass / **2 fail**. The contributor's
  new tests are genuine red-then-green regressions.

A green contributor suite is the starting point of the audit, not its
conclusion: #1460, #1462, #1434 and #1452 are all green on their own heads and
all four still carry a real defect (see 010, 020, 050, 060).
