# 040 — app-owned byte observability and retained-store budget

Date: 2026-08-01  
Work phase: wp5  
Depends on: 010, 020, 035 (030 provides no accounting hook)  
Binding inputs: `000_state_store_inventory.md`, `005_impl_roadmap.md` budget scope split and locked decision 4, `006_roadmap_audit_synthesis.md` R1-6/S2-3/S3-1.

## Outcome

Expose one privacy-safe `appOwnedBytes` block on authenticated
`GET /api/system/memory`, then enforce a configurable 256 MiB process-wide budget over
evictable retained stores only. Enforcement always demotes oldest unpinned retained
entries in fixed category order:

`logs/rings -> caches -> blobs -> continuation spill`.

040 wires the `ObservedBufferRegistration` registry and the scalar management shape, but
registers NO production observed-buffer owners: `observedInFlight` is `{}` when 040 lands
alone. Phase 050 owns the translator/tail instrumentation and, as its integration contract,
adds `registerDefaultAppOwnedObservedBuffers()` in `src/lib/app-owned-memory-stores.ts`,
calls it beside 040's retained-store registration at startup, and registers only static ids
(`translator_buffers`, `image_fulfillment_tail`, `oauth_mutation_tail`,
`grok_apply_flight`) through 040's `registerObservedBuffer()`. Once 050 lands those
current/high-water counters become visible, but they remain pinned observation-only state
and are never evicted by this budget. Their hard admission is owned by 050.
All 040 implementation items below are delivered; the 050 observed-owner instrumentation
just described is the only remaining cross-phase integration and is not part of wp5 repair.

## Delivered implementation and anchors

- `src/lib/app-owned-memory.ts:1-257` is the delivered coordinator: retained and
  observed registrations, configurable byte budget, scalar snapshots, deterministic
  category/owner ordering, failure counters, and synchronous single-flight enforcement.
- `src/lib/app-owned-memory-stores.ts:71-157` owns the fixed retained-store registration
  array, registers it in array order, and registers the named app-owned post-sweep hook.
- `src/server/management/system-routes.ts:77-99` assembles process memory,
  `responseState`, privacy-safe `appOwnedBytes` at `:92`, inspector counters, watchdog,
  and active-turn scalars. `src/server/memory-watchdog.ts:53-60,102-155` remains a
  separate warn-only RSS/native watchdog; it does not manage app-owned state.
- `src/responses/state.ts:621-652` exports all-row continuation accounting and
  resident-only durable demotion; `responseStateMetrics()` remains the compatibility
  observe-only seam at `src/responses/state.ts:756-787`.
- `src/server/request-log.ts:151-192` and `src/codex/model-cache.ts:45-68,158-168,215-226`
  deliver owner-local UTF-8 byte accounting, exact replacement accounting, oldest-row
  timestamps, and centralized eviction callbacks.
- `src/types.ts:708` exposes `appOwnedMemoryBudgetMb`; `src/config.ts:747-751` degrades
  malformed persisted edits to 256 MiB, while the raw-candidate guard at
  `src/config.ts:1448-1465` rejects invalid writes before schema normalization.
  `/api/settings` GET/PUT reports, validates, persists, configures, and synchronously
  enforces the field at `src/server/management/config-routes.ts:120-149,200-250`.
- Startup registers stores, the post-sweep fallback, the configured budget, and the
  first enforcement pass before starting the sweeper at `src/server/index.ts:326-330`.
- Delivered regressions live in `tests/app-owned-memory.test.ts`,
  `tests/state-store-sweeper.test.ts`, `tests/responses-state.test.ts`,
  `tests/cursor-blob.test.ts`, `tests/memory-watchdog.test.ts`, `tests/config.test.ts`,
  `tests/cli-headless-parity.test.ts`, and `tests/settings-stream-mode.test.ts`.

## Config decision

Choose a user-configurable top-level MiB field, not an environment-only or fixed knob:

```ts
export interface OcxConfig {
  /** Evictable retained app-state budget in MiB. Default 256; valid 64..4096. */
  appOwnedMemoryBudgetMb?: number;
}

export const DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;
export const MIN_APP_OWNED_MEMORY_BUDGET_MB = 64;
export const MAX_APP_OWNED_MEMORY_BUDGET_MB = 4_096;
export function resolveAppOwnedMemoryBudgetBytes(value: unknown): number;
```

