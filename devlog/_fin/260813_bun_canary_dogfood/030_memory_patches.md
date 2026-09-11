# WP-2 — Memory Ownership Audit and Diff-Level Patches

## Purpose

Distinguish application retention from Bun allocator/GC behavior, close every proven app-owned gap, and leave regression tests that fail if a new long-lived owner becomes unbounded or invisible.

No patch is justified by RSS growth alone. For each candidate, use at least these hypotheses:

- H1: an OpenCodex Map/Set/cache/listener/timer retains reachable objects;
- H2: Bun/JSC or a native subsystem releases JS references but retains allocator pages/external buffers;
- H3: the load generator increases legitimate live cardinality or in-flight work.

Falsifiers:

- H1 is weakened when heap snapshots and `appOwnedBytes` stay flat while RSS rises.
- H2 is weakened when a named owner counter grows with heap and falls after its cleanup path.
- H3 is weakened when traffic stops, active turns reach zero, forced-GC measurements stabilize, and the same owners continue growing.

## Existing ownership contract

The production budget owner is `src/lib/app-owned-memory.ts`:

- default retained-state target: 256 MiB;
- retained categories: logs, caches, blobs, continuation;
- observed categories: translator and serialized tails;
- budget enforcement is reentrancy-fenced;
- periodic fallback runs after the 60-second state-store sweep.

`src/lib/app-owned-memory-stores.ts` currently registers these 12 retained owners:

```text
request_log
provider_debug
injection_debug
claude_debug
crash_ring
image_normalize
vision_descriptions
antigravity_replay
model_cache
usage_summary
cursor_blobs
responses_continuation
```

It observes these four in-flight buffers without evicting them:

```text
translator_buffers
image_fulfillment_tail
oauth_mutation_tail
grok_apply_flight
```

## Audit procedure

### 1. Prove the explicit inventory

```bash
cd /Users/jun/Developer/opencodex

rg -n 'id: "' src/lib/app-owned-memory-stores.ts
rg -n 'registerRetainedStore|registerObservedBuffer|registerStateStore' src tests
bun test tests/app-owned-memory.test.ts tests/state-store-sweeper.test.ts
```

### 2. Scan all post-baseline owners

Use the zero-leak work baseline as the lower bound only after verifying it is an ancestor:

```bash
git merge-base --is-ancestor dd6c60b3 HEAD
git diff --name-only dd6c60b3..HEAD -- 'src/**/*.ts'
git diff --unified=0 dd6c60b3..HEAD -- 'src/**/*.ts' \
  | rg '^\+[^+].*(new (Map|Set)|WeakMap|WeakSet|addEventListener|\.on\(|setInterval|setTimeout|cache|flight|queue|ring)'
```

Then scan the complete current source because moved/rewritten files can evade an added-line grep:

```bash
rg -n 'new (Map|Set)|new Weak(Map|Set)|addEventListener|removeEventListener|\.on\(|\.off\(|setInterval|setTimeout|clearInterval|clearTimeout' src --glob '*.ts'
rg -n 'CACHE|Cache|cache|TTL|MAX_(ENTRIES|BYTES|SIZE)|sweep|evict|prune|clear' src --glob '*.ts'
```

For each long-lived owner, record:

```text
path:line
owner variable
key cardinality source
value byte source
count cap
byte cap
TTL and whether TTL actively deletes
write-path cleanup
periodic cleanup
shutdown/listener cleanup
budget registration or explicit exclusion
focused test
```

A TTL checked only on read is not a memory bound. A cache needs active expiry, a finite count/byte cap, or both.

### 3. Focused owner review

#### `src/responses/state.ts`

Verify:

- `states` is capped at 1,000 entries, 64 MiB resident bytes, and one-hour TTL;
- every delete routes through `deleteEntry` so byte counters and spill deletion agree;
- oversized rows go directly to bounded durable spill or a bounded tombstone;
- `pendingSpillUnlinks` remains capped at 128;
- the 60-second sweeper calls `sweepExpiredResponseStates`;
- debounce timer and persistence single-flight do not retain superseded payloads;
- WeakMaps for replay provenance cannot retain request objects independently.

No production diff is planned unless a red probe breaks one of those invariants.

#### `src/codex/model-cache.ts`

Verify:

