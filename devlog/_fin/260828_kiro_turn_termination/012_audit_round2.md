# A-phase audit round 2 — verdict FAIL on wp2, wp1 cleared

Same reviewer as round 1 (blocker-closure reuse). Round 1's seven findings were
all accepted; this round re-read the revised plan.

## wp1 — cleared

The reviewer confirms the revised placement, criteria, and completion language
are sufficient: bypassing transport, request building, and the empty-completion
guard, with guard-on/guard-off and streaming/non-streaming coverage, zero sends,
no estimated usage, and the forced `text_fallback` exclusion.

It also rejected `runTurn` as the seam, with specifics worth keeping: adopting
`runTurn` routes EVERY Kiro request into the custom transport branch, which waits
on provider pacing and increments `sendCount` before any local decision, still
meets the empty-completion guard afterwards, and would force Kiro to re-own
transport, retries, failover, cancellation, and accounting that its existing
`buildRequest`/`fetchResponse`/`parseStream` path already provides. The local
terminal therefore belongs immediately after adapter resolution and before
`buildRequest`.

## wp2 — two execution-path blockers, both accepted

1. **The outer drain.** Skipping the inner flush at `src/adapters/kiro.ts:1467`
   is not enough: `parseKiroAttempt` independently drains `deferred` at
   `src/adapters/kiro.ts:996-999` after the inner generator returns. The final
   answer would be emitted first and the commentary after it — the duplicate
   survives, reversed. Found independently while reading the same file, so this
   is confirmed twice. The deferred collection must be consumed, and the claim
   that this stays clear of retention machinery is withdrawn.
2. **`text_fallback` has the same shape through a different collection.** It
   retains in `fallbackEvents`, and `src/adapters/kiro.ts:1470-1477` emits all of
   them and then the completion answer. The rule must apply independently inside
   each inference.

Criterion 3 was also overbroad — "any turn whose completion never arrives enters
the fallback exactly once" is false for real tools, provider/protocol failures,
and explicit stops like `MAX_TOKENS`. Narrowed to a clean required-mode
inference, with added controls for failure, explicit incomplete stop,
text_fallback duplication, and budget return-to-baseline.

The six release paths the reviewer enumerated from source are now a table in
`020_wp2_duplicate_answer.md` and are treated as controls.

## HEAD movement

Verified: `60537f067..761cb4cfe` touches only
`src/adapters/cursor/tool-result-normalize.ts` and
`tests/cursor-exec-empty-result.test.ts`. No Kiro adapter, adapter contract,
Responses core, bridge, or Kiro test file changed. The plan is unaffected.

## Disposition

wp1 proceeds to implementation. wp2's plan page is corrected here and will be
re-audited as part of its own cycle rather than blocking wp1.
