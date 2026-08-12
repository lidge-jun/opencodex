# Zero-leak state-store inventory

Audited 2026-08-01 against `dev@a9926d01da5dde052dba2ac6d804a3336edb2f99`.
This read-only roadmap input inherits
`devlog/_plan/260731_macos_rss_retention/062_external_handoff_audit.md`.
The prior unit's stream-path work is out of scope.

## Scope and verdicts

This covers app-owned process state that can survive a request/stream, plus
request-scoped state that exists because OpenCodex is a **bidirectional protocol
translator**. Immutable lookup tables, non-escaping locals, weak collections
that do not keep keys alive, and disk files not retained in RAM are excluded.

- **BOUNDED**: finite production count/bytes, fixed slot, or current-config snapshot.
- **CONDITIONALLY-UNBOUNDED**: one dimension is uncapped, cleanup is lazy, historical
  key churn accumulates, or growth is limited only by active concurrency/config.
- **UNBOUNDED**: reachable additions have no count, byte, TTL, or replacement bound.
- **Translation duty**: state required to assemble/correlate/replay protocols. It
  must stay but be bounded; deleting it like a pure relay would break the product.

`S(x)` below means the retained size of variable value `x`.

## Summary table

| # | Store | Current bound | Verdict | Translation duty |
|---:|---|---|---|:---:|
| 1 | Responses continuation | 1,000; lazy 1 h TTL; nominal 64 MiB but last entry exempt | **CONDITIONALLY-UNBOUNDED** | yes |
| 2 | Responses replay provenance | weak body-key map | **BOUNDED** | yes |
| 3 | Cursor shared blobs | 4,096; lazy 15 min TTL; no bytes | **CONDITIONALLY-UNBOUNDED** | yes |
| 4 | Cursor context-usage carry | 200 numeric rows; lazy 1 h TTL | **BOUNDED** | yes |
| 5 | Cursor thread overrides | 2,048; lazy 1 h TTL/LRU | **BOUNDED** | yes |
| 6 | Antigravity signature replay | 10,240 sessions; unbounded inner call maps | **CONDITIONALLY-UNBOUNDED** | yes |
| 7 | Request-log ring | 2,000 entries; no bytes | **CONDITIONALLY-UNBOUNDED** | no |
| 8 | Memory watchdog | 360 fixed samples | **BOUNDED** | no |
| 9 | Debug/injection/Claude-debug rings | 2,000 / 2,000 / 20; variable entries | **CONDITIONALLY-UNBOUNDED** | no |
| 10 | Debug subscribers | active listener set; no count | **CONDITIONALLY-UNBOUNDED** | no |
| 11 | Crash fetch ring + inspector counters | 12 traces (URL/stack/rejection strings uncapped — audit R1-4) + five numbers | **CONDITIONALLY-UNBOUNDED** | no |
| 12 | Image normalization cache | 64 MiB payload; zero-weight sentinels uncapped | **UNBOUNDED** | yes |
| 13 | Model/discovery caches | bounded response/provider; historical provider keys uncapped | **CONDITIONALLY-UNBOUNDED** | no |
| 14 | Catalog/warning state | current config plus historical warning keys | **CONDITIONALLY-UNBOUNDED** | no |
| 15 | Usage summary cache | 12 keys; summary model cardinality uncapped | **CONDITIONALLY-UNBOUNDED** | no |
| 16 | API-key rollup | one 60 s current-config snapshot | **BOUNDED** | no |
| 17 | Provider/Codex quota caches | account keyed; historical keys uncapped | **CONDITIONALLY-UNBOUNDED** | no |
| 18 | Codex/Anthropic routing health | account keyed; health cleanup lazy | **CONDITIONALLY-UNBOUNDED** | no |
| 19 | Codex/Anthropic affinity | 2,048 / 2,000; lazy 24 h TTL/LRU | **BOUNDED** | no |
| 20 | Subagent quota-failure records | expired keys never removed | **UNBOUNDED** | no |
| 21 | Pool/combo rotation + cooldown | config keyed; historical/expired keys lazy or permanent | **CONDITIONALLY-UNBOUNDED** | no |
| 22 | OAuth/Codex login and refresh state | provider/flow/active-flight keyed | **CONDITIONALLY-UNBOUNDED** | no |
| 23 | Guardian/reauth/GCP token state | account/source keyed; historical keys possible | **CONDITIONALLY-UNBOUNDED** | no |
| 24 | GUI management sessions | 128; lazy 5 min TTL | **BOUNDED** | no |
| 25 | Current-config registries | whole-map replacement, current catalog/config | **BOUNDED** | partly |
| 26 | Config ownership/PID/warning memos | root/PID/path/history keyed; no general cap | **CONDITIONALLY-UNBOUNDED** | no |
| 27 | Windows ACL memo sets | unique atomic-temp success paths never clear | **UNBOUNDED on Windows** | no |
| 28 | Single-slot diagnostics/jobs | one value/job/outcome per owner | **BOUNDED** | no |
| 29 | Active turns/sockets/workers/slots | cleanup-bound; no registry admission cap | **CONDITIONALLY-UNBOUNDED** | no |
| 30 | Cursor background shells | live child until close; no count/age cap | **UNBOUNDED when enabled** | yes |
| 31 | Cursor per-stream MCP manager | config-sized; disposed on close; no payload/count cap | **CONDITIONALLY-UNBOUNDED** | yes |
| 32 | Vision-description LRU | 256 entries; cached text has no byte cap | **CONDITIONALLY-UNBOUNDED** | yes |
| 33 | Serialized promise tails | one tail reference; pending closure chain has no admission cap | **CONDITIONALLY-UNBOUNDED** | partly |
| 34 | Codex credential-refresh flights | one active promise/grant fingerprint; no admission cap | **CONDITIONALLY-UNBOUNDED** | no |
| 35 | MiMo JWT/client-id cache | fixed slots; JWT value has no byte cap | **CONDITIONALLY-UNBOUNDED** | no |
| 36 | Usage-log management read flight | one active full-log parse/result | **CONDITIONALLY-UNBOUNDED** | no |