- `cache` byte accounting includes provider key and serialized models;
- `clearModelCache`, generation reconciliation, and budget eviction remove all sibling metadata maps;
- dynamic provider churn does not leave `providerCacheGenerations`, `failureAt`, `discoveryStatus`, or `liveModelCounts` growing indefinitely;
- five-minute freshness is paired with generation reconciliation, not mistaken for active expiry;
- app-owned registration uses `modelCacheRetainedStoreSnapshot` and `evictOldestModelCacheForBudget`.

Add a provider-churn test before changing production logic. If the test proves generation tombstones grow after repeated add/remove cycles, amend `reconcileModelCacheProviders` with a bounded generation-token design; do not clear a token while an old discovery can still write.

#### `src/adapters/anthropic-image-normalize.ts`

Verify:

- max bytes = 64 MiB, max entries = 4,096, max entry = 20 MiB;
- key, value, and metadata UTF-8 bytes are included;
- replacement does not double-count;
- reads refresh true LRU order;
- `Bun.Image` pipelines become unreachable after each encode/validate attempt;
- concurrency remains four, so native decoded bitmap pressure is bounded;
- registration exposes `anthropicImageNormalizeRetainedStoreSnapshot` and oldest eviction.

If JS cache counters flatten but `external`/`arrayBuffers`/RSS grow, produce a standalone `.tmp/` Bun.Image reproduction against both runtimes. Do not patch this cache to hide a Bun-native leak.

#### `src/server/request-log.ts`

Verify:

- count remains capped at 2,000;
- serialized UTF-8 bytes are tracked in the WeakMap and running total;
- every shift/delete decrements bytes;
- hydration cannot exceed the cap and is one-shot;
- request bodies, credentials, and account identifiers never enter new diagnostics;
- registration exposes `requestLogRetainedStoreSnapshot` and oldest eviction.

No production diff is planned unless replacement/hydration tests show counter drift.

## Concrete identified leak: workspace metadata cache

### Location

`src/adapters/command-code.ts`, current `workspaceMetadataCache` near lines 202-249.

### Root cause

`WORKSPACE_METADATA_TTL_MS = 30_000` controls freshness only. Expired entries remain in the Map until the exact same `cwd` is queried again, and a newly observed working directory is always appended. A long-lived proxy visiting unique repositories therefore retains every path and metadata object for process lifetime. This is a true unbounded-key leak independent of Bun's GC because the Map keeps values strongly reachable.

### Proposed production diff

File: `/Users/jun/Developer/opencodex/src/adapters/command-code.ts`  
Operation: MODIFY

Add a finite count cap, actively delete expired entries on every insertion path, and evict oldest-first before insertion. Keep the cache local because the values are small control metadata; do not add it to the 256 MiB byte budget unless measurements show material bytes.

```diff
 const WORKSPACE_METADATA_TTL_MS = 30_000;
+const WORKSPACE_METADATA_MAX_ENTRIES = 128;
 ...
 const workspaceMetadataCache = new Map<string, { collectedAt: number; value: GitWorkspaceInfo }>();
+
+function pruneWorkspaceMetadataCache(now: number): void {
+  for (const [key, entry] of workspaceMetadataCache) {
+    if (now - entry.collectedAt >= WORKSPACE_METADATA_TTL_MS) {
+      workspaceMetadataCache.delete(key);
+    }
+  }
+  while (workspaceMetadataCache.size >= WORKSPACE_METADATA_MAX_ENTRIES) {
+    const oldestKey = workspaceMetadataCache.keys().next().value;
+    if (oldestKey === undefined) break;
+    workspaceMetadataCache.delete(oldestKey);
+  }
+}
 ...
-  workspaceMetadataCache.set(cwd, { collectedAt: Date.now(), value });
+  const collectedAt = Date.now();
+  pruneWorkspaceMetadataCache(collectedAt);
+  workspaceMetadataCache.delete(cwd);
+  workspaceMetadataCache.set(cwd, { collectedAt, value });
```

Before applying, inspect the enclosing function and avoid a second `Date.now()` if it already captures `now`. Preserve public exports.

### Regression test

Place the focused test beside the existing command-code tests (resolve the exact owner with `rg --files tests | rg 'command-code'`; do not create a duplicate suite). If no existing test seam can vary CWD/clock without real git subprocesses, add test-only exports with explicit names rather than exposing the Map.

Required assertions:

1. 129 unique workspaces retain at most 128 entries.
2. Advancing the clock by 30,000 ms removes expired entries without rereading their keys.
3. Replacing an existing key does not increase size.
4. The newest 128 keys remain and the oldest key is absent.

