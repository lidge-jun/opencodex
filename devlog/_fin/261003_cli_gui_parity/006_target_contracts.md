# wp0 target crux: local versus live settings workflows

2026-10-03, source-only bounded decision record. Resolves set-M06/M13/S04, provider P02/P05 and logout P10 for roadmap selection. No tracked files, prior artifacts, user config, credentials, proxy, upstream or tests were changed/run. Source establishes the transport/side-effect differences sufficiently to choose implementation; it does not establish runtime parity. Existing isolated tests were inspected, not executed.

## Concrete roadmap choice

**Retain existing roots and local behavior. Add an explicit `--live` option to the existing commands for exact management-target GUI behavior, with structured receipts. Do not auto-fallback between local and live; do not create `agent mode` or a generic API passthrough.** The only new API surface work needed by these cruxes is CLI transport/options, not new server routes. `--json` selects output, never target.

| Tasks | Accepted implementation choice for roadmap | Smallest before → after |
|---|---|---|
| set-M06 | Existing `models add/remove` gain `--live --json`; keep existing local add/remove default and existing live `models edit`. Add proper local JSON save/sync disposition as output enhancement. | Before: add/remove modify local config and optionally perform broad Codex sync, emit prose; edit is live. After: explicit live add/remove use the same server custom-model handlers as GUI, return its identity and catalog receipt; local remains available and is labeled local. |
| set-M13 | Reuse `v2 status`, `mode`, `keep-native-v1`, `threads`, plus existing on/off. Add `--live --json` and explicit advisory acknowledgment for live mode changes. Keep current local implementation and add strict JSON output/argument parsing. | Before: local files/Codex helpers, mode/keep sync, prose, no advisory-version write; trailing flags are not systematically rejected. After: live option operates on the selected management target and returns server post-write state/advisory/catalogRefresh; no-live remains existing local functionality. |
| set-S04 | Reuse `v2 mode-hint TEXT` and `v2 mode-hint --clear`; route through the same narrow v2 live option when requested. Local set/null writer already exists and needs only machine output/discovery. | Before: shared local hint helper already implements set/null and rejects blanks. After: no duplicate hint implementation; optional live path receives the target runtime's capability/refusal and receipt. |
| set-P02 | Existing `provider add` gains explicit live path; preserve offline default. Add missing typed fields (responses path/auth mode) to the same domain parser. | Before: local seed/save, `--json` bypasses `--sync`; target runtime not the mutation owner. After: live preset read/POST provider and receipt belong to one resolved server; local `--sync --json` actually executes the requested sync and reports disposition. |
| set-P05 | Existing `provider remove` and `provider set-default` gain `--live`. Existing `provider edit --enabled` already uses management and does not need a second endpoint. | Before: local remove refuses current default and only deletes local provider/custom-model config; live GUI can reassign default and removes OAuth account set/caps. After: explicit live operations use exactly those server validations and effects, with destructive confirmation for removal. |
| set-P10 logout | Existing top-level `logout P` gains `--live --json`; keep local logout default and its current removed/not-found semantics. | Before: shared auth-store removal occurs locally, but live caches/login state aren't cleared by this CLI branch. After: explicit live logout invokes `/api/oauth/logout?provider=P` and returns its actual success receipt; no unproved `removed:true` claim. |

“Accepted” here is the explorer's concrete recommended lock for the parent's roadmap, not a claim that implementation or user-state mutation has occurred. Main retains naming/final phase authority. This choice is intentionally narrower than changing all existing command defaults.

## Why machine-output enhancement alone is insufficient for live GUI parity

### Shared persistence is not a shared target or completion receipt

- `saveConfig` writes local config under a mutation lock and bumps a generation; its body is persistence, not a management request: `src/config.ts:370`.
- Server handlers mutate their retained live `config`, use preserving/rebase-aware persistence (`src/config/live-reconcile.ts:443`), and perform explicit live-store/cache/convergence work. Their GET config returns that retained config: `src/server/management/config-routes.ts:306`.
- `runtimeBaseUrl` selects the identity-checked live proxy or rejects absent/client-role management; it does not promise the dashboard's remote-relay target: `src/cli/runtime-api.ts:70`. Therefore `--live` means **the existing CLI management target**, not arbitrary GUI apiBase/remote equivalence. No new raw `--url` capability is proposed.
- Resolve base URL **once per multi-request workflow**, then pass a pinned `RuntimeApiDeps.baseUrl` to every request. Otherwise list/resolve/delete can re-resolve the listener between calls (`src/cli/runtime-api.ts:136`). This is a per-command target fix, not a new transport framework.
- Do not invoke the local handler before deciding `--live`; a refused or unreachable live request must never have already saved local config. Do not fall back after a transport error, timeout, 409 or partial receipt.