## 1. Responses continuation state

- **Owner/purpose:** `src/responses/state.ts:6-35,319-334,415-455` stores
  expanded input plus authoritative output by response id so
  `previous_response_id` works against stateless/routed providers.
- **Growth driver:** one row per remembered turn. Each row is
  `inputItems(request.input) + response.output` (`state.ts:444-447`). Arrays are
  new; history objects/strings may be shared, while persistence serializes each
  full prefix.
- **Bounds:** 1,000 rows, `createdAt` TTL 1 h, nominal 64 MiB
  (`state.ts:6-16`). TTL pruning is access-triggered, not periodic. The sole
  measurement is `JSON.stringify(entry.items).length` in JS code units; it omits
  provider/map/object overhead and counts stringify failure as zero
  (`state.ts:52-60`).
- **Eviction:** TTL, then count, then oldest-bytes. The byte loop is
  `while (storedResponseBytes > byteCap() && states.size > 1)`, so it never
  removes the newest/only row (`state.ts:319-333`).
- **Worst case:** measured retention is `max(64 MiB, S(newest row))`. The newest
  row can include a near-256 MiB accepted request plus unbounded streamed output
  and base64 items. Idle expired rows remain past 1 h until another access.
  Verdict: **CONDITIONALLY-UNBOUNDED**.
- **Disk contract:** persistence is 2 s debounced/single-flight. A serialized
  pair over 2 MiB is skipped; newest-first snapshot selection stops at 24 MiB
  (`state.ts:252-299`). The timer admits one scheduled write; `persistGate`
  serializes overlapping explicit flushes, whose active call stacks can still
  grow with unconstrained concurrent `flushResponseState()` callers. Thus
  oversized rows remain in RAM but disappear after restart.
  `tests/responses-state.test.ts:856-883` pins this exact behavior.
- **Naive-cap blast radius:** evicting/rejecting the newest row makes the next
  chained turn a naked delta. Cursor/Kiro lose conversation identity; tool
  results lose prior tool metadata; stateless upstreams cannot resolve history.
  Use explicit admission/miss semantics and bounded blob/spill references, not
  silent replay truncation.

### Exact continuation contract

`tests/responses-state.test.ts` was read fully (1,016 lines):

1. Replay prepends prior input and output, including tool-call metadata needed to
   parse later `function_call_output` (`:67-179`).
2. Completed and only `incomplete/max_output_tokens` partial output are replayable;
   failed/content-filtered partials are not (`:90-155`).
3. Ordinary `store:false` skips storage, but forced storage is required for
   Cursor, Kiro, and stateless passthrough continuation (`:181-217,495-533`).
4. Empty terminal output may be reconstructed from `output_item.done`. Non-empty
   terminal output wins; malformed items are ignored; duplicate indices are
   last-write-wins; cap-tainted reconstruction is never stored (`:219-493`).
5. Weak replay provenance distinguishes restored prefix from new suffix, avoiding
   duplicate developer guidance and false compaction resets (`:335-397,913-957`;
   `state.ts:79-82`).
6. Provider-keyed Cursor/Kiro state survives restart. Cursor conversation id
   survives client-tool suspension, while `checkpointUsable` becomes false for a
   function-call output (`state.ts:436-452`; tests `:782-804,885-911`).
7. Replacement, count eviction, TTL eviction, and restart load must keep byte
   accounting exact (`:535-658`).
8. Snapshot recovery is best-effort; v1 migrates; stale/corrupt snapshots are
   ignored; valid small chains survive restart (`:660-883`).
9. Metrics are observe-only and may not load, prune, evict, or reserialize
   (`:959-1015`; `state.ts:371-408`).

The “newest link survives” assertion (`tests/responses-state.test.ts:535-555`) is
the policy conflicting with a hard ceiling. Redesign must replace it explicitly.

## 2. Cursor and translation replay stores

