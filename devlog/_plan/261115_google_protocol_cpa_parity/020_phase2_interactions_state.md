# 020 — Phase 2: Interactions state (`previous_interaction_id`, get, delete)

Rows: INT-13, INT-14, INT-15. Class C4: new caller state with an ownership rule. Depends on 010.

## Design (decision D2)

CPA keeps no local state: it forwards `previous_interaction_id` to a native Interactions upstream and
drops it for every translated target (A-I14). opencodex translates every Interactions request onto Chat,
so without local state a chained turn would silently lose its history. This phase adds a store with these
rules:

- **Process-local memory only.** Nothing is written to disk or the request log; a restart forgets
  every interaction (stored interactions then answer 404, and the client resends history).
- **Owner-scoped.** The owner key is `contextPrincipalIdOf(admission)` (`src/server/auth-cors.ts:549`,
  a salted HMAC of the matched data-plane secret). Loopback admission has no principal, so loopback
  callers share the single owner `"loopback"`; that matches the trust model of the unauthenticated
  loopback listener. Admission without either is not stored. A lookup with a different owner is
  indistinguishable from a missing id (404).
- **Unguessable ids.** `ocx-int-` + 128 random bits from `crypto.getRandomValues` (010).
- **Bounded.** TTL 24 hours from the last write (same span as `RESPONSE_TTL_MS` in
  `src/responses/state.ts:71`), at most 1,000 entries and 64 MiB in total, and per owner at most 200
  entries and 16 MiB, so one key's traffic cannot evict another owner's conversations; 8 MiB per entry
  (serialized history). Eviction removes the owner's own oldest entry first, then the globally oldest.
  An entry that cannot be stored (over the per-entry cap) still returns its answer, with the response
  header `x-opencodex-interaction-stored: false` so a client can tell a later chain will 404.
- **Memory budget.** The store registers with `registerRetainedStore` (`src/lib/app-owned-memory.ts:100`)
  like the Responses continuation store, so the shared app-owned budget can evict it.
- **What is stored**: the Chat history needed to continue (prior history without system messages, the
  new input messages, and the assistant message with text, tool calls and their
  `extra_content.google.thought_signature`), plus the Interaction resource for GET (steps including
  `user_input`, status, usage, model, timestamps).
- **Interaction-scoped fields are not inherited** (002 "Server-side state management"):
  `system_instruction`, `tools`, `generation_config` come only from the current request.
- **`store:false`**: the turn is served and not stored; a later `previous_interaction_id` naming it is 404.

## Stale check before B

`src/lib/app-owned-memory.ts:100` (`registerRetainedStore` signature, as used for
`responseContinuationRetainedStoreSnapshot` in `src/responses/state.ts:1002`); the 010 handler and codec as merged; the loopback allowlist in
`src/server/index.ts` that keys on `parseGeminiNativePath`.

## Changes

### NEW `src/server/gemini-interactions-store.ts`

```ts
export const INTERACTION_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_STORED_INTERACTIONS = 1_000;
export const MAX_INTERACTION_BYTES = 8 * 1024 * 1024;
export const MAX_INTERACTION_STORE_BYTES = 64 * 1024 * 1024;
export interface StoredInteraction {
  id: string; owner: string; model: string; created: string; updated: string; status: string;
  history: Record<string, unknown>[];          // Chat messages, no system role
  resource: Record<string, unknown>;           // GET body: steps incl. user_input, usage
  bytes: number; expiresAt: number;
}
export function interactionOwner(admission: DataPlaneAdmission): string | undefined;   // principal | "loopback" | undefined
export function rememberInteraction(entry: Omit<StoredInteraction, "bytes" | "expiresAt">, now?: number): boolean;
export function recallInteraction(id: string, owner: string | undefined, now?: number): StoredInteraction | undefined;
export function forgetInteraction(id: string, owner: string | undefined): boolean;
export function clearInteractionsForTests(): void;
```

A `Map` in insertion order plus per-owner counters; `rememberInteraction` deletes then re-inserts,
sweeps expired entries, evicts the owner's oldest until the per-owner caps hold, then the globally
oldest until the global caps hold. Registered with `registerRetainedStore`.

