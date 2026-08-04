# 035 — registry, flight, discovery, and diagnostic admission caps

Date: 2026-08-01  
Work phase: wp4b (must land before 040)  
Depends on: none  
Binding inputs: `000_state_store_inventory.md` §§3–6, `005_impl_roadmap.md` 035 regression classes, `006_roadmap_audit_synthesis.md` S2-1/S2-2/S3-1/S3-3.

## Outcome

Close the operational stores omitted by the initial roadmap audit. Every active registry
gets a finite hard admission cap and coherent busy result; each identified unbounded
single-flight gets a finite distinct-key cap and identity-checked release, with stale-
owner replacement on refresh flights. Discovery and usage payloads are bounded before
full materialization. MCP payloads are rejected at the earliest enforceable
boundary after SDK materialization and before any manager-owned retained copy (see the
MCP section). Retained diagnostic and affinity strings are truncated at insertion with
a visible marker, but bidirectional protocol-translator payloads are never silently
truncated into invalid data. Existing accepted owners are never silently untracked.

This phase provides retained-byte accounting hooks for 040. It does not implement the
process-wide eviction policy.

## Shared primitives

### NEW `src/lib/admission.ts`

```ts
export const RETAINED_TRUNCATION_MARKER = "\n…[truncated by opencodex]";

export class ResourceAdmissionError extends Error {
  readonly code = "server_busy";
  constructor(readonly resource: string, readonly limit: number);
}
export interface AdmissionMetrics {
  active: number;
  peak: number;
  admitted: number;
  rejected: number;
  releaseMisses: number;
}
export interface AdmissionLease { release(): void } // idempotent, including after forced shutdown
export function createAdmissionGate(name: string, limit: number): {
  tryAcquire(): AdmissionLease | null;
  metrics(): Readonly<AdmissionMetrics>;
};
export function truncateRetainedUtf8(value: string, maxBytes: number): string;
export function retainedUtf8Bytes(value: string): number;
```

`truncateRetainedUtf8()` cuts on a valid UTF-8 boundary and reserves marker bytes. It
never returns an invalid surrogate fragment. Metrics are scalar-only and monotonic except
`active`; they retain no ids, keys, paths, URLs, commands, request bodies, or errors.

## Compatibility configuration for high-risk caps

Current config ownership is `src/types.ts:531-534,904-923` and
`src/config.ts:470-483,736-788`; Cursor transport receives provider config at
`src/adapters/cursor/transport.ts:16-34` and constructs the MCP manager at
`src/adapters/cursor/live-transport.ts:416-430`.

The compatibility-sensitive limits keep safe defaults but accept explicit positive-
integer overrides:

```ts
const MANAGEMENT_USAGE_MAX_READ_BYTES = 64 * 1024 * 1024;
const CURSOR_MCP_MAX_TOOLS = 512;
const CURSOR_MCP_MAX_SCHEMA_BYTES = 256 * 1024;
const CURSOR_MCP_MAX_RESULT_BYTES = 8 * 1024 * 1024;
```

Exact config keys are top-level `managementUsageMaxReadBytes` (default 67,108,864),
plus `providers.<name>.mcpMaxTools` (default 512),
`providers.<name>.mcpMaxSchemaBytes` (default 262,144), and
`providers.<name>.mcpMaxResultBytes` (default 8,388,608). Add them to the TypeScript
types and Zod schema; reject non-finite, non-integer, or non-positive writes and thread
the provider values into `CursorMcpManagerOptions`. A configured lower limit is honored
exactly. Do not silently clamp, truncate, or fall back to a larger default: usage
history gets visible qualification and MCP gets a typed visible error. Affinity and
MiMo caps stay fixed (low compatibility risk); all other admission/count caps in this
phase also remain fixed.

## Debug subscribers and diagnostic rings

Current anchors:

- `src/lib/debug-log-buffer.ts:10-35` retains 2,000 unbounded lines and an unbounded
  listener set. `subscribeDebugLogEntries` currently has NO production consumer:
  `/api/debug/logs` is a polling JSON route (`src/server/management/logs-usage-routes.ts:141-144`),
  not SSE. The cap therefore lands in the owner only; no route change exists or is invented.
- `src/lib/injection-debug-log.ts:10-27` retains 2,000 unbounded lines.
- `src/claude/inbound-debug.ts:40-106` retains 20 variable metadata rows; `Object.keys`
  at :98 has no key-count or aggregate-row-byte bound.