| Store | Growth and bounds | Worst case / verdict | Naive-cap blast radius |
|---|---|---|---|
| Shared blobs (`src/adapters/cursor/native-exec.ts:75-136,202-227`) | Content-addressed roots/turn/KV bytes shared across streams. Re-store refreshes order. 4,096 rows; lazy 15 min TTL/count eviction; no per-blob/aggregate bytes. | `sum(S(blob_i)), i<=4096`. Connect allows payload length `2^32-1` (`cursor/framing.ts:1-5`), nearly 16 TiB theoretical at 4,096 rows; no finite app byte bound. **CONDITIONALLY-UNBOUNDED**. | Missing blobs break Cursor hydration. Preserve hash lookup/live refresh; add per-blob+aggregate admission and explicit miss. |
| Context usage (`cursor/protobuf-events.ts:17-123`; singleton `live-transport.ts:73`) | Absolute token total by conversation; 200 rows, lazy 1 h TTL/oldest prune. | `200 × (id + numbers)`. **BOUNDED**. | Eviction loses absolute carry-forward and can report tiny output as context; retain compaction reset/rekey. |
| Thread override (`cursor/thread-continuity.ts:9-62`) | Recovered thread/scope→conversation; 2,048, lazy 1 h TTL/LRU. | `2048 × two ids`. **BOUNDED**. | Eviction can revert to stale deterministic conversation id. |
| Antigravity replay (`src/adapters/google-antigravity-replay.ts:13-24,60-130`) | Outer model/session rows; inner map per distinct function-call canonical args. Outer lazy 1 h TTL/max 10,240; no inner count/bytes. | `<=10240 × unbounded calls/session × (canonical args + signature)`. **CONDITIONALLY-UNBOUNDED**. | Clearing active identities causes upstream invalid-signature 400. Bound bytes/calls while retaining recent referenced calls and clear-on-invalid. |

The Cursor external selected-root budget is 192 roots/512 KiB
(`cursor/protobuf-request.ts:54-60,233-305`), but all candidate roots are stored
before selection (`:195-230`). Native step blobs (`:340-404`) and KV
`setBlobArgs` do not inherit that budget.

## 3. Logs, metrics, and image cache

| Store | Bounds/eviction and worst case | Verdict | Blast radius |
|---|---|---|---|
| Request log (`src/server/request-log.ts:150-154,218-246`) | Latest 2,000, hydrated/shifted. No byte cap: `2000 × S(RequestLogEntry)`; nested attempts and several strings have no aggregate accounting. | **CONDITIONALLY-UNBOUNDED** | Preserve retry/failover attribution; normalize per-entry bytes rather than silently dropping attempts. |
| Watchdog (`src/server/memory-watchdog.ts:53-60,102-155`) | Default 360 fixed samples; splice on tick; singleton replacement stops prior timer. | **BOUNDED** | Lower count only weakens trend diagnosis. |
| Provider debug (`src/lib/debug-log-buffer.ts:10-35`) | 2,000 unbounded-length lines; active listener set has explicit unsubscribe but no count cap. | **CONDITIONALLY-UNBOUNDED** | Preserve safe diagnostic endings and GUI tailing; cap line bytes/admission. |
| Injection debug (`src/lib/injection-debug-log.ts:10-27`) | 2,000 unbounded-length lines. | **CONDITIONALLY-UNBOUNDED** | Same; retain capture semantics. |
| Claude debug (`src/claude/inbound-debug.ts:40-106`) | 20 rows; metadata key arrays/model/beta strings locally uncapped, globally body-capped. | **CONDITIONALLY-UNBOUNDED** | Preserve privacy tags and flag-off clearing. |
| Crash ring (`src/lib/crash-guard.ts:206-245`) / inspector counters (`src/server/relay.ts:18-49`) | 12 traces, but URL/stack-origin/rejection strings per trace are uncapped (audit R1-4); counters are a fixed five-number object. | **CONDITIONALLY-UNBOUNDED** (value bytes) | Truncate retained strings (035); too-small caps lose Bun-failure provenance. |
| Image normalize (`src/adapters/anthropic-image-normalize.ts:96-143`) | Encoded data has 64 MiB LRU. `\"pass\"`/`\"miss\"` are assigned zero size, so unique sentinel keys never trigger eviction; no count/TTL. | **UNBOUNDED** Map metadata | Deleting cache repeats decode/encode for accumulated screenshots. Add count/key-overhead cap including sentinels; retain encoded LRU. |

## 4. Catalog, usage, and quota caches

