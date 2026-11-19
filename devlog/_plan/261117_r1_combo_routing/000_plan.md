# R1 combo-routing lane — plan (2026-11-17)

Base: `origin/dev` at `c36793a9336b70cfe5bc3b7f6e6f751e730fb6fc`. Branch: `triage/r1-combo-routing`.
Authority: push this branch and open one lane PR to `dev`. No merge, no edits to other PRs, no `lane=all` dispatch.

## Why no item is merge-ready

Every PR in the lane is from a fork. On each exact head, the `Cross-platform CI` workflow (which owns
`gates` and `test changed`) and `Catalog async contracts` sit in `action_required`: they never ran. Only
`enforce`, `hygiene` and `label` passed. Without green required checks none qualifies as MERGE-READY, so
sound PRs are carried onto this branch, where CI runs.

## Triage

| Item | Head | Class | Reason |
| --- | --- | --- | --- |
| #8563 hop on unoffered tool-call refusals | c359dcac7 | CARRY | Self-contained classifier in `src/combos/failover.ts`; no open threads; CI never ran. |
| #8749 time a rotated attempt from its own send | 180caac76 | CARRY | Draft, sound logging arithmetic; no review threads; CI never ran. |
| #8575 devin context windows for combo admission | 013dc428e | CARRY | Sound adapter fallback; the open Major thread is already fixed at head (`tests/providers/devin-adapter.test.ts` expects 850_000); one doc wording thread is folded in here. |
| #8857 Anthropic pool funded-roster failover | d1545947d | CARRY | Maintainer-invited parity PR for #8759; credential path, so it gets an independent security review. The PR only addresses #8759; the lane PR closes it. |
| #8759 scale Anthropic pool failover cap | issue | CARRY (via #8857) | Maintainer accepted a parity PR with the conditions #8857 covers. |
| #8645 committed-terminal cooldown + degenerate hop | a896a5f58 | DEFER | Unresolved Major CodeRabbit finding (cooldown compares summed output across attempts); `degeneratePrelude: true` holds reasoning frames up to 1 s on every combo stream and adds a 10-minute cooldown policy: maintainer review. |
| #8585 reserve output headroom in admission | ddefc44ab | DEFER | Replaces the documented fail-open rule for an undeclared output allowance with heuristic 10% / 1.1x constants; a design decision. Conflicts with #8575 in `tests/server/input-admission.test.ts` and the structure doc (`input-admission.ts` itself merges cleanly). |
| #8862 synthetic replay refusal not a quota failure | 58f1501ec | DEFER | Draft; `replaySafe: true` for every self-contained request bypasses the operator ambiguous-resend allowance in `fetchWithResetRetry` (`src/lib/upstream-retry.ts`), a replay-policy decision; unresolved CodeRabbit finding about compaction skipping the stored-body check. |
| #8312 combo modality intersection | issue | DEFER | A maintainer called the strict intersection documented design (`docs-site/.../guides/combos.md`); the `dsh` refresh needs a lock decision. |

## Overlap and landing order

`git merge-tree` against `origin/dev`: each PR merges cleanly alone. Pairwise, #8645 x #8749 conflict in
`scripts/test-layout/layout-combos.json`, and #8585 x #8575 conflict in `structure/transports/responses-failover.md`
and `tests/server/input-admission.test.ts`. #8563 and #8749 both edit `core-combo.ts` and the combos layout
shard but merge cleanly together. #8857 edits the Anthropic dispatch paths; it shares only
`structure/transports/responses-failover.md` with #8575 and `tests/fixtures/test-layout-expected.json` with
#8563/#8749. The full squash chain #8563 -> #8749 -> #8575 -> #8857 was verified conflict-free.

Landing order: #8563 -> #8749 -> #8575 -> #8857. For the deferred PRs, a later landing order is #8645 after
this lane (rebase over #8563/#8749 in `core-combo.ts` and the layout shard), #8585 after #8575 (rebase its
doc and tests), #8862 independently once the replay policy is decided.

## Constraints checked

A simulated merge of all four carries (`git merge-tree` chain) keeps every touched file under the ratchet:
no touched file is in `tests/fixtures/file-size-baseline.json`, the largest are `scripts/test-layout/layout.json`
1999 (unchanged by #8857, which edits an existing line) and `src/server/responses/adapter-dispatch.ts` 1990.
`structure/providers/anthropic-account-pool.md` ends at 599 lines against the 600-line structure budget.

## Phase map

| Phase | Doc | Depends on | Outcome |
| --- | --- | --- | --- |
| wp0 | this unit | — | Roadmap locked. |
| wp1 | 010 | wp0 | #8563, #8749, #8575 carried as three commits. |
| wp2 | 020 | wp1 | #8857 carried after security review. |
| wp3 | 030 | wp2 | Final gates, lane PR, CI on exact head, report. |