Rationale: 256 MiB leaves room for the existing 64 MiB continuation, 64 MiB Cursor
blob, and 64 MiB image-normalization ceilings plus bounded logs/caches, while still
forcing cross-store demotion before retained state becomes multi-GiB. MiB is readable in
`config.json`; all metrics remain bytes. Reject non-integer/out-of-range values at the
management write boundary. On load, malformed legacy hand edits degrade to the default
without resetting unrelated config, following existing schema doctrine.

Because the schema intentionally catches an invalid persisted value, the delivered
`appOwnedMemoryBudgetError(value: unknown): string | null` beside
`blankHostnameError()` is included in `validateConfigCandidate()` BEFORE
`configSchema.safeParse()`. It inspects the raw candidate's own
`appOwnedMemoryBudgetMb` value and rejects nonnumeric, non-finite, fractional, below-64,
or above-4096 values. `tests/cli-headless-parity.test.ts:189-216` carries the named
behavioral regression `config set and import reject an invalid app-owned memory budget
without persisting the normalized default`; assert both CLI paths return nonzero and the
previous file remains byte-for-byte/field-for-field unchanged.

The English and translated configuration tables (`ja`, `ko`, `ru`, `zh-cn`) are
synchronized. They describe an evictable retained-state budget and explicitly do not
claim to cap RSS/native memory.

## Delivered coordinator — `src/lib/app-owned-memory.ts`

```ts
export type AppOwnedRetainedCategory = "logs" | "caches" | "blobs" | "continuation";
export type AppOwnedObservedCategory = "translator" | "serialized_tails";

export interface RetainedStoreSnapshot {
  count: number;
  bytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  oldestAt: number | null;
}
export interface RetainedStoreRegistration {
  id: string;
  category: AppOwnedRetainedCategory;
  snapshot(): RetainedStoreSnapshot;       // observe-only, no sweep/load/serialization
  evictOldest(): number;                   // bytes released; 0 means no candidate
}
export interface ObservedBufferRegistration {
  id: string;
  category: AppOwnedObservedCategory;
  snapshot(): { currentBytes: number; highWaterBytes: number; active: number };
}
export interface AppOwnedBytesSnapshot {
  budgetBytes: number;
  retainedBytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  overBudgetBytes: number;
  stores: Record<string, RetainedStoreSnapshot>;
  observedInFlight: Record<string, { currentBytes: number; highWaterBytes: number; active: number }>;
  enforcement: {
    runs: number;
    entriesDemoted: number;
    bytesReleased: number;
    noEvictableCandidate: number;
    snapshotFailures: number;
    oldestAtContractViolations: number;
  };
}

export function registerRetainedStore(registration: RetainedStoreRegistration): () => void;
export function registerObservedBuffer(registration: ObservedBufferRegistration): () => void;
export function configureAppOwnedMemoryBudget(bytes: number): void;
export function appOwnedBytesSnapshot(): AppOwnedBytesSnapshot;
export function enforceAppOwnedMemoryBudget(): AppOwnedBytesSnapshot;
export function resetAppOwnedMemoryForTests(): void;
```

Registrations are unique by static id. Duplicate registration replaces callbacks and
does not duplicate bytes or change that id's original owner-order slot. Snapshot
collection catches each throwing retained or observed owner, substitutes the appropriate
all-zero scalar shape, and increments `enforcement.snapshotFailures` exactly once per
caught snapshot invocation; it never invokes `evictOldest()`. The scalar failure total is
exposed in `GET /api/system/memory`; no error text or dynamic owner data is retained.

## Retained-store registrations

`src/lib/app-owned-memory-stores.ts:71-149` delivers one fixed
`APP_OWNED_RETAINED_STORE_REGISTRATIONS` readonly array and
`registerDefaultAppOwnedMemoryStores()`. The array order is exactly the store-id order in
the table below and is the deterministic owner tie-break order. Startup registers this
array once; test re-registration of an existing static id replaces its callbacks while
preserving its array index. 040 does not add an observed-owner array entry; the named 050
integration point is defined in Outcome.

