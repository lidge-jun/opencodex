# Part 1 research — Codex catalog gather/commit seam

The failure is a check/write gap, not a missing `try/catch`. The failed OFF design
needed provider discovery outside the per-`CODEX_HOME` lock and catalog/cache
mutation inside it, but the only management dependency returns `Promise<void>`
and the production function performs both halves before it resolves
(`src/server/management/context.ts:9-18`,
`devlog/_fin/260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md:17-24`).
Calling that operation outside the lock leaves native writes after OFF can
linearize; calling it inside the lock admits provider I/O and a 10-second bundled
catalog subprocess under a rule that forbids slow work there
(`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:250-310`,
`src/codex/catalog/bundled.ts:127-143`).

This document specifies only the catalog substrate needed to remove that
contradiction. It does not specify the desired-state flag, lock implementation,
history writer, ownership preflight, management toggle, or GUI; those were
separate responsibilities in the failed design
(`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:53-84`).

## 1. Current call graph

There are two production entry paths to `refreshCodexModelCatalog`: the
management helper dynamically imports it, while `syncModelsToCodex` imports it
directly (`src/server/management-api.ts:105-113`, `src/codex/sync.ts:1-4,24-34,83-108`).
The management helper is then awaited at 16 mutation sites; no production caller
uses `void`, an unhandled promise, or a detached task
(`src/server/management/provider-routes.ts:147,338,487,512,527,546`,
`src/server/management/model-routes.ts:214,313,352,390,404,440`,
`src/server/management/combo-routes.ts:198,216`,
`src/server/management/agent-settings-routes.ts:280,525`).

The existing dependency and production paths are not equivalent. An injected
`deps.refreshCodexCatalog` returns before the helper's `try`, so its rejection
reaches the management error mapper; the production dynamic import and refresh
are inside a blanket catch and disappear
(`src/server/management-api.ts:105-112,150-163`). The management API already has
a `CatalogGatherBusyError` to 503/`Retry-After` mapping, but production refresh
contention cannot reach it through this helper
(`src/server/management-api.ts:75,150-163`,
`src/codex/catalog/provider-fetch.ts:76-78,670-693`).

### 1.1 `refreshCodexCatalogBestEffort` callers

Every row below has the same current result handling: persist the primary
mutation, await a `Promise<void>`, discard any refresh result, and return the
ordinary success body shown at the cited route tail.

