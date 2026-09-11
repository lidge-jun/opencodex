# 002 — #3023: expired roster silently shortens every management model surface

Verified against `origin/dev` `870a2adb6`.

## Mechanism

`listManagementModelRows` builds native rows through `nativeModelRows(config)`
(`src/server/management/model-rows.ts:50`). A gated slug is included only when
`cachedAvailableAccountGatedNativeModels(Date.now(), ...)` returns it
(`src/codex/catalog/metadata.ts:414`). That projection is **synchronous** and
requires a confirmed entry with `expiresAt > now`
(`src/codex/model-entitlements.ts:596`).

So a never-fetched roster and an *expired* roster project identically: empty.

`listManagementModelRows` calls only `fetchAllModels`
(`src/server/management/shared.ts:173`), which gathers routed providers and never
resolves Codex entitlements. `/v1/models` differs — it runs `fetchAllModels` and
`resolveCodexModelEntitlements` together (`src/server/index.ts:1143`) — which is
exactly why one `GET /v1/models` repairs all three surfaces.

## The three surfaces are not identical

The reporter treated them as one path; they are three paths over one entry point:

- `/api/models` calls `listManagementModelRows` directly
  (`src/server/management/model-routes.ts:352`).
- `/api/client-config` goes through `loadExportModels`
  (`:393`, `src/server/management/model-rows.ts:164`).
- `ocx export` does **not** use `loadExportModels`. It requests `/api/models`
  over HTTP and serializes the rows itself
  (`src/cli/export-command.ts:169`).

That third detail matters for the test plan: a fixture that stubs rows instead of
going through the real management handler cannot see this defect.

## Why an unconditional refresh is not acceptable

The dashboard polls `/api/sidecar-settings` every 5 seconds
(`gui/src/pages/use-dashboard-data.ts:237`), and that route computes vision and
web-search candidates independently
(`src/server/management/config-routes.ts:589`), so each tick reaches the shared
list **twice**. The Models page adds `/api/models` every 10 seconds
(`gui/src/pages/Models.tsx:452`).

That is ~24 shared-list calls/minute with the dashboard open, ~30 with the Models
catalog active. Polls pause while the document is hidden
(`gui/src/client-resource.ts:538`). An unconditional `resolveCodexModelEntitlements`
at the shared entry point would put credential enumeration on that cadence.

## Fix surface

Add a cheap ensure/freshness operation in `src/codex/model-entitlements.ts` and
await it from `listManagementModelRows` before `nativeModelRows`, in parallel with
`fetchAllModels` — the shape `/v1/models` already uses
(`src/server/index.ts:1155`). It must:

- treat confirmed-empty and the 15-second unconfirmed entry as *cached answers*,
  not as cache misses;
- preserve per-account/version keys and in-flight deduplication
  (`:223`, `:455`) so concurrent pollers collapse into one fetch;
- never refresh from inside the synchronous `nativeModelRows`.

## Must not change

- The expiry check itself. Serving expired grants while refreshing would stop the
  visual disappearance but break fail-closed revocation (`:509`).
- `/v1/models` authorization or version behaviour.
- Failure must stay a bounded fail-closed roster result, not an exception: a throw
  from the shared entry would degrade sidecar candidates and could turn
  client-config into a 503 (`src/sidecar/candidates.ts:29`).

## The dishonest status is a separate, additive change

`discovery: {"status":"ok"}` comes from routed-provider discovery
(`src/codex/catalog/provider-fetch.ts:1510`, `src/codex/model-cache.ts:94`), not
from entitlements, which never write it. So "ok" is *true* for what it describes.
Overloading it would erase a simultaneously-correct routed result. The honest fix
is an additive entitlement diagnostic; GUI types currently admit only provider
discovery states (`gui/src/models-groups.ts:2`).

## Test plan

- `tests/codex-model-entitlements.test.ts` — repeated fresh ensure calls do zero
  refetches; at TTL+1 concurrent callers produce exactly one; failed refresh stays
  unconfirmed with no retry for 15s.
- `tests/native-model-toggle.test.ts` — expired confirmed roster, then
  `/api/models` still lists sol/terra/luna. Red today.
- `tests/management-client-config-route.test.ts` — same fixture, OpenCode map
  contains the GPT-5.6 entries, entitlement fetch count is 1.
- `tests/cli-export-command.test.ts` — point its fake proxy at the real
  `/api/models` handler; its current stubbed rows bypass the defective boundary.