| Store | Growth/bounds/eviction | Verdict | Blast radius |
|---|---|---|---|
| Model cache/status (`src/codex/model-cache.ts:42-56,114-147`) | Last-good arrays + status per provider. Fresh 5 min/failure cooldown 30 s, but stale arrays and historical providers persist until explicit clear. Generic discovery is capped at 4 MiB, 2,000 models, 1,024-char ids (`providers/model-discovery.ts:12-16,175-230`). Cursor's custom RPC buffers every response chunk before applying a 500-id result cap (`adapters/cursor/live-models.ts:98-125`), so that active value has no byte cap. | **CONDITIONALLY-UNBOUNDED** provider churn/active Cursor response | Last-good is availability behavior; prune only providers absent from current config and cap Cursor RPC bytes before decode. |
| Gather in-flight (`catalog/provider-fetch.ts:64-129,645-665`) | One promise/result per distinct concurrent config fingerprint, deleted in `finally`; no concurrency cap. A Cursor flight may retain the uncapped RPC body above. | **CONDITIONALLY-UNBOUNDED by active concurrency/value bytes** | Keep same-key dedup; reject/coalesce churn and abort oversized discovery bodies. |
| Warning/omission state (`provider-fetch.ts:219-245`; `catalog/aggregation.ts:37-69,235-320`; `router.ts:152-180`; `combos/request.ts:4-38`; `config.ts:435,2052-2053`) | Catalog keys clear on sync (`catalog/sync.ts:313-317`); router/config/combo warning keys do not. Latest omissions are replacement/config-sized. | **CONDITIONALLY-UNBOUNDED** historical signatures | Clearing every request floods logs; use config generation/bounded signature LRU. |
| Usage summary (`management/logs-usage-routes.ts:81-115,187-205`) | Exactly 3 ranges × 4 surfaces. A summary can retain every distinct model in append-only usage history. | **CONDITIONALLY-UNBOUNDED** value bytes | Aggregate excess models into “other”; never drop totals. |
| API-key rollup (`management/api-key-usage.ts:105-161`) | One replacement snapshot, 60 s TTL, current configured keys. | **BOUNDED by config** | Preserve duplicate-id ambiguity and revision/config keying. |
| Provider quota (`src/providers/quota.ts:52-61,195-239,278-407`) | One report, active flights, 10 min per-account rows. Historical account rows require explicit clear; flights delete in `finally`. | **CONDITIONALLY-UNBOUNDED** | Preserve last-good negative caching; prune removed credential generations. |
| Codex quota (`src/codex/quota.ts:14-27,51,261-326`) | Fixed numeric row/account persisted. Disk load admits rows <=6 h old, but loaded rows do not age out; no count/file-size cap. | **CONDITIONALLY-UNBOUNDED** | Retain live account quota bars/selection; reconcile with live store plus age. |
| Desktop registry (`src/claude/desktop-3p.ts:106-107,151-205,246-280`) | Whole-map replacement, current models/profile. | **BOUNDED by config**, translation-required | Removal breaks inbound alias decoding. |

## 5. Routing, cooldown, and auth stores

| Store | Current contract | Worst case / verdict | Blast radius |
|---|---|---|---|
| Codex health (`src/codex/routing.ts:85-138,209-243`) | Account-wide + fixed quota-scope maps; semantic cooldowns, manual/outcome clears, no historical-account cap. | Historical accounts × fixed rows. **CONDITIONALLY-UNBOUNDED**. | Never erase live Retry-After/probe generation. |
| Codex affinity (`routing.ts:105-109,624-688`) | Hard 2,048 total thread/scope bindings, lazy 24 h TTL/LRU. | **BOUNDED**. | Too small causes account flapping/cache misses. |
| Anthropic health/affinity (`oauth/anthropic-routing.ts:34-40,62-63,96-116,234-241`) | Health max 15 min semantically but no global expired sweep; affinity hard 2,000/lazy 24 h TTL/LRU. | **CONDITIONALLY-UNBOUNDED** historical health; affinity **BOUNDED**. | Preserve live Retry-After/session affinity. |
| Subagent failure (`codex/subagent-model-fallback.ts:40-42,160-171,229-253`) | `unavailableUntil` is checked but expired rows are never deleted; no count cap. Prime map has one `global` key. | Arbitrary failed model/account keys forever. **UNBOUNDED**. | Delete on expiry/cap history without disabling active fallback suppression. |
| Pool/combo rotation (`codex/pool-rotation.ts:6-12,44-80,180-185`; `combos/resolve.ts:13-20,85-105,161-167`) | Outer per pool/combo, inner weight per account/target; explicit clear only. | Historical config keys. **CONDITIONALLY-UNBOUNDED**. | Preserve deterministic sticky/round-robin state for current config. |
| Combo/key cooldown (`combos/failover.ts:9-76`; `providers/key-failover.ts:21-53,89-130,174-190`) | Duration <=10 min, but expiration deletes only when that exact key is checked. | Historical expired keys. **CONDITIONALLY-UNBOUNDED**. | Global-prune expired rows; retain live 429 suppression. |
| OAuth (`oauth/index.ts:54-61,823-904,939-1020`) | Refresh flights delete in `finally`. XAI verdict TTL 30 s is exact-key lazy. Login/abort/manual maps are static-provider keyed; pending pasted code is variable size. | **CONDITIONALLY-UNBOUNDED** verdict churn/value bytes. | Preserve one flow/provider, early-paste/CSRF handoff, refresh dedup. |
| Codex auth (`codex/auth-api.ts:91,246-249,437,579-605,1193-1414`) | Random flow rows have 5 min timers (some setup errors 30 s); quota flights delete when empty; no flow admission cap. | Request rate × 5 min + active probes. **CONDITIONALLY-UNBOUNDED**. | Return explicit busy; never evict in-progress generation owner. |
| Guardian/reauth (`oauth/token-guardian.ts:54-99,118-225`; `codex/account-runtime-state.ts:1-13`) | Account-keyed rows delete on success/manual reauth; deleted historical accounts may remain. | **CONDITIONALLY-UNBOUNDED**. | Do not aggressively retry revoked tokens. |
| GCP ADC (`lib/gcp-adc.ts:61-66,83-127,274-302`) | Source-fingerprint token/flight maps; expired tokens sweep on resolve, flights delete in `finally`; source churn uncapped. | Source churn × token. **CONDITIONALLY-UNBOUNDED**. | Keep source freshness and refresh dedup. |
| GUI sessions (`server/management-auth.ts:27-45,150-184`) | Hard 128, lazy 5 min TTL, oldest eviction before issue; fixed token/CSRF plus origin. | **BOUNDED**. | Preserve same-origin/CSRF checks. |