The fixed array registers hooks delivered by 010/020/035 and existing owners. The
delivered 035 hook shapes use `entries` (not `count`) and omit pinned/evictable fields, so each
registration uses a named adapter in `app-owned-memory-stores.ts` mapping the
owner hook onto `RetainedStoreSnapshot` (rings: `evictableBytes = bytes`,
`pinnedBytes = 0`). Delivered hooks:

- `debugBufferMetrics` / `evictOldestDebugEntryForBudget` (`src/lib/debug-log-buffer.ts:65-70`)
- `injectionBufferMetrics` / `evictOldestInjectionEntryForBudget` (`src/lib/injection-debug-log.ts:43-48`)
- `claudeInboundDebugMetrics` / `evictOldestClaudeInboundForBudget` (`src/claude/inbound-debug.ts:155-160`)
- `crashRingMetrics` / `evictOldestCrashTraceForBudget` (`src/lib/crash-guard.ts:277-282`)
- caches: `src/adapters/anthropic-image-normalize.ts:216-235`,
  `src/vision/index.ts:119-133`, `src/adapters/google-antigravity-replay.ts:220-247`
- blobs: `src/adapters/cursor/native-exec.ts:84-134,396-421` (provenance/pin classes
  map directly onto pinned/evictable)

| Category | Store ids | Demotion rule |
|---|---|---|
| logs | `request_log`, `provider_debug`, `injection_debug`, `claude_debug`, `crash_ring` | Remove oldest complete diagnostic row; never truncate an attempt array during budget enforcement. |
| caches | `image_normalize`, `vision_descriptions`, `antigravity_replay`, `model_cache`, `usage_summary` | Remove oldest LRU/session/provider value through owner accounting. Preserve “other” usage totals. |
| blobs | `cursor_blobs` | Remove the oldest EVICTABLE row (unpinned local, or expired unpinned remote — 020 round-4). Live remote and request-pinned blobs report as pinned. |
| continuation | `responses_continuation` | Demote oldest resident row through 010 durable spill. Spill stubs/tombstones are not repeatedly demoted. |

The request-log owner now has per-entry UTF-8 byte accounting and one centralized oldest
delete at `src/server/request-log.ts:151-192`; successful retention updates accounting
before invoking enforcement at `:172-178`. Individual retained diagnostic strings stay
normalized per 035 while retry/failover attempt structure remains intact.

Model-cache values now carry owner-local `sizeBytes` and `fetchedAt`, replace exactly,
and expose snapshot/oldest eviction at `src/codex/model-cache.ts:17-20,45-68`,
`:158-168`, and `:215-226`. Usage-summary cache accounting and oldest eviction are delivered at
`src/server/management/usage-summary-cache.ts:1-80`. Cardinality overflow preserves
totals in `other` for every per-day breakdown at `src/usage/summary.ts:340-361` and for
the top-level model aggregation at `src/usage/summary.ts:434-482`; unique request counts,
attempts, tokens, and cost remain preserved wherever applicable.

Every registration's `oldestAt` is the timestamp of the exact row its
`evictOldest()` would remove next, never merely the oldest pinned or unrelated row:

| Store ids | `oldestAt` source |
|---|---|
| `request_log` | Oldest retained `RequestLogEntry.timestamp`. |
| `provider_debug`, `injection_debug`, `claude_debug`, `crash_ring` | Oldest row's existing `at`. |
| `image_normalize`, `vision_descriptions` | Oldest LRU row's `storedAt`, refreshed by the existing cache-hit behavior. |
| `antigravity_replay` | Minimum `touchedAtMs` of the next complete session selected for eviction; snapshot and eviction use the same session comparison. |
| `model_cache` | Oldest provider entry's existing `fetchedAt`. |
| `usage_summary` | New owner-local `revisionReadAt`, captured immediately after `readUsageSnapshotForManagement()` returns and stored with that revision-backed cache entry; do not use response serialization time. |
| `cursor_blobs` | Existing `storedAt` of the exact oldest evictable local or expired-unpinned remote row. |
| `responses_continuation` | Oldest resident row's `createdAt`; stubs/tombstones are excluded from candidacy. |