### set-M06: custom model CRUD

Local add writes `config.customModels`, calls `saveConfig`, then `syncCustomModelsIfLive`: `src/cli/models.ts:197`, `src/cli/models.ts:250`. Local remove follows the same save/sync family: `src/cli/models.ts:280`, `src/cli/models.ts:331`. The sync helper catches failures and emits warning text rather than returning a durable save/catalog receipt (`src/cli/models.ts:185`).

`syncModelsToCodex(port, config=loadConfig())` checks local desired integration/service-home authority; depending on path it can refresh catalog/cache **and inject config** (`src/codex/sync.ts:99`, `src/codex/sync.ts:209`, `src/codex/sync.ts:293`). It is not equivalent to the GUI handler's catalog-only convergence.

Live POST builds the same core `OcxCustomModel` fields, validates provider/collisions and mutates retained live config, then returns 201 `{...entry,catalogRefresh}` (`src/server/management/model-routes.ts:961`, `src/server/management/model-routes.ts:1001`). Live DELETE accepts UUID, updates live config, and returns `{ok:true,catalogRefresh}` (`src/server/management/model-routes.ts:1079`). Management convergence is bound to retained config and catalog-only scope (`src/server/management-api.ts:255`, `src/codex/management-convergence.ts:144`).

**Resolved:** CRUD effects already exist, but a new live option is needed to claim the same target/management receipt. JSON-only changes cannot supply that. Existing local source remains a supported offline workflow.

Exact live grammar:

- `ocx models add P M [existing metadata flags] --live --json` → POST `/api/custom-models` with provider/modelId and provided displayName/contextWindow/inputModalities/reasoningEfforts/defaultReasoningEffort. No local `loadConfig()` preflight; target server validates provider.
- `ocx models remove UUID --yes --live --json` → DELETE `/api/custom-models/UUID`.
- Retain `P/M` removal convenience by GET `/api/custom-models` on the **same pinned target**, resolve exact-or-refuse using existing collision/slug rules, then DELETE UUID. Never resolve from local `customModels` before live deletion.
- Preserve empty reasoning `[]` versus inherit omission/null. Existing live edit parser already handles clear variants (`src/cli/models-runtime.ts:195`).

### set-M13 / set-S04: reuse v2

Existing implementations are substantive, not aliases: `src/cli/v2.ts:109` status, `:144` hint set/clear, `:177` thread transition, `:191` mode save/sync, `:220` keep-native save/sync. Dispatch wires the root directly (`src/cli/dispatch.ts:539`).

Server and local paths use the same `transitionMultiAgentV2` and `setMultiAgentModeHintText` helpers (`src/server/management/agent-settings-routes.ts:391`, `:415`, `:464`). Source establishes **local scalar/transition equivalence**, including blank hint rejection and null clear. It does not establish equivalence of surrounding target and convergence behavior: CLI sync is broad and local, while server returns post-write readings plus `catalogRefresh` (`src/server/management/agent-settings-routes.ts:484`). Local hint and threads paths do not issue management requests.

Advisory semantics are now resolved: the GUI modal records explicit choice (`gui/src/pages/Models.tsx:2026`); the server validates acknowledgment is boolean and only true writes the advisory version **after** mode has landed (`src/server/management/agent-settings-routes.ts:372`, `:444`). There is no session-only principal gate or mandatory pre-write acknowledgment in `/api/v2`. Do not invent such a security guard. Do not auto-acknowledge just because a script requests a mode.

Exact live grammar/mapping:

| Existing root + proposed option | Exact live operation |
|---|---|
| `v2 status --live --json` | GET `/api/v2` |
| `v2 mode v1\|default\|v2 --live [--acknowledge-surface-advisory] --json` | PUT `{multiAgentMode, multiAgentSurfaceAdvisoryAcknowledged?:true}`; omission preserves unacknowledged state; default remains string `default`, not null. |
| `v2 keep-native-v1 on\|off --live --json` | PUT `{keepNativeChatGptOnV1:boolean}` |
| `v2 threads N --live --json` | PUT `{maxConcurrentThreadsPerSession:N}`, integer >=1 |
| `v2 mode-hint TEXT --live --json` | PUT `{multiAgentModeHintText:TEXT}`; nonblank raw text retained. |
| `v2 mode-hint --clear --live --json` | PUT `{multiAgentModeHintText:null}` |
| `v2 on\|off --live --json` | PUT `{enabled:boolean}`; retain server hybrid conflict refusal. |