| # | Trigger | Current action after persistence | Typed-outcome change |
|---|---|---|---|
| P1 | `POST /api/providers` add or overwrite | Clears that provider's model cache, awaits refresh, then returns `{ success: true, name }` (`src/server/management/provider-routes.ts:96-99,132-148`). | Keep the provider mutation successful, but attach the catalog outcome instead of implying that Codex also changed. |
| P2 | Ordinary `PATCH /api/providers?name=...` field edit or enabled toggle | The standalone default/mode branches return earlier; the ordinary branch saves, optionally clears discovery cache, awaits refresh, then returns provider state (`src/server/management/provider-routes.ts:193-208,210-305,330-344`). | Return provider success plus committed/skipped/failed catalog status. |
| P3 | `DELETE /api/providers?name=...` | Reassigns the default if needed, saves, clears the deleted provider cache, awaits refresh, then returns success (`src/server/management/provider-routes.ts:449-488`). | Preserve deletion success and report whether stale Codex rows remain. |
| P4 | `PUT /api/provider-context-caps` with `value` | Saves the new global cap, clears affected provider caches, awaits refresh, then returns the cap view (`src/server/management/provider-routes.ts:495-513`). | Preserve cap success and expose catalog disposition. |
| P5 | `PUT /api/provider-context-caps` with `setAll` | Saves all cap toggles, clears affected caches, awaits refresh, then returns the cap view (`src/server/management/provider-routes.ts:516-528`). | Preserve cap success and expose catalog disposition. |
| P6 | `PUT /api/provider-context-caps` for one provider | Saves the provider cap, clears its cache, awaits refresh, then returns the cap view (`src/server/management/provider-routes.ts:531-547`). | Preserve cap success and expose catalog disposition. |
| M1 | `PUT /api/disabled-models` | Saves the blocklist, awaits refresh, then returns `{ ok: true, disabled }` (`src/server/management/model-routes.ts:206-215`). | Preserve blocklist success and state explicitly when Codex did not consume it. |
| M2 | `PUT /api/model-visibility` | Saves the combined allowlist/blocklist edit, awaits refresh, then returns visibility success (`src/server/management/model-routes.ts:218-255,277-314`). | Preserve visibility success and expose catalog disposition. |
| M3 | `POST /api/custom-models` | Saves the new custom row, awaits refresh, then returns the row with 201 (`src/server/management/model-routes.ts:321-353`). | Preserve 201 and report whether the row reached Codex. |
| M4 | `PUT /api/custom-models/:id` | Saves the edited row, awaits refresh, then returns it (`src/server/management/model-routes.ts:356-391`). | Preserve edit success and report whether Codex consumed it. |
| M5 | `DELETE /api/custom-models/:id` | Saves removal, awaits refresh, then returns `{ ok: true }` (`src/server/management/model-routes.ts:394-405`). | Preserve removal success and report whether a stale native row may remain. |
| M6 | `PUT /api/selected-models` | Saves/clears the provider allowlist, awaits refresh, then returns selection success (`src/server/management/model-routes.ts:426-441`). | Preserve selection success and expose catalog disposition. |
| C1 | `PUT /api/combos` create, update, or rename | Saves combo and migrated references, clears combo runtime state, awaits refresh, optionally syncs Claude agents, then returns success (`src/server/management/combo-routes.ts:83-115,150-200`). | Codex failure must not suppress the already-saved combo or the independent Claude sync; include a catalog status. |
| C2 | `DELETE /api/combos?id=...` | Saves removal, clears combo runtime state, awaits refresh, then returns success (`src/server/management/combo-routes.ts:203-217`). | Preserve deletion success and report whether the retired combo row remains in Codex. |
| A1 | `PUT /api/v2` | Applies Codex feature/config writers, awaits refresh, then returns the effective settings and warnings (`src/server/management/agent-settings-routes.ts:154-178,240-294`). | Add a typed catalog warning/status; do not turn an already-landed feature write into 5xx. |
| A2 | `PUT /api/subagent-models` | Saves chosen models, awaits Codex refresh, then independently syncs Claude agents and Desktop before returning success (`src/server/management/agent-settings-routes.ts:495-528`). | Continue the Claude/Desktop work after any Codex skip/failure and attach the Codex disposition. |

`config-routes.ts`, `logs-usage-routes.ts`, and `oauth-account-routes.ts` destructure
the shared helper but do not invoke it; the complete production invocation set is
the 16 sites above
(`src/server/management/config-routes.ts:77`,
`src/server/management/logs-usage-routes.ts:124`,
`src/server/management/oauth-account-routes.ts:115`).

### 1.2 Direct `refreshCodexModelCatalog` caller

`syncModelsToCodex` is the only non-test direct caller. It skips catalog refresh
for an externally owned model provider, otherwise catches every refresh throw,
logs a warning, and still calls `injectCodexConfig`; its final `ok` is the
injection result rather than catalog success
(`src/codex/sync.ts:49-71,73-129`). This fallback is pinned: a thrown refresh must
still call injection with an undefined catalog path and return `ok: true` plus a
warning when injection succeeds (`tests/codex-sync-api.test.ts:148-166`).

Its second-order production callers are all awaited: custom-model save and
provider `--sync` catch and warn, start suppresses failure, both ensure paths
catch and warn, `restore back` and explicit `sync` inspect `ok`, and `POST
/api/sync` maps `ok` to HTTP 200/500
(`src/cli/models.ts:102-107`, `src/cli/provider.ts:232-237`,
`src/cli/index.ts:318-320,358-411,745-763,827-840`,
`src/server/management/config-routes.ts:261-268`). A typed desired-OFF or native
lock-busy result must stop before `injectCodexConfig`; network/auth catalog
degradation must retain the existing injection fallback
(`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:372-423`).