## 6. Filesystem memos, fixed singletons, and active resources

| Store | Growth/eviction | Verdict | Blast radius |
|---|---|---|---|
| Ownership (`lib/config-ownership.ts:79-87,233-258`) | Manifest snapshot/config root; root row deleted only when that root is removed. Manifest paths are capped, roots are not. | **CONDITIONALLY-UNBOUNDED** home churn | Ownership is deletion safety; prune only proven inactive roots. |
| Windows ACL (`lib/windows-secret-acl.ts:37-40,375-448`) | Successful file/dir paths and timeout keys; no production clear. Atomic writes harden unique `*.ocx.<pid>.<seq>.tmp` paths (`config.ts:96-113,174-197`), adding dead success paths each write. | **UNBOUNDED on Windows**, about one path/write | Keep timeout protection/fail-closed ACL semantics. Remedy (audit R1-2, supersedes earlier draft): DELETE the ephemeral-temp success entry after rename — never re-key success by destination/generation, because a destination-keyed success memo could skip hardening future secret-bearing temps (windows-secret-acl.ts:47 doctrine: only the timeout memo may use the destination key). |
| Config/PID/warnings (`config.ts:413-435,2111-2121`; `router.ts:152-180`) | Config dir is one slot; PID results and warning keys have no age/count cleanup. | Slot **BOUNDED**; PID/warnings **CONDITIONALLY-UNBOUNDED** | Keep PID identity safety and warning dedup; prune by liveness/config generation. |
| Fixed caches (`server/startup-health-cache.ts:10-14,77-99`; `codex/main-account-cache.ts:13-24`; `github/star-state.ts:28-30,85-94`; `codex/project-config-warnings.ts:33,302-315`) | One cached value and at most one flight/owner; current warning array replacement. | **BOUNDED** | Retain stale-while-revalidate/last-known status. |
| Job/install slots (`storage/policy-job.ts:72-83`; `storage/restore-job.ts:37,66-68`; `server/startup-action-control.ts:43-57`) | One state/outcome, worker, cancellation hook and flight/owner; worker timeout 10 min. | **BOUNDED** | Never evict active destructive-operation locks. |
| Active turns (`server/lifecycle.ts:13-23,37-67,70-95`) | One controller/live turn; remove on finish/cancel, force clear at shutdown deadline; no admission cap. | **CONDITIONALLY-UNBOUNDED by concurrency/stalls** | Cap request admission, never untrack live work. |
| Sockets (`codex/websocket-registry.ts:4-35,47-73`) | One active pool-auth socket; remove on close/invalidate. | **CONDITIONALLY-UNBOUNDED by connections** | Needed for credential invalidation. |
| Storage workers/slots (`storage/worker-lifecycle.ts:25-80`; `storage/storage-mutation-coordinator.ts:20-64`) | Live workers explicitly terminate/drain; one mutation slot/distinct home, deleted in `finally`. | **CONDITIONALLY-UNBOUNDED by workers/homes** | Cap creation, never stop tracking live worker/lock. |
| Cursor background shells (`cursor/native-exec-shell.ts:23-24,215-265`) | Live child + output-length counter; deleted only on child close. No count/TTL/idle/transport ownership. App does not retain output text here. | **UNBOUNDED** when unsafe native exec enabled | Blind eviction kills side effects/data. Add session ownership, max-live, idle/absolute lifetime and controlled termination. |

### Additional process caches and queues

