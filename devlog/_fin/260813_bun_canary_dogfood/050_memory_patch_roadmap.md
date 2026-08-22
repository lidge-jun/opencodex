# Memory ownership re-audit and patch roadmap

Date: 2026-08-13  
Baseline: `dd6c60b3` (zero-leak implementation head)  
Current checkout: `preview-dev@9973559e78a6319c1051b51bace9ce7c17ce8aff`

## Scope and method

This re-audit read the complete 36-store baseline inventory at
`devlog/_fin/260801_zero_leak_state_stores/000_state_store_inventory.md:1-312`,
then inspected every current owner that the inventory classified
CONDITIONALLY-UNBOUNDED or UNBOUNDED. The post-baseline scan covered the first
40 changed source files requested by the work order and the complete added-file
and current-source Map/Set/cache scan; the resulting new-owner ledger is
`devlog/_fin/260813_bun_canary_dogfood/051_new_owners_since_baseline.md:1-66`.

The current runtime has two distinct ownership systems. Retained logs, caches,
blobs, and continuation rows are byte-accounted and evicted by the 12
registrations at `src/lib/app-owned-memory-stores.ts:76-155`; translator and
serialized-tail buffers are observe-only at
`src/lib/app-owned-memory-stores.ts:157-166`. Expiry and topology reconciliation
are centralized in the 24 registrations at
`src/lib/state-store-registrations.ts:75-107`. Active resources are not swept;
they use finite admission leases (`src/lib/admission.ts:28-57`) and release on
their real lifecycle boundary.

## Current status of the formerly non-bounded inventory

Priority means the original growth driver: HIGH = traffic/input, MEDIUM =
configuration/path churn, LOW = active connections or bounded administrative
activity. “Patched” means the 2026-08-01 implementation already supplied a
finite cap, byte budget, active expiry/reconciliation, or admission gate in the
current source. The table includes the four baseline UNBOUNDED rows because the
same implementation closed them and omitting them would hide regressions.