## 2. Where gathering ends and committing begins

`refreshCodexModelCatalog` currently looks small because `syncCatalogModels`
contains the mixed operation. It awaits that function, checks whether the
returned path exists, then calls a cache invalidator that reads the just-written
catalog and writes `models_cache.json`
(`src/codex/refresh.ts:40-52`, `src/codex/catalog/sync.ts:601-616`).

### 2.1 Gathering: permitted to be async or slow, forbidden to write

The gather phase must include all of the following work:

1. Resolve the effective catalog path and load an in-memory source catalog,
   existing target catalog, native template, and baseline
   (`src/codex/catalog/sync.ts:513-525,545-565`).
2. Run bundled catalog discovery when needed. `loadBundledCodexCatalog` can resolve
   the Codex runtime and execute `codex debug models --bundled` with a 10-second
   timeout, so it cannot run under the write lock
   (`src/codex/catalog/bundled.ts:127-165,188-210`).
3. Await `gatherRoutedModels`. It admits one gather flight, resolves provider auth,
   and fans out provider model discovery with `Promise.all`
   (`src/codex/catalog/provider-fetch.ts:410-490,670-717`).
4. Filter visible models, build routed entries, merge native/routed state, clamp
   fields, and serialize the final catalog in memory
   (`src/codex/catalog/sync.ts:533-568`).
5. Build the expired cache wrapper in memory instead of rereading the catalog
   after commit; the wrapper shape is currently assembled immediately before its
   write (`src/codex/catalog/sync.ts:600-613`).
6. Decide whether pristine backup payloads are needed and capture their bytes in
   the candidate. Current backup creation performs `existsSync`, catalog reads,
   `copyFileSync`, `mkdirSync`, and `atomicWriteFile`; those writes cannot remain
   in gather (`src/codex/catalog/parsing.ts:428-444`).

`loadCatalogForSync` is itself mixed. Its bundled/source reads belong to gather,
but its final fallback calls `materializeBundledCodexCatalog`, whose
`mkdirSync` plus `atomicWriteFile` are writes
(`src/codex/catalog/bundled.ts:213-234`). The split therefore cannot merely move
the `await` at `syncCatalogModels:526`; it must replace the materializing fallback
with a pure in-memory source and defer materialization bytes to commit
(`src/codex/catalog/sync.ts:507-531`).

### 2.2 Committing: synchronous, bounded, and byte-oriented

The commit phase consumes already-built payloads and performs no provider fetch,
auth refresh, subprocess, catalog merge, JSON parsing, or `await`. Its complete
write set is:

- create a parent/config directory only when one of the prepared writes needs it
  (`src/codex/catalog/bundled.ts:213-218`,
  `src/codex/catalog/parsing.ts:440-444`);
- write zero, one, or two prepared pristine backup payloads, replacing the current
  `copyFileSync`/`atomicWriteFile` choice with candidate bytes
  (`src/codex/catalog/parsing.ts:428-444`);
- write the prepared catalog bytes with `atomicWriteFile`
  (`src/codex/catalog/sync.ts:565-569`);
- write the prepared expired cache wrapper with `atomicWriteFile`
  (`src/codex/catalog/sync.ts:601-613`).

`atomicWriteFile` is synchronous: it writes a temporary file, hardens it, renames
it, and scrubs/removes a failed temporary file before rethrowing
(`src/config.ts:178-230`). The number of candidate writes is fixed by the payload
set rather than provider/model count, which is the bounded property required by
the failed lock design
(`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:250-310`).

`syncCodexModelsCacheFromCatalog` is not in the production refresh path and must
not become the commit primitive: it rereads the catalog and writes raw catalog
bytes to the cache path, while the active invalidator requires an expired wrapper
(`src/codex/refresh.ts:29-38`, `src/codex/catalog/sync.ts:600-613`).