### MODIFY `src/protocols/codecs/gemini-interactions.ts`

- `interactionsToChat` returns `inputMessages` and `systemMessages` separately on the plan so the
  handler can splice stored history between them.
- NEW `interactionsStreamAssistant(state)` / `chatResponseAssistant(chatResponse)`: the assistant
  message to store (content, tool_calls with signatures).
- NEW `interactionInputSteps(plan)`: `user_input`/`function_result` steps for the GET resource.

### MODIFY `src/server/gemini-native-paths.ts`

```diff
+  | { kind: "interaction"; httpMethod: "GET"; allow: readonly ["GET", "DELETE"]; id: string }
+  | { kind: "interaction-cancel"; httpMethod: "POST"; id: string };
+/** Whether `method` is served on the route (by-id routes answer GET and DELETE). */
+export function geminiRouteAllows(route: GeminiNativeRoute, method: string): boolean {
+  return "allow" in route ? (route.allow as readonly string[]).includes(method) : method === route.httpMethod;
+}
```

Paths: `/v1beta/interactions/{id}` and `/v1/interactions/{id}` (id = one URL-decoded segment matching
`^[A-Za-z0-9_-]{1,128}$`, else not a native path), and `…/{id}/cancel`. `isGeminiGenerationPath` stays
true only for create. Callers that compare `req.method === route.httpMethod` (`src/server/index.ts`
loopback allowlist, `src/server/index/gemini-routes.ts` 405 check) switch to `geminiRouteAllows`, and
the 405 `Allow` header lists `allow.join(", ")` when present.

### MODIFY `src/server/gemini-interactions-inbound.ts`

- Remove the phase-1 400 for `previous_interaction_id`. When present: `recallInteraction(id, owner)`;
  missing → 404 `interaction not found`; otherwise `messages = [...systemMessages, ...stored.history,
  ...inputMessages]`. Then resolve `plan.unmatchedResultIds` against the tool calls in
  `stored.history`; only ids still unmatched are 400 `unmatched function_result`.
- After a successful terminal, when `plan.store` and an owner exist, `rememberInteraction`. Buffered:
  after `finalLog.waitForInner()` reports settled and before the 200 is returned. Streamed: inside the
  `frames()` closure returned by `terminal()`, never in `terminal()` itself — #8742's bridge evaluates
  `terminal()` "before settlement is known" and calls `frames()` only on success
  (`native-chat-bridge.ts`, `NativeStreamTranslator`). A failed, cancelled or unsettled turn is not stored.
  The `x-opencodex-interaction-stored` header is buffered-only (stream headers are sent first).
- NEW `handleGeminiInteractionResource(method, id, admission)`: GET → `stored.resource` or 404;
  DELETE → `{}` 200 or 404. NEW cancel handler: 404 when unknown, else 400 `only background interactions
  can be cancelled` (INT-15).

### MODIFY `src/server/index/gemini-routes.ts`

By-id and cancel routes take data-plane admission without a turn lease (`resolveResponsesApiAuth`,
origin check), never forward anything upstream, and write no request-log row.

## Tests (first, failing)

- NEW `tests/server/gemini-interactions-store.test.ts` (domain `server`): owner isolation (other
  principal → undefined), loopback owner, TTL with an injected clock, per-entry cap refusal, total-cap
  eviction order, delete.
- EXTEND `tests/server/server-gemini-interactions-inbound.test.ts`: two-turn chain (the second upstream
  Chat body contains turn-1 user text, assistant answer and the new input, and the turn-2
  `system_instruction` only); chain after a tool turn carries the call and the `function_result`;
  a chained request whose input is only a `function_result` (no repeated `function_call`) succeeds;
  a stream whose Chat EOF arrives but settlement fails stores nothing; per-owner eviction leaves another
  owner's entries intact;
  `store:false` turn → later chain 404; GET returns `user_input` + output steps; DELETE then GET 404;
  a different data key → 404 on GET and chain; cancel → 400 / 404; GET wrong method → 405 with
  `Allow: GET, DELETE`.
- Register the new file in the layout shard and expected-layout shard.

## Docs

`structure/data-planes/gemini-inbound.md` "Interactions state" subsection with every rule above, and
the manifest entry for the store file.