Use the same strict parser for local/live flags. `--json` must be consumed and unknown/trailing args rejected before local writers run; it must not be silently ignored. Local JSON must report `transport:local`, actual helper changed/no-op state and sync outcome without manufacturing server advisory or catalog receipts. Live JSON should preserve server returned state/warnings/catalogRefresh. If catalog refresh fails after persistence, do not claim rollback.

### set-P02 / set-P05: provider lifecycle

Local add parser seeds from registry/custom flags and writes local config (`src/cli/provider.ts:144`, `:192`, `:212`, `:274`). JSON mode returns before `--sync` handling (`:279`, `:292`). Existing test explicitly pins `needsSync:true` despite its misleading title (`tests/cli/cli-provider.test.ts:680`); fixing JSON-plus-sync is a deliberate behavior correction, not an untested assumption.

Live POST validates the candidate, mutates retained live provider config, reconciles state stores, clears model cache and returns `{success:true,name,catalogRefresh}` (`src/server/management/provider-routes.ts:1372`, `:1400`). Live default selection rejects a disabled row and persists/reconciles a standalone `{setDefault:true}` (`:1459`). Local set-default only verifies existence before saving (`src/cli/provider.ts:439`, `:459`).

Live remove is materially broader: default replacement and combo dependency checks (`src/server/management/provider-routes.ts:1824`), custom-model removal, cap cleanup, OAuth account-set removal, live-store reconciliation, model-cache invalidation and catalog receipt (`:1854`). Local remove refuses current default and deletes provider/custom-model config (`src/cli/provider.ts:345`, `:355`, `:364`). **Do not silently substitute the live delete in the existing unflagged command**: it would add credential deletion/default reassignment side effects.

Exact live grammar:

- `provider add P [existing fields plus --auth-mode MODE --responses-path PATH] --live --json` → POST `/api/providers` `{name,provider,setDefault?}`. Fetch target presets for canonical reserved provider seed; no local config mutation. Retain explicit `--force` overwrite intent. Existing POST is upsert: a read-before-post duplicate guard is not atomic create-only CAS; document that limit, do not claim a nonexistent server precondition.
- `provider set-default P --live --json` → standalone PATCH `{setDefault:true}`.
- `provider remove P --live --yes --json` → DELETE providers by name; server performs atomic default selection within its mutation path. Include removed credential scope in help/confirmation, and preserve dependentShadowIntercept/droppedCustomModels/catalogRefresh fields.
- `provider edit P --enabled on|off --json` is already management-backed; no new implementation needed for enable/disable. Do not overload adding `--live` on this already-live branch into a new transport selector.
- Reject `--live --sync`: live lifecycle endpoint already converges the catalog; broad local sync is a different action. Fix local `--sync --json` by running the requested local sync and reporting its actual returned/refused/skipped status; do not force it to `needsSync:false`.

### set-P10: logout

Both paths call `removeCredential`, which removes the active credential and chooses the next usable account under the store mutation lock (`src/oauth/store.ts:1093`). Local dispatch preserves useful removed/not-found semantics (`src/cli/dispatch.ts:425`). Store mutation persists and publishes account selection (`src/oauth/store.ts:828`), but publication uses in-process listeners (`src/lib/account-selection-events.ts:25`, `:36`); it is not a management cache-cleanup receipt.

Server logout additionally clears login state, model/inflight catalog caches, provider/account quota caches and Devin direct caches (`src/server/management/oauth-account-routes.ts:373`). This is a concrete source difference; no timing probe against user state is needed to choose the live path.

- `ocx logout P --live --json` → POST `/api/oauth/logout?provider=P`; no local credential read/remove first.
- Keep local `logout P --json` existing exit 4/removed receipt semantics. The live route returns `{success:true}` and is effectively idempotent for a missing credential; do not synthesize `removed:true` or local exit 4 from it. No server response extension is necessary for minimum GUI parity.
- Do not broaden login work in this crux. Browser preference/initial-login variants remain the separate P10/P20 parser gap already recorded.

## Exact file plan

New filenames below were checked absent at inspection time. Source files named existing must be extended narrowly; no shared transport framework is needed.