| Baseline # | Store | Current status and proof | Owner system | Patchability now | Priority |
|---:|---|---|---|---|---|
| 1 | Responses continuation | **Patched**: 1,000 rows, 64 MiB resident cap, direct spill for oversized rows, and active one-hour sweep (`src/responses/state.ts:17-35,305-349,729-765`). | App-owned + sweeper (`src/lib/app-owned-memory-stores.ts:144-147`; `src/lib/state-store-registrations.ts:85`). | No new patch; translation duty requires explicit spill/miss semantics. | HIGH |
| 3 | Cursor shared blobs | **Patched**: 4,096 rows, 16 MiB/blob and 64 MiB aggregate (`src/adapters/cursor/native-exec.ts:89-126,234-328`). | App-owned (`src/lib/app-owned-memory-stores.ts:138-141`). | No new patch; explicit admission already preserves hash lookup. | HIGH |
| 6 | Antigravity replay | **Patched**: 256 calls/session, 2 MiB/session, 64 MiB total and periodic expiry (`src/adapters/google-antigravity-replay.ts:37-43,531-577`). | App-owned + sweeper (`src/lib/app-owned-memory-stores.ts:120-123`; `src/lib/state-store-registrations.ts:86`). | No new patch; replay signatures are protocol state. | HIGH |
| 7 | Request-log ring | **Patched**: 2,000 rows with retained-byte accounting and oldest eviction (`src/server/request-log.ts:168-193`; `src/lib/app-owned-memory-stores.ts:77-82`). | App-owned. | No new patch. | HIGH |
| 9 | Debug rings | **Patched**: 2,000 rows/16 KiB line for provider and injection logs and 32 KiB/row for Claude metadata (`src/lib/debug-log-buffer.ts:10-33`; `src/lib/injection-debug-log.ts:12-32`; `src/claude/inbound-debug.ts:45-47,112-133`). | App-owned (`src/lib/app-owned-memory-stores.ts:83-100`). | No new patch. | MEDIUM |
| 10 | Debug subscribers | **Patched**: 64-lease gate and explicit unsubscribe release (`src/lib/debug-log-buffer.ts:11-16,48-66`). | Admission gate. | No new patch; active listeners must remain tracked. | LOW |
| 11 | Crash ring | **Patched**: retained URL/origin/rejection values are truncated to 8 KiB (`src/lib/crash-guard.ts:210-238`) and the ring is app-owned (`src/lib/app-owned-memory-stores.ts:101-106`). | App-owned. | No new patch. | MEDIUM |
| 12 | Image normalization cache | **Patched**: finite entry, payload and metadata accounting (`src/adapters/anthropic-image-normalize.ts:103-138`) with app-budget eviction (`src/lib/app-owned-memory-stores.ts:108-112`). | App-owned. | No new patch. | HIGH |
| 13 | Model/discovery caches | **Mostly patched**: retained model bytes are budgeted and provider rows reconcile (`src/codex/model-cache.ts:179-197,225-266`); catalog flights are capped at eight (`src/codex/catalog/provider-fetch.ts:212-227,1526-1552`). **Investigation remains**: generation tombstones are deliberately retained in `providerCacheGenerations` (`src/codex/model-cache.ts:48-50,163-171,225-248`). | App-owned + sweeper + admission. | Do not delete tombstones until in-flight authority is represented without historical keys. | MEDIUM |
| 14 | Catalog/warning state | **Patched**: warning memo reconcilers are registered for config generation (`src/lib/state-store-registrations.ts:87-91`); model rows are covered by #13. | Sweeper. | No new patch. | MEDIUM |
| 15 | Usage summary cache | **Patched**: exact serialized bytes and oldest eviction (`src/server/management/usage-summary-cache.ts:21-80`) under the app budget (`src/lib/app-owned-memory-stores.ts:132-135`). | App-owned. | No new patch. | HIGH |
| 17 | Provider/Codex quota caches | **Patched**: provider-account rows expire/reconcile (`src/providers/quota.ts:1223-1234,1283-1309`) and Codex rows reconcile to live accounts (`src/codex/quota.ts:424-436`). | Sweeper (`src/lib/state-store-registrations.ts:92-93`). | No new patch; in-flight probes remain active-owner state. | MEDIUM |
| 18 | Codex/Anthropic routing health | **Patched**: live-account reconciliation and expired-health sweeping are registered (`src/lib/state-store-registrations.ts:83,94`); affinity remains finite LRU (`src/oauth/anthropic-routing.ts:253-263,372-373`). | Sweeper. | No new patch. | MEDIUM |
| 20 | Subagent quota-failure records | **Patched**: expired rows are swept centrally (`src/lib/state-store-registrations.ts:76`; `src/codex/subagent-model-fallback.ts:229-253`). | Sweeper. | No new patch. | MEDIUM |
| 21 | Pool/combo rotation and cooldown | **Patched**: rotation state reconciles to current topology and cooldowns actively sweep (`src/lib/state-store-registrations.ts:78-82,96-97`). | Sweeper. | No new patch. | MEDIUM |
| 22 | OAuth/Codex login and refresh | **Patched**: Codex login rows cap at 32 and terminal rows expire (`src/codex/auth-api.ts:154-181,1845-1853`); OAuth flow topology reconciles (`src/lib/state-store-registrations.ts:103`). | Admission + sweeper. | No new patch; accepted flows cannot be evicted mid-login. | HIGH |
| 23 | Guardian/reauth/GCP token state | **Patched**: guardian/reauth rows reconcile and GCP rows both expire and reconcile (`src/lib/state-store-registrations.ts:98-102`). | Sweeper. | No new patch. | MEDIUM |
| 26 | Config ownership/PID/warning memos | **Patched** for baseline owners: roots reconcile, dead PIDs sweep, and warning generations reconcile (`src/lib/state-store-registrations.ts:87-91,102-104`). | Sweeper. | New path memos are handled separately in `051_new_owners_since_baseline.md:20-56`. | MEDIUM |
| 27 | Windows ACL memo sets | **Patched**: hardened paths are identity-aware maps and ephemeral hardening is released after rename (`src/lib/windows-secret-acl.ts:40-47,113-122`). | Owner-specific cleanup. | No generic TTL; deleting live identity proof would weaken secret-file hardening. | MEDIUM |
| 29 | Active turns/sockets/workers/slots | **Bounded by design**: 256 turns (`src/server/lifecycle.ts:32-40`), 128 WebSockets (`src/codex/websocket-registry.ts:5-31`), 16 worker reservations (`src/storage/worker-lifecycle.ts:29-40`), and 32 storage-home slots (`src/storage/storage-mutation-coordinator.ts:27-29`). | Admission gates. | Not evictable; release only when the live owner ends. | LOW |
| 30 | Cursor background shells | **Patched**: finite admission plus idle/absolute timers and controlled kill/close release (`src/adapters/cursor/native-exec-shell.ts:74-81,287-321,367-390`). | Admission + owner timers. | No blind eviction; shell side effects require controlled termination. | LOW |
| 31 | Cursor per-stream MCP manager | **Patched**: 32 servers, 512 tools, 1,024 resources, 4 MiB catalog and 8 MiB result limits (`src/adapters/cursor/mcp-manager.ts:9-14,111-116`). | Stream-owned limits. | Not process-cached; dispose remains the lifecycle boundary. | LOW |
| 32 | Vision-description LRU | **Patched**: 256 rows, 1 MiB aggregate, 2,000-character stored text (`src/vision/index.ts:31-40,105-129,512`). | App-owned (`src/lib/app-owned-memory-stores.ts:114-117`). | No new patch. | HIGH |
| 33 | Serialized promise tails | **Patched**: image and OAuth tails have finite pending limits (`src/images/fulfill.ts:11,63-64`; `src/oauth/store.ts:24,409-450`); Grok apply rejects/coalesces stale work (`src/server/management/agent-settings-routes.ts:77,136,743`). | Observe-only (`src/lib/app-owned-memory-stores.ts:159-161`). | Accepted writes must remain ordered; do not truncate the queue. | HIGH |
| 34 | Codex credential-refresh flights | **Patched**: finite refresh admission and typed busy/stale outcomes are consumed by auth (`src/codex/account-store.ts:297-360`; `src/codex/auth-api.ts:18-22,932-939`). | Admission gate. | Accepted token rotation must remain attached to its owner. | HIGH |
| 35 | MiMo JWT/client-id cache | **Patched**: bootstrap 128 KiB and JWT 64 KiB (`src/adapters/mimo-free.ts:27-31,113-141`). | Fixed slots + value admission. | No new patch. | HIGH |
| 36 | Usage-log management read | **Patched**: 64 MiB read window and 500,000 parsed-entry cap (`src/usage/log.ts:448-451,544-546,604-687`). | Active single-flight + input cap. | Do not cache completed parsed rows. | HIGH |