## 3. Proposed contract

**INFERRED contract:** expose exactly these two operations from the catalog owner,
because the audit requires the lock owner to schedule them separately
(`devlog/_fin/260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md:46-58`).

```ts
export interface CodexCatalogCandidate { /* opaque, readonly, branded */ }

export async function gatherCodexCatalogCandidate(
  config: OcxConfig,
): Promise<CodexCatalogCandidate>;

export function commitCodexCatalogCandidate(
  candidate: CodexCatalogCandidate,
): CodexCatalogCommitResult;
```

The candidate must carry:

- final catalog bytes, expired cache-wrapper bytes, target catalog/cache paths,
  and optional pristine-backup path/byte pairs; these are the complete current
  write products (`src/codex/catalog/sync.ts:568,601-613`,
  `src/codex/catalog/parsing.ts:428-444`);
- `added`, `comboOmissions`, source/catalog existence, and the result metadata now
  returned after mutation (`src/codex/refresh.ts:8-15,44-52`);
- a digest of the catalog-affecting config snapshot, including credential changes
  without retaining or exposing credential values; provider auth and config both
  influence gathered rows (`src/codex/catalog/provider-fetch.ts:410-490,696-717`);
- canonical target identity, resolved catalog path, and a digest-or-absence marker
  for the base catalog from which the merge was assembled; the merge deliberately
  preserves existing routed/user-native rows from that file
  (`src/codex/catalog/sync.ts:513-525,430-468`);
- typed provider-discovery notices and the fallback actually used. Current network,
  HTTP, malformed-response, and destination-policy failures degrade to stale or
  configured models rather than throwing (`src/codex/catalog/provider-fetch.ts:494-570,616-632`);
- an internal one-shot identity so the same candidate cannot be committed twice.
  **INFERRED:** two commits of one snapshot can overwrite a later refresh even
  when the lock serializes both (`src/codex/catalog/sync.ts:568`).

The candidate must not carry a mutable `OcxConfig` reference, an open file handle,
or a callback. **INFERRED:** those would allow mutation after gather or smuggle
slow work back into commit, recreating the opaque all-in-one dependency rejected
by the audit
(`devlog/_fin/260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md:19-24`).

The payload fields are mostly JSON-compatible, but the candidate is deliberately
not a persistence or IPC format. **INFERRED:** a private brand/one-shot token and
freshness evidence are process-local; serializing and later replaying it would
turn a short gather/commit handoff into an unbounded stale-write mechanism.

The management test seam must split too. Keeping
`refreshCodexCatalog?: () => Promise<void>` as an early-return override would let
the injected path continue bypassing lock admission, exactly as it does now
(`src/server/management/context.ts:9-18`, `src/server/management-api.ts:105-112`).
**INFERRED:** inject a paired gather/commit dependency (or one object containing
both) so tests can substitute candidate production and byte commit independently;
the management orchestrator, desired-state check, and lock remain outside that
pair.

## 4. Freshness contract

A candidate can become stale between gather and commit. The lock serializes
commits; it does not freeze the config, target path, or catalog while gathering
happens outside it
(`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:250-310`).

**INFERRED invalidators:** commit must refuse with `stale_candidate` when any of
these differ under the lock from the candidate's evidence:

1. effective desired state is OFF or unavailable;
2. catalog-affecting config digest changed;
3. canonical `CODEX_HOME`, resolved catalog path, or cache path changed;
4. base catalog digest/existence changed, including a prior refresh committing
   while this candidate waited;
5. ownership is no longer the same owned target; or
6. the candidate was already consumed.

The need for checks 1 and 5 comes from the failed OFF ordering, while checks 2-4
close the stale-config and stale-merge window created by gathering outside the
lock
(`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:250-310`,
`src/codex/catalog/sync.ts:513-525,430-468`). A newly appearing valid pristine
backup is not permission to overwrite it: current behavior is create-once, so
commit skips that prepared backup write if another commit created it first
(`src/codex/catalog/parsing.ts:428-444`).

