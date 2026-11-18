# 010 — carry #8563, #8749, #8575

Stale check at wp1 entry: `origin/dev` still `c36793a933`; PR heads unchanged (c359dcac7, 180caac76, 013dc428e).

Each carry is one commit created by squashing the PR head onto the lane branch. Commit author stays the
lane; the original author is credited with a `Co-authored-by` trailer (AGENTS.md, "Landing another
author's work").

## Commands

```bash
git fetch origin pull/8563/head:refs/pr/8563 pull/8749/head:refs/pr/8749 pull/8575/head:refs/pr/8575
git merge --squash refs/pr/8563   # head c359dcac799365acbf9e973c23e46a80506fa838
git commit -F <msg>               # "fix(combo): hop on unoffered tool-call refusals (#8563)"
                                  # trailer: Co-authored-by naming Omar (@omar391) at his commit address
git merge --squash refs/pr/8749   # head 180caac769021512a46f932f0c5d79163cba1034
git commit -F <msg>               # "fix(combo): time a rotated attempt from its own send (#8749)"
                                  # trailer: Co-authored-by naming Andrew (@andrew05060414) at his commit address
git merge --squash refs/pr/8575   # head 013dc428e90eb3a932a85509f36e706bc3b0229c
# + doc amendment below
git commit -F <msg>               # "fix(combos): resolve devin context windows for combo input admission (#8575)"
                                  # trailer: Co-authored-by naming Omar (@omar391) at his commit address
```

#8749's branch contains a merge of `upstream/dev`; the squash takes only its net diff against the lane.

## Files per carry (verbatim from the PR heads)

- #8563: MODIFY `src/combos/failover.ts` (+`isUnofferedToolCallRefusal`, wired into `comboFailureCooldownScope`
  -> "none" and `decideComboFailure` -> "hop"), `src/server/responses/core-combo-failure.ts`
  (classify intact bounded body), `src/server/responses/core-combo.ts` (pass verdict, two call sites),
  `src/server/responses/core-options.ts` (`ConsumedComboFailure.unofferedToolCallRefusal`),
  `structure/transports/responses-combo-boundaries.md` (new section); NEW
  `tests/routing/combo-unoffered-tool-refusal.test.ts`, registered in `scripts/test-layout/layout-combos.json`
  and `tests/fixtures/test-layout-expected.json`.
- #8749: MODIFY `src/server/responses/core-combo.ts` (`segmentStartedAt()` replaces `started` in each
  `finishRequestAttempt`, `firstOutputMs` and `activeAttemptStartedAt`), `src/server/responses/core-combo-native.ts`
  (`finish` uses `childLog.activeAttemptStartedAt ?? startedAt`); NEW
  `tests/responses/combo-stream-attempt-timing.test.ts`, registered in the same two layout files.
- #8575: MODIFY `src/adapters/devin/live-models.ts` (`swe-2` 262_000 -> 850_000, `swe-2-flash` 262_000),
  `src/providers/stale-context-window-migration.ts` (`{devin, swe-2, 262_000 -> 850_000}`),
  `src/server/responses/input-admission.ts` (`adapterContextWindow` fallback for devin, dotted-id
  normalization for `modelMaxInputTokens`), `structure/transports/responses-failover.md`, tests in
  `tests/providers/context-window-seed-repair.test.ts`, `tests/providers/devin-adapter.test.ts`,
  `tests/server/input-admission.test.ts`.

## Amendment to #8575 (open CodeRabbit thread on responses-failover.md:483)

The strict check runs only when the target's window and input ceiling both resolve; a declared output
allowance alone does not select it (`checkComboTargetInputAdmission` falls back when
`window === null || ceiling === null || requestedOutput === null`).

```diff
-... The context window itself is what input and output actually share. When the caller declared `max_output_tokens`, `checkComboTargetInputAdmission` requires both ...
+... The context window itself is what input and output actually share. When the target's context window and input ceiling both resolve and the caller declared `max_output_tokens`, `checkComboTargetInputAdmission` requires both ...
```

## Verification

```bash
bun test tests/routing/combo-unoffered-tool-refusal.test.ts tests/responses/combo-stream-attempt-timing.test.ts \
  tests/server/input-admission.test.ts tests/providers/context-window-seed-repair.test.ts tests/providers/devin-adapter.test.ts \
  tests/routing/router-combo-failover-classification.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts \
  tests/ci-workflows/file-size-ratchet.test.ts
bun run typecheck
```

Regression proof: #8563's and #8749's new tests fail on `origin/dev` source (checked by reverting the
`src/` hunk of each commit and rerunning that file); #8575's input-admission devin cases likewise.

## Outcome (wp1)

Commits `306d3ee75` (#8563), `65d76c8e5` (#8749), `e48adb1c9` (#8575 plus the doc amendment). Focused set
plus `tests/lab/core-lab-boundary.test.ts`: 361 pass, 0 fail; `bun run typecheck` clean (2,564 files).
Reverting each commit's `src/` files fails its new tests (5, 1 and 7 failures respectively), so each test
guards its fix. What did not change: #8575's seed repair still rewrites an operator's deliberate 262_000 for
`swe-2`, the same rule every existing stale-window entry follows; the review thread asking for an opt-in
repair stays a residual for maintainers.