## Patchable work, in dependency order

These are post-baseline owners, not regressions in the closed 36-store work.
All four patches are local and should land before expanding app-owned-memory: their
worst-case values are small and a count/LRU bound is sufficient.

### Phase 1 — reusable bounded path-memo convention

No new shared helper is required. The three owners have different invalidation
semantics, and a generic cache would obscure security-sensitive behavior. Use
insertion-order LRU locally and add focused reset/size seams only for tests.

#### 1. Native-main hardened identity memo

File: `src/codex/native-main-claim.ts:25,74-90`  
Risk: MEDIUM path churn; eviction merely repeats hardening and identity assertion.

```diff
-const hardenedIdentities = new Map<string, string>();
+const NATIVE_MAIN_HARDENED_IDENTITY_MAX_ENTRIES = 32;
+const hardenedIdentities = new Map<string, string>();
+function rememberHardenedIdentity(path: string, identity: string): void {
+  hardenedIdentities.delete(path);
+  hardenedIdentities.set(path, identity);
+  while (hardenedIdentities.size > NATIVE_MAIN_HARDENED_IDENTITY_MAX_ENTRIES) {
+    const oldest = hardenedIdentities.keys().next().value;
+    if (oldest === undefined) break;
+    hardenedIdentities.delete(oldest);
+  }
+}
 ...
-      hardenedIdentities.set(path, identity);
+      rememberHardenedIdentity(path, identity);
```

The before/after preserves the required “harden before opening SQLite” ordering at
`src/codex/native-main-claim.ts:74-99`; an evicted row causes another harden rather
than skipping protection.

#### 2. Lab installation-salt memo

File: `src/lab/subject/installation-salt.ts:6-21`  
Risk: MEDIUM config-root churn; values are fixed 32-byte salts.

```diff
 const SALT_BYTES = 32;
+const INSTALLATION_SALT_CACHE_MAX_ENTRIES = 16;
 const installationSaltCache = new Map<string, Uint8Array>();
 ...
 function cacheSalt(path: string, salt: Uint8Array): Uint8Array {
   const cached = new Uint8Array(salt);
+  installationSaltCache.delete(path);
   installationSaltCache.set(path, cached);
+  while (installationSaltCache.size > INSTALLATION_SALT_CACHE_MAX_ENTRIES) {
+    const oldest = installationSaltCache.keys().next().value;
+    if (oldest === undefined) break;
+    installationSaltCache.delete(oldest);
+  }
   return new Uint8Array(cached);
 }
```

Cache eviction is behavior-neutral because every miss re-reads and validates exactly
32 bytes at `src/lab/subject/installation-salt.ts:10-15,25-34`.

### Phase 2 — bounded capability memo

#### 3. Codex mode-hint capability cache