Provider inventory changing upstream after gather does not by itself invalidate
the candidate. **INFERRED:** it is a point-in-time discovery result, just as the
current fetch/cache path is; a later refresh supersedes it
(`src/codex/catalog/provider-fetch.ts:481-510,613-632`). Wall-clock age alone is
also not a correctness test; revision evidence is.

## 5. Typed refresh outcome

`refreshCodexCatalogBestEffort` should remain non-throwing by design, but
"best effort" must mean a returned disposition, not `Promise<void>` plus a blanket
catch (`src/server/management-api.ts:105-112`). **INFERRED contract:** the
orchestrator returns this closed shape:

```ts
type CodexCatalogRefreshOutcome =
  | { status: "committed"; result: CodexCatalogRefreshResult; notices: CatalogGatherNotice[] }
  | { status: "skipped"; reason: "catalog_unavailable" | "desired_off" |
      "gather_busy" | "lock_busy" | "stale_candidate"; retryable: boolean }
  | { status: "failed"; reason: "provider_network" | "provider_auth" | "disk";
      phase: "gather" | "commit"; retryable: boolean; writes?: CatalogWriteReceipt };
```

The real dispositions and caller meanings are:

| Condition | Evidence | Outcome and required handling |
|---|---|---|
| Per-provider network/HTTP/policy failure with stale or configured fallback | Discovery records failure and returns fallback rows (`src/codex/catalog/provider-fetch.ts:494-570,616-632`). | Commit can succeed with a typed notice; management mutations stay successful and `syncModelsToCodex` keeps its warning/fallback behavior. |
| Network failure that prevents any candidate | `Promise.all` rejects if a provider-stage operation escapes its local fallback (`src/codex/catalog/provider-fetch.ts:696-717`). | `failed/provider_network`, no commit; management returns primary success plus warning, sync may continue injection fallback. |
| Missing OAuth token | Discovery returns configured rows (`src/codex/catalog/provider-fetch.ts:475-479`). | A committed candidate with `provider_auth` notice, not a route failure. |
| Auth/token resolution throws before fetch fallback | Token resolution occurs before the fetch `try` (`src/codex/catalog/provider-fetch.ts:428,512-516`). | `failed/provider_auth`, no commit; management returns primary success plus warning, sync may continue injection fallback. |
| Gather admission occupied | `tryAcquire` throws `CatalogGatherBusyError` (`src/codex/catalog/provider-fetch.ts:670-684`). | `skipped/gather_busy`, retryable; best-effort mutation routes do not become 503 after their primary write, but report retryable skip. |
| Desired Codex state is OFF | The failed design requires a fresh desired-state check under the shared lock before any native write (`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:250-310,372-423`). | `skipped/desired_off`, not retryable until intent changes; no catalog, cache, or injection write. |
| Native write lock is occupied | The failed design classifies lock timeout as a no-write result (`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:372-423`). | `skipped/lock_busy`, retryable; no commit and no injection. |
| Candidate revision changed | Gathering reads and merges current on-disk rows before its write (`src/codex/catalog/sync.ts:513-525,430-468`). | `skipped/stale_candidate`, retryable after regather; never commit against changed config/catalog. |
| No usable catalog source | Current sync returns `catalogWritten:false`, and refresh reports absent without touching cache (`src/codex/catalog/sync.ts:513-515`, `src/codex/refresh.ts:44-52`). | `skipped/catalog_unavailable`; retain current native catalog/injection fallback. |
| Backup/catalog/cache filesystem failure | Backup errors are currently swallowed, catalog write throws, and cache write is caught as `false` (`src/codex/catalog/sync.ts:527-531,568`, `src/codex/catalog/sync.ts:601-616`). | `failed/disk` with per-write receipt. Do not claim rollback across files; report partial catalog/cache state and let convergence retry. |