| Work slice | Existing files to edit | New files proposed | Smallest responsibilities |
|---|---|---|---|
| Custom live add/remove + local receipts | `src/cli/models.ts`, `src/cli/models-runtime-subcommands.ts` only if dispatcher contract needs it | `src/cli/models-custom-runtime.ts`; `tests/cli/cli-models-custom-runtime.test.ts` | Route explicit live add/remove before local config access; typed bodies/same-target ID resolution; JSON local outcome separation. Reuse existing `src/cli/models-runtime.ts` edit implementation. |
| v2 target/JSON contract | `src/cli/v2.ts`, `src/cli/dispatch.ts`, `src/cli/registry.ts` | `src/cli/v2-runtime.ts`; `tests/cli/cli-v2-runtime.test.ts` | Parse common flags once, reuse existing local functions, route live operations to `/api/v2`, project truthful receipts. Add mode-hint to root help. No agent.ts mode taxonomy. |
| Provider live lifecycle | `src/cli/provider.ts`, `src/cli/provider-runtime.ts` only for shared parser/dispatch seam, `src/cli/registry.ts` | `src/cli/provider-lifecycle-runtime.ts`; `tests/cli/cli-provider-lifecycle-runtime.test.ts` | Explicit live add/default/remove; fetch target preset; reject local sync combination; preserve offline behavior. Existing local JSON-plus-sync test updated in `tests/cli/cli-provider.test.ts`. |
| Live logout | `src/cli/dispatch.ts`, `src/cli/registry.ts` | `src/cli/logout-command.ts`; `tests/cli/cli-logout-runtime.test.ts` | Extract or wrap existing validated root grammar, add explicit live branch and injectable RuntimeApiDeps, keep local behavior. No new account logout alias required. |
| Discovery/contracts/docs | `src/cli/capabilities.ts`; `skills/ocx/references/03_recipes.md`; `structure/runtime.md`, `structure/config.md`, `structure/clients/chatgpt-desktop.md`, `structure/ops/docs-and-release.md` as affected by each slice | none required for transport | Declare existing/new leaf options and distinguish local/live. Main owns canonical output/error envelope work. |
| Test layout | `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` | none | Register every new test file in both maps. Avoid enlarging ratcheted `tests/codex-integration/codex-v2-gate.test.ts`; use focused new siblings. |

Verified ownership mapping is `structure/INDEX.md:124`: CLI is jointly owned by runtime/config/client-integration/desktop/docs-and-release documents. The file plan names the applicable existing owners; main should update only the affected invariants, following their nested instructions. No server source change is necessary to expose these existing routes. A future atomic create-only provider contract or richer logout removed receipt would be separate scope, not hidden in this roadmap.

## Source evidence versus required implementation proof

Existing test source confirms that these are real existing features, not names inferred from declarations: `tests/codex-integration/codex-v2-gate.test.ts:1641` covers hint write/clear; `:1661` covers nonblank whitespace preservation and missing/blank rejection; `:1742` covers v1/v2 thread-slot transitions. `tests/cli/cli-provider.test.ts:473` deliberately expects local default-provider removal refusal; `:680` pins JSON skip-sync. None were run in this pass.

The plan can be locked from source: a local sync and an HTTP catalog-only receipt have demonstrably different code paths; local versus live logout cleanup is explicit; provider removal side effects differ. Running those existing local tests would not establish cross-target live parity, so no scratch probe or test run was warranted merely to choose the roadmap.

Implementation gate (for main, not claimed complete):

1. Fake `RuntimeApiDeps.fetchImpl/baseUrl/findLiveProxy`, temporary home/auth context only, with every unexpected network call failing. Test target pinning across read/resolve/write and no local read/write on live refusal.
2. Custom add/remove: exact metadata/null/empty variants; UUID versus slug collision; created entry and saved/catalog failure receipts; unflagged local path unchanged.
3. V2: all seven live mappings above; strict unknown/trailing args before any mutation; hint null/blank cases; advisory omitted by default and true only by explicit flag; mixed live target local home remains untouched; server partial persistence/convergence outcome stays visible.
4. Provider: live default delete reassigns through one DELETE, offline continues to refuse; dependent combos and credential cleanup are handler authority; missing provider and disabled default errors; live --sync rejected; local --sync --json calls sync and keeps truthful skipped/refused outcomes. Never assert read-before-create is CAS.
5. Logout: live request never calls local removeCredential; server receipt preserved; local removed/not-found JSON/exit unchanged; mocked handler tests demonstrate cleanup functions invoked, not upstream calls.
6. Use existing nonzero/error-body machinery; parent-owned machine-envelope work must retain RuntimeApiError.body on partial/failed-convergence responses. A tool exit or 2xx alone is not proof that persisted state and live/client state all converged.

Remaining bounded limits: the existing CLI management target intentionally refuses a connected-client listener; dashboard remote relay equivalence is outside this change. Runtime receipts, target isolation and failure behavior remain to be tested during implementation. The transport choice and file plan no longer depend on an unexplained UNKNOWN.


# Operational parity target decisions

2026-10-03, bounded explorer follow-up. Repository root `the task checkout`; all source anchors are relative to that root. This artifact supersedes the target-dependent labels in `gaps-operations.md` for the rows below. Main owns roadmap and command conventions. No tracked files, live proxy, real credentials, upstream traffic, branch state or orchestration were touched. Two focused test files ran with pure/mock inputs; details below distinguish executed proof from inspected tests.

