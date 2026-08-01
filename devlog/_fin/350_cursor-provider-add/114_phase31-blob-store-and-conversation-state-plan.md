# 350.114 — Cursor Blob Store Scoping + Conversation State / Turns Persistence (work-phase 31)

Date: 2026-06-27
Branch: dev
Work phase: close findings **#4 (High, global blob leak)** and **#8 (Medium, first-turn-biased state)**
— the blob map is a single module-global `Map` shared across all turns/conversations, and the request
always sends `turns: []`, so multi-turn context relies entirely on root-prompt blobs.

> Status: **PLAN**. C3-class (correctness + cross-conversation isolation; memory growth).

---

## 1. Easy explanation

Cursor doesn't send big message bodies inline — it sends short "blob IDs" and later asks opencodex to
hand back the bytes for each ID. opencodex keeps **one global bag** of those blobs for the whole
process, so blobs from conversation A are visible to conversation B and the bag never empties. It also
sends an **empty `turns` list**, stuffing all prior history into the root-prompt blobs. jawcode instead
keeps a **per-conversation** blob bag plus a per-conversation **state cache**, and rebuilds both
`rootPromptMessagesJson` (the real model prompt) and `turns` (structured history) each turn. The fix:
scope blobs per conversation, reuse cached state on `conversationCheckpointUpdate`, and build `turns`.

## 2. Pre-write evidence