`CatalogWriteReceipt` must identify which fixed writes landed before failure because
catalog and cache are separate atomic replacements, not one transaction
(`src/codex/catalog/sync.ts:568,601-613`). **INFERRED:** a disk failure after the
catalog rename but before cache rename is a partial commit, so a single boolean
cannot tell an explicit sync whether a long-lived Codex app-server may be stale;
the CLI already reacts to either `catalogWritten` or `cacheSynced`
(`src/cli/index.ts:827-840`).

### 5.1 Caller policy

All 16 management callers are best-effort with respect to Codex catalog refresh:
their primary config mutation is persisted before refresh, and their current
success response follows the awaited call
(`src/server/management/provider-routes.ts:132-148,330-344,479-488`,
`src/server/management/model-routes.ts:311-314,350-353,387-405,437-441`,
`src/server/management/combo-routes.ts:190-217`,
`src/server/management/agent-settings-routes.ts:240-294,518-528`).
**INFERRED:** they must keep their existing 2xx/201 primary outcome for every
catalog disposition and add a small `catalogRefresh` field containing
`status/reason/retryable`; rolling back or returning 5xx would falsely say the
provider/model/combo/setting mutation did not land.

`syncModelsToCodex` has two policies. Provider network/auth, unavailable catalog,
and ordinary disk failure preserve the tested injection fallback and return a
warning/receipt; desired OFF, native lock busy, or stale locked approval return
`ok:false` before injection because those mean native writes are not authorized
(`src/codex/sync.ts:83-129`, `tests/codex-sync-api.test.ts:148-166`,
`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:372-423`). Explicit
`POST /api/sync` can then map desired OFF to 409, retryable busy to 409/503, and
non-retryable disk failure to 500 instead of mapping every `ok:false` to 500
(`src/server/management/config-routes.ts:261-268`,
`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:396-407`).

## 6. Existing tests and contract breakage

The split is a contract change, not an internal rename:

- `tests/codex-refresh.test.ts` pins one async all-in-one
  `syncCatalogModels` dependency followed by `existsSync` and cache invalidation,
  the exact result booleans, real catalog rewrite, and cache success/failure
  (`tests/codex-refresh.test.ts:60-216`). It must split gather assertions from
  fixed-write commit assertions and add stale-candidate/partial-write receipts.
- `tests/codex-sync-api.test.ts` stubs `refreshCodexModelCatalog` with the current
  result object and pins catch-and-continue injection fallback
  (`tests/codex-sync-api.test.ts:47-166,227-255`). It must stub typed outcomes and
  separately pin desired-OFF/lock-busy no-injection behavior.
- `tests/codex-models-cache-invalidate.test.ts` calls the real refresh through
  `syncModelsToCodex` and pins `catalogWritten || cacheSynced` as the app-server
  restart gate (`tests/codex-models-cache-invalidate.test.ts:114-177`). Its
  assertions must consume the write receipt without losing that gate.
- `tests/injection-model-api.test.ts` directly verifies that the current refresh
  forwards the mutable config object to `syncCatalogModels`
  (`tests/injection-model-api.test.ts:373-401`). It must instead verify candidate
  fingerprint/input snapshot behavior.
- `tests/model-visibility-management-api.test.ts` counts exactly one injected
  void refresh per successful mutation and expects 200 responses
  (`tests/model-visibility-management-api.test.ts:49-89,92-106`). It must use the
  paired seam and assert the response-side catalog disposition.
- `tests/management-provider-validation.test.ts` pins no refresh for dedicated
  provider mode changes and one refresh for ordinary provider edits
  (`tests/management-provider-validation.test.ts:1751-1823,1843-1865`). Those call
  counts remain, but the injected contract and response assertions change.
- `tests/combo-management-api.test.ts` has a `Promise<void>` helper and a real
  callback that invokes `syncCatalogModels` to prove DELETE retires the final
  combo row (`tests/combo-management-api.test.ts:117-142,682-725`). It must drive
  gather then commit through the new seam.
- `tests/combos.test.ts` and `tests/codex-v2-gate.test.ts` encode the same
  `() => Promise<void>` dependency in helpers or route fixtures
  (`tests/combos.test.ts:119-143`, `tests/codex-v2-gate.test.ts:637-745`). They
  need paired no-write stubs and typed success outcomes.