## Decisions ready for the roadmap

| Existing task IDs | Resolved classification | Decision and smallest command choice | Implementation boundary / source evidence |
|---|---|---|---|
| ops-C06 | IMPLEMENTATION_GAP for live desired-profile read; existing live status COMPLETE | Keep `ocx claude desktop show --json` explicitly local. Add **`ocx claude desktop profile show --json`**, a fixed GET `/api/claude-desktop` on the existing local management runtime. Invoke it on the hub host to inspect the Hub profile. Existing `desktop status --json` remains the applied-health read. | GUI receives sharedBase at `gui/src/App.tsx:584`, GET at `gui/src/pages/ClaudeDesktop.tsx:270`. CLI show builds disk state at `src/cli/claude-desktop.ts:790`; status uses live route at `:751`. `src/cli/runtime-api.ts:71` rejects a client-role listener and does not automatically authenticate to a Hub. Do not introduce `--url`, remote admin-token storage, or automatic relay login. |
| ops-C07, ops-C12 | IMPLEMENTATION_GAP for live save/import; existing local editing retained | Add **`ocx claude desktop profile import FILE --json`**, validates one bounded DesktopProfile and sends `{profile}` to PUT `/api/claude-desktop`. It saves only; use existing `ocx claude desktop apply --gateway` or `--first-party` separately. Existing local `move`, `default`, `import`, `export` retain current meaning. A file-based profile operation is a domain operation, not generic config editing. | `src/cli/claude-desktop.ts:203` writes only persisted local profile under connection/CAS guards; it does not adopt live server config. GUI PUT `src/server/management/agent-settings-routes.ts:907` validates routes, protects applied markers, performs conflict check and explicitly adopts live config at `:959`. Existing connected import --apply is refused at `src/cli/claude-desktop.ts:736`. New handler: small `src/cli/claude-desktop-profile.ts`, dispatch through existing `src/cli/claude-desktop.ts:676`; do not grow a second parser or change auth. |
| ops-S05 | COMPLETE for actual GUI task; discovery/output clarification only | **`ocx status --json`** already exposes `connection.selectedClients`; **`ocx sync`** on connected machine already runs the same domain sync. No `machine clients` command or journal inspection task is needed to match this GUI. | `gui/src/pages/Integrations.tsx:64` consumes only selectedClients; renders at `:137`. Although API also returns journalOwner/shim, that page does not display them. CLI projection `src/cli/status.ts:918` includes selectedClients. GUI machine API calls deps.sync (`src/client/machine-api.ts:94`), whose default is syncConnectedClient at `:30`; connected CLI uses syncConnectedClient at `src/cli/dispatch.ts:450`. No new remote transport. |
| ops-O08 | Existing client-self + Hub-total COMPLETE in their authorized execution contexts; IMPLEMENTATION_GAP for administrator selecting one key on Hub | Keep **`ocx usage ... --json`** on a connected machine as own-key data-plane usage, and the same command on the Hub host as whole-Hub management usage. Add only **`--api-key-id ID`** to `ocx usage` for the existing non-client management branch. Reject this option on connected client before reading secret/transport; do not forward it to `/v1/usage`. | GUI machine button adds apiKeyId; Hub button omits it (`gui/src/pages/Usage.tsx:1113`, `:1275`). Management API accepts filter (`src/server/management/logs-usage-routes.ts:243`). CLI branch `src/cli/observe.ts:188` uses stored enrolled data key + `/v1/usage` for client; local Hub uses `/api/usage` at `:209`. `/v1/usage` authenticates exact configured key, projects `scope:'client'`, rejects caller-selected identity and strips accounts (`src/server/hub-usage.ts:15`, `:25`; `src/remote/hub-usage.ts:8`). This intentionally does NOT promise remote Hub-total access using a client data key. |
| ops-I14 | IMPLEMENTATION_GAP for narrow invocation, not missing backend/helper | Add **`ocx integration client sync --client aside --json`**. No profile selector: GUI refreshes server-selected enabled profiles. Call existing **refreshAsideProfilesThroughServer**, preserving its direct-local attestation capability. Emit per-profile outcomes, and nonzero on any unsuccessful outcome; do not turn partial 207 into blanket success. | GUI uses exact POST `/api/client-integrations/aside/sync {}` at `gui/src/pages/integrations/aside-profile-api.ts:38`; owner `src/server/management/aside-profile-routes.ts:308`. Helper already exists in `src/cli/aside-profiles.ts:9`; capability transport at `:24`, `:50`; controlled baseUrl seam at `:69`. Current `ocx sync` first syncs Codex and other file clients, then calls helper at `src/cli/dispatch.ts:526`, so it is an effect superset with warning-only failure handling, not the narrow task. Add branch in `src/cli/integrations.ts:222` with lazy helper import; no new backend owner. |
| ops-O06 | Snapshot read COMPLETE; follow amendment semantics IMPLEMENTATION_GAP | Keep command **`ocx logs --follow --jsonl`**. Make this existing follow workflow cursor/reset aware and surface changed already-seen rows; don't invent a history endpoint. Minimal compatible JSONL choice: re-emit a row when its canonical payload changes, with same id; document consumers should upsert. Preserve duplicate IDs when server explicitly returns them, resets and removals; see exact output decision below. | CLI `src/cli/observe.ts:100` never sends cursor and suppresses any seen ID at `:108`. Server content hash deliberately sends reset for same-ID content changes (`src/server/request-log-cursor.ts:50`, `:57`, `:77`); GUI replaces snapshot on reset (`gui/src/pages/Logs.tsx:621`) and merges only valid deltas. Probe below proves the mismatch with actual cursor/parser modules and the exact source-equivalent dedupe predicate. |
| ops-D01 | IMPLEMENTATION_GAP for authenticated runtime-health projection | Add **`ocx system health --json`**, fixed GET `/api/system/health` via existing runtimeRequest, run on the serving runtime's host. Keep existing `ocx health` liveness contract and `system status` aggregate unchanged. | Endpoint returns status/service/version/uptime/pid/spendLedger at `src/server/management/system-routes.ts:66`. `ocx health --json` emits only ok/pid/port (`src/cli/dispatch.ts:787`); `status --json` emits health ok/url/message plus other machine state (`src/cli/status.ts:873`), not this projection; `system status` fetches only settings/startup/memory (`src/cli/system-command.ts:35`). New leaf in `src/cli/system-command.ts:193`; no new API or remote credential scheme. |