## Continuation pre-work (fold-in of verified external findings)

040 delivers these owner exports at `src/responses/state.ts:621-652`, beside the
compatibility observe-only metrics seam at `src/responses/state.ts:756-787`:

```ts
export function responseContinuationRetainedStoreSnapshot(): RetainedStoreSnapshot;
export function evictOldestResponseContinuationForBudget(): number;
```

The snapshot is side-effect-free and does not lazy-load, prune, spill, or serialize.
`count` and `bytes` cover ALL in-RAM rows using each row's cached `sizeBytes`, including
the actual small retained bytes of spill stubs and spill-failure tombstones.
`evictableBytes` is the gross cached bytes of resident rows only; `pinnedBytes` is the
actual cached bytes of stubs/tombstones (budget-protected metadata, not a request pin),
so `bytes === evictableBytes + pinnedBytes`. Stubs and tombstones are never global-budget
eviction candidates. `oldestAt` is the oldest resident `createdAt`, or null when no
resident exists. `evictOldestResponseContinuationForBudget()` demotes exactly that one
resident through the durable spill/tombstone path and returns NET released RAM:
`gross resident sizeBytes - actual replacement stub/tombstone sizeBytes`; no resident or
no net release returns 0.

Three verified defects on this phase's continuation/sweeper seam were repaired before
the budget coordinator was built on them:

1. **Bounded snapshot retry (VALID High).** `writeBoundedSnapshot()` now caps rewrite
   attempts at four (`src/responses/state.ts:485-526`). If the final write is still
   revision-unstable, `persistNow()` (`:543-558`) schedules a
   follow-up flush and does not drain `pendingSpillUnlinks` — only a revision-stable
   snapshot may authorize unlinking superseded spill generations (`:528-557`).
   Follow-up contract: the follow-up retains the SAME captured `path` (the guard at
   `:535-564` against recomputing `snapshotPath()` stays intact). Background
   persistence uses an unref'd timer. Explicit `flushResponseState()` (`:566-578`,
   called by `src/server/lifecycle.ts:164-166`) awaits one bounded same-path follow-up pass
   after the cap; if that pass is still unstable it returns with a best-effort
   snapshot and intact pending unlinks — shutdown is never blocked indefinitely.
   Test: revision churn during atomic write settles within the bound and leaves
   pending unlinks intact until a stable snapshot lands.

2. **Resident-first demotion (VALID High/data loss).** The delivered RAM-cap loop at
   `src/responses/state.ts:587-619` scans for and demotes the oldest resident first;
   it deletes stubs/tombstones only when no resident remains and bounded metadata alone
   exceeds the cap. The 040 continuation `evictOldest()` callback at `:631-652` is
   resident-only by construction and returns net released bytes.
   Test: mixed older-stub/newer-resident state demotes the resident and keeps the
   stub's durable spill file on disk.

3. **GCP ADC expiry sweep (VALID Medium).** `sweepExpiredGcpAdcTokens()` remains at
   `src/lib/gcp-adc.ts:71-80` and is now wired beside `reconcileGcpAdcTokens` in
   `STATE_STORE_REGISTRATIONS` at `src/lib/state-store-registrations.ts:97`.
   `tests/gcp-adc.test.ts:94-105` proves the periodic registration removes expiry.

A fourth external claim (sweeper partial-pass fence dropping newly-added-owner
writes) was audited INVALID against current source — every fenced writer also
accepts keys in the owner's live-key set — but a partial-failure/live-key regression
test is added to pin that property.

## Enforcement algorithm

```ts
const CATEGORY_ORDER: readonly AppOwnedRetainedCategory[] = [
  "logs", "caches", "blobs", "continuation",
];

while (retainedBytes() > budgetBytes) {
  const candidate = oldestEvictableStoreInFirstNonemptyCategory(CATEGORY_ORDER);
  if (!candidate) { counters.noEvictableCandidate++; break; }
  const released = candidate.evictOldest();
  if (released <= 0) markCandidateIneligibleForThisRun(candidate);
  else recordAndContinue(released);
}
```