- Stub-only management fixtures in integration, client-config, response-shadow,
  and combo-failover tests inject the old void callback to prevent real-home
  writes (`tests/management-integration-routes.test.ts:125`,
  `tests/management-client-config-route.test.ts:84-96,246`,
  `tests/responses-shadow-intercept.test.ts:200`,
  `tests/server-combo-failover-e2e.test.ts:346`). They break at the dependency
  type even where their exercised route never refreshes.
- `tests/catalog-input-modality-enum.test.ts` constructs a direct
  `ManagementContext` with a void best-effort helper and therefore breaks when
  that context returns a typed outcome
  (`tests/catalog-input-modality-enum.test.ts:90`).

No caller depends on fire-and-forget timing. All production sites await the
operation, and route tests count refreshes synchronously after the response
(`src/server/management/provider-routes.ts:147,338,487,512,527,546`,
`src/server/management/model-routes.ts:214,313,352,390,404,440`,
`tests/model-visibility-management-api.test.ts:78-106`). What callers do depend
on is failure isolation: management mutations still succeed after their primary
write, and `syncModelsToCodex` still injects when ordinary catalog refresh fails
(`src/server/management-api.ts:105-112`, `tests/codex-sync-api.test.ts:148-166`).

## 7. Risks and the hardest problem

The main risk is an optimistic-concurrency window: gather reads config and the
existing catalog, waits on provider discovery, and assembles a merge while
another process can change either input
(`src/codex/catalog/sync.ts:513-526,430-468`). A lock acquired only for commit
orders writers but does not prove that the candidate was built from the state now
being overwritten
(`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:250-310`).

**INFERRED:** the single hardest problem is defining the revision key that makes
that proof exact without rerunning slow work under the lock. A config-only digest
is insufficient because a newer refresh or Codex itself can replace the base
catalog; a catalog-only digest is insufficient because provider enablement,
allowlists, custom models, combos, modality metadata, and credentials all affect
assembly/discovery
(`src/codex/catalog/sync.ts:513-565`,
`src/codex/catalog/provider-fetch.ts:410-490,696-717`). The candidate therefore
needs both a catalog-affecting config digest and target/base-catalog revision, and
commit must reject rather than “best effort” overwrite when either changed.

Other risks follow from that decision:

- Conservative full-config fingerprinting can cause harmless retries after an
  unrelated config edit, but a hand-maintained subset can miss a future
  catalog-affecting field; **INFERRED:** conservative invalidation is safer for
  Part 1 because catalog inputs already span providers, visibility, combos, and
  subagent settings (`src/codex/catalog/sync.ts:533-565`).
- Backup, catalog, and cache writes are separately atomic, so a disk error can
  leave a catalog/cache mismatch; the receipt and later convergence must make
  that partial state visible (`src/codex/catalog/sync.ts:527-531,568,601-616`).
- A second candidate gathered from the same initial revision can wait behind the
  first and then overwrite it; base-catalog revision validation makes the second
  return `stale_candidate` and regather instead
  (`src/codex/catalog/sync.ts:513-525,568`).
- Current provider discovery frequently degrades instead of throwing, so a typed
  outcome added only around exceptions would still lose network/auth evidence;
  notices must be gathered from the provider discovery result/status path
  (`src/codex/catalog/provider-fetch.ts:494-570,616-632`).
- The bundled fallback currently writes while loading; leaving that one call
  untouched would preserve the audit failure even if the final catalog/cache
  writes move (`src/codex/catalog/bundled.ts:213-234`).

The seam is sufficient only when gather can be paused indefinitely with zero
native write, OFF or a config/catalog revision change can win during that pause,
and commit either performs the fixed prepared write set or returns a typed no-write
or partial-write receipt
(`devlog/_fin/260803_codex_desktop_toggle/030_desired_state.md:585-597`,
`devlog/_fin/260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md:19-24`).