The Desktop additions are deliberately scoped to the currently serving **local management runtime**, which may be a Hub. Running them on a connected client should preserve the existing client-role refusal and guidance to run on the Hub. The connected browser's independently authorized shared dashboard session is not a CLI credential. Existing connected Desktop **apply** intentionally downloads the Hub's resolved Desktop model snapshot and writes the connected machine's gateway config (`src/cli/claude-desktop.ts:238`, `:260`); that is a separate target from editing the Hub's desired profile.

The GUI profile import stages a draft only (`gui/src/pages/ClaudeDesktop.tsx:480`) whereas a terminal import command naturally commits when explicitly invoked. This does not require implementing a persistent CLI draft editor: file inspection followed by explicit `profile import` and separate `apply` preserves the meaningful save/apply boundary. Reuse `parseDesktopProfile`; retain server's unavailable-model validation and trusted applied-marker handling. No automatic mode switch or apply is added to import.

## Exact follow-output choice

`ops-O06` is a workflow gap, not merely inefficient repeated polling. With a stable request id, CLI seen-ID dedupe loses later status/token/pricing updates even though `/api/logs` exposes them.

Smallest bounded change is to extract cursor/snapshot state into **`src/cli/log-follow.ts`** and call it from **`src/cli/observe.ts`**. It should:

1. Parse cursor/reset envelopes defensively. Legacy array/snapshot responses remain accepted and never manufacture a cursor.
2. Replace the local bounded window on reset; append suffixes otherwise. The server explicitly permits repeated IDs, so do not use an id-only set to represent the window.
3. Existing text/row-JSONL follow can re-emit changed rows; an explicit removed/reset event would be a different output contract. If deletion/reset visibility is required for exact machine reconstruction, add **`--events`** to follow and emit `{type:'snapshot',rows,cursor}`, `{type:'append',rows,cursor}` rather than silently breaking the existing row JSONL stream. This is the smallest additive exact-state option. No `--api-path` or new backend route.
4. Keep `--json` one-shot; `--follow --jsonl` streaming. Bound window/cursor sizes, handle interruption, and never claim an accepted stale snapshot is new data.

Recommended roadmap split: fix row amendments and cursor transport in existing follow; add `--events` only in the same reviewed output-contract unit if exact reset/removal projection is an acceptance requirement. GUI-to-CLI read parity must at least stop losing amendments. Full event schema is main's shared output-contract decision, not a new unresolved target/auth question.

## Duplicate settings tasks: use existing IDs

These are aliases for existing owner tasks, **not additional UNKNOWN roadmap rows**.