Within the first category that has any evictable bytes, choose the store whose
`oldestAt` is earliest. Equal timestamps are broken by the fixed
`APP_OWNED_RETAINED_STORE_REGISTRATIONS` array index; this is a total order, not Map or
import-order accident. If a snapshot reports `evictableBytes > 0` with `oldestAt ===
null` (or a non-finite timestamp), increment
`enforcement.oldestAtContractViolations` once for that owner in the outer pass, skip it
for the remainder of the current pass, and
continue with the next valid owner. Re-snapshot after every demotion; never trust a stale
projected counter across a spill or replacement. A per-run visited/no-progress set
prevents loops.

The complete trigger set is:

- after every successful retained-store insertion or replacement (owner accounting first);
- once after all startup registrations and budget configuration;
- synchronously after every valid live budget change;
- after a pin/class transition makes existing bytes newly evictable: Cursor
  `releaseHydratedBlob()` / `releaseCursorBlobRequestScope()` after class reconciliation
  (`src/adapters/cursor/native-exec.ts:147-190,202-214,365-370`) and the remote-blob TTL
  expiry timer after it recomputes class accounting; and
- as a fail-safe after each existing periodic sweep tick finishes expiry/liveness
  reconciliation. The sweeper exposes only the generic named
  `registerStateSweepAfterTick({ name, afterTick })` registry
  (`src/lib/state-store-sweeper.ts:20-23,58-65,108-116`), invokes its isolated callbacks
  after both sweep phases at `:155-164`, and remains independent of app-owned-memory.
  `registerAppOwnedMemorySweepFallback()` registers the static
  `app-owned-memory-budget` callback in `src/lib/app-owned-memory-stores.ts:152-157`;
  startup calls it beside the other singleton registrations at
  `src/server/index.ts:326-330`. This covers TTL/class transitions with no write traffic
  and adds no second timer.

Observation happens first: update owner bytes/classification, then enforce. Never reject
new request admission as the first lever.

Enforcement is synchronous single-flight with an `isEnforcing` guard. Only the outermost
call increments `runs`; a reentrant call returns the current scalar snapshot without
starting a nested pass or changing run/demotion counters. Owner eviction may use the same
replacement helper as ordinary writes: continuation resident-to-stub replacement is
therefore allowed to encounter the guard, but it cannot recurse. The outer pass
re-snapshots and continues. Each successful callback that produces positive actual net
release increments `entriesDemoted` once and adds that net release to `bytesReleased`
once; zero/throwing callbacks do neither, and `noEvictableCandidate` increments at most
once per outer pass. Evictions performed inside an enforcement pass never schedule a
second deferred pass.

Edge contracts:

- A single entry over global budget is demoted/evicted even when it is the only entry.
- Pinned-only saturation may leave `overBudgetBytes > 0`; record
  `noEvictableCandidate`, warn once per 60 seconds, and do not violate per-store pinning.
- Continuation spill failure follows 010 tombstone replacement and counts net released RAM;
  budget enforcement does not keep the row hot.
- If a callback throws or reports zero release, move to the next candidate without
  spinning and retain honest over-budget metrics.
- Budget decrease is applied synchronously through the same demotion order.

## `/api/system/memory` payload

Delivered at `src/server/management/system-routes.ts:77-99`, beside `responseState` at
`:91`:

```ts
appOwnedBytes: appOwnedBytesSnapshot(),
```

Retain `responseState` for compatibility during this unit; it may duplicate a scalar
subset. `appOwnedBytes` contains only static store ids, counts, byte totals,
timestamps/ages, and counters. It must never include keys, ids, model/provider names,
paths, hashes, errors, commands, tool arguments, prompts, URLs, or account data.

Recommended wire example:

```json
{
  "budgetBytes": 268435456,
  "retainedBytes": 0,
  "evictableBytes": 0,
  "pinnedBytes": 0,
  "overBudgetBytes": 0,
  "stores": {
    "request_log": {
      "count": 0,
      "bytes": 0,
      "evictableBytes": 0,
      "pinnedBytes": 0,
      "oldestAt": null
    }
  },
  "observedInFlight": {},
  "enforcement": {
    "runs": 0,
    "entriesDemoted": 0,
    "bytesReleased": 0,
    "noEvictableCandidate": 0,
    "snapshotFailures": 0,
    "oldestAtContractViolations": 0
  }
}
```

