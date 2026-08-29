# 050 — Phase 6: the native turn branch still emits an orphaned result

Depends on: `11d33597f` (#2910), `cfb70c972` (#2913), `6906049c6` (#2919), all on `origin/dev`.

## Why this exists

The final-gate review of #2910 flagged a fourth emission site as a MINOR finding and I deferred it,
on the grounds that it was pre-existing and not induced by the checkpoint cut. Both of those are
true. What I did not check before deferring is whether it produces **the same defect this whole unit
is about** — an emitted result envelope that names no invocation.

It does. Measured on `origin/dev`:

```text
no-interleave [composer-2.5]      steps=["toolCall"]
interleaved   [composer-2.5]      steps=["toolCall","BARE_TEXT_ENVELOPE(invoked=false)"]
no-interleave [composer-2.5-fast] steps=["toolCall"]
interleaved   [composer-2.5-fast] steps=["toolCall","BARE_TEXT_ENVELOPE(invoked=false)"]
```

So this is not a cosmetic gap in a doc table. It is the orphaned-result condition, reachable today,
on the native path.

## Root cause

`conversationTurns` handles a native `toolResult` by looking for its call in `pendingToolCalls`, a map
populated **only while walking the current turn**:

```ts
const priorCall = pendingToolCalls.get(message.toolCallId);
if (priorCall) {
  current.steps.push(toolCallStep(priorCall, requestScope, message));   // paired: call + result together
  pendingToolCalls.delete(message.toolCallId);
} else {
  current.steps.push(/* … */ toolResultToText(message) /* … */);        // bare: no invocation named
}
```

A user message closes the current turn (`flush()`), which clears `pendingToolCalls`. So when history
interleaves a user message between a call and its result — an ordinary shape, not a contrived one —
the lookup misses and the `else` fires. That branch calls `toolResultToText(message)` with **no second
argument**, even though the function has accepted an optional `call` since #2900:

```ts
function toolResultToText(
  message: OcxToolResultMessage,
  call?: Extract<OcxAssistantContentPart, { type: "toolCall" }>,
): string
```

`turnCalls` — the full-history index this unit already threads in — is in scope at that line and holds
exactly the call the fallback could not find.

## The change — after TWO audits corrected it

> **Audit round r2 returned VERDICT: FAIL** on the version of this plan below the first correction,
> with three BLOCKERs. This section records what was wrong, because the same reasoning error keeps
> recurring in this unit and the record is the only thing that makes it visible.
>
> The rewritten design is in "Design v3" further down. Everything between here and there is history.

**The first version of this plan was wrong, and the audit gate caught it before implementation.** It
proposed resolving the fallback from `turnCalls`. That cannot work, and the reason is worth recording
because it is the same class of mistake this unit keeps making — reasoning about the code instead of
measuring it.

`turnCalls` is gated on the external predicate:

```ts
const turnCalls = externalModel ? (knownCalls ?? toolCallsByCallId(messages)) : undefined;
```

And the `toolResult` handler returns early for external models, *before* the `pendingToolCalls`
lookup exists. So the two sets are disjoint by construction:

| Model | `isCursorExternalWireModel` | `turnCalls` | Reaches the `else` branch? |
|-------|------------------------------|--------------|----------------------------|
| `grok-4.6-high` | true | populated | **no** — external branch handles it |
| `composer-2.5` | false | `undefined` | yes |
| `composer-2.5-fast` | false | `undefined` | yes |

Measured: `grok-4.6-high` already emits `ENVELOPE(invoked=true)` on the interleaved history, through
the external branch. Every model that reaches the fallback has `turnCalls === undefined`, so
`turnCalls?.get(...)` is unconditionally `undefined` there. The proposed one-line change would have
been **inert**, shipped green, and looked like a fix.

The actual change is a separate index that does not ride the external gate:

```ts
// Native fallback: the call is real history, just not in THIS turn's pending map.
const nativeCalls = knownCalls ?? toolCallsByCallId(messages);
…
const fallbackCall = nativeCalls.get(decodeCursorCallId(message.toolCallId));
… toolResultToText(message, fallbackCall) …
```

Deliberately narrow:

- The `if (priorCall)` paired path is untouched. When call and result sit in one turn, Cursor gets a
  real `toolCallStep` carrying both halves, which is strictly better than text and must not change.
- Only the `else` branch — already a text envelope today — gains a line inside it.
- `knownCalls` is reused when the checkpoint path supplied it, so the covered-history lookup from
  `040` applies here too rather than being re-derived from a slice.
- Ambiguity handling is inherited: `toolCallsByCallId` drops any id two different invocations claim, so
  a reused id still yields no invocation line rather than a confidently wrong one.

### Cost

This indexes history for native models, which previously skipped it. Measured in `040` at 0.27 ms per
encode on a 401-message thread, against blob serialization and SHA-256 hashing already in the same
encode. Verified again for the native path in this phase.

## Audit r2: three BLOCKERs against the design above

An independent auditor copied `src/` to a scratch tree, applied the exact patch this plan proposed,
and ran both trees through the real encoder. Findings, each reproduced:

**B1 — the fix would name a FUTURE call for a stale result.** `toolCallsByCallId` carries no
positional information, but `pendingToolCalls` was inherently backward-looking: it only ever held
calls already walked in the current turn. Replacing it with a whole-history index removes that bound.
Measured with a result at index 1 and its id's call at index 3 (`echo LATER`):

| tree | output |
|------|--------|
| base | `TEXT invoked=false` |
| patched | `TEXT invoked=true — invoked: exec_command with {"cmd":"echo LATER"}` |

The ambiguity guard does not catch this, because one call for an id is not ambiguous. I re-derived it
independently: `resultIndex=1`, `callIndex=3`, `callIndex > resultIndex` is true. This is precisely the
failure the index's own doc comment calls unacceptable — "an early result could be labelled with a
later command… a wrong invocation is worse than none". The root path escapes it only because it skips
results at or after `activeUserIndex`; the turn path has no such bound.

**B2 — the added line can make a request fail to encode.** The turn path stores one blob per step with
no truncation guard. The root path has `truncateToolResultBlob`; `toolCallStep` degrades by dropping
images; this `else` branch has neither, and `storeCursorBlob` throws `CursorBlobAdmissionError`
unconditionally on rejection. With the entry ceiling lowered to reach the boundary cheaply, a
large-but-legal argument plus a result that fits in base threw `entry_too_large` in the patched tree.
The plan's cost section discussed only the 2 KB argument cap, never the step-blob total.

**B3 — the "no-index guard" test row was false, and it was the row that would have caught B1.**
`nativeCalls` was unconditional, so no model stays un-indexed. Measured `invoked=false → true` for
`composer-2.5-fast`, `auto`, and `auto-intelligence`. A test asserting "unchanged" would have failed
immediately and been quietly rewritten to match observed output — the exact mechanism that produced
three partial fixes in this unit already.

Plus: the affected set is wider than this plan listed. `isCursorNativeWireModel` returns true for
`auto` and `default` as well as `composer-*`, so `auto` and `auto-intelligence` reach the branch too.

## Design v3

Three constraints, one per BLOCKER.

**Positional bound (B1).** The fallback accepts a call only when it appears *before* the result in
history. That needs an index carrying position, so `toolCallsByCallId` gains a variant that records the
message index of each first binding, and the fallback compares against the result's own index. A call
at a later index yields no invocation line — the honest degradation the existing code already prefers.

**The bound must compare within ONE coordinate system, and this is the trap.** `040` threads a
**full-history** index into a **sliced** replay: `buildPreparedCursorRunRequest` builds
`toolCallsByCallId(request.rawMessages)` and hands it to `conversationTurns`, which then iterates
`rawMessages.slice(suffixStart)` using slice-local positions. Comparing a full-history `callIndex`
against a slice-local `resultIndex` compares two different origins. Worked example with
`suffixStart = 4`, the call at full index 1 and the result at full index 4:

| comparison | result |
|------------|--------|
| full vs full (correct) | `1 < 4` → accept |
| full vs slice-local (naive) | `1 < 0` → **reject** |

A naive bound therefore drops the invocation line for a legitimately earlier call — silently
re-creating, on the checkpoint path, the exact orphan #2910 was merged to fix. So the fallback must
either receive the suffix offset and compare `callIndex < suffixStart + localIndex`, or the index must
be built over the same message array the loop walks. Whichever is chosen, a test must pin the
checkpoint case specifically, because a unit test on full replay alone cannot see this.

**Byte budget (B2).** The rendered step is measured against `cursorBlobMaxEntryBytes()` before it is
stored. If naming the invocation would not fit, the envelope is emitted **without** the invocation
line rather than throwing: the result output is the payload, the invocation line is a convenience, and
that ordering is already established by the root path's `PROBE a huge argument must not evict the
result output` test.

**Honest scope (B3).** The change affects every model that reaches this branch — `composer-2.5`,
`composer-2.5-fast`, `auto`, `auto-intelligence` — and the tests must assert that, not the opposite.
No test claims a model is unchanged when it is not.

What stays untouched: the `if (priorCall)` paired path. The auditor confirmed it is byte-identical
across all five models in the patched tree, and it produces a real `mcpToolCall` protobuf step
carrying both halves, which is strictly better than any text envelope.

### The 363-B question, answered rather than inherited

The previous draft asserted safety by inheritance. The specific guard forbids a `[Tool Call]` marker,
and `toolInvocationLine` emits none — confirmed, no `[Tool Call]` string appears in any patched turn
step. But the auditor named a shape that does not exist on the external path: the text envelope now
sits directly beside a genuine `mcpToolCall` step describing the same call, so the same invocation is
described twice in one turn. Given that `040` already records a live `composer-2.5` run fabricating a
`[Tool Result]` envelope as chat, that duplication is not obviously harmless.

This is why the phase does **not** widen the gate and does not proceed on inference. The narrow
question — a result whose call is genuinely absent from the current turn gets its invocation named,
bounded by position and by bytes — is decidable from the wire. Whether a native model should see the
same call described twice is a live-behaviour question, and it is deferred with that reason stated.

## The predicate question, deliberately not answered here

`turnCalls` is gated on `isCursorExternalWireModel`, while the root builder gates on the wider
`cursorNeedsExternalToolContinuation`. They disagree for `composer-2.5` (true vs **false**), so this
change alone will not name the invocation for that model's turn steps.

Widening the turn gate to match would change what a *native* model receives on its resume path, and
this unit has already shipped three partial fixes by reasoning about the Cursor wire instead of
measuring it. The gate stays as it is; the asymmetry stays recorded in `040`. What this phase fixes is
the case where the index already exists and was simply not consulted.

## Tests

In `tests/cursor-tool-result-invocation.test.ts`, driven red before the fix:

Two rows of the previous table were factually wrong and audit r2 rejected them: one named an
"external" model when every model reaching this branch is native by `isCursorExternalWireModel`, and
one asserted native turn steps were "unchanged" when the patch changes them for four models. A test
that asserts the opposite of what the code does gets quietly rewritten to match observed output, which
is how this unit shipped three partial fixes.

| Test | Without the fix |
|------|-----------------|
| a native result separated from its call by a user message names its invocation in the turn step | **red** |
| a result whose id's call appears LATER in history gets no invocation line | **red** — B1 bound |
| naming the invocation is dropped, not thrown, when the step would exceed the entry ceiling | **red** — B2 budget |
| a call and result inside one turn still pair into an mcpToolCall step, not text | green — paired-path guard |
| every model reaching the branch is named explicitly (`composer-2.5`, `composer-2.5-fast`, `auto`, `auto-intelligence`) | green — scope is asserted, not assumed |
| `grok-4.6-high` is unaffected, because the external branch handles it before this code | green — disjointness guard |
| on the CHECKPOINT path, a call before `suffixStart` is still accepted by the positional bound | **red** — coordinate-system guard |

The second and third rows are the ones that did not exist before the audit, and they are the two that
encode its BLOCKERs as executable checks rather than prose.

## Verification

- Focused `bun test` on the cursor files.
- `bun x tsc --noEmit`.
- Full suite on `ssh lidge`; no local full-suite run as a gate.