- `src/lib/crash-guard.ts:206-245` retains 12 traces with unbounded URL/origin/rejection.
- fixed string slots include `src/lib/sidecar-tracker.ts:10-17,39-44`, startup health,
  main-account cache (`src/codex/main-account-cache.ts:13-20`), shim discovery error
  (`src/codex/shim.ts:32-37` — file input already capped at 1 MiB, the retained error
  string is not), and project-config warnings (`src/codex/project-config-warnings.ts:290-315`).
  GitHub star state (`src/github/star-state.ts:32-38,85-87`) retains only a finite enum
  and is EXCLUDED — truncating it would duplicate an existing finite representation.
- Codex/Anthropic affinities are count-bounded at
  `src/codex/routing.ts:107-108,142,663-721` (with credential-generation liveness
  at :667-669) and `src/oauth/anthropic-routing.ts:36-37,63-64,245-252,345-449`,
  but id components are not byte-bounded. New caps must preserve the generation
  validation semantics.

Constants and changes:

```ts
const MAX_DEBUG_SUBSCRIBERS = 64;
const MAX_DEBUG_LINE_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_VALUE_BYTES = 8 * 1024;
const MAX_CLAUDE_INBOUND_METADATA_KEYS = 64;
const MAX_CLAUDE_INBOUND_ROW_BYTES = 32 * 1024;
const MAX_AFFINITY_COMPONENT_BYTES = 512;
```

- `subscribeDebugLogEntries()` throws `ResourceAdmissionError("debug_subscribers",64)`
  before insertion. Existing subscribers remain active; unsubscribe is idempotent and
  repeated unsubscribe is a no-op; only a foreign owner token updates release-miss
  metrics. Since no production route subscribes today, this is a defensive owner-side
  cap for future consumers; no route-level catch is added in this phase and the polling
  `/api/debug/logs` route is untouched.
- Debug/injection lines are truncated before ring insertion and before listener fanout;
  console logging may retain its existing safe line, but no ring stores the original.
- Claude inbound rows cap `metadataKeys` at 64 and expose `metadataKeysDropped`.
  Variable strings use the diagnostic value cap. Build each row in deterministic field
  order under the 32 KiB aggregate UTF-8 budget, omitting/truncating only optional
  diagnostic fields and setting `rowTruncated: true`; never retain the pre-cap key
  array or row.
- Crash trace URL/origin/rejected fields and fixed-slot strings use the 8 KiB cap at
  assignment. Preserve redaction first, then truncate.
- Affinity key components are normalized at admission. Oversized thread/scope/account ids
  are rejected from affinity caching, not truncated into collision-prone keys; displayed
  diagnostic aliases may be truncated. Existing request routing continues without affinity.

Expose hooks:

```ts
export function debugBufferMetrics(): { entries: number; bytes: number; subscribers: AdmissionMetrics; oldestAt: number | null };
export function injectionBufferMetrics(): { entries: number; bytes: number; oldestAt: number | null };
export function crashRingMetrics(): { entries: number; bytes: number; oldestAt: number | null };
export function claudeInboundDebugMetrics(): { entries: number; bytes: number; oldestAt: number | null };
export function evictOldestDebugEntryForBudget(): number;
export function evictOldestInjectionEntryForBudget(): number;
export function evictOldestCrashTraceForBudget(): number;
export function evictOldestClaudeInboundForBudget(): number;
```

All ring replacements, explicit/flag-off clears, and evictions use centralized subtract
helpers so 040/wp5 sees exact current bytes.

## Active turns, WebSockets, workers, and slots

Current anchors:

- `src/server/lifecycle.ts:19-29,43-73,76-92` registers every live turn with no
  admission cap and forcibly clears `activeTurns` after shutdown abort.
  `trackStreamLifetime()` registers only after the body already exists (:43-49).
- Response handling also registers late at
  `src/server/responses/core.ts:1671-1719,1731-1782,1824-1827,1952-1955,2010-2015,2097-2099,2566-2568`.
  A WebSocket frame registers at `src/server/index.ts:856-881` and then enters the same
  response pipeline at :915-958, so adding admission inside stream wrappers would
  double-register one WS turn.
- `src/codex/websocket-registry.ts:4-35,47-73` tracks sockets by account until close.
- `src/storage/worker-lifecycle.ts:25-85` can register only after a `Worker` exists;
  `withStorageWorkerSpawnGate()` drains every predecessor before invoking the next spawn
  closure (:69-85). Production workers are created at
  `src/storage/policy-job.ts:286-304` and `src/storage/restore-job.ts:144-166`.
- `src/storage/storage-mutation-coordinator.ts:20-64,78-109` has one slot per distinct
  home but no total-home cap and releases by recomputing the home key.

Production defaults:

```ts
export const MAX_ACTIVE_TURNS = 256;
export const MAX_TRACKED_CODEX_WEBSOCKETS = 128;
export const MAX_RESERVED_STORAGE_WORKER_SPAWNS = 16;
export const MAX_ACTIVE_STORAGE_HOME_SLOTS = 32;
```

