# 000 — L7 CI/infra stability: master plan

Lane L7 of the 2026-10-09 coordination round. Base: `origin/dev` `c15037b324`.
Branch for this roadmap: `codex/ci-infra-stability`. Each implementation work-phase
ships as its own PR to `dev` from a sibling worktree `.tmp/lanes/L7-ci-infra-<n>`.

## Objective

1. Find and fix the ownership defects behind the recurring Windows test-teardown
   failures (`EPERM`/`EBUSY` while removing a fixture root). Raising a timeout is not a fix.
2. Carry the CI/infra contributor PRs #6783, #6726 and #6723 (split), then the B-tier
   PRs #6779, #6754 and #6765, each with `Co-authored-by` credit.
3. Report #6472 and #6654 to the maintainer without carrying them.

Every PR stops at merge-ready: exact-head CI green plus an independent gpt-6.1-sol review
PASS. Merging, releasing, commenting on or closing contributor PRs, and approving fork
workflow runs all need the maintainer.

## Constraints

- Local tests are minimal: focused files for the changed behavior and `bun run typecheck`.
  Hosted CI is the main evidence. Every PR's Verification section names the exact commands
  and what was left to CI.
- AGENTS.md gates: file-size ratchet (`tests/fixtures/file-size-baseline.json`; uncapped
  files must stay below 2000 lines), test layout (new test files go in both
  `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`),
  `structure/` ownership sync, PR template, `dev` target.
- Lane boundaries: L1 owns desktop runtime ownership and launchers (so #6765 is coordinated
  with L1), L2 owns service/journal, L5 owns auth/quota. L7 does not edit their areas.

## Evidence (2026-10-09)

| Failure | Run / job | What the log shows |
| --- | --- | --- |
| (a) management auth | 37833647677 / 113537302143 (#6772, windows 8/9) | `server-management-auth.test.ts:220` afterEach → `removeTreeWithRetry` → `EPERM` after the 15 s retry budget; case time 15993 ms |
| (b) picker startup | 37735258668 / 113173321175 (dev, windows 3/9) | `claude-picker-startup.test.ts:24` raw `rmSync` `EBUSY` after `handle.stop()` |
| (c) OAuth live update | 37636581013 / 112844420207 (dev, windows 9/9) | `oauth-login-cli-live-update.test.ts:60` afterEach `EPERM` |

The "ACL hardening timed out" warnings near (a) come from an earlier mocked-timeout case,
so they do not prove a live icacls child under (a)'s root. The logs prove that teardown
failed; they do not name the native handle owner. Static reading of current dev confirms
three concrete ownership gaps:

- G1 `src/lib/windows-secret-acl.ts:417-479`: the removal barrier sees only runners that
  outlived the outer belt. Normal in-flight icacls runners, and the gaps between successive
  commands of one harden, are invisible to `flushWindowsSecretAclReapsBeforeRemoval`.
- G2 `src/routing/history/indexer.ts:356-384,481-487`: the request-history SQLite index
  (WAL) stays open after server stop, and the management-auth and OAuth live-update
  fixtures never call `closeRequestHistoryIndex()` (only `tests/routing/policy-execution.test.ts:23` does).
- G3 `tests/oauth/oauth-login-cli-live-update.test.ts:55-60`: synchronous teardown
  with no producer, config-flight or ACL drain before removal.

(b) is already fixed on dev by #6748 (`b6ec62ae43`, `cleanupPickerStartup`).

Research reports (scratch, untracked): `.tmp/research/r1_teardown.md`, `r2_6783.md`,
`r3_6723.md`, `r4_btier.md`.

## Decisions

| ID | Decision | Reason |
| --- | --- | --- |
| D1 | Fix G1-G3 in one teardown PR (wp1) built from #6723's ACL registry and drain hunks, #6783's fixture extraction and history close, and new OAuth teardown code | Three failures, one ownership contract; neither source PR alone covers it |
| D2 | wp1 adds Bun regression tests for the ACL flight registry and does not introduce #6723's Rust crate | Ordinary CI does not invoke the crate; only #6723's new workflow does, and that needs a separate security review (wp5). Bun tests run in every shard |
| D3 | Transplant #6723's close-awaiting WebSocket helper into #6783's extracted `tests/helpers/management-auth-fixture.ts` | Applying both inline pushes `server-management-auth.test.ts` to 2005 lines |
| D4 | #6783's retry-only cleanup hunks go into wp1 for files #6723 does not touch; where both touch a file, #6723's drain-then-retry wins | Retry alone does not settle producers |
| D5 | #6783's cache-isolation core, warm-ups, bounded children and serial GUI gate become wp2 | Separate concern (cache ownership) from removal ownership |
| D6 | #6723 splits into runtime (wp4) and CI/Rust diagnostics (wp5); the storage policy-load barrier moves to wp1 | The storage hunks are test barriers; the runtime has no dependency on the workflow |
| D7 | #6472 is not carried in L7 | It changes credential/session behavior, needs human security review and live Student acceptance, and leaves `core.ts` at 210/210 |
| D8 | #6654 is report-only | Its new 256 KiB generated-attribution cap (HTTP 413) is a product policy only the maintainer can accept |

## Work-phase map (dependency order)

| WP | Doc | Unit | Depends on |
| --- | --- | --- | --- |
| wp0 | this file | Roadmap (docs only) | — |
| wp1 | 010 | Windows removal ownership (G1-G3) | wp0 |
| wp2 | 020 | #6783 transpiler-cache isolation | wp1 |
| wp3 | 030 | #6726 link-test isolation | wp0 |
| wp4 | 040 | #6723 runtime: async catalog probes, budget release on abort | wp1 |
| wp5 | 050 | #6723 CI: contracts workflow + Rust diagnostics (security review, draft) | wp4 |
| wp6 | 060 | #6779 and #6754 provider carries | wp0 |
| wp7 | 070 | #6765 desktop hint (with L1) + #6472/#6654 reports | wp0 |

Execution model: after this roadmap is locked, gpt-6.1-sol subagents may prepare
independent branches in parallel in their own sibling worktrees. The coordinator still runs
one PABCD cycle per work-phase: P re-verifies the decade doc against the live branch, A is
an independent review, B finalizes and pushes, C reads exact-head CI, D records the result.

## Verification policy per PR

- Focused: the changed and new test files, `bun run typecheck`, `bun run privacy:scan`,
  `bun run structure:check`, plus `tests/test-layout.test.ts` when layout tables change.
- Hosted: exact-head Cross-platform CI with all Windows shards. One failure on a
  Windows shard in a file the PR does not touch is classified from its log before any
  single re-run; it is never re-run silently.

## Architect consultation record

Proposals: r1 (teardown root cause, agent `01a11e37-20f2`), r3 (#6723 split,
`01a11e37-2262`), r2 (#6783), r4 (B-tier). Main dispositions: D1-D8 above. D2 amends r3's
recommendation to ship a minimal Rust crate in the harness PR. Reflection: see 001.
