# 032 — Tickets #15/#16/#17 per-route decision record (read-surface batches, pre-flip scope)

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Status: recorded on `dev-go`; #16 and #17 advanced by one strict route each; #15 triaged to completion
Tickets:
- [#15](https://github.com/waxiangzi/opencodex/issues/15) (system read routes batch, spec #2)
- [#16](https://github.com/waxiangzi/opencodex/issues/16) (config read routes batch, spec #2)
- [#17](https://github.com/waxiangzi/opencodex/issues/17) (model/provider/catalog read views batch, spec #2)
Parent spec: [#2](https://github.com/waxiangzi/opencodex/issues/2) (increment 2)
Gate: `030_read_surface_state_source_gate.md` — a route is pre-flip
Go-servable byte-identically only when its body is a pure function of state the
sidecar can see (env / on-disk / OS / its own process). Everything else defers
to the flip, when the Go binary IS the serving process and legitimately owns
process state.

Owner decision (2026-09-05/06): implement #15/#16/#17 under that framework;
deferral decisions are made and recorded here rather than re-escalated.

## Why most of these routes cannot move pre-flip

The in-process TS handler bodies reflect the SERVING proxy's live state:
discovery caches, update jobs, effort clamps, runtime probing, Windows tray
actions, project-config scan caches. A sidecar is a separate process; it cannot
see another process's memory, and inventing a snapshot would re-create the
dev2-go divergence class (Go values rendered under TS labels). The batches'
tickets were written when the takeover was imagined as mechanical route
copying; the state-source gate is the discovery that it is not. Migrating the
pure residue now and recording the deferrals is the owner-approved pre-flip
completion of each batch. Deferred routes migrate with the binary at the flip
(themselves Go-served, so process state becomes legitimate) under #25/#40/#41.

## Migrated in this run (machine-proven via the differential oracle)

- **`GET /api/custom-models` → Go-owned, STRICT** (ticket #17). The TS body is
  `JSON.stringify(config.customModels ?? [])` — a raw echo of a zod-passthrough
  config subsection (probed: unknown keys, per-entry key order and non-schema
  values all survive a save/load round trip). Byte parity therefore needs
  document-order JSON, not a typed projection. Added an ordered decoder +
  JSON.stringify-compatible marshaler to the shared Go config package
  (`go/internal/config/ordered.go`): object keys in file order, compact
  whitespace, no HTML or U+2028/U+2029 escaping, the five control-char
  shortcuts, lowercase `\u00xx` below U+0020 — all pinned against Bun. This is
  also the foundation the `/api/config` provider-DTO port will need (provider
  entries keep their file order). Marker: strict (`volatileFields: []`), the
  oracle compares raw bytes.
- (Earlier slices already closed in: #14 delivered `/api/system/health`;
  devlog 031 delivered `GET /api/shadow-call-settings` for #16.)

## Per-route verdicts

### #15 — system reads (`src/server/management/system-routes.ts`)

| Route | Verdict | Reason (citation) |
|---|---|---|
| `GET /api/system/health` | **Go-owned** (#14, volatile pid/uptime) | own process values |
| `GET /api/system/memory` | defer to flip | body mixes OS memory with TS-runtime-owned keys: `bunVersion`, `jscHeap`, `responseState` etc. — the serving process's runtime internals, not reproducible by a sidecar. Flip: Go owns the process, keys become its own. |
| `GET /api/system/windows-replace-retries` | defer to flip | process-local retry counter (windows binary replacement state machine). |
| `GET /api/codex-app-server` | defer to flip | reports on ~1260 lines of app-server process management (`src/codex/app-server-processes.ts`): OS process enumeration + cached state + platform heuristics. Reimplementing the machinery for byte parity pre-flip is flip-scale work, not batch work. |

### #16 — config reads (`src/server/management/config-routes.ts`)

| Route | Verdict | Reason (citation) |
|---|---|---|
| `GET /api/shadow-call-settings` | **Go-owned, strict** (devlog 031) | pure function of config subsection |
| `GET /api/config` | defer (registry data) | body = `withProviderServiceTierDTO(safeConfigDTO(config))`; the DTO projects per-provider registry notes, `codexAccountMode`, service-tier records, redaction policy and xai opt-in state from the TS provider registry's static per-provider data. A partial port would be silently wrong for real providers (openai, anthropic, …) — the exact dev2-go defect class. Needs the registry subset ported as shared data first; ordered JSON from this run is the substrate. |
| `GET /api/settings` | defer (live fields mixed into one body) | config-derived keys coexist in one object with `resolveCodexRuntime()` (memoized active-binary probing), `readStartupHealth(config)` (cached install-state probes) and `Intl…timeZone` (process zone). Can't split a single response object; not reproducible by a sidecar. |
| `GET /api/sidecar-settings` | defer (model-capability registry + candidate tables) | body = vision/web-search candidate rows from `findAnthropicVisionProvider` / `resolveVisionBackend` / `visionModelOptionsFor` / `webSearchCandidateRows` — provider model-capability registry + picker tables with live reachability checks (config-routes.ts:109, web-search-sidecar-options.ts:43). #17-scale registry port. |
| `GET /api/startup-health` | defer (cached install-state probe) | `readStartupHealth(config)` reads process-level cached install/service state (`invalidateStartupHealthCache` after actions). |
| `GET /api/diagnostics/project-config` | defer (process scan cache) | `getCachedProjectConfigDiagnostics()` — lazy scan cache in `src/codex/project-config-warnings.ts`; reimplementing scan+cache semantics is flip-scale. |
| `GET /api/update/check` | defer (updater state) | `checkForUpdate()` module state (update/job.ts). |
| `GET /api/update/status` | defer (job table + query param) | `readUpdateJob(jobId)` — in-memory job table; absent job id → 404 handled in-process. |
| `GET /api/windows-tray` | defer (platform probe) | non-win32 static body carries `process.platform`; win32 runs tray-action status probes. Cross-platform probe semantics, not a config read. |

### #17 — model/provider/catalog reads (`model-routes.ts`, `provider-routes.ts`)

| Route | Verdict | Reason (citation) |
|---|---|---|
| `GET /api/custom-models` | **Go-owned, strict** (this run) | raw config echo (see above) |
| `GET /api/models` | defer (live catalog) | `listManagementModelRows(config)` over the converged live catalog (fetchAllModels family). #17's own acceptance says "catalog reads reflect live state" — that lives with the catalog store at the flip. |
| `GET /api/catalog` | defer (persisted-catalog serializer) | `serializePersistedCatalog()` from `src/server/catalog-download.ts` — a large deterministic serializer over the Codex-converged catalog; port is flip-scale model-store work, plus corsHeaders sharing. |
| `GET /api/client-config` | defer (catalog rows) | rows over the converged catalog. |
| `GET /api/model-discovery` / `/api/selected-models` / `/api/model-presets` | defer (live catalog + discovery) | `fetchAllModels(config)`, `getProviderLiveModelCount`, `materializeModelPreset` over the live catalog. |
| `GET /api/aliases` | defer (live /models cache) | `knownModelIdsForProvider` unions in `getStaleCached(provName)` (router.ts:99) — the last-known-good live /models cache; catalog drift handling (`builtinRule`) is registry-side. |
| `GET /api/providers` | defer (live keys in one body) | config-derived keys share one object with live `discovery` status and openai entitlement state. |
| `GET /api/provider-context-caps` | defer (in-memory caps module) | live context-capability state. |
| `GET /api/provider-presets` | defer (derive-provider-presets static table) | registry-derived preset table (`src/providers/derive.ts`) — static data port, moderate; folded into the registry-subset work that unblocks /api/config. |
| `GET /api/provider-request-pacing` | defer (live pacers) | `providerRequestPacingStatus` reads the module-level `pacers` map: queue depths, next-slot timestamps, last-start (src/providers/request-pacing.ts). `enabled` is config but is one key in a live body. |
| `GET /api/provider-quotas` | defer | live quota/usage cache (usage-quota surface, #20 family). |

## Registry and oracle state after this run

Three read routes are Go-owned: `/api/system/health` (volatile pid/uptime),
`/api/shadow-call-settings` (strict), `/api/custom-models` (strict). The strict
pair exercises the empty-volatile contract against real wire bytes. Nothing in
`management-api.ts` names a route (pinned by test 7 of
`tests/go-ownership-plumbing.test.ts`); adding the next route stays a marker
flip + Go handler + oracle cases.

## What unblocks the deferred reads at the flip

- Registry static data as shared Go data (provider notes, codexAccountMode,
  presets, alias rules) → then `/api/config`, `/api/provider-presets`,
  `/api/aliases`' registry half.
- The live model store/catalog moves into the Go binary with the takeover
  (#25 + the #40/#41 flip line) → `/api/models`, `/api/catalog`, discovery
  views, sidecar-settings candidates become the binary's own state.
- Process-state routes (memory, update jobs, clamps, tray, diagnostics caches)
  become the binary's own process state at the flip — no snapshot problem.
