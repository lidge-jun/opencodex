# U2 — Observed checkpoint maxTokens is an account-scoped observation (#4816)

## What the branch does today

`recordObservedCursorContextWindow(modelId, maxTokens)` writes a positive
`ConversationTokenDetails.maxTokens` into a module-level
`Map<string, number>` keyed by the lowercased model id.
`inferCursorContextWindow` prefers that value over the id heuristic, and
`cursorRequestSizeContext` feeds it into the 0.5-window overflow-versus-429 prior.

## The contract this unit has to hold

**An observation belongs to the account that produced it.** A checkpoint from one
Cursor account and plan says nothing authoritative about another account's
ceiling for the same model id, and must never become that account's limit.

The key is the model id alone, so it does not hold. Two accounts on different
plans routing `grok-4.6` through one proxy overwrite each other, and whichever
checkpoint landed last decides how the other account's requests are classified.
A free-plan 32k observation silently reclassifies a paid account's genuine
overflow as a 429, and the reverse hides a real overflow.

### Decided resolution

Key the map on the identity scope *and* the model id. The scope already exists
and is already the unit of account separation everywhere else in this adapter:
`_parsed._cursorIdentityScope`, normalized the way `request-builder.ts` normalizes it
(`trim()` or the literal `local`), and the same value that
`cursorOverflowRemintScopeKey` and `cursorConversationIdFromClientThread` use. Reuse
it rather than inventing a second notion of "account" — a second one will drift.

Plumbing: `live-transport.ts` already forwards `wireModelId` into the event state.
Forward the identity scope the same way, from the Cursor request rather than
re-deriving it, and confirm the field survives the `createCursorProtobufEventState`
boundary. Trace every `inferCursorContextWindow` caller before changing the
signature; prefer an options object over a second positional number so a caller
that forgets the scope is a type error rather than a silent global lookup.

### Two properties the map needs beyond scoping

**A bound.** The map has no eviction. Scope keys are per-account and per-route, so
the key space grows with usage and nothing ever removes an entry. Mirror the
existing precedent in `thread-continuity.ts`
(`CURSOR_OVERFLOW_REMINT_MAX_ENTRIES = 2_048`, insertion-ordered eviction).

**A clearing path.** `run-turn-execution.ts` and `request-transport.ts` both clear
`_cursorIdentityScope`. With scoped keys a cleared scope falls back to `local`,
which is its own key and therefore cannot inherit a real account's observation —
that is the correct outcome, and it should have a test rather than being left as
an accident of the normalization. The test-only reset must clear every scope.

Zero and missing `maxTokens` keep the id heuristic; that part of the branch is
already right and the senpi first-checkpoint-is-zero case stays covered.

## Files

`src/adapters/cursor/discovery.ts`, `src/adapters/cursor/live-transport.ts`,
`src/adapters/cursor/protobuf-events.ts`, `src/adapters/cursor.ts`,
`tests/providers/cursor/cursor-discovery.test.ts`,
`tests/providers/cursor/cursor-errors.test.ts`, `structure/providers/cursor.md`.

## Regressions to add

Two scopes observing different ceilings for one model id do not see each other's
value; an unscoped request does not read a scoped observation; eviction keeps the
map bounded; zero and negative ceilings are ignored; the existing 20-token-against-32k
stays on the 429 class within its own scope.