### Current opencodex — single global map, empty turns
```30:45:src/adapters/cursor/native-exec.ts
const blobs = new Map<string, Uint8Array>();
…
export function storeCursorBlob(data: Uint8Array): Uint8Array {
  const blobId = new Uint8Array(createHash("sha256").update(data).digest());
  blobs.set(key(blobId), data);
  return blobId;
}
```
- One module-global `blobs` map; `handleCursorNativeKv` (`native-exec.ts:78-104`) serves/sets from the
  same global map. No conversationId scoping, no TTL/LRU/cap. (Review #4.)
- `protobuf-request.ts:62-76` — `conversationState` is built with `turns: []`, `todos:[]`,
  `fileStates:{}`, etc. on **every** request. Prior messages go only into `rootPromptMessagesJson`
  (`protobuf-request.ts:21-33`, `slice(0,-1)`). No state cache, no checkpoint reuse. (Review #8.)
- `protobuf-events.ts:17-21` — `conversationCheckpointUpdate` is consumed **only** for token usage; the
  checkpoint state is discarded, never cached for the next request.

### jawcode reference — per-conversation scope + checkpoint reuse + turns
(from research of `jawcode/packages/ai/src/providers/cursor.ts`)
- `jawcode cursor.ts:136-137`:
  ```
  const conversationStateCache = new Map<string, ConversationStateStructure>();
  const conversationBlobStores  = new Map<string, Map<string, Uint8Array>>();
  ```
- Per-request attach (`cursor.ts:342-351`): look up/create the per-conversation blob store + cached
  state by `conversationId`, pass both into `buildGrpcRequest`, then write the new state back to the
  cache.
- `storeCursorBlob(blobStore, data)` / `readCursorBlob(blobStore, id)` take the **store as a param**
  (`cursor.ts:2125-2137`) — not a global.
- Checkpoint save (`cursor.ts:406-408`, `619-621`, `2101-2118`):
  `onConversationCheckpoint = ckpt => conversationStateCache.set(conversationId, ckpt)`.
- `turns` ARE built: `buildConversationTurns(context.messages, blobStore)` (`cursor.ts:2353-2452`),
  and `rootPromptMessagesJson` carries system + prior history (`cursor.ts:2316-2347`). Comment
  (`cursor.ts:2268-2277`): **Cursor's server uses `rootPromptMessagesJson` (not `turns[]`) to build the
  actual model prompt; `turns[]` is UI/display metadata** — but both are populated; last user message
  is excluded (it goes in the action).
- Unbounded-growth mitigation = content-addressed IDs so identical history reuses IDs
  (`cursor.ts:2240-2244`). Explicit TTL/LRU/cap = **NOT FOUND in jawcode** → opencodex may add a cap as
  a hardening beyond jawcode (review #4 asks for it).

## 3. Decision

1. **Scope blobs per conversation.** Introduce a `CursorConversationStore` keyed by `conversationId`;
   `storeCursorBlob`/`getBlob` operate on a passed-in store, not a module global.
2. **Cache + reuse state.** Keep a per-conversation `ConversationStateStructure` cache; on
   `conversationCheckpointUpdate` save it; on the next request seed `baseState` from it (jawcode parity).
3. **Build `turns` + populate `rootPromptMessagesJson`** from prior history (last user → action).
4. **Add a cap beyond jawcode:** per-store max-bytes / max-entries + a TTL/LRU sweep so the cache can't
   grow unbounded (review #4). Content-hash reuse still applies.

## 4. Diff-level plan

### NEW `src/adapters/cursor/conversation-store.ts`
```ts
export interface CursorConversationStore {
  stateByConversationId: Map<string, ConversationStateStructure>;
  blobsByConversationId: Map<string, Map<string, Uint8Array>>;
  lastAccessByConversationId: Map<string, number>;
}
export function createCursorConversationStore(): CursorConversationStore { … }
export function getOrCreateBlobStore(store, conversationId): Map<string, Uint8Array> { … }
export function pruneCursorConversationStore(store, opts: { ttlMs; maxConversations; maxBytes }): void { … }
```
- `storeCursorBlob(blobStore, data)` and `getBlob(blobStore, id)` move here (or to a small blob module)
  taking the store as a parameter; `native-exec.ts` no longer owns a global `blobs` map.

### MODIFY `src/adapters/cursor/native-exec.ts`
- `handleCursorNativeKv(kvMsg, blobStore)` — serve `getBlobArgs`/`setBlobArgs` from the **passed**
  per-conversation store; remove the module-global `blobs`/`storeCursorBlob` ownership.

### MODIFY `src/adapters/cursor/protobuf-request.ts`
- `encodeCursorRunRequest(request, blobStore, cachedState?)`:
  - `rootPromptMessagesJson` = system blobs + prior-history blobs (current behavior, but into the
    passed store) — keep last-user-in-action.
  - NEW `buildConversationTurns(request.messages, blobStore)` → populate `turns` (jawcode shape:
    structured turn blobs, last user excluded).
  - Seed non-history fields (`todos`, `fileStates*`, `pendingToolCalls`, `summaryArchives`, …) from
    `cachedState` when the system-prompt blob prefix matches; otherwise defaults. Always rebuild
    `rootPromptMessagesJson` + `turns` (jawcode `cursor.ts:2568-2599` rationale: server echoes empty
    placeholders for historical user entries).

### MODIFY `src/adapters/cursor/live-transport.ts`
- Own a `CursorConversationStore` (per transport, or a shared one passed via `input`); resolve
  `conversationId` (from `request.conversationId`), look up the blob store + cached state, pass them
  into `encodeCursorRunRequest` and `handleCursorNativeKv`, and write back state on checkpoint.
- Call `pruneCursorConversationStore` opportunistically (e.g. before each new run).

### MODIFY `src/adapters/cursor/protobuf-events.ts`
- On `conversationCheckpointUpdate`, in addition to usage, surface the checkpoint
  `ConversationStateStructure` so the transport can cache it (callback or returned event).

## 5. Verification plan (non-destructive)
- NEW `tests/cursor-conversation-store.test.ts`:
  - blob stored in run A's conversation is **not** retrievable in run B's conversation (isolation).
  - `getBlobArgs` for a known id returns the bytes; unknown id returns the empty/typed result.
  - `rootPromptMessagesJson` entries are 32-byte SHA-256 ids, not inline JSON; id == sha256(bytes).
  - `turns` is non-empty for a 2+ message history and excludes the last user message.
  - `pruneCursorConversationStore` evicts by TTL and by max-entries; cap respected.
- extend `tests/cursor-*.test.ts` for checkpoint reuse: a mock `conversationCheckpointUpdate` is cached
  and seeded into the next request's `baseState`.
- `bun x tsc --noEmit` → exit 0; full `bun test` no regression.
- NO live call.

## 6. Out of scope
- Full tool-call/tool-result round-trip fidelity into `turns` (deep multi-turn tool state) — start with
  text/assistant turns; a follow-up can add tool steps if live evidence requires.

## 7. Cross-references
- GPT Pro review 260627 — findings **#4 (High)** and **#8 (Medium)**.
- jawcode `cursor.ts:136-137, 342-351, 406-408, 2101-2118, 2125-2137, 2268-2277, 2316-2452, 2568-2599`.
- `106` (blob handshake live success — predecessor) · `113` (lifecycle) · `118` (index).