Change signatures:

```ts
export interface ActiveTurnLease extends AdmissionLease {
  bindAbortController(ac: AbortController): void;
}
export interface AdmissionReservation<T> extends AdmissionLease {
  bind(value: T): void;
}
export function tryAdmitTurn(): ActiveTurnLease | null;
export function tryReserveCodexWebSocket(): AdmissionReservation<ServerWebSocket<WsData>> | null;
export function tryReserveStorageWorker(): AdmissionReservation<Worker> | null;
export function tryBeginStorageMutation(...):
  | { acquired: true; lease: AdmissionLease }
  | { acquired: false; error: "storage_mutation_busy" };
```

Turn admission moves to the true ingress. After draining/auth/origin checks but before
request parsing, adapter work, or upstream I/O, every turn-producing POST branch in
`src/server/index.ts:480-510,513-537,569-637,642-705,711-739` acquires ONE lease. Each
generating WS `response.create` frame acquires ONE lease at :856-881 before
`handleResponses`; warmup frames do not consume a turn lease. Thread the same lease
through handler options and every nested response/stream wrapper. Existing late
`registerTurn`/`trackStreamLifetime` sites become controller binding and idempotent
release sites only: they MUST NOT acquire another gate slot. This preserves one active
count for HTTP translation, sidecars, native passthrough, and WS-to-Responses
translation even when several wrappers participate.

Lease release is boundary-owned: handler exceptions and non-stream responses release in
the ingress `finally`; streaming responses transfer the same lease exactly once to the
response-lifetime wrapper (`src/server/relay.ts:303-350`), whose settle/cancel/error path
releases it. A WS frame releases in its existing `finally` (:957-961). HTTP admission
failure returns structured 503 `server_busy` with `Retry-After: 1`; an already-upgraded
WS frame gets a typed retryable `server_busy` error frame and starts no handler work.

Forced shutdown replaces direct `activeTurns.clear()` with one centralized
`abortAndReleaseAllTurns()` operation. It snapshots each admitted owner, aborts every
bound controller, removes the owner, and calls that owner's same idempotent lease once.
Later stream/WS finalizers call the same lease and become no-ops: they do not increment
`releaseMisses`, underflow the gate, or leak `active`. A direct duplicate lease release
is always a no-op; `releaseMisses` is reserved for a genuinely foreign/unknown owner
token.

WebSocket capacity is reserved before `server.upgrade()`
(`src/server/index.ts:370-394`). Carry the reservation in `WsData`
(`src/server/ws-bridge.ts:21-55`), bind the actual socket on `open`
(`src/server/index.ts:806-812`), and then allow the existing account binding to update
later at :915-920. Upgrade failure, open rejection, and close (:964-972) all release the
same reservation. No API requires a socket object before upgrade.

Storage worker admission is likewise reservation-level. Call
`tryReserveStorageWorker()` BEFORE entering `withStorageWorkerSpawnGate()` and before
`new Worker`; carry it into the spawn closure, bind immediately after construction, and
release only after deterministic termination, spawn cancellation, or construction
failure. The cap counts queued reservations plus the at-most-one bound live worker.
Because :69-85 drains predecessors, a production "worker 17 concurrently live" state
is unreachable; the regression is instead `storage worker reservation 17 rejects
before enqueue while the first 16 spawn serially and drain`. Policy and restore callers
retain their returned reservation until their `terminateStorageWorker()` join settles.

Storage mutation callers must also retain the returned lease, not recompute a home key
on release. `withStorageMutationSlot()`/`runPolicyStorageMutation()`
(`src/storage/storage-mutation-coordinator.ts:78-109`), cleanup
(`src/storage/cleanup-job.ts:35-53`), restore (`src/storage/restore-job.ts:253-273`),
and the policy job (`src/storage/policy-job.ts:350-389`) release that exact lease in
their authoritative `finally`, after worker termination where applicable.

Admission leases are NEVER released by state-store sweeper reconciliation. Normal
settle/cancel/close/termination is authoritative; reconciliation may report stale
owners but cannot decrement an active gate or silently untrack accepted work.

Add `activeRegistryMetrics()` returning per-registry `AdmissionMetrics`. `releaseMisses`
is the leak signal under the foreign-owner rule above; never remove another owner to
hide it.

## Codex credential refresh flights

Current `src/codex/account-store.ts:235-270,349-465` deduplicates by grant fingerprint
and deletes in `finally`, but distinct fingerprints have no cap and a stuck Promise is
joined forever.

