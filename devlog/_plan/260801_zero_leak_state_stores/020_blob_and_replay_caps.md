# 020 — Cursor blob and replay-cache byte caps

Date: 2026-08-01  
Work phase: wp3  
Depends on: none  
Binding inputs: `000_state_store_inventory.md` §§2–3 and “Additional process caches”, `005_impl_roadmap.md` locked decision 2, `006_roadmap_audit_synthesis.md` R1-1/R1-3/R2-2.

## Outcome

Bound all four translation-duty stores owned by this phase at insertion time:

1. Cursor shared blobs: per-blob + aggregate bytes, request-lifetime liveness pins,
   provenance-aware post-request eviction, and coherent capacity rejection before any
   request containing an unstored hash reaches the wire.
2. Antigravity replay: bounded calls and bytes per session while retaining recent
   live identities and clear-on-invalid behavior.
3. Vision descriptions: clamp before insertion and byte-weight the existing LRU.
4. Anthropic image normalization: count key/sentinel metadata and prevent a single
   cache value from bypassing the aggregate cap.

## Current code and verified anchors

- `src/adapters/cursor/native-exec.ts:75-136` stores 4,096 shared blobs with 15-minute
  lazy TTL/count eviction but no byte or provenance field. `setBlob()` returns void.
- `src/adapters/cursor/native-exec.ts:202-227` maps missing `getBlobArgs` to an empty
  `GetBlobResult`; remote `setBlobArgs` always acknowledges after insertion.
- `src/adapters/cursor/gen/agent_pb.ts:7866-7880` defines the exact get-miss wire shape:
  `GetBlobResult.blobData` is optional. `:7903-7917` defines
  `SetBlobResult.error`, and `:13245-13258` defines its typed `Error.message`; rejection
  is not limited to an empty acknowledgement.
- `src/adapters/cursor/protobuf-request.ts:54-60,195-305` limits selected external roots
  to 192/512 KiB only after candidates have been stored. Inventory warning: all
  candidates are stored before selection.
- `src/adapters/cursor/protobuf-request.ts:107,352,391,399,430,449,471,484,495` calls
  `storeCursorBlob()` repeatedly while constructing one request. Origin provenance is
  knowable (`storeCursorBlob` versus remote `setBlobArgs`), but origin alone does not
  prove that a blob is safe to evict before that request has hydrated it.
- `src/adapters/google-antigravity-replay.ts:13-24` has a bounded outer map and an
  unbounded inner `Map<string,string>`.
- `src/adapters/google-antigravity-replay.ts:79-98` accumulates every call identity for
  a session; `:105-125` replays live rows; `:128-135` clears on invalid/reset.
- `src/vision/index.ts:18-24,32-68` has a 256-entry LRU with no value-byte accounting.
- `src/vision/index.ts:197-204` clamps only when rendering, while `:341-343` caches the
  unclamped `outcome.text.trim()`.
- `src/adapters/anthropic-image-normalize.ts:96-143` gives `pass`/`miss` zero weight,
  has no entry cap, and inserts a single encoded value even if it exceeds 64 MiB.

Blast-radius constraints from the inventory: missing Cursor blobs break hydration;
clearing Antigravity identities can cause invalid-signature 400s; clearing vision/image
caches repeats paid or expensive work. The remedy is bounded admission/LRU, not deletion
of the translation feature.

## Cursor blob-store diff

Modify `src/adapters/cursor/native-exec.ts`, `src/adapters/cursor/protobuf-request.ts`,
and `src/adapters/cursor/live-transport.ts`:

```ts
const BLOB_TTL_MS = 15 * 60_000;
const BLOB_MAX_ENTRIES = 4_096;
const BLOB_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const BLOB_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

type CursorBlobProvenance = "local-regenerated" | "remote-setBlobArgs";
export type CursorBlobRequestScopeToken = symbol;
interface CursorBlobEntry {
  data: Uint8Array;
  storedAt: number;
  sizeBytes: number;
  provenance: CursorBlobProvenance;
  requestPins: Set<CursorBlobRequestScopeToken>;
}
type CursorBlobAdmission =
  | { admitted: true; replaced: boolean }
  | { admitted: false; reason: "entry_too_large" | "pinned_saturation" | "request_pinned_conflict" };

let blobBytes = 0;
function setBlob(
  k: string,
  data: Uint8Array,
  provenance: CursorBlobProvenance,
  requestScope?: CursorBlobRequestScopeToken,
): CursorBlobAdmission;
function deleteBlob(k: string): void;
export function createCursorBlobRequestScope(): CursorBlobRequestScopeToken;
export function sealCursorBlobRequestScope(scope: CursorBlobRequestScopeToken): void;
export function releaseCursorBlobRequestScope(scope: CursorBlobRequestScopeToken): void;
export function handleCursorNativeKv(
  kvMsg: KvServerMessage,
  requestScope?: CursorBlobRequestScopeToken,
): Uint8Array;
```

`prepareCursorRunRequest()` owns one request-scope token and passes it through every
root/turn/step helper into `storeCursorBlob(data, scope)`. Each stored or reused blob adds
that scope to `requestPins`; sealing after construction fixes the complete set of distinct
blob keys advertised by the request. `PreparedCursorRunRequest` carries the sealed token
beside `bytes`, and `CursorLiveRun` passes that stream's token into
`handleCursorNativeKv()`. This is necessary because blob id alone cannot distinguish two
concurrent requests that reference identical content. A successful `getBlobArgs` removes
only that stream token's pin for the hydrated key. When all sealed keys have hydrated,
the scope releases; the stream's single terminal cleanup releases any remainder exactly
once on close/error/abort. A request pin
always wins over provenance and TTL: an in-flight request's blob is not an eviction
candidate. Provenance controls eviction only after request pins are gone:

- unpinned `local-regenerated` rows are LRU-evictable;
- unpinned live `remote-setBlobArgs` rows stay provenance-pinned until TTL expiry;
- expired remote rows become removal candidates once no request scope pins them.

External-root selection moves before global insertion. Candidate construction retains
serialized bytes locally; after the existing 192-root/512-KiB policy selects the final
roots, only those selected bytes call `storeCursorBlob(data, scope)`. Unadvertised
candidates never consume store capacity or acquire pins. Native turns/steps are all
advertised and store directly with the same scope. This changes construction order, not
the selected-root policy or blob-id hash format.

Admission is a synchronous two-phase transaction for every insert or replacement:

1. Validate the per-entry cap and same-key predecessor. A differing replacement cannot
   displace a request-pinned predecessor; reject `request_pinned_conflict` without mutation.
   Same-key CROSS-PROVENANCE refresh never downgrades protection (A-gate blocker:
   naive replacement would turn a live remote pin into an evictable local row):
   the surviving row's provenance is the STRONGER of the two — a live
   `remote-setBlobArgs` row refreshed by a local `storeCursorBlob()` for the same
   content-addressed key keeps `remote-setBlobArgs` provenance and its TTL clock;
   a local row refreshed by a remote set upgrades to `remote-setBlobArgs`.
   (Content-addressed keys make the bytes identical by construction, so only the
   protection class is merged.) Regression tests: remote→local refresh stays
   pinned within TTL; local→remote refresh upgrades and survives local LRU.
2. Build a logical candidate view containing all TTL-expired, unpinned rows. Do not delete
   them yet. Request-pinned rows remain live regardless of age.
3. Compute projected bytes and count after the eligible same-key replacement and logical
   TTL removals. De-duplicate the same key across replacement/TTL/victim sets so its bytes
   and count are subtracted exactly once.
4. Select additional oldest unpinned `local-regenerated` victims until **both**
   `BLOB_MAX_TOTAL_BYTES` and `BLOB_MAX_ENTRIES` would fit. Live remote rows and all
   request-pinned rows are ineligible.
5. If either limit still cannot fit, reject with `pinned_saturation`. The map, byte
   counter, recency, request pins, and same-key predecessor remain byte-for-byte unchanged;
   logically selected TTL/local victims are not committed.
