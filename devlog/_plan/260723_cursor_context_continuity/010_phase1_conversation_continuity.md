# Phase 1 — Cursor conversation continuity across store:false requests

Owns RC1 (000_plan.md). Goal: every Responses request chained by
`previous_response_id` in one Codex task restores the remembered
`_cursorConversationId`, so the carry-forward context cache hits and
`done.usage.totalTokens` stays the absolute conversation context.

Scope note (audit r2 blocker 6): "same conversationId across the chain" applies
to NATIVE / non-rotating requests. External-model tool-result continuations
intentionally mint a fresh id (`src/adapters/cursor/request-builder.ts:180`)
and rekey the usage cache (`src/adapters/cursor.ts:80`) — that behavior stays;
continuity there means the NEWLY minted id is what gets persisted for the next
turn.

## File change map

### MODIFY `src/server/responses.ts` — 2 call sites (runTurn branch only)

Audit r1 blocker 1: Cursor always defines `runTurn` (`src/adapters/cursor.ts:69`),
so `handleResponses` takes the runTurn branch (`src/server/responses.ts:1483-1577`)
and the generic adapter sites (`:1824`, `:1859`) can NEVER observe
`activeAdapter.name === "cursor"`. Forcing cursor there would be dead code
(C-ACTIVATION-GROUNDING-01 violation). Kiro-only ternaries at 1824/1859 stay.

Introduce one EXPORTED predicate near the top of the file (after imports, near
other small helpers) — exported so it is unit-testable (audit r1 blocker 2):

```ts
// Adapters whose continuation state must survive Codex's store:false requests:
// their provider conversation ids (kiro, cursor) only live in the proxy-internal
// continuation cache, and losing them breaks tool continuation (kiro) and
// absolute context carry-forward (cursor).
export function adapterNeedsForcedContinuation(name: string): boolean {
  return name === "kiro" || name === "cursor";
}
```

Then replace the two reachable ternaries:

Before (`:1537`, streaming routed):
```ts
                adapter.name === "kiro" ? { force: true } : undefined,
```
After:
```ts
                adapterNeedsForcedContinuation(adapter.name) ? { force: true } : undefined,
```

Same one-line replacement at `:1574` (non-streaming routed, `adapter.name`).
Sites `:1824` / `:1859` are untouched (unreachable for cursor, see above).

No behavioral change to `rememberResponseState()`'s gate itself
(`src/responses/state.ts:195` store:false skip):
its `force` bypasses only the store:false skip; status/id/output checks stay.
Compaction turns already skip `rememberResponseState` entirely (routedCompaction
guard covers both routed sites), so the stale-chain hazard is unchanged.

### MODIFY `src/responses/state.ts` — byte-bounded store (audit r1 blocker 3, r2 blocker 1)

Forced retention stores the full expanded input each turn: expansion copies
prior items into the next request (`state.ts:147-163`) and persistence stores
that expanded input again (`:207` region) → ~quadratic total bytes per chain.
Current bounds are count (`MAX_STORED_RESPONSES = 1_000`, `:6`) + 1h TTL only —
no byte cap in memory. Kiro traffic already carries this risk; fix it for both:

```ts
const MAX_STORED_RESPONSE_BYTES = 64 * 1024 * 1024; // ~64 MB high-water across all entries
let storedResponseBytes = 0;
```

Accounting invariants (audit r2 blocker 1 — load/reset/replace paths):

- ONE measured-entry constructor `measuredEntry(items, providers, createdAt)`
  computes `sizeBytes = JSON.stringify(items).length` (provider state
  negligible) — the ONLY place sizes are computed.
- ONE deletion helper `deleteEntry(id)` — the ONLY place `states.delete`
  happens — decrements `storedResponseBytes`. TTL, count, byte, and explicit
  deletes all route through it.
- Replacement: `rememberResponseState` on an existing id calls `deleteEntry`
  first (no double-count).