| Operations row | Canonical settings IDs | Why |
|---|---|---|
| ops-D18 multi-agent mode/thread/native behavior and advisory | **set-M13**, **set-S04** | Existing v2 root and advisory/local-live join belong to these rows; do not introduce another agent-mode taxonomy. |
| ops-D18 injection model/effort/guidance/default synchronization | **set-S03** | Same injection/default contract. Featured roster and fallback references, where rendered, map to **set-S01**, **set-S02**. Effort-cap metadata should be reconciled with this settings-owned unit, not counted again. |
| ops-O15 account/quota/active-selection reads in Tray | **set-A01**, **set-P09**, **set-P12**, **set-P14** | Codex readiness/quota plus generic OAuth/API-key roster. Usage/companion reads stay ops-O08/O10/O13. |
| ops-O16 Tray switches | **set-A04** (Codex), **set-P12** (OAuth), **set-P14** (provider API-key pool) | `gui/src/pages/tray-data.ts:36` selects these exact three route families. No tray-specific command. |

Canonical titles/IDs verified from `.tmp/cli-parity/gaps-settings.md`. These references are stable task identities; that artifact may continue gaining source evidence while main assembles the roadmap.

**Coverage expansion requiring main allocation, not a duplicate UNKNOWN:** the first inventory's D18 footnote also mentioned `MemoryModelsPanel` and `CompactionRoutingPanel`, but neither has a matching dedicated `set-*` row in the current 67-row settings join. They write `memoryModels` and `compactionRouting` through PUT `/api/settings` (`gui/src/components/MemoryModelsPanel.tsx:111`, `gui/src/components/CompactionRoutingPanel.tsx:180`); they are not injection or v2 fields and must not be falsely mapped to set-S03/M13. Parent should allocate these two field groups to its runtime/model settings unit before calling all dashboard fields closed. Exact values: memoryModels `{extract?:{...phase},consolidation?:{...phase}}|null`; compactionRouting `{model,reasoningEffort?,triggers?,sourceModels?}|null`. Existing system settings parser only handles autostart/stream-mode/desktop-authless/client-compaction (`src/cli/system-command.ts:123`), so generic `config set` would not establish live PUT parity. This pass does not create new set IDs or edit sibling artifacts.

## Accepted C4 data-plane unit

Parent explicitly accepted terminal model test, transcription and connection-only voice probe as tasks. **ops-K08/K12/K13 are included IMPLEMENTATION_GAPs**, not pending product scope. Browser microphone capture, playback widgets, copy buttons and waveform UI remain excluded. Authorization authority is unchanged.

| ID | Smallest command | Code/contract and proof requirements |
|---|---|---|
| ops-K08 | **`ocx access test MODEL --protocol responses\|chat\|messages --api-key-stdin --json`** | Keep existing access test grammar, add explicit chosen-key input. Current `src/cli/access.ts:255` uses runtimeRequest, whose headers start with management auth (`src/cli/runtime-api.ts:142`); that is not GUI newly-created-key proof. Use bounded `readSecretBytes` (`src/cli/runtime-api.ts:398`) with a 4096-byte key limit, strict UTF-8/single-line decoding, explicit TTY refusal, input deadline and returned-buffer cleanup and a dedicated fixed data-plane transport that sets only the chosen `x-opencodex-api-key`, never management bearer/header defaults. Existing no-flag test must not newly claim selected-key validation. |
| ops-K12 | **`ocx access audio transcribe FILE --model ID --api-key-stdin --json`** | Multipart file/model/response_format=json to fixed `/v1/audio/transcriptions`, bounded file size/deadline/body, abort on signal. GUI contract at `gui/src/audio-api-client.ts:13`; actual admitted route `src/server/index/serve-options.ts:1594`. Output transcript only by explicit task result, not incidental debug logging; no background retries that spend usage again. |
| ops-K13 | **`ocx access audio live-check --model ID --api-key-stdin --json`** | Fixed WebSocket `/v1/live?model=...`, same data-key subprotocol scheme and session.update/client-delegation settings as GUI (`gui/src/audio-api-client.ts:71`, `:88`). Wait for server session id/status, then session.close; bounded readiness/session lifetime. No microphone, audio uploads, delegation execution or auto-reconnect. Return connection outcome, not a claim of usable voice roundtrip. |

Recommended file boundaries: **`src/cli/access-data-plane.ts`** for fixed allowlisted HTTP test/transcription origin+headers+bounded response helpers, **`src/cli/access-audio.ts`** for the two audio verbs and WebSocket lifecycle; wire through **`src/cli/access.ts:274`**. These are domain-specific internal helpers, not an operator-visible arbitrary-URL request command. Reuse existing stdin/timeout/error primitives where safe; never call runtimeRequest for the chosen-key wire request.