6. Once feasibility is proven, commit the complete removal set, eligible replacement,
   immutable-byte insertion/reuse, request-pin attachment, recency update, and exact
   counters in one non-throwing synchronous section. There is no observable intermediate
   over-cap state and no post-insert rejection path.

`storeCursorBlob(data, scope)` computes the SHA-256 id and passes
`local-regenerated`, but returns the id only after the blob is stored/reused and pinned by
that scope. Infeasible admission throws a typed, privacy-safe
`CursorBlobAdmissionError` with stable code `cursor_blob_capacity`; request preparation
releases the partial scope and fails before `live-transport.ts` writes an
`AgentRunRequest`. The adapter surfaces the ordinary structured provider error. It never
returns an unstored hash and never sends a partially constructed request.

`PreparedCursorRunRequest` adds `blobRequestScope: CursorBlobRequestScopeToken` so the
production transport owns terminal cleanup. The byte-only `encodeCursorRunRequest()`
compatibility helper remains test-only in current consumers: its scope self-releases after
all advertised distinct keys are hydrated, and deterministic test reset releases any
scope left by a test that intentionally does not hydrate every id.

`setBlobArgs` passes `remote-setBlobArgs`. On rejection it returns a `KvClientMessage`
with the original request id, `message.case = "setBlobResult"`, and the optional typed
`SetBlobResult.error` populated with a bounded privacy-safe capacity message. It does not
acknowledge success for an absent blob and does not log the hash or bytes.

The existing get-miss contract remains distinct: `getBlobArgs` always returns a
`KvClientMessage` preserving the request id with `message.case = "getBlobResult"`; when
the key is absent, optional `GetBlobResult.blobData` is omitted. Evicted/expired hashes
use that exact shape. A successful get includes `blobData` and advances request-scope
hydration accounting.

Expose accounting for 040:

```ts
export interface CursorBlobMetrics {
  count: number;
  totalBytes: number;
  localBytes: number;
  pinnedBytes: number;
  rejectedEntryTooLarge: number;
  rejectedPinnedSaturation: number;
  oldestAt: number | null;
}
export function cursorBlobMetrics(): CursorBlobMetrics;
export function cursorBlobRetainedStoreSnapshot(): {
  count: number; bytes: number; evictableBytes: number; pinnedBytes: number; oldestAt: number | null;
};
export function evictOldestCursorBlobForBudget(): number; // oldest evictable row; bytes released
```