- `ensureLoaded` (`state.ts:48` region) RECOMPUTES `sizeBytes` for every entry
  of every snapshot version while loading — persisted sizes are never trusted
  (stale/tampered accounting).
- `clearResponseStateMemoryForTests` (`state.ts:221`) resets
  `storedResponseBytes = 0`.
- `pruneResponses()` evicts oldest-first while
  `storedResponseBytes > MAX_STORED_RESPONSE_BYTES` (after TTL + count passes).
- Test seam (audit r2 blocker 2): exported test-only
  `setResponseStateByteCapForTests(bytes: number | null)` mirroring the
  existing clear-for-tests convention; `null` restores the default.

Activation scenario: long-chain test (below) drives the byte pruner and asserts
oldest entries evicted while the newest chain link survives.

## Why not force for every adapter

Continuation items replay full input on expansion; adapters that are stateless
per request (plain HTTP providers) don't need the cache, and forcing globally
would grow the store for no benefit. Only kiro/cursor carry provider-side
conversation ids in continuation state today (see `OcxProviderContinuationState`).

## Accept criteria

1. A Cursor request with `store:false` that completes → its response id is
   expandable: `previousResponseProviderState(id)?.cursor?.conversationId` equals
   the conversation id the adapter used.
2. Follow-up request with `previous_response_id` → `parsed._cursorConversationId`
   restored (`src/server/responses.ts:963`) → `createCursorRequest` keeps it
   (`src/adapters/cursor/request-builder.ts:195`).
3. Kiro behavior byte-identical.
4. Activation scenario (C-ACTIVATION-GROUNDING-01): new regression test drives a
   store:false Cursor-shaped rememberResponseState call through the SAME force
   policy used at the call sites and asserts the state is retained; a control
   case with a non-forced adapter name stays skipped.

## Tests (audit r1 blocker 2: must exercise the real policy, not bypass it)

### MODIFY `tests/responses-state.test.ts`

Using this suite's ACTUAL fixture pattern (`buildResponseJSON`, see `:38` and
the kiro force case at `:123-135`):

1. `adapterNeedsForcedContinuation` unit test: true for "kiro" and "cursor",
   false for "openai"/"claude"/"" (imports the exported predicate from
   `src/server/responses.ts`).
2. Byte-cap tests using `setResponseStateByteCapForTests`: (a) eviction —
   oldest evicted, newest retained, `previousResponseProviderState` resolves
   the newest; (b) restart-recompute — persist, clear memory, `ensureLoaded`
   path re-derives sizes and the cap still evicts correctly; (c) overwrite —
   re-remembering the same response id does not double-count.

### MODIFY `tests/server-combo-failover-e2e.test.ts` (existing `resolveAdapter` mock)

Audit r2 blocker 2: production resolution calls `createCursorAdapter(provider)`
without deps (`src/server/adapter-resolve.ts:42`), and the harness's mocked
`resolveAdapter` (`tests/server-combo-failover-e2e.test.ts:35`) currently only
returns a `"test-run-turn"` adapter. Add a mock branch that, for a cursor
provider, returns `createCursorAdapter(provider, { createTransport: fakeFactory })`
— `adapter.name` stays `"cursor"` (set inside `createCursorAdapter`), so the
call-site predicate activates for real.

End-to-end chain proof (NATIVE model, plain text continuation — no tool-result
rotation): POST a `store:false` Responses request → capture `response.id` →
POST a follow-up with `previous_response_id` → assert the fake transport
received the SAME `conversationId` both times, driven by the real `:1537`/`:1574`
policy.

Separate external-model case (audit r2 blocker 6): chain whose last message is
a toolResult on an external wire model → assert the transport received a NEW
conversationId (intentional rotation), the usage tracker was rekeyed, and the
NEW id is what the continuation state persists.

## Verification

```
bun run typecheck
bun test tests/responses-state.test.ts tests/cursor-request-builder.test.ts tests/cursor-protobuf-events.test.ts tests/server-combo-failover-e2e.test.ts
```