Target resolution reuses current topology, not a new credential store: standalone/Hub use the existing local serving origin; connected client uses its already-enrolled normalized serverUrl, analogous to `fetchHubUsage` (`src/client/hub-client.ts:484`). The explicit key is still provided for this task through stdin; never implicitly substitute the enrolled key or admin token. Revalidate connection identity around an async read on connected clients and retain HTTPS-or-loopback, redirect refusal, safe headers, and origin policy. Do not add `--base-url`, token argv/env flags, token file caches, or a management-relay credential exchange in this unit.

For review, require fixture evidence for wrong chosen key, missing key, all three protocol shapes, explicit refusal when the target does not enforce the chosen key, no admin-header leakage, no redirects, no stderr/stdout secret echo, bounded file/body/session sizes, timeout/interruption and correct session.close. Existing auth/scope policy remains authoritative; adding a CLI cannot make a data key a management principal. All synthetic keys must stay fixture-only. The final 070 observational guard supersedes any unconditional chosen-key-enforcement assumption in this source proposal.

## Focused proof and proposed test placement

Executed, using only mocked/pure inputs:

- From repository root: `bun test gui/tests/log-poll.test.ts tests/clients/client-hub-usage.test.ts` — Bun selected **only the client file**, 16 pass / 0 fail / 40 assertions. Do not claim this invocation ran GUI tests.
- From `gui/`: `bun test tests/log-poll.test.ts` — 4 pass / 0 fail / 22 assertions. Covers legacy snapshots, reset metadata, malformed cursor rejection and repeated-ID preservation.
- A fileless `bun -e` probe imported actual `src/server/request-log-cursor.ts` and `gui/src/pages/log-poll.ts`, fed two snapshots `{id:'fixture-same-id',status:200,totalTokens:1}` then tokens=9, and applied the exact source-equivalent CLI `seen.has(String(row.id))` predicate. Output: **`{"serverReset":true,"guiAmendedTokens":9,"cliDedupeEmitted":0}`**. This is proof of cursor/parser behavior plus a source-level CLI predicate reproduction, **not execution of the whole CLI follow loop**.

Inspected only, not executed:

- `tests/claude-integration/claude-desktop-cli.test.ts:402` asserts connected show/export/move/default remain local and warn; `:280` asserts connected import --apply refuses before writing; `:501` asserts apply delegates profile to live owner.
- `tests/clients/aside-profile-sync-owner.test.ts:211` covers stale CLI refreshing only live-server-enabled Aside profiles; existing helper is the owner to reuse.
- `tests/server/hub-usage.test.ts:66` rejects absent/environment/admin keys for data-plane usage; `:76` rejects caller-selected identity; `:85` retains authenticated scope with bounds/filters. Executed client-side mocks additionally verify dedicated data key/no Authorization and dropping management-only DTO fields.

New focused files proposed (no edits made):

| Change | Proposed focused test file | Essential assertions |
|---|---|---|
| Desktop live profile show/import | `tests/cli/cli-claude-desktop-profile.test.ts` | Fixed GET/PUT shape, bounded parse-before-write, missing/invalid file zero write, 409 does not rebase, live adoption result, client-role refusal, existing local verbs untouched. |
| Runtime health read | `tests/cli/cli-system-health.test.ts` | Current runtime GET, version/uptime/pid/spendLedger preserved, remote/client refusal, no invented liveness success. |
| Usage admin filter | `tests/cli/cli-usage-scope.test.ts` | Hub query includes apiKeyId only when explicit; connected rejection before secret/transport; default connected self read unchanged; invalid connection fails closed. |
| Narrow Aside sync | `tests/cli/cli-aside-sync.test.ts` | Calls existing helper only, no Codex/other-client sync, no profile flag, partial outcomes nonzero, attestation refusal no fallback. Keep stale-owner test as server proof. |
| Log amendments/events | `tests/cli/cli-log-follow.test.ts` | Changed same ID, repeated IDs, valid suffix, reset/removal, legacy snapshots, malformed cursor, bounded state, interruption. GUI parser tests are not CLI coverage. |
| Data-plane chosen key/audio | `tests/cli/cli-access-data-plane.test.ts`, `tests/cli/cli-access-audio.test.ts` | Injected HTTP/WebSocket and fake stdin only; auth/secret/redirect/failure/cancel matrix above. No provider traffic. |

Any new test files must be registered in both repository layout maps under the existing AGENTS rule. Prefer these siblings over extending already-large legacy parity/desktop files. Exact-head integration/test execution and final receipt design remain main-owned.

Static receipt: 47 explicit source file/line anchors resolve; all 10 referenced set-* task IDs exist in the current settings join. Proposed new implementation/test paths are explicitly proposals and were not created.