File: `src/codex/features.ts:1039-1082`  
Risk: MEDIUM binary/version churn; each value is one tri-state boolean but each key
contains paths and stat fingerprints.

```diff
-const modeHintCapabilityCache = new Map<string, boolean | null>();
+const MODE_HINT_CAPABILITY_CACHE_MAX_ENTRIES = 8;
+const modeHintCapabilityCache = new Map<string, boolean | null>();
+function cacheModeHintCapability(key: string, value: boolean | null): void {
+  modeHintCapabilityCache.delete(key);
+  modeHintCapabilityCache.set(key, value);
+  while (modeHintCapabilityCache.size > MODE_HINT_CAPABILITY_CACHE_MAX_ENTRIES) {
+    const oldest = modeHintCapabilityCache.keys().next().value;
+    if (oldest === undefined) break;
+    modeHintCapabilityCache.delete(oldest);
+  }
+}
 ...
-          modeHintCapabilityCache.set(cacheKey, true);
+          cacheModeHintCapability(cacheKey, true);
 ...
-    modeHintCapabilityCache.set(cacheKey, result);
+    cacheModeHintCapability(cacheKey, result);
```

A miss repeats a binary inspection (`src/codex/features.ts:1046-1082`); it does not
change the capability result.

### Phase 3 — remove the unnecessary Lab process index

#### 4. Lab ledger event-id index

File: `src/lab/ledger/store.ts:28,160-173,175-216`  
Risk: HIGH append-only traffic. The map retains every event id for every ledger path,
while duplicate-safe append already rebuilds a fresh set under the inter-process lock.

```diff
-const eventIdIndexByLedger = new Map<string, Set<string>>();
 ...
-/** Load or build the in-memory event-id index for a ledger path. */
-function loadEventIdIndex(ledgerPath: string): Set<string> { ... }
 ...
-  loadEventIdIndex(ledgerPath).add(validated.eventId);
 ...
-    eventIdIndexByLedger.set(ledgerPath, fresh);
     if (fresh.has(validated.eventId)) return false;
```

This is safe because ordinary `appendLabEvent()` does not perform deduplication
(`src/lab/ledger/store.ts:175-196`), while `appendLabEventIfAbsent()` constructs the
authoritative `fresh` set from disk under `withLedgerLock()` before testing membership
(`src/lab/ledger/store.ts:202-216`). If replay cost later becomes material, replace
the process Map with a bounded on-disk index; do not restore an all-history RAM set.

## Not patchable by eviction

- Translation continuation, replay, Cursor MCP, tool-argument, item-id, and response
  assembly state cannot be truncated or randomly evicted: coherent overflow must fail
  the turn, because partial JSON or missing identity cross-wires protocol events
  (`src/lib/translator-budget.ts:115-165`; `src/adapters/cursor/mcp-manager.ts:9-14`).
- Active turns, sockets, workers, storage slots, login/refresh flights, and background
  shells represent live ownership. Their finite admission gates are the bound; sweeping
  an accepted owner would make cleanup and credential rotation unsafe
  (`src/server/lifecycle.ts:32-40`; `src/codex/websocket-registry.ts:5-24`;
  `src/storage/worker-lifecycle.ts:29-40`; `src/adapters/cursor/native-exec-shell.ts:74-81`).
- The model-cache generation tombstones prevent a discovery admitted before a clear
  from repopulating stale data (`src/codex/model-cache.ts:163-185,199-248`). They need
  a redesigned per-flight authority token or bounded epoch table before deletion; a
  count cap alone is not safe.
- The Lab MCP loopback invocation array is test/harness-only: production source has no
  caller, and tests clear it after each case (`src/lab/live/mcp-loopback.ts:17-31`;
  `tests/lab-live-probe.test.ts:14-23`). It should remain excluded from production
  app-owned-memory unless the stub becomes a live service feature.

## Bun 1.3.14 to 1.4-canary memory/GC findings

