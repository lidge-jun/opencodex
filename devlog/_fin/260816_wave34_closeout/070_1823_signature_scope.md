# 070 — PR #1823: scope the thought-signature replay store

Head `493c7712a`. Draft, no review threads, no exact-head test CI. The roadmap's factual description of the store is accurate; its prescription is not.

**Citation base:** every `src/responses/thought-signature-replay.ts` reference below is at PR #1823 head `493c7712a`, not at baseline `7c348a032` — that file does not exist on `dev`. The `src/bridge.ts`, `src/types.ts` and `src/config.ts` references are at the PR head too, since the PR edits `bridge.ts`.

## Verified defects (all three block merge)

1. **Key is the client-visible `call_id` alone.** `entries: Map<string, StoredEntry>`, write `entries.set(callId, ...)`, lookup `entries.get(callId)` (`src/responses/thought-signature-replay.ts:29-33`, `:92-97`, `:129-138`). Two threads, accounts, providers or models sharing a `call_id` overwrite each other.
2. **Emit precedes durability.** `response.output_item.added` is emitted at `src/bridge.ts:1026-1033`, before the store is touched at all (`:612-637`). The persist itself is an unawaited chain ending in `.catch(() => {})` (`src/responses/thought-signature-replay.ts:77-88`), so `done` can reach the client before the atomic rename completes.
3. **Failures are silent successes.** File-open, corrupt-JSON and write failures are all swallowed (`:43-46`, `:62-64`, `:86-88`).

Two corrections to the roadmap: eviction is age/write-order, **not** LRU (`:71-74`), and the 16,384-entry cap is not a memory bound — each signature may be 64KiB (`src/responses/provider-opaque-metadata.ts:31-38`), so the nominal ceiling is ~1GiB with no byte cap.

A fourth, separate defect: ordinary function calls enqueue the same signature twice, because `rememberExtraContentForReplay` is unconditional at `src/bridge.ts:612-614` and the function branch then calls `rememberAndSerializeExtraContent` at `:627-635`. Same pattern buffered at `:1587-1608`.

## Fix — reuse the existing identity, do not invent a schema

The roadmap proposes a new SQLite table keyed by `provider_family/route_account_key/conversation_root_key/call_id/model_key`. None of those exist, and a stronger contract already does:

```ts
// src/types.ts:3-21
interface OcxReasoningReplayIdentity {
  providerName: string; providerDestinationIdentity: string;
  adapterName: string; modelId: string; credentialIdentity: string;
}
interface OcxReasoningReplayScopeRef { readonly clientThreadId: string; current?: ... }
```

`src/responses/reasoning-replay-cache.ts:65-84` already keys on thread + provider + destination + adapter + model + credential + call id, and `tests/reasoning-replay-identity.test.ts:56-69` already proves the isolation dimensions. Use that identity.

SQLite is not justified by any demonstrated failure. What is required is:

1. **Scope the key** to the existing replay identity plus `call_id`.
2. **Move hydration out of `parseRequest`.** The parser runs before thread attachment and route selection (`src/server/responses/core.ts:1642-1649`, `:1704-1709`), so it cannot query a route-scoped store. Parse, bind the real scope, then hydrate before adapter serialization.
3. **Await durability before the first emit.** `atomicWriteFileAsync` already returns only after write, harden and rename (`src/config.ts:307-334`); awaiting it is a sufficient commit point.
4. **Typed result instead of `void`:** `stored | already_equal | conflict | unscoped | persist_failed`. A different signature under the same complete key fails closed rather than overwriting.
5. **Add a byte cap** and prune after load.
6. **Guard the duplicate enqueue** so an ordinary function call persists once.

Note on restart: the in-memory cache uses process-local HMAC identities, so those exact hashes cannot be written to disk and expected to survive a restart. Persist stable non-secret route/account identifiers (or an install-persistent HMAC key) together with thread root, model and `call_id`.

## Tests

- `tests/thought-signature-replay.test.ts` (new): conflict result, byte cap, TTL, corrupt store, injected persist failure, restart-stable keys, exactly-one-write per call.
- `tests/google-signature-history-roundtrip.test.ts`: same `call_id` across two threads/accounts/models stays isolated; restart recovery.
- `tests/responses-stream-tool-events.test.ts`: no `output_item.added`/`done` observable before an injected persistence promise settles.
- `tests/config-ownership-uninstall.test.ts`: `thought-signature-replay.json` is actually removed as owned state.