```ts
const MAX_CODEX_REFRESH_FLIGHTS = 32;
const CODEX_REFRESH_FLIGHT_STALE_MS = 120_000;
export class CodexCredentialRefreshBusyError extends Error {
  readonly code = "CODEX_REFRESH_BUSY";
}
export class CodexCredentialRefreshStaleError extends Error {
  readonly code = "CODEX_REFRESH_STALE";
}
interface RefreshFlight {
  promise: Promise<CodexRefreshResult>;
  startedAt: number;
  abort: AbortController;
}
const refreshLocks = new Map<string, RefreshFlight>();
```

Admission order:

1. Same fingerprint and age <=120 s: join it.
2. Same fingerprint older than 120 s: abort with a typed stale reason, remove only if
   still the same owner, then create a replacement.
3. New fingerprint with 32 live rows: throw
   `CodexCredentialRefreshBusyError` before file lock/fetch.
4. Thread `AbortSignal.any([flight.abort.signal, timeout])` through lock wait and fetch.
5. `finally` deletes only if `refreshLocks.get(key) === flight`.

An aborted stale owner remains awaited by its original callers and settles with a typed
retryable error; it is not silently detached. The replacement is the only mapped owner.

Both new errors are RETRYABLE credential outcomes, never evidence for reauthentication.
Enumerate them explicitly at every current consumer so they cannot fall through an
`unknown` branch:

- `src/codex/auth-context.ts:186-189`: both return `false` from
  `shouldMarkAccountNeedsReauthForCodexAuthFailure()`.
- `src/oauth/token-guardian.ts:210-230`: record ordinary transient backoff and a skipped/
  retryable result; do not call `markCodexAccountValidationFailed()` and never mark the
  failure permanent.
- `src/codex/auth-api.ts:559-566`: quota reads keep cached quota with
  `needsReauth: false` and expose the same optional retryable-skip marker used for a busy
  quota probe.
- `src/codex/auth-api.ts:1354-1377`: login background state records a retryable busy
  message, while a synchronous route rejection returns structured 503 `server_busy`
  with `Retry-After: 1`; neither path becomes the generic 500 or reauth-worthy state.

Refresh-flight owner tests live in `tests/codex-account-store.test.ts`, alongside the
existing grant/file-lock contract at :229-339. Consumer classification extends
`tests/codex-auth-context.test.ts`, `tests/token-guardian.test.ts`, and
`tests/codex-auth-api.test.ts`; do not put Codex grant-flight tests in
`tests/xai-refresh-lock.test.ts`.

## Management usage-read bound

Current `src/usage/log.ts:389-403,470-511` reads `stat.size` into one Buffer, converts all
text, splits every line, and retains the parsed array in one revision-keyed Promise.

```ts
const MANAGEMENT_USAGE_MAX_READ_BYTES = 64 * 1024 * 1024;
const MANAGEMENT_USAGE_MAX_ENTRIES = 200_000;
const MANAGEMENT_USAGE_FLIGHT_STALE_MS = 30_000;
interface ManagementUsageSnapshot {
  entries: PersistedUsageEntry[];
  revision: UsageLogRevision | null;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
}
```

- Read at most the newest effective `managementUsageMaxReadBytes` (64 MiB by default)
  through bounded 1 MiB chunks; when starting mid-file,
  discard the first partial line.
- Parse batches cooperatively and retain at most the newest 200,000 valid rows.
- `truncatedPrefixBytes` counts omitted file-prefix bytes (including the discarded
  partial line). Independently, `entriesTruncated` and `entriesDropped` report valid
  parsed rows dropped by the 200,000-entry cap. A byte-truncated prefix has an unknown
  row count, so never fold it into `entriesDropped`.
- A 30-second-stale same-revision flight is aborted through a local controller and
  replaced. At most one management usage-read flight exists. Include the effective byte
  limit in the flight and cache key so a live config change cannot join/reuse a snapshot
  built under another limit.
- Never allocate `Buffer.allocUnsafe(stat.size)` for a file over the cap.

Every consumer derives `historyTruncated = truncatedPrefixBytes > 0 ||
entriesTruncated`; totals describe only the returned window:

- `/api/usage` at `src/server/management/logs-usage-routes.ts:187-205` carries
  `historyTruncated`, `truncatedPrefixBytes`, `entriesTruncated`, and `entriesDropped`
  through both fresh and cached summaries. The read-failure fallback returns explicit
  false/zero metadata. Do not fabricate lifetime totals.
- `UsageResponse` at `gui/src/pages/Usage.tsx:77-87` accepts those fields. Render a
  persistent localized qualification banner whenever `historyTruncated` is true, and
  change the active "All" option at :243-255 to localized "Available history" (not
  "All"). The notice applies to every range because the omitted prefix may overlap any
  requested time window.