Required red/green sequence:

```bash
bun test tests/command-code.test.ts
# RED before production diff: retained count is 129 or expired keys remain.
bun test tests/command-code.test.ts
# GREEN after production diff.
```

If the owning test filename differs, use that exact discovered path in the evidence record.

## Completeness patch: explicit inventory test

The observed-buffer IDs already have a test. Add the symmetric retained-owner contract so registration drift is intentional and reviewable.

File: `/Users/jun/Developer/opencodex/tests/app-owned-memory.test.ts`  
Operation: MODIFY

Add imports:

```diff
-import { registerDefaultAppOwnedObservedBuffers } from "../src/lib/app-owned-memory-stores";
+import {
+  APP_OWNED_OBSERVED_BUFFER_REGISTRATIONS,
+  APP_OWNED_RETAINED_STORE_REGISTRATIONS,
+  registerDefaultAppOwnedObservedBuffers,
+} from "../src/lib/app-owned-memory-stores";
```

Add inside `describe("app-owned retained memory", ...)`:

```diff
+  test("production retained and observed owner inventories stay explicit", () => {
+    expect(APP_OWNED_RETAINED_STORE_REGISTRATIONS.map(owner => owner.id)).toEqual([
+      "request_log",
+      "provider_debug",
+      "injection_debug",
+      "claude_debug",
+      "crash_ring",
+      "image_normalize",
+      "vision_descriptions",
+      "antigravity_replay",
+      "model_cache",
+      "usage_summary",
+      "cursor_blobs",
+      "responses_continuation",
+    ]);
+    expect(APP_OWNED_OBSERVED_BUFFER_REGISTRATIONS.map(owner => owner.id)).toEqual([
+      "translator_buffers",
+      "image_fulfillment_tail",
+      "oauth_mutation_tail",
+      "grok_apply_flight",
+    ]);
+  });
```

This test is an inventory alarm, not proof that no other cache exists. The source scan remains mandatory.

## Bounded cache follow-up: reasoning replay

`src/responses/reasoning-replay-cache.ts` is bounded to 64 entries, 256 KiB, and one-hour TTL and was recently corrected by PR #1474 to reject unscoped replay. It is not a leak at that bound. However, TTL cleanup currently occurs only on insert/peek and it is absent from the central retained-store inventory.

Required decision after profiling:

- If its maximum 256 KiB is immaterial and counters remain flat, document it as a bounded local exclusion; no production change.
- If centralized completeness is preferred, add snapshot/oldest-eviction functions, register it as a cache, and add periodic TTL sweeping. Do not do so merely to increase the inventory count—the current goal states 12 retained owners.

## Event listener, timer, and closure audit

For every `addEventListener`, `.on`, timer, and single-flight promise found in the scan:

- identify the owner lifecycle (request, stream, worker, service);
- prove `{ once: true }`, explicit removal, abort cleanup, or terminal settlement;
- ensure timeout callbacks do not capture full request/response bodies after settlement;
- ensure `.finally()` clears in-flight Map entries using identity-safe deletion;
- ensure intervals are singleton, stopped at shutdown/tests, and unrefed when appropriate;
- add an active-count/high-water metric for bounded in-flight tails rather than registering them as evictable state.

Any newly found defect gets a separate subsection with location, root cause, exact before/after diff, red test, and verification command before implementation.

## Canary attribution protocol

If canary exposes growth:

1. Capture scalar samples: heap, RSS, external, ArrayBuffers, JSC heap, app-owned stores, active turns.
2. Stop traffic and wait for active turns to reach zero plus two 60-second sweep intervals.
3. Compare retained-owner counters to heap growth.
4. Repeat the identical workload under Bun 1.3.14.
5. Take beginning/end heap snapshots in a controlled process.
6. Attribute to OpenCodex only if a reachable owner/path grows and a cleanup toggle removes/restores it.
7. Attribute to Bun only if app-owned/reachable heap stays bounded, the behavior differs by runtime revision, and a minimal scratch reproduction retains it.

## Verification gates

```bash
bun run typecheck
bun test tests/app-owned-memory.test.ts tests/state-store-sweeper.test.ts tests/model-cache.test.ts tests/responses-state.test.ts
bun test tests/command-code.test.ts  # replace only if repository discovery found a different owning suite
bun run test
bun run privacy:scan
git diff --check
```

Do not claim a leak fixed until the original red probe passes, the owner counter falls as predicted, and the full suite is green.