| Store | Growth/eviction and worst case | Verdict | Blast radius |
|---|---|---|---|
| Vision descriptions (`vision/index.ts:18-24,32-68,215-233,303-343`) | Process LRU, one row per persistent data-image + backend/model/detail/context identity; 256 rows, no TTL. Display is clamped to 2,000 chars only after lookup, while the cache stores the upstream `outcome.text.trim()` before that clamp. Worst `256 x S(upstream description)` plus keys; no byte bound. | **CONDITIONALLY-UNBOUNDED**, translation duty | Clearing loses cross-turn image-to-text reuse and repeats paid sidecars. Clamp before insert and add aggregate bytes while retaining identity/LRU. |
| Image retention tail (`images/fulfill.ts:12-24,89-106`) | One promise points to a FIFO chain of every concurrent write-prune-filter closure. Settled work collapses to a resolved tail, but arrivals have no admission/backlog cap. Each queued closure retains up to four artifact paths. Worst `pending fulfillments x path bytes`. | **CONDITIONALLY-UNBOUNDED while backlog grows**, translation duty | Parallel pruning can delete another response's just-written artifact. Keep serialization; bound image-fulfillment admission/backlog rather than dropping queued prune steps. |
| OAuth mutation tail (`oauth/store.ts:292-305`) | One promise points to an uncapped FIFO of load-modify-persist closures. No timeout or queue-depth admission; settled work collapses. Worst is every pending mutation closure and captured credential/config values. | **CONDITIONALLY-UNBOUNDED while disk mutation stalls** | Removing serialization reintroduces lost updates between refresh and account switching. Add admission/timeout without reordering accepted writes. |
| Grok apply tail (`server/management/agent-settings-routes.ts:62-70,545`) | One promise points to an uncapped FIFO of management apply closures; settled work collapses. Worst pending applies times captured apply arguments/config references. | **CONDITIONALLY-UNBOUNDED while apply stalls** | Concurrent read-modify-write cycles can overwrite each other. Coalesce superseded settings or return busy, preserving accepted order. |
| Codex credential refresh (`codex/account-store.ts:20-22,268-270,349-360,383-458`) | Active promise per distinct refresh-grant fingerprint; same grant deduplicates. Rows delete in `finally`; fetch is 30 s, file-lock wait is 65 s, but distinct admissions have no cap. Worst concurrent expired grants times credential/fetch state. | **CONDITIONALLY-UNBOUNDED by active account concurrency** | Evicting a live flight duplicates token rotation and can cause generation conflicts. Bound admission; never detach an accepted grant owner. |
| MiMo bootstrap (`adapters/mimo-free.ts:27-35,47-74,92-133`) | One JWT, expiry number, one in-flight bootstrap, and one 36-char client id. Bootstrap has a 15 s timeout and flight clears in `finally`; JWT refresh is expiry-triggered. Count is fixed, but upstream `data.jwt` has no response/value byte cap. | **CONDITIONALLY-UNBOUNDED value bytes** | Keep same-flight bootstrap, expiry skew, and stable anonymous client id; reject an oversized bootstrap response/JWT before caching. |
| Management usage read (`usage/log.ts:389-403,470-511`) | One active revision-keyed promise; same revision deduplicates and it clears in `finally`. The promise retains the fully parsed append-only usage log and byte/text intermediates until completion; no file-size cap. | **CONDITIONALLY-UNBOUNDED active value bytes** | Dedup prevents duplicate full parses. Bound/read incrementally or aggregate, but do not cache parsed rows after completion. |

Other fixed process slots are finite by replacement: Codex runtime resolution
(`codex/runtime.ts:362-385`, one 15 s result), Kiro throttle probe/cooldown
(`adapters/kiro-retry.ts:31-52`, one probe and timestamp), sidecar/activity
breadcrumbs (`lib/sidecar-tracker.ts:10-48`, two latest strings/counters), storage
scheduler timers (`storage/policy-scheduler.ts:10-11`), restart acceptance
(`server/management/system-restart.ts:51-53`), current CORS origin
(`server/auth-cors.ts:20`), main-account plan/cache (`codex/main-account.ts:12`;
`codex/main-account-cache.ts:13-24`), latest shim-discovery error
(`codex/shim.ts:34`), Claude Desktop health counters
(`claude/desktop-health.ts:9`), finite debug-flag override keys
(`lib/debug-settings.ts:33`), and MiMo's client id above. Their string-bearing
slots should still receive local length normalization, but key/count growth is
**BOUNDED**. Replacing them indiscriminately would weaken runtime discovery,
throttle single-flight, crash attribution, scheduling, restart idempotency, or
current health/config reporting respectively.

## Translator-layer state

OpenCodex cannot be reduced to a byte relay. The structures below exist because
of translation duty. Most die with the turn/stream, but multiply under concurrency.

### Tool-call assembly (20+ parallel calls is normal)