## Regression tests

Delivered in `tests/app-owned-memory.test.ts`:

- `snapshot is observe-only and never calls an eviction callback`
- `replacement registration cannot double-count one store id`
- `exact budget boundary performs no demotion`
- `one byte over budget demotes oldest log before newer log`
- `equal oldestAt ties evict the earlier registered owner first`
- `category order beats cross-category timestamp order`
- `cache demotion starts only after logs and rings have no candidates`
- `local blobs demote before continuation and pinned remote bytes remain`
- `continuation is the final demotion category and uses durable spill callback`
- `single retained entry over budget is demoted even when it is the only entry`
- `pinned-only saturation reports honest overBudgetBytes and noEvictableCandidate`
- `zero-release and throwing callbacks cannot spin or hide over-budget bytes`
- `throwing snapshot reports zero owner scalars and increments snapshotFailures`
- `evictable bytes with null oldestAt increments oldestAtContractViolations and skips the owner`
- `continuation demotion releases resident bytes minus retained replacement stub bytes`
- `pin release and remote TTL expiry trigger enforcement after class reconciliation`
- `continuation replacement during enforcement is non-reentrant and counts one demotion`
- `replacement and eviction byte accounting remains exact across all hooks`
- `observed-buffer registry is wired but empty until 050 and never participates in eviction`
- `budget decrease enforces synchronously in the documented order`.

Delivered continuation/sweeper tests in `tests/responses-state.test.ts`,
`tests/state-store-sweeper.test.ts`, and `tests/gcp-adc.test.ts`:

- `persistNow settles within the bounded rewrite attempts under revision churn`
- `unstable final snapshot defers spill unlinks until a stable snapshot`
- `RAM cap demotes the oldest resident before deleting any older spill stub`
- `stub-only over-cap state still deletes bounded metadata oldest-first`
- `expired GCP ADC token is removed by the periodic sweep registration`
- `partial reconcile failure keeps live-key writes accepted for new owners`
- `periodic sweep enforces bytes that become evictable via TTL expiry without write traffic`.

Delivered in `tests/memory-watchdog.test.ts`:

- `GET system memory includes privacy-safe appOwnedBytes scalars`
- `GET system memory does not load prune serialize or evict retained stores`
- `payload contains no dynamic store keys paths ids or diagnostic text`.

Delivered config tests:

- `appOwnedMemoryBudgetMb defaults to 256 MiB`
- `appOwnedMemoryBudgetMb accepts integer bounds and rejects raw invalid candidates before normalization`
- `settings PUT rejects below/above/fractional/nonnumeric budget values`
- `settings PUT applies a valid budget change synchronously through enforcement`
- `malformed persisted value degrades to default without dropping providers`
- `config set and import reject an invalid app-owned memory budget without persisting the normalized default`.

Run:

```bash
bun test tests/app-owned-memory.test.ts tests/memory-watchdog.test.ts tests/config.test.ts \
  tests/cli-headless-parity.test.ts
bun test tests/responses-state.test.ts tests/state-store-sweeper.test.ts \
  tests/gcp-adc.test.ts tests/settings-stream-mode.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

## Commit

`feat(memory): enforce an app-owned retained-state byte budget`

## Explicitly not changed

- No RSS/native-memory restart threshold or watchdog behavior.
- No eviction of in-flight translator buffers, promise-tail closures, active turns,
  sockets, workers, refreshes, OAuth flows, or MCP calls.
- No first-line request rejection while an evictable retained candidate exists.
- No pin override for live remote Cursor blobs.
- No path/id/account/provider/model/prompt/tool/error content in observability.
- No 030 dependency or accounting hook; expiration sweeping stays independent.
  (Exception: the GCP expiry-sweep wiring above touches the 030 registration table
  because the defect lives there; it adds no accounting coupling.)
- No GUI redesign beyond consuming the additive payload if desired in docs sync.

Docs sync for the new config field covers English AND the translated configuration
references (`ja`, `ko`, `ru`, `zh-cn`).
