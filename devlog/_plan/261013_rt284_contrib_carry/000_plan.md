# L2 — contributor carry for the 2.84.0 release train

Lane L2, thread session `01a130c8-402a-7121-8f45-80144f1912d0`. The coordinator thread
`01a130be-2e10-7af0-adf9-efca9fe37e30` owns push, PR creation, merge, and release.

- Worktree: `/private/tmp/rt284-lanes/L2`
- Branch: `codex/rt284-contrib-carry`
- Base: `origin/dev` `3e58c2ce3ee5433901ed467fe87c32fb4b5c5e77`
- Status file: `/private/tmp/rt284-lanes/status/L2.md`

## Carry order and method

Each source PR becomes one squashed commit made with `git merge --squash` of the PR head. The
commit keeps the original author (`git commit --author`), and its message carries the PR title,
the line `Carried from #N`, and a `Co-authored-by:` trailer for that author.

| Order | PR | Author (trailer identity) | Head | Disposition |
|---|---|---|---|---|
| 1 | #7005 (fixes #7004) | Ingwannu <ingwannu@users.noreply.github.com> | 5f81eab523 | CARRY |
| 2 | #7001 (#7000) | Ingwannu <ingwannu@users.noreply.github.com> | 6f50b502e1 | CARRY |
| 3 | #7003 (#6764) | Robin Bially <7304732+robin-bially@users.noreply.github.com> | 08a4f130a9 | CARRY-WITH-FIX |
| 4 | #7002 (draft) | NineDayCC <110006840+NineDayCC@users.noreply.github.com> | 913e64ddcf | CARRY after independent review, else SKIP with reason |
| 5 | #6968 | LilMGenius <smsmeee@naver.com> | 78f75273d5 | CARRY |

## #7003 fixes (separate commit after the carry, Co-authored-by Robin Bially)

The fix commit answers Ingwannu's CHANGES_REQUESTED review of `08a4f130a9`:

1. Scope `CHECKPOINT_CONTINUATION_NOTE` in `src/responses/compaction.ts` to work that was already
   authorized and is still in scope. It must keep existing permission and confirmation gates,
   state that a checkpoint or delegation grants no new authority, and let later user messages
   that pause, cancel, or replace the task win. Prompt-contract fixtures cover a task that is
   active but awaiting a decision, scoped delegated work, and a later pause/cancel/replacement.
   These assert prompt text, not model behavior.
2. Add translated-route wire assertions. Each real adapter outbound request built from the
   parsed context must keep both the pre-existing instructions and the note (CodeRabbit
   `src/responses/parser.ts:594`).
3. Sync the structure docs that own `responses/parser.ts`, `responses/compaction.ts`, and the
   passthrough path. They must record conditional application, summarizer/native-opaque
   exclusions, the unchanged `SUMMARY_PREFIX`, and the authorization limit.

The detailed design comes from the architect consultation recorded in `010_execution.md`.

## Union constraints

- `scripts/test-layout/layout.json` is 1999 lines on dev and must stay below 2000. The #7003
  entry is appended to an existing line, and later entries follow the same rule.
- New test files are registered in both `layout.json` `explicit` and
  `tests/fixtures/test-layout-expected.json`.
- No lines are added to files at their `tests/fixtures/file-size-baseline.json` cap. New
  cases go in sibling files.

## Verification (C)

Run with `OCX_TEST_RUNNER_BUN=/Users/jun/.cache/rt284-bun/bun-darwin-aarch64/bun` in
`/private/tmp/rt284-lanes/L2`:

- Focused tests for each carried PR:
  - `tests/codex-integration/codex-clamp-notice.test.ts`
  - `tests/codex-integration/codex-quota-auto-refresh.test.ts`
  - `tests/responses/compaction-continuation-note.test.ts` and the new adapter wire test
  - `tests/codex-integration/main-account-credit-renewal.test.ts`,
    `main-account-hard-lock-retirement.test.ts`, and `main-quota-provenance.test.ts`
  - `gui/tests/lazycodex-role-models.test.tsx`
- `bun run typecheck`
- `tests/ci-workflows/file-size-ratchet.test.ts`, `tests/test-layout.test.ts`, and
  `tests/test-layout-tooling.test.ts`
- `bun run structure:check` and `bun run privacy:scan`
- `bun run lint:gui`

## Review and terminal state

An independent sol reviewer checks the final head and returns PASS, NEAR-PASS, or FAIL. Any
NEAR-PASS residuals are folded or rebutted. The lane ends DONE with the final report, or
BLOCKED/NEEDS_HUMAN when a maintainer objection cannot be met in code or a guard cannot pass
without being weakened.