- `readApiKeyUsageRollup()` at
  `src/server/management/api-key-usage.ts:131-162` propagates snapshot truncation in
  `ApiKeyUsageSnapshot`; `/api/keys` carries it at
  `src/server/management/oauth-account-routes.ts:482-506`. Existing `totalRequests`
  remains additive compatibility data but means "requests in available history" when
  truncated. `gui/src/pages/ApiKeys.tsx:28-57,175-186` passes the flag to
  `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx:358-387`, which visibly
  qualifies both the total label and attribution-since date.

Add the new Usage/API-key strings in every existing GUI locale. Capped history must be
visibly qualified on all three surfaces (usage API, Usage GUI, API-key GUI); a boolean
that no consumer renders is insufficient.

## Cursor model discovery and gather flights

Inventory anchors:

- `src/adapters/cursor/live-models.ts:98-125` buffers all RPC chunks before applying the
  500-id result cap.
- `src/codex/catalog/provider-fetch.ts:64-129,654-675` keeps one gather Promise per
  distinct config fingerprint without a concurrency cap.

```ts
const CURSOR_MODEL_DISCOVERY_MAX_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENT_CATALOG_GATHERS = 8;
export class CatalogGatherBusyError extends Error {
  readonly code = "catalog_busy";
  readonly retryAfterSeconds = 1;
}
```

Reject an announced `content-length` above 4 MiB before reading and cancel the body once
streamed chunks exceed 4 MiB. Decode only after admission. Keep the existing 500 model-id
result cap. Add a gate around distinct gather fingerprints; same-fingerprint callers
still join, while the ninth distinct gather rejects with `CatalogGatherBusyError` and
starts no provider requests. `gatherRoutedModels()` keeps its existing
`Promise<CatalogModel[]>` signature (no result union), so existing callers keep
compiling. Release the distinct-flight lease in the flight's own `finally` even if
`clearGatherRoutedModelsInflight()` removes its map entry; cache clearing never releases
active admission.

Caller mapping is explicit:

- The central management dispatch at `src/server/management-api.ts:82-136` catches only
  `CatalogGatherBusyError` and returns structured 503 `catalog_busy` with
  `Retry-After: 1`; other errors retain existing handling. The public `/v1/models`
  boundary at `src/server/index.ts:410-474` uses the same 503 mapping.
- Startup prewarm at `src/cli/catalog-prewarm.ts:15-22` warns once that discovery was
  skipped because it was busy, then settles successfully; it no longer silently
  swallows this typed condition.
- System-env context discovery at `src/server/system-env.ts:235-241` treats busy as a
  bounded skip and continues with native/default windows only.
- Direct maintenance/catalog sync at `src/codex/catalog/sync.ts:485-509` remains
  error-propagating so its owning route/CLI can report failure; it is not converted to
  an empty catalog.

## OAuth flow/probe and pending-code bounds

Account-scoped access-token refresh is another unbounded owner:
`tokenRefreshes` at `src/oauth/index.ts:55,235-268` stores one Promise per distinct
`provider\0accountId` with no cap or stale replacement.

```ts
const MAX_OAUTH_TOKEN_REFRESH_FLIGHTS = 32;
const OAUTH_TOKEN_REFRESH_FLIGHT_STALE_MS = 120_000;
interface OAuthTokenRefreshFlight {
  promise: Promise<OAuthAccessSnapshot>;
  startedAt: number;
  abort: AbortController;
}
export class OAuthTokenRefreshBusyError extends Error {
  readonly code = "OAUTH_TOKEN_REFRESH_BUSY";
}
export class OAuthTokenRefreshStaleError extends Error {
  readonly code = "OAUTH_TOKEN_REFRESH_STALE";
}
```

Same-key callers join a flight younger than 120 seconds. An older same-key flight is
aborted with typed retryable `OAuthTokenRefreshStaleError`, removed only by identity,
and replaced. A 33rd distinct key throws typed retryable
`OAuthTokenRefreshBusyError` before provider refresh/network work. Thread the local
abort signal through the provider refresh path, and let the original stale callers
observe settlement; `finally` deletes only the matching flight. Neither typed error
deletes credentials or marks an OAuth account as needing reauthentication.

Generic OAuth flow state (`src/oauth/index.ts:827-837,975-990`) is ONE flow per known
provider with an existing busy result, so its active-flow count is already bounded by
the seven-entry static provider registry, and a same-provider second flow already
rejects at :982-985. A generic `MAX_ACTIVE_OAUTH_FLOWS = 32` would therefore be
vacuous and is not added. The management boundary rejects pasted input above 4,096
characters at `src/server/management/oauth-account-routes.ts:184-193` (the check is
at :191), but
that is a character limit and internal callers can bypass the route; owner-side UTF-8
byte validation is still missing at `src/oauth/index.ts:897-921`.

The actually unbounded flow/probe owners live in `src/codex/auth-api.ts`:

- `codexAuthLoginState` (`src/codex/auth-api.ts:93,1175-1377`) — random login-state keys
  with no distinct-key cap.
- `poolQuotaRefreshInFlight` (`src/codex/auth-api.ts:432-440,583-609`) — a map keyed by
  account id whose VALUES are `Set<PoolQuotaRefreshFlight>` holding one flight per
  credential generation; neither the key count nor the total flight-object count is
  capped.

```ts
const OAUTH_PENDING_CODE_MAX_BYTES = 4 * 1024;
const MAX_CODEX_LOGIN_STATE_ROWS = 32; // all retained codexAuthLoginState keys
const MAX_POOL_QUOTA_FLIGHTS = 16;     // TOTAL flight objects across ALL account sets
export class CodexLoginStateBusyError extends ResourceAdmissionError {}
export class PoolQuotaProbeBusyError extends ResourceAdmissionError {}
```

Enforce pending-code UTF-8 bytes in the owner (`src/oauth/index.ts:897-921`) before
assignment. For Codex login, prune terminal rows whose 300-second retention expired,
then evict oldest terminal rows if needed; pending/starting owners are never evicted.
Insert one identity-bearing `starting` row before `startLoginFlow`, browser work, polling
Promise, or cleanup timer. If 32 pending/retained rows still occupy the map, return
typed 503 `server_busy`. Start failure deletes the same row immediately; terminal
completion keeps it for polling and schedules an identity-checked delete at 300 seconds,
so an old timer cannot remove a replacement row.

The pool-quota cap counts TOTAL flight objects across all account sets (a per-key cap
would not bound the sum). Check for a compatible live generation and join it first;
otherwise reserve before `fetchFreshPoolAccountQuota()` creates a Promise. Retain the
exact flight owner in its account set and release only that owner in `finally`, deleting
the account set only when it is still the mapped set and becomes empty. The cap MUST
preserve the writer-generation fencing already present in
`poolQuotaRefreshInFlight` (030).

There is NO existing busy surface for quota probes, so each caller gets a defined
behavior for the typed `PoolQuotaProbeBusyError`:

- management GET `/api/codex-auth/accounts` (`src/codex/auth-api.ts:818-820`): return
  the account list with cached/stale quota values and an additive optional
  `quotaProbeSkipped?: true` field on the PER-ACCOUNT `CodexAuthAccountDto`
  (`src/codex/auth-api.ts:442-457`) for each account whose probe was skipped — never a
  5xx for a busy probe.
- reset-credit refresh (`src/codex/auth-api.ts:1135-1152`): map the busy error to a
  structured 503 `server_busy` with `Retry-After: 1` instead of the current generic 500.
- startup priming (`src/codex/auth-api.ts:631-666`): already best-effort; a busy
  rejection is swallowed like any other priming failure.

Login-state admission (`MAX_CODEX_LOGIN_STATE_ROWS`) rejects before `startLoginFlow`/browser
work. Note the existing concurrent-flow response is a 409
(`src/codex/auth-api.ts:1372-1377`, "already in progress"); the CAP overflow is a NEW
structured 503 `server_busy` surface — distinct from that 409, which is preserved
unchanged for the same-provider concurrent case.
Existing generation owners remain until their normal finish/abort timer. Reconciliation
of dead provider/account keys remains in 030.

## MiMo bootstrap value cap

Current `src/adapters/mimo-free.ts:27-35,92-133` caches one unbounded JWT and parses the
entire bootstrap JSON after a 15-second fetch timeout.

```ts
const MIMO_BOOTSTRAP_MAX_BYTES = 128 * 1024;
const MIMO_JWT_MAX_BYTES = 64 * 1024;
```

Use bounded response-body reading, reject content-length/chunks above 128 KiB before
`JSON.parse`, require `jwt` UTF-8 bytes <=64 KiB, then cache and parse expiry. Oversized
values throw `MiMo bootstrap response too large`, never enter `cachedJwt`, and preserve
single-flight cleanup.

## Cursor MCP manager payload caps

Current `src/adapters/cursor/mcp-manager.ts:64-70,80-101,121-139,152-223` retains
configured connections/tool schemas and materializes tool/resource payloads without
local count/byte caps. The MCP SDK fully materializes `listTools` (:123), `callTool`
(:159-166), `listResources` (:175-177), and `readResource` (:187-194) before the manager
regains control. No manager-only patch can truthfully promise a transport/framing limit.
This phase therefore measures immediately after each SDK Promise resolves, rejects with
a typed error before normalization/copy/registry commit, and retains NO over-limit
manager-owned state. SDK/transport pre-materialization limits remain explicitly out of
scope.