| Path | State / bounds / worst case | Verdict | Naive-cap blast radius |
|---|---|---|---|
| OpenAI Chat (`src/adapters/openai-chat.ts:697-712,792-818,854-861`) | `pendingToolCalls[]` per interleaved call; `args += fragment`. No call-count/aggregate bytes. Retained O(calls + final args); concatenation may copy O(args²). | **CONDITIONALLY-UNBOUNDED per stream** | A single-digit cap breaks normal 20+ calls. Bound aggregate bytes/pathological calls, preserve index/id interleaving, fail coherently. |
| Generic bridge (`src/bridge.ts:317-324,667-718`) | One current atomic call and accumulating args; completed items retained later. No arg bytes. | **CONDITIONALLY-UNBOUNDED per stream** | Truncation emits invalid JSON. Overflow must fail/cancel, not complete truncated args. |
| Cursor (`cursor/protobuf-events.ts:152-163,355-410,441-470`; `live-transport.ts:506-529`) | `openToolCalls` cumulative args, `completedToolCalls`, schema/name maps. No count/bytes; atomic completion serializes parallel calls for bridge. | **CONDITIONALLY-UNBOUNDED per turn** | Preserve atomic start→delta→end, dedup, and 20+ normal calls. |
| Responses→Chat (`chat/outbound.ts:153-157,304-365,545-620`) | Per-index id/name/argument maps; collector also accumulates content/reasoning. No aggregate output cap. | **CONDITIONALLY-UNBOUNDED per response** | Eviction cross-wires deltas or duplicates authoritative done snapshot. |
| Anthropic (`adapters/anthropic.ts:832-885`) | One current block, `currentToolCallJson += partial_json`, forwards fragments while retaining validation copy. | **CONDITIONALLY-UNBOUNDED per block** | Cannot truncate after forwarding; overflow must fail turn before completion. |
| Responses→Claude (`claude/outbound.ts:162-250,600-629`) | One open block/WebSearch args; non-stream fold retains text/thinking/tool JSON/content. | **CONDITIONALLY-UNBOUNDED per response** | Preserve block order, one signature, tool JSON integrity. |
| Kiro (`adapters/kiro.ts:857-975,978-1111`) | One open tool at a time with `chunks[]`; `assistantText`, `outputChars`, required-mode `deferred[]`, and text-fallback events also accumulate. Each Smithy message is capped at 16 MiB, but aggregate stream/tool bytes are not. | **CONDITIONALLY-UNBOUNDED per stream** | Kiro rejects parallel calls, but truncating the one open call corrupts JSON/private completion; dropping deferred events breaks required/text-fallback terminal classification. |
| Cursor queue/frame (`cursor/live-transport.ts:457-493,727-756`; `cursor/framing.ts:1-5,68-123`) | Producer queue uncapped; partial frame repeatedly concatenated; announced frame up to `2^32-1`. | **CONDITIONALLY-UNBOUNDED per stream** | Add backpressure and reject announced size before buffering; never reorder terminal/tool messages. |

Kiro's eventstream decoder also caps headers at 128 KiB
(`src/lib/eventstream-decoder.ts:26-27,189-203`). Google function calls arrive
atomically. Neither adapter has a process-level pending-call store.

### MCP namespaces and manager state

- `buildToolBridgeMaps()` creates request-local `toolNsMap`,
  `freeformToolNames`, and `toolSearchToolNames`, one row/tool
  (`server/responses/collaboration.ts:102-115`). No local count/bytes; accepted
  body max 256 MiB; freed with request. Worst O(tool count + names) per turn;
  **CONDITIONALLY-UNBOUNDED per request**. Preserve exact
  `namespacedToolName()` round-trip or calls/results route incorrectly.
- One Cursor MCP manager/transport holds configured server/tool maps
  (`cursor/mcp-manager.ts:54-70,80-139`), with 15 s connect/120 s call timeouts,
  and clears/closes in `dispose()` (`:198-223`). Transport calls dispose without
  awaiting (`live-transport.ts:579-599`). Counts/schema/resource bytes have no
  local cap: **CONDITIONALLY-UNBOUNDED per stream/config**, with possible short
  post-stream close lifetime. Bound catalog/resource payloads; keep tool/resource
  execution and explicit ownership.
- Per-turn Cursor KV clones every value and has no count/bytes
  (`cursor.ts:74-82`; `cursor/kv-store.ts:10-24`). It dies with the turn:
  **CONDITIONALLY-UNBOUNDED per turn**. It is distinct from shared blobs.

### Images

- `imageGenCallAliases` builds at most two exact aliases/relevant tool and lives
  for one response rewrite (`server/responses/core.ts:1427-1429,1638,1768-1792`;
  `server/responses-image-gen-repair.ts:16-47,100-117`). It is tool-catalog
  sized with no independent cap:
  **CONDITIONALLY-UNBOUNDED per request**, translation-required.
- Anthropic normalization allows four concurrent decodes, rejects one input
  base64 over 64 MiB/100M pixels, then reduces final image share to 20 MiB
  (`anthropic-image-normalize.ts:50-64,286-401`;
  `anthropic-image-guard.ts:19-45`). Original strings coexist with normalized
  copies/native bitmaps; worst accepted peak is multiple body copies plus four
  decoded images.
- Image responses buffer under 100 MiB total/50 MiB decoded per image
  (`server/images.ts:46-49,211-231,291-304,443-449`;
  `images/artifacts.ts:11-25,112-129`): **BOUNDED per request**, but
  concurrency-multiplicative.
- Continuation retains raw expanded input/output (`responses/state.ts:444-447`)
  before provider-specific image reduction makes it cheap. This is how one
  screenshot-heavy row exceeds 64 MiB, remains exempt, and is skipped on disk.

