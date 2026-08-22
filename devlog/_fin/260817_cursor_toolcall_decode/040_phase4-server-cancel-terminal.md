# 040 — Phase 4: a server-side cancel must not vanish

Discovered by the round-6 audit of `010` and recorded there as a follow-up.
Its own work-phase (LOOP-UNIT-CHAIN-01). **Revised after an audit returned FAIL**
with two blockers; the original plan is corrected below.

## The defect

An unexpected `NGHTTP2_CANCEL` produces a turn with **zero adapter events**.

The transport already gets this right. Both failure exits
(`live-transport.ts:629`, `:638`) check provenance before swallowing:

```ts
if (this.expectedClose && isCursorBenignCancelError(failure)) return;
throw attachPartialUsage(summarizeFailure(failure), state);
```

So an unexpected cancel is thrown, correctly. It is the **adapter** that loses it
(`cursor.ts:181`):

```ts
if (isCursorBenignCancelError(err)) return;
```

No `expectedClose` in scope, so it re-decides from the error **code** alone
(`cursor-errors.ts:49`) and returns silently. The transport's provenance check is
overruled one layer up by a weaker test of the same question.

Downstream: streaming synthesizes `response.incomplete` / `adapter_eof`
(`bridge.ts:1283`); non-streaming defaults to `"completed"` (`:1829`) — the same
silent-success shape `010` closed for EOF.

## Audit corrections

**Blocker 1 — do not re-emit after a terminal.** Tagging on `!expectedClose`
alone would fire even when a `done`/`error` was already queued, adding a second
terminal (`emittedTerminal` is set at `live-transport.ts:540`). Buffered JSON
processes both and flips a completed turn to failed. **Tag only when
`!expectedClose && !emittedTerminal`**, at both exits.

**Blocker 2 — a marker alone produces a lying message.** Making
`isCursorBenignCancelError` false is not enough: `safeCursorTransportError`
(`cursor.ts:50`) passes only `err.message` to `safeCursorErrorMessage`, and
`classifyCursorError:105` re-matches the untagged string and labels it
`"Cursor stream suspended"`. The turn would fail with a message claiming an
intentional suspension — worse than the silent drop, because it misdirects
diagnosis. **The tagged error must carry its own message**, not be reclassified
from the raw text.

**Blocker 3 — the fixture cannot do a literal server RST.** A server-side
`stream.close(NGHTTP2_CANCEL)` surfaces as a clean `end` in the local h2 fixture.
Test 1 uses the existing fault-injection seam
(`tests/cursor-live-transport.test.ts:207`) and is named for a **cancel-shaped
transport failure**, not a literal RST reproduction. It is genuinely red today
under that seam.

## Contract

| Situation | Behavior |
|-----------|----------|
| We cancelled (`expectedClose`) | silent — unchanged |
| Cancel with a terminal already emitted | silent — no duplicate |
| Cancel we did not request, no terminal yet | one `error`, with an honest message |

## Diff-level plan

**`src/adapters/cursor/cursor-errors.ts`**

- Add `CursorUnexpectedCancelError` carrying a message that names what happened
  ("Cursor cancelled the stream before the turn completed"), so the adapter's
  existing `safeCursorTransportError` path renders it correctly instead of
  matching `"nghttp2_cancel"` and calling it a suspension.
- `isCursorBenignCancelError` returns **false** for this class. Untagged errors
  keep the current code/message matching, so nothing that returns silently today
  starts erroring without evidence.
- Verify `classifyCursorError` maps the new message to a connection failure, not
  `"Cursor stream suspended"`.

**`src/adapters/cursor/live-transport.ts`**

- At both failure exits, when `!this.expectedClose && !this.emittedTerminal` and
  the failure is cancel-shaped, throw `CursorUnexpectedCancelError` (preserving
  `attachPartialUsage`) instead of the raw failure.
- `cancelCursorRun` is unchanged; its `expectedClose` write is the provenance.

**`src/adapters/cursor.ts`** — unchanged.

## Tests (`tests/cursor-cancel-provenance.test.ts`)

1. Cancel-shaped transport failure, no `expectedClose`, no prior terminal ->
   exactly one `error` event, **and** its message does not say "suspended".
   Red today. Uses the fault-injection seam.
2. Client-tool suspend (`expectedClose`) -> still silent. The regression that
   matters: every working multi-turn tool cycle takes this path.
3. Cancel after a terminal was already emitted -> still silent, no duplicate.
4. Unit: `isCursorBenignCancelError` false for the new class, still true for an
   untagged `NGHTTP2_CANCEL` and for `"cursor stream suspended"`;
   `classifyCursorError` does not label the new message as a suspension.

## Scope

Not in scope: the non-streaming `completed` default (`bridge.ts:1829`), still the
open follow-up in `000_index.md`. This removes one route to it, not the default.

## Done when

All four pass, `bun run typecheck` clean, cursor suite green on `ssh lidge`,
pushed. Test 1 demonstrated red on the pre-fix tree.


## Shipped

Commits `f145fd513` (fix + tests) and `c9681d043` (review follow-up).

The plan's tagging design survived implementation, with one correction the audit
forced and one it surfaced afterwards:

- **The guard is `!expectedClose && !emittedTerminal`,** not `!expectedClose`
  alone. Tagging after a terminal was already queued would have added a second
  one, and buffered JSON processes both — flipping a completed turn to failed.
- **The typed error carries its own message**, because a raw `NGHTTP2_CANCEL`
  string is re-matched by `classifyCursorError` and reported as an intentional
  "Cursor stream suspended". A turn that failed unexpectedly would have claimed a
  deliberate suspension, which is worse than the silent drop it replaced.
- **It also re-exposes the originating transport code.** Wrapping hid it from the
  `turn-failed` diagnostic, leaving the one summary that exists to explain this
  failure without an error code. The regression test pins the non-obvious
  consequence: carrying `NGHTTP2_CANCEL` back onto the wrapper must not make
  `isCursorBenignCancelError` match it again — provenance is checked first.

Implementation note: `classifyTurnFailure` is a closure beside `summarizeFailure`
rather than a method, because `summarizeFailure` is itself a per-run closure over
the turn's state. A method could not reach it.

Verified on `ssh lidge` at `c9681d0435`: typecheck clean, 630 pass / 0 fail.
Red-before-green demonstrated, and independently reproduced by the reviewer as
4 pass / 1 fail under a mutation that disables the classification.