```ts
const CURSOR_MCP_MAX_SERVERS = 32;
const CURSOR_MCP_MAX_TOOLS = 512;
const CURSOR_MCP_MAX_RESOURCES = 1_024;
const CURSOR_MCP_MAX_SCHEMA_BYTES = 256 * 1024;
const CURSOR_MCP_MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const CURSOR_MCP_MAX_RESULT_BYTES = 8 * 1024 * 1024;
```

The tool/schema/result defaults resolve through the compatibility config above; server,
resource, and aggregate catalog caps stay fixed. Add typed
`McpCatalogLimitError`/`McpPayloadTooLargeError` classes with stable codes that
`src/adapters/cursor/native-exec-mcp.ts:52-105` maps to the existing protobuf error
cases, preserving a visible failure instead of a partial success.

Validate server count in the constructor. Discovery is transactional for the WHOLE
manager: `connectOne()` returns a staged connection plus staged tool handles, and
`connectAll()` validates advertised name + description + canonical schema bytes and the
global tool/catalog totals before committing either `servers` or `toolIndex`. If any
limit fails, close every staged client, clear staging, and reject `ensureConnected()`;
no prefix of the catalog survives. The broad catch at
`src/adapters/cursor/mcp-manager.ts:90-101` may continue isolating ordinary per-server
connect/protocol failures, but it MUST rethrow limit errors. A server whose discovery
fails ordinarily is closed and omitted rather than left as a connected empty partial.

`listResources()` stages all normalized listings and commits its return only after the
count/byte checks pass. `callTool()` and `readResource()` measure the fully materialized
SDK value immediately and reject before `normalizeContent`, blob decode, or manager
retention. `dispose()` remains authoritative and clears accounting before awaiting
client closes.

Image translation needs a second-allocation guard. At
`src/adapters/cursor/native-exec-mcp.ts:115-142`, compute decoded base64 length from the
encoded string without allocating, include it in the aggregate result budget, and throw
`McpPayloadTooLargeError` BEFORE `Buffer.from`/`Uint8Array.from`; apply the same rule to
resource blobs at `src/adapters/cursor/mcp-manager.ts:183-195`. Exact-boundary data is
decoded once. Oversized schemas, tool results, resources, and images are REJECTED with
typed errors—never truncated, sliced, compressed beyond existing valid image semantics,
or flattened/restored into syntactically valid-looking partial protocol data. opencodex
remains a bidirectional translator, so byte admission cannot change payload meaning.

## Regression tests

Concrete names/fixtures. Put cross-registry lease/accounting cases in NEW
`tests/active-registry-admission.test.ts`; extend existing owner suites for the rest:

- `debug subscriber 65 is rejected while the first 64 still receive entries`
- `subscriber unsubscribe is idempotent and only a foreign owner records release miss`
- `polling debug-log route remains JSON and never invents an SSE admission response`
- `debug injection crash and fixed-slot strings truncate on UTF-8 boundary with marker`
- `Claude inbound metadata key 65 and aggregate row overflow are visibly capped and wp5 hooks account exact bytes`
- `affinity rejects an oversized key component without colliding or changing routing`
- `active turn 257 returns structured server_busy before handler work`
- `one HTTP or WS turn through nested stream wrappers consumes one lease only`
- `forced shutdown abort releases every lease and later finalizers cause no miss or underflow`
- `websocket 129 rejects upgrade without entering account registry`
- `storage worker reservation 17 rejects before enqueue and the first 16 spawn serially and drain`
- `storage home slot 33 returns storage_mutation_busy without dropping active slots`
- `cleanup restore and policy retain their exact mutation lease through worker join`
- `active registry peak rejected and release-miss metrics are monotonic`
- `same refresh grant joins a live flight`
- `33rd distinct refresh grant is rejected before file lock and fetch`
- `stale refresh flight is aborted and replaced without deleting the replacement`
- `Codex refresh busy and stale stay retryable in auth context guardian quota and login consumers`
- `usage reader never requests more than 64 MiB from an oversized log`
- `usage byte-prefix truncation and entry-count truncation report independent metadata`
- `usage route cache preserves truncation metadata and invalidates when configured byte limit changes`
- `Usage All becomes Available history and API-key lifetime totals are qualified when capped`
- `stale usage-read flight is replaced and old completion cannot clear new owner`
- `Cursor model discovery rejects announced and streamed 4 MiB overflow before decode`
- `ninth distinct catalog gather is busy while same-fingerprint caller still joins`
- `catalog busy maps management and v1 models to 503 startup to warn-skip and system-env to skip`
- `OAuth pending code rejects 4097 UTF-8 bytes in the owner`
- `OAuth token-refresh flight 33 rejects and a stale same-key owner cannot delete replacement`
- `Codex login state row 33 rejects before browser work and terminal TTL deletes only its owner`
- `pool-quota flight 17 total across accounts rejects before request creation while compatible generation joins`
- `busy pool-quota probe leaves management GET 200 with cached quota and per-account quotaProbeSkipped`
- `busy pool-quota probe maps reset-credit refresh to 503 server_busy with Retry-After 1`
- `busy pool-quota probe is swallowed by startup priming like other priming failures`
- `MiMo accepts exact JWT boundary and rejects one byte over without caching`
- `MCP exact transactional catalog boundary admits and one byte over closes staging with empty committed catalog`
- `MCP list tool call resource and read bounds are proven after SDK receipt with no retained partial`
- `MCP oversized base64 image rejects before its second decode allocation`
- `usage and MCP config overrides change the effective bound while defaults remain compatible`.

