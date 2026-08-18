# 015 — WP2b: the surviving EOF truncation error must carry partial usage

Origin: audit `r1` finding F3. This work-phase exists **because** `010` chose dev's
error-event shape; without it, choosing that shape would be a usage regression.

Revised by audit `r2` finding 1: the value must be PARTIAL-failure usage, not
clean-turn usage.

## The defect

Two paths report a truncated Cursor turn, and only one of them reports tokens.

| Path | Usage |
|------|-------|
| thrown transport failure | `attachPartialUsage` (`live-transport.ts:1193-1197`) → `cursor.ts:181-192` copies `partialUsage` into the error event |
| `finalizeTurnEvents` open-tool branch | none (`protobuf-events.ts:1367-1372`) |

`CursorServerMessage`'s error variant already carries usage
(`src/adapters/cursor/types.ts:44-48`). So the omission is an oversight in the
open-tool branch, not a design constraint.

Consequence: a turn that consumed real tokens and then truncated mid-tool-call
reports `usageStatus: unreported` with 0 tokens — the exact failure mode
`attachPartialUsage`'s own doc comment says it exists to prevent.

## Which resolver (audit r2 finding 1)

The first draft said `resolvedTurnUsage(state)`. That is wrong in one case, and the
reason is worth stating because it is the same class of mistake this campaign made
once before.

`resolvedTurnUsage` (`protobuf-events.ts:1340-1352`) is the CLEAN-turn resolver: it
falls back to the session carry-forward, then the request-local estimate, so it
returns a number even when this turn produced no token signal at all.

`partialUsageFromEventState` (`live-transport.ts:1178-1188`) exists precisely
because that is wrong for a failure. It returns `undefined` unless this turn
produced a checkpoint or a positive output delta, on its own stated grounds: "a
carry-forward value belongs to an earlier successful turn ... cannot by itself prove
that a first-frame failure consumed anything."

An unconditional `resolvedTurnUsage` would therefore make the EOF error report
stale or inferred consumption exactly where the thrown path correctly reports none.
That trades one wrong number (0) for a different wrong number.

Use the failure-specific helper. It currently lives in `live-transport.ts` while
`finalizeTurnEvents` lives in `protobuf-events.ts`, and `protobuf-events.ts` imports
nothing from the transport. So the helper moves DOWN to `protobuf-events.ts` (next
to `resolvedTurnUsage`, which it already calls) and `live-transport.ts` imports it
from there. That is the direction the dependency already runs; the reverse would
create a cycle.

## MODIFY — `src/adapters/cursor/protobuf-events.ts`

Move `partialUsageFromEventState` here from `live-transport.ts`, keeping its
exported name and its doc comment (it is exported for unit testing and
`live-transport.ts` keeps using it via import).

Then, in `finalizeTurnEvents`, the open-tool branch:

    for (const callId of openCallIds) state.translatorBudget?.closeCall(callId);
    state.openToolCalls.clear();
    // A truncated turn still consumed tokens, and the error variant carries usage
    // (types.ts CursorServerMessage). Use the FAILURE resolver, not resolvedTurnUsage:
    // a carry-forward or request estimate belongs to an earlier successful turn and must
    // not be reported as this turn's consumption. Absent when nothing was proven, which
    // matches the thrown path exactly.
    const partial = partialUsageFromEventState(state);
    return [{
      type: "error",
      message: `Cursor stream ended with incomplete tool call(s): ${openIds}. Arguments may be truncated; the call was not committed.`,
      ...(partial ? { usage: partial } : {}),
    }];

Note the spread: no `usage` key at all when this turn proved nothing.

## MODIFY — `src/adapters/cursor/live-transport.ts`

Delete the local `partialUsageFromEventState` definition and import it from
`./protobuf-events` alongside the existing `finalizeTurnEvents` import.

**RE-EXPORT it.** `tests/cursor-interaction-query.test.ts` imports it from
`live-transport.ts` five times (`:150`, `:164`, `:172`, `:189`, `:195`) — that file
is dev's existing contract for partial-usage reporting and this work-phase has no
business rewriting it. So:

    export { partialUsageFromEventState } from "./protobuf-events";

keeps every existing import path working while the definition lives in one place.
Verified with `rg -n 'partialUsageFromEventState' tests src`.

Import-cycle check: `protobuf-events.ts` imports only `../../types`, `./gen/agent_pb`,
`./arg-codec`, `./arg-normalize`, `./types`, and `../../lib/translator-budget` — nothing
from `live-transport.ts`. Moving the helper down therefore adds no cycle; moving
`finalizeTurnEvents` up would have.

## Confirmed before writing: the consumer forwards it

`src/adapters/cursor/message-mapper.ts:29` maps an error message to
`{ type: "error", message, ...(message.usage ? { usage: message.usage } : {}) }`, and
`src/adapters/cursor.ts:127-142` emits the mapped event unchanged. The patch site is
right and no mapper change is needed. (`cursor.ts:181-192` is the THROWN path's
`err.partialUsage` handling, unrelated to an event that flowed through the mapper.)

## TESTS — `tests/cursor-eof-terminal.test.ts`

Two cases, both driven red first.

Positive — a real token signal this turn:

    test("an EOF truncation error reports the tokens the turn already consumed", async () => {
      // Assistant text plus a tokenDelta (or checkpoint) BEFORE the open tool call,
      // then clean EOF with no terminal. Red before the fix: usage is undefined.
      expect(errorEvent.usage).toBeDefined();
      expect(errorEvent.usage?.outputTokens ?? 0).toBeGreaterThan(0);
    });

Negative — carry-forward only, which audit `r2` asked for. Without it, a later
change could satisfy the positive case by reporting a previous turn's tokens:

    test("an EOF truncation with no token signal this turn reports no usage at all", async () => {
      // Seed a session carry-forward / request estimate, then open a tool call and EOF
      // with NO checkpoint and NO tokenDelta this turn.
      expect(errorEvent.usage).toBeUndefined();
    });

The rewritten case from `010` asserts the SHAPE (error event, no `done`, no
`tool_call_end`); these assert the USAGE. Keeping them separate means a future
change cannot quietly satisfy one by breaking the other — the mistake this campaign
already made once, when a test titled "carrying usage" never asserted usage.

`010`'s assertion uses `toMatchObject`, which tolerates the added `usage` property,
so the two docs do not conflict (confirmed in audit `r2`).

## Verification (C)

    bun test tests/cursor-eof-terminal.test.ts tests/cursor-hardening.test.ts \
             tests/cursor-interaction-query.test.ts
    bun x tsc --noEmit

`tests/cursor-interaction-query.test.ts:148-185` is in the list because it is the
existing contract for partial-usage reporting; this change must not disturb it.

## Push before handing off to WP3 (audit `r8`)

`010` step 7 pushes the rebase tip, and that push happens BEFORE this work-phase
exists. WP3 then verifies whatever `origin/cursor-call` points at — so without a
second push here, lidge would authoritatively verify a tip that does not contain
WP2b, and PR3's WP2b implementation would reach `dev` with only local checks behind
it.

So this work-phase ends with:

    git push --force-with-lease --no-verify origin cursor-call
    test "$(git ls-remote origin refs/heads/cursor-call | cut -f1)" = "$(git rev-parse cursor-call)"

This is the push WP3 hands off from. `010`'s earlier push stays (it is a harmless
checkpoint after the rebase), but it is not the verification handoff.