The range was verified from Bun's official Git history starting at tag
`bun-v1.3.14` (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`). These are upstream
runtime changes, not substitutes for the OpenCodex bounds above.

| Area | Finding | Dogfood implication |
|---|---|---|
| Native leaks | Bun's broad native leak sweep fixed fetch/request clone, streams, WebSocket, timers, workers and many other native ownership paths in [oven-sh/bun#30875](https://github.com/oven-sh/bun/commit/fba43af684f3b1d97e51370c847acbcc52db99ec). | Re-run HTTP/WebSocket churn; flatter RSS with flat app-owned counters is plausible, but the change is broad and needs A/B proof. |
| JSC pressure | `Bun.serve` restored per-request external-memory reporting so JSC collects native request garbage promptly; upstream measured a lower steady RSS plateau and explicitly called it “not a leak” in [oven-sh/bun#31422](https://github.com/oven-sh/bun/commit/19dd34df338f66648ff984d2754ec6f0ff3ff76f). | Compare steady-state plateau, not only end RSS; record `heapUsed`, `external`, `arrayBuffers`, JSC heap, and app-owned bytes. |
| Fragmentation / OS return | Freed mimalloc pages are scavenged on a background thread, including busy server loops, in [oven-sh/bun#34181](https://github.com/oven-sh/bun/commit/c4d67139cf192babe48835ff44684fc2c788bc64). The change is disabled on Windows by its own design. | This is the strongest direct improvement for RSS retention/fragmentation on macOS/Linux; run platform-separated A/B and do not expect the same Windows result. |
| External memory | Node crypto wrappers now report native buffers/contexts to JSC in [oven-sh/bun#32653](https://github.com/oven-sh/bun/commit/de400b1c7c41ff8b4f37c8e3ed9ba63ba19892c3); N-API negative adjustment bookkeeping is fixed in [oven-sh/bun#34142](https://github.com/oven-sh/bun/commit/6a1acc93f821e5145c5366e50e12ae3da5095bd7). | Better GC pressure/accounting exists, but the N-API fix cannot decrement JSC's own historical extra-memory counter; interpret that metric with care. |
| ArrayBuffer/backpressure | Fetch receive backpressure is coupled to JS consumption in [oven-sh/bun#29831](https://github.com/oven-sh/bun/commit/81dfd59967), and aborted streaming fetch releases unread native bytes in [oven-sh/bun#32662](https://github.com/oven-sh/bun/commit/4b7241669601260cd35cd00c7853ab5a43027f96). | Exercise slow downstream, cancellation, and abort-after-buffer workloads; these changes directly match proxy behavior. |
| Fetch leaks | Proxy/file/blob URL string refs are released in [oven-sh/bun#32329](https://github.com/oven-sh/bun/commit/91f028382c77bf269f3adf3a3b3589289b9e39d5), and CONNECT response buffering is cleared after handoff in [oven-sh/bun#30385](https://github.com/oven-sh/bun/commit/8cf37378129933f73a830a069fd7dc928360c109). | Include proxy URL churn and CONNECT split-envelope cases if the dogfood route uses a proxy. |
| WebSocket | Client ownership no longer holds an exclusive reference across re-entrant callbacks in [oven-sh/bun#33055](https://github.com/oven-sh/bun/commit/5124b0ce18a6571aa04fbe712fcddb601b76e950). This is a lifetime/UAF correction, not a documented heap-fragmentation fix. | Keep WebSocket connection churn and callback re-entry in stability tests; do not claim an RSS win from this commit alone. |

No upstream commit in the inspected range makes a general claim that JSC heap
fragmentation itself is eliminated. The strongest evidence is allocator-page return
in #34181 and improved external-memory pressure/accounting in #31422/#32653; therefore
the canary evaluation must retain an OpenCodex 1.3.14 control and distinguish reachable
heap, external/ArrayBuffer memory, and allocator RSS.

## Counts and implementation-loop recommendation

For the baseline's 27 formerly non-bounded rows: **25 stores are patched, 1 store
is accepted as bounded-by-design, and 1 store needs further investigation**.
The post-baseline scan adds **0 newly patched stores, 4 patchable stores, 1 store needing
further investigation, and 1 test-only exclusion**
(`devlog/_fin/260813_bun_canary_dogfood/051_new_owners_since_baseline.md:20-66`).

Recommended implementation loop:

1. Phase 1: add red cardinality tests, then cap native-main and installation-salt path
   memos (`src/codex/native-main-claim.ts:25-90`;
   `src/lab/subject/installation-salt.ts:6-34`).
2. Phase 2: cap the mode-hint fingerprint memo and verify alternating binary identities
   still re-probe correctly (`src/codex/features.ts:1039-1082`).
3. Phase 3: remove the Lab event-id process index and prove duplicate-safe append remains
   atomic under the existing ledger lock (`src/lab/ledger/store.ts:150-216`).
4. Phase 4: design and test bounded model-cache generation authority before changing
   tombstone retention (`src/codex/model-cache.ts:163-185,225-248`).
5. Phase 5: run identical 1.3.14/canary HTTP, abort, WebSocket, image and idle-recovery
   workloads; accept a Bun attribution only when app-owned counters and reachable heap
   stay flat while external/ArrayBuffer/RSS behavior changes.