### Reasoning/thinking carry

- Anthropic keeps current block/tool JSON and emits opaque redacted/signature
  events (`adapters/anthropic.ts:832-870`). The bridge accumulates a coherent
  reasoning item and pending redacted blocks (`bridge.ts:251-324`). No bytes:
  **CONDITIONALLY-UNBOUNDED per stream**.
- Responses parsing preserves real signature/redacted envelopes
  (`responses/parser.ts:411-425`); remembered envelopes inherit continuation's
  cap hole.
- Responses→Claude emits one synthetic signature/close and non-stream fold keeps
  real signature (`claude/outbound.ts:214-248,600-629`). Removing state breaks
  block validity/order.
- Antigravity cross-turn replay is process state, covered in section 2.

### Responses item-ID repair

Each rewritten stream owns provider-config placeholder sets and two
`output_index → id` maps (`server/responses-item-id-repair.ts:7-12,51-84,187-205`).
Distinct message/reasoning indices have no count/bytes; closure dies with stream.
Worst O(output count × id bytes): **CONDITIONALLY-UNBOUNDED per stream**. Eviction
would make ids inconsistent across item/delta/terminal snapshot. Any cap must
fail coherently; function-call ids stay untouched and raw continuation keeps
upstream ids (`:169-185`).

### `tool_search` lifecycle

`toolSearchToolNames` is request-local (`collaboration.ts:107-115`). The bridge
classifies matching calls, buffers/parses current args, retains pending web
sources, and emits `tool_search_call`/results (`bridge.ts:122-143,199-215,317-324,667-718`).
No cross-turn discovery registry exists; completed output may enter ordinary
continuation. Tool-catalog and current argument/source bytes are uncapped:
**CONDITIONALLY-UNBOUNDED per stream**. A cap must not recast the call as a
normal function or lose source attribution.

### Request-direction conversion

- Responses, Chat, and Claude JSON use `readJsonRequestBody()`:
  `await req.arrayBuffer()` → optional decompression → full text → `JSON.parse`
  (`server/request-decompress.ts:15-21,52-84`). Accepted decoded/raw identity body
  cap is 256 MiB, but identity raw bytes are fully materialized before assertion;
  decoded bytes, text, parsed object, translated object, and serialized internal
  request can overlap.
- Chat converts and serializes a new Responses request
  (`server/chat-completions.ts:40-58,120-150`; `chat/inbound.ts:209-294`).
  Claude does likewise (`server/claude-messages.ts:65-70,510-589`;
  `claude/inbound.ts:407-508`). Responses retains parsed raw body through routing
  (`server/responses/core.ts:1070-1116`).
- Copies normally die with request: **BOUNDED per accepted body but
  high-water-multiplicative**. Exception: `rememberResponseState()` stores the
  translated Responses input/output. Lowering the body cap naively breaks normal
  screenshot-heavy sessions; reduce copies/stream where semantics permit and
  surface coherent 413 on hard overflow.

### SSE inspection

The inspector retains at most a 4 MiB partial frame and 256 completed items /
8 MiB source bytes; overflow taints reconstruction; callback/dispose clears all
(`server/relay.ts:18-21,555-648,680-724`): **BOUNDED per stream**. Eager relay
backpressures above 8 MiB and bounds post-cancel drain to 15 s/32 MiB
(`server/relay-eager.ts:45-75,123-188`). Preserve terminal/log/continuation
callbacks and never persist a tainted partial reconstruction.

## Exclusions and roadmap implications

- Weak response provenance (`responses/state.ts:82`) and relay response tags
  (`server/relay.ts:15-16`) do not keep keys alive.
- Immutable provider/model/header/effort sets and generated descriptors do not grow.
- Durable JSONL/snapshot/config/OAuth/update files are disk stores; their in-RAM
  snapshots are listed above.
- Other per-request search/image/video/compact/non-stream collectors are not
  process stores; their surface caps are high-water controls.

Minimum coherent implementation order:

1. Define aggregate-byte accounting/admission/metrics for continuation, Cursor
   blobs, Antigravity replay, and image-cache metadata.
2. Preserve continuation via bounded blobs/spill and explicit misses; intentionally
   replace “always keep newest.”
3. Add per-blob + aggregate Cursor caps while retaining hash lookup/re-store refresh.
4. Bound Antigravity inner calls and image sentinel count/metadata.
5. Globally prune expired cooldown/health rows and reconcile config/account/catalog
   maps by generation.
6. Windows ACL: delete the ephemeral-temp success entry after rename (no
   destination/generation re-keying — see the ACL row above; audit R1-2),
   preserving timeout/fail-closed behavior.
7. Add translator-wide per-turn budgets for tool args/calls, item-id maps, Cursor
   frame/queue, and body-copy high water. Acceptance must explicitly include 20+
   parallel tool calls; overflow must be coherent protocol failure, never truncated
   JSON or cross-wired calls.

No source/test behavior should change until these contracts and regressions are
split into implementation phases.