Verification:

```bash
bun test tests/debug.test.ts tests/active-registry-admission.test.ts \
  tests/api-debug.test.ts tests/claude-inbound-debug.test.ts \
  tests/codex-websocket-registry.test.ts tests/storage-worker-lifecycle.test.ts \
  tests/storage-mutation-race.test.ts tests/codex-account-store.test.ts \
  tests/codex-auth-context.test.ts tests/token-guardian.test.ts
bun test tests/usage-log.test.ts tests/api-usage.test.ts tests/api-key-attribution.test.ts \
  gui/tests/usage-layout.test.ts tests/cursor-hardening.test.ts \
  tests/gather-routed-models-single-flight.test.ts tests/cli-catalog-prewarm.test.ts \
  tests/system-env.test.ts tests/model-visibility-management-api.test.ts
bun test tests/oauth-refresh.test.ts tests/oauth-manual-code.test.ts \
  tests/codex-auth-api.test.ts tests/mimo-free-provider.test.ts \
  tests/cursor-mcp-manager.test.ts tests/config.test.ts
bun run typecheck
bun run lint:gui
bun run build:gui
bun run test
bun run privacy:scan
```

File ownership is fixed as follows: debug subscriber/value cases extend
`tests/debug.test.ts` and `tests/api-debug.test.ts` (the latter owns the `/api/debug`
route behavior); Claude row/accounting cases extend `tests/claude-inbound-debug.test.ts`.
Turns use the new cross-registry file; sockets, worker reservations, and mutation lease
retention extend `tests/codex-websocket-registry.test.ts`,
`tests/storage-worker-lifecycle.test.ts`, and `tests/storage-mutation-race.test.ts`.
Codex refresh-flight ownership extends `tests/codex-account-store.test.ts` (NOT
`tests/xai-refresh-lock.test.ts`, which owns OAuth/XAI refresh), while consumer retry
classification extends `tests/codex-auth-context.test.ts`, `tests/token-guardian.test.ts`,
and `tests/codex-auth-api.test.ts`.

Usage reader, route, API-key rollup, and rendered GUI qualification extend
`tests/usage-log.test.ts`, `tests/api-usage.test.ts`,
`tests/api-key-attribution.test.ts`, and `gui/tests/usage-layout.test.ts`, respectively.
Cursor discovery and gather admission/caller mapping extend
`tests/cursor-hardening.test.ts`, `tests/gather-routed-models-single-flight.test.ts`,
`tests/cli-catalog-prewarm.test.ts`, `tests/system-env.test.ts`, and
`tests/model-visibility-management-api.test.ts`. OAuth token refresh and pending code
extend `tests/oauth-refresh.test.ts` and `tests/oauth-manual-code.test.ts`; Codex login/
quota owners extend `tests/codex-auth-api.test.ts`. MiMo extends
`tests/mimo-free-provider.test.ts`. MCP bounding is proven at the actual enforcement
layer in `tests/cursor-mcp-manager.test.ts`, including SDK-already-materialized fixtures
and native base64 decode; do not claim transport-level proof. Config defaults/validation
extend `tests/config.test.ts`. Do not invent parallel test harness names.

## Commit

`fix(runtime): cap registries flights and retained diagnostics`

## Explicitly not changed

- No forced eviction/untracking of accepted ACTIVE turns, sockets, workers, mutation
  slots, refresh grants, pending OAuth flows, or probes. Expired/old terminal Codex
  login-status rows may be removed because their work has already settled.
- No `#820` scheduler/session-lane architecture.
- No credential, token, account id, URL, path, command, or body in metrics.
- No truncation of MCP schemas/results/resources or flattened/restored translator data
  into syntactically valid-looking partials.
- No MCP SDK fork or transport/framing limit claim; this phase bounds only what can be
  enforced immediately after SDK receipt.
- No change to provider retry/rotation, MCP tool execution semantics, or usage-log disk format.
- No process-wide demotion; 040 consumes only the retained-ring accounting hooks.