Snapshot/metrics read cached fields only. For the 040 registration the evictable
class is exactly the set `evictOldestCursorBlobForBudget()` draws from (round-3
audit): unpinned local rows AND expired unpinned remote rows (an expired remote
row has lost its TTL protection — line "expired remote rows become removal
candidates" — so it is evictable, not pinned). `pinnedBytes` covers live
remote-provenance rows and every request-pinned row (without double counting);
`evictableBytes` = total − pinned. `oldestAt` is the `storedAt` timestamp of the
EXACT row budget eviction would remove next (oldest member of the evictable
class), or null when the evictable class is empty — never a pinned row's
timestamp, so 040's cross-store oldest-first comparison operates on genuinely
reclaimable rows. Budget eviction removes that row and returns exact released
bytes. Add test-only reset/cap overrides; production constants remain fixed.
Regression: an expired unpinned remote row is reported evictable, becomes
`oldestAt`, and is removed by budget eviction before any younger local row.

## Antigravity replay diff

Modify `src/adapters/google-antigravity-replay.ts`:

```ts
const REPLAY_MAX_CALLS_PER_SESSION = 256;
const REPLAY_MAX_BYTES_PER_SESSION = 2 * 1024 * 1024;
const REPLAY_MAX_SIGNATURE_BYTES = 64 * 1024;

interface ReplayCall { signature: string; sizeBytes: number; touchedAtMs: number }
interface ReplayEntry {
  byCall: Map<string, ReplayCall>;
  bytes: number;
  expiresAtMs: number;
}
```

Use `TextEncoder` byte lengths for canonical call key + signature. On observation:

- ignore an individual call whose signature or combined row exceeds its cap;
- replace through a centralized delete/subtract helper;
- insert/refresh the observed call as newest;
- evict oldest inner calls until both count and bytes fit;
- refresh the outer session TTL only when at least one valid call was inserted;
- delete expired outer entries during observe/apply and retain the existing outer cap.

`applyAntigravityReplay()` refreshes inner recency when a signature is actually matched;
it does not refresh session TTL. `clearAntigravityReplay()` still deletes the entire
session immediately after an upstream invalid-signature response (`src/adapters/google.ts:451-455`).

Expose scalar accounting/test seams:

```ts
export function antigravityReplayMetrics(): {
  sessions: number; calls: number; totalBytes: number; largestSessionBytes: number;
};
export function antigravityReplayRetainedStoreSnapshot(): {
  count: number; bytes: number; evictableBytes: number; pinnedBytes: number; oldestAt: number | null;
};
export function evictOldestAntigravityReplayForBudget(): number;
```

For 040, one replay session is one evictable retained row: the snapshot reports all replay
bytes as evictable and zero pinned bytes, `oldestAt` is the oldest session/call touch, and
budget eviction removes the oldest complete session through the same centralized
subtract helper. It never partially clears a session. The existing invalid-signature path
at `src/adapters/google.ts:451-455` still calls `clearAntigravityReplay()` and immediately
removes the complete bounded session with exact byte subtraction.

## Vision description-cache diff

Modify `src/vision/index.ts`:

```ts
const DESCRIPTION_CACHE_MAX_ENTRIES = 256;
const DESCRIPTION_CACHE_MAX_BYTES = 1024 * 1024;

interface VisionDescriptionCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  clear(): void;
  snapshot?(): { count: number; bytes: number; oldestAt: number | null };
  evictOldest?(): number;
}

export function visionDescriptionRetainedStoreSnapshot(): {
  count: number; bytes: number; evictableBytes: number; pinnedBytes: number; oldestAt: number | null;
};
export function evictOldestVisionDescriptionForBudget(): number;
export function setVisionDescriptionCacheLimitsForTests(
  limits?: { maxEntries?: number; maxBytes?: number },
): void;
```

`BoundedLruDescriptionCache` stores `{value,sizeBytes,storedAt}` and tracks key UTF-8
bytes plus value UTF-8 bytes. Replacement subtracts first; eviction happens before
insert until count and projected bytes fit. A single value that cannot fit is not cached.

The owner-level 040 snapshot delegates to the production cache's cached accounting and
reports all bytes evictable and zero pinned bytes; owner-level eviction removes its oldest
complete LRU row and returns exact released bytes. An injected custom test cache that
does not provide the optional methods reports an empty owner snapshot and zero release,
so observation never mutates or guesses external state.

`setVisionDescriptionCacheLimitsForTests()` rebuilds an empty default cache with bounded
test limits; `undefined` restores the production 256-entry/1 MiB limits. It follows the
continuation store's cap-override pattern and permits boundary tests without allocating
MiB-scale fixtures.

At `src/vision/index.ts:341-343`, change the insertion value to:

```ts
const successfulText = outcome.error ? "" : clamp(outcome.text.trim(), DESC_MAX_CHARS);
if (identity.persistent && successfulText) descriptionCache.set(identity.key, successfulText);
// The outcome handed to resolveOutcome must carry the SAME clamped text —
// building successfulText alone leaves the first-use outcome unclamped
// (A-gate blocker 4). Replace the successful outcome before resolution:
const resolvedOutcome = outcome.error ? outcome : { ...outcome, text: successfulText };
resolveOutcome(resolvedOutcome);
```

Return the same clamped text in `outcome` so first use and cache hit are byte-identical.
Do not clamp error markers or change paid-sidecar admission/concurrency.
The regression `clamps a successful description before cache insertion and first render`
must assert BOTH surfaces: the cached value and the first-use resolved outcome are the
identical clamped string; an error outcome passes through resolveOutcome unmodified.

## Image-normalization cache diff

Modify `src/adapters/anthropic-image-normalize.ts:96-143`:

```ts
const CACHE_BYTE_CAP = 64 * MiB;
const CACHE_MAX_ENTRIES = 4_096;
const CACHE_MAX_ENTRY_BYTES = 20 * MiB;
type CacheValue = { data: string; mediaType: string } | "pass" | "miss";
interface CacheEntry { value: CacheValue; sizeBytes: number; storedAt: number }
```

`sizeBytes` includes UTF-8 key bytes for every row, sentinel marker bytes, media type,
and encoded data. `cachePut()` returns `boolean`; it skips an individually oversized
entry and evicts before insertion until both count and aggregate byte caps fit. There is
no zero-weight path. `cacheGet()` preserves true LRU and returns `entry.value`.

Extend `getNormalizeStatsForTests()` and the 040 hook with `sentinelEntries`,
`metadataBytes`, and `oldestAt`. Budget eviction removes the oldest row through the same
centralized subtract helper.

Expose the 040 owner contract explicitly:

```ts
export function anthropicImageNormalizeRetainedStoreSnapshot(): {
  count: number; bytes: number; evictableBytes: number; pinnedBytes: number; oldestAt: number | null;
};
export function evictOldestAnthropicImageNormalizeForBudget(): number;
```

All image-normalization rows, including `pass`/`miss`, are evictable and none are pinned;
the snapshot therefore reports `evictableBytes === bytes` and `pinnedBytes === 0`.
Eviction removes the oldest complete LRU row and returns its full key/value/metadata byte
weight.

## Cap rationale

- Cursor 16 MiB per blob is 32 times the external selected-root budget and still admits
  native conversation-step/KV payloads, while rejecting protocol-scale allocations long
  before the 32 MiB translator frame ceiling. The 64 MiB aggregate matches the existing
  continuation/image-cache order of magnitude and gives four maximum entries or many
  ordinary roots without allowing the 4,096 count cap to imply TiB retention.
- Antigravity 256 calls is more than ten times the normal 20+ parallel-call acceptance;
  2 MiB/session permits roughly 8 KiB per identity on average. A 64 KiB signature ceiling
  is far above observed opaque signatures but prevents one value from consuming the
  entire session budget.
- Vision keeps the established 256 identities. The 1 MiB aggregate holds hundreds of
  ordinary short descriptions; clamp-before-insert guarantees every retained value is
  at most the existing 2,000-character presentation contract, so paid-call reuse remains
  useful while pathological upstream prose cannot dominate the process.
- Image normalization keeps a generous 4,096-row metadata ceiling so pass/miss reuse is
  not destroyed by screenshot churn. The 20 MiB per-entry ceiling matches Anthropic's
  final aggregate image-share contract and is above every normal ladder output; the
  existing 64 MiB aggregate remains the stronger ordinary constraint.

## Regression tests

`tests/cursor-blob.test.ts`:

- `admits a local blob exactly at the per-blob byte boundary`
- `request construction one byte above the per-blob boundary fails before writing a request and returns no unstored hash`
- `request-scope pins preserve every advertised root turn and step until each distinct getBlob hydration completes`
- `two concurrent streams sharing one blob id release only their own request-scope pin on getBlob`
- `stream close error and abort release every remaining request-scope pin`
- `external root pruning stores and pins only selected candidates and cannot fail from discarded history bytes`
- `replacement subtracts old bytes and refreshes local LRU`
- `aggregate admission evicts oldest local-regenerated blobs first`
- `remote setBlobArgs remains pinned within TTL while local blobs are evicted`
- `expired remote setBlobArgs becomes evictable before aggregate admission`
- `pinned saturation returns typed SetBlobResult.error without exceeding aggregate bytes`
- `getBlob miss preserves the request id and emits getBlobResult with blobData omitted`
- `getBlob hit preserves the request id includes blobData and releases that key's request pin`
- `pinned-saturation get after rejected set uses the same omitted-blobData miss shape`
- `rejected same-key replacement preserves the previously admitted blob`
- `atomic pinned-saturation rejection preserves unrelated TTL candidates local victims recency pins counters and same-key predecessor byte-for-byte`
- `one request whose construction crosses the aggregate cap fails coherently instead of emitting IDs evicted earlier in that request`
- `blob metrics remain observe-only and exact after reset replacement and eviction`.

Preserve/redefine the existing `tests/cursor-blob.test.ts` contract that every blob id
emitted by `encodeCursorRunRequest()` is immediately hydratable by the current
`blobData()` helper. Add deterministic reset/cap setup so the process-global store cannot
leak state between old handshake/root/turn tests and the new saturation tests.

`tests/google-antigravity-replay.test.ts`:

- `preserves 20+ live signed calls below count and byte caps`
- `evicts oldest inner call at the exact per-session count boundary`
- `evicts oldest inner calls to satisfy aggregate session bytes`
- `does not cache one oversized signature`
- `apply refreshes matched call recency without extending session TTL`
- `clear-on-invalid drops the bounded session and all byte accounting`
- `040 snapshot is observe-only and oldest-session eviction returns exact released bytes`.

Retain the existing canonical nested-argument identity, order independence, nested
signature alias, outgoing-signature no-clobber, Claude bypass, sequential multi-call
retention, and direct clear regressions in `tests/google-antigravity-replay.test.ts`.

`tests/vision-cache.test.ts`:

- `clamps a successful description before cache insertion and first render`
- `cache hit returns the same clamped description without a sidecar call`
- `test-only limits make a successful clamped value larger than maxBytes observable but not retained`
- `multiple entries fit exactly at the aggregate byte boundary and the next byte evicts the oldest before insert`
- `040 snapshot is observe-only and oldest-entry eviction returns exact released bytes`.

Retain the existing single-flight/later-turn cache hit, failed/empty non-caching,
hit/miss/over-cap message ordering, cache-key backend/model/detail/context partitioning,
and explicit-zero per-turn-cap tests in `tests/vision-cache.test.ts`.

`tests/anthropic-image-normalize.test.ts`:

- `unique pass and miss sentinels consume metadata bytes and hit the count cap`
- `encoded replacement keeps aggregate accounting exact`
- `one encoded value above maxEntrySize is returned but not cached`
- `cache eviction occurs before insertion and never exceeds 64 MiB`
- `040 snapshot is observe-only and oldest-row eviction returns full metadata-inclusive released bytes`.

Retain the existing zero-additional-encode cache-hit and media-type-partition regressions
in `tests/anthropic-image-normalize.test.ts`, plus the reset-dependent retry, Kiro image,
Claude native passthrough, and retry-E2E suites. Sentinel/accounting changes must not
alter image wire bytes, ladder/demotion order, terminal behavior, or retry tightening.

Verification:

```bash
bun test tests/cursor-blob.test.ts tests/google-antigravity-replay.test.ts \
  tests/vision-cache.test.ts tests/anthropic-image-normalize.test.ts
bun run typecheck
bun run test
```

## Commit

`fix(state): bound Cursor blobs and translation replay caches`

## Explicitly not changed

- No Cursor blob-id/hash format, protobuf schema, selected-root 192/512 KiB policy,
  get-miss wire shape, or remote TTL change. Hydration lookup only adds request-pin release
  accounting after a successful get.
- No eviction of live remote blobs merely to admit another pinned blob.
- No eviction of any blob pinned by an in-flight request, regardless of provenance or TTL.
- No Antigravity identity algorithm, canonical JSON format, signature validity threshold,
  Claude-on-Antigravity behavior, or clear-on-invalid behavior.
- No vision sidecar backend/model selection, paid-call concurrency, cache identity, or
  image-description wording beyond using the existing clamp earlier.
- No image tier ladder, decode validation, wire mutation, demotion order, or 20 MiB
  request-level image budget.
- No process-wide budget; 040 only consumes the accounting/demotion hooks defined here.
