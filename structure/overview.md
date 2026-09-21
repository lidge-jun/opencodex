# Overview

Management provider-validation calls use the [shared relative send-path validation](config.md#provider-relative-send-paths) before persistence.
Native steering follows [the shared WebSocket contract](transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

The dashboard's compile-checked locale catalogs include Vietnamese. Locale registration, browser
detection, Compatibility Lab labels, status descriptions, and locale-sensitive quota formatting
advance together under the `gui/` catalog parity contract.

The configuration-only [plaintext V2 contract](subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

Shared parsing and streaming follow the [request-copy](transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](transports/byte-accounting.md#stream-buffer-accounting) contracts.

## Product boundary

opencodex is a local proxy for Codex. It does not patch Codex binaries. It changes local Codex
state by writing root routing keys and a model catalog — a provider table only in the
API-auth-header form described in [`config.md`](config.md) —
then serves the Responses data plane:

```text
Codex CLI / TUI / App / SDK
  -> http://127.0.0.1:<port>/v1/responses
  -> opencodex routing + adapter bridge
  -> upstream provider
```

Responses is the primary surface. The same listener also answers Anthropic-shaped `/v1/messages`
and OpenAI-shaped `/v1/chat/completions`. On the routed path those are inbound translations onto the
same routing and adapter bridge rather than separate products; `/v1/messages` additionally has a
native Anthropic passthrough branch that forwards without translation. The Live/Realtime surface is
different in kind — it resolves an OpenAI/ChatGPT relay and forwards to it directly, without the
adapter bridge.

`app/` contains the native macOS WidgetKit extension bundled into the Tauri desktop app.
`MenuBarCore` is its snapshot model/formatting layer; the desktop shell writes the
privacy-safe snapshot that the widget reads without network access. It is a client of
the management API, not part of the proxy — it adds no endpoint and changes no routing.
Treat it the way you treat `gui/`: it may consume what `src/` already exposes,
and a change that requires a new endpoint is a change to the proxy first.
Its persisted display contract is owned by `src/companion/`.

The default install keeps native OpenAI/ChatGPT passthrough working through one option-aware
`openai` provider. Pool is the default and selects across main plus added accounts; Direct uses only
the current caller/main login. `openai-apikey` explicitly selects API-key transport, and the two
credential routes never fall through into one another. Built-in provider presets include Anthropic,
Google, Azure, Neuralwatt Cloud, Tencent Cloud Coding Plan, SiliconFlow, and separate Volcengine Ark
pay-as-you-go, Coding Plan, and Agent Plan endpoints. Crusoe Serverless Inference is a fixed-host
API-key preset with registry-owned authenticated model discovery. Additional
providers are routed by explicit `provider/model`, provider model lists, or the configured
`defaultProvider`.

Native model retirement changes the advertised catalog and model-specific quota support; it
preserves saved user model selections and historical usage. See the bounded
[catalog policy](catalog.md#shared-catalog) and [legacy settings contract](config.md#config-surface).

> Decision record: [ADR-0001](decisions/ADR-0001-product-boundary.md)

## Local state

`~/.opencodex/` is the default state root and `OPENCODEX_HOME` overrides it; the GUI and the
installed service resolve it the same way (`src/config.ts`). Ownership inside that root is tracked
by the uninstall manifest in `src/lib/config-ownership.ts`, which starts from a declared path list
and grows as opencodex claims further paths at runtime — so the manifest, not this table, is what
bounds uninstall. Newly generated recovery backups follow the [backup ownership contract](config.md#restore)
without suppressing recovery when registration is unavailable. This table groups state by purpose; it is not an exhaustive file list, and
derived files such as `auth.json.pre-multiauth` are covered by the group they belong to.

`$CODEX_HOME` is a separate root with a separate owner, and opencodex writes there too: removing the
opencodex state root does not undo those writes. Putting native Codex back is the job of
`ocx restore`/`eject` and the injection journal, not of deleting a directory.

| Path | Owner | Notes |
| --- | --- | --- |
| `~/.opencodex/config.json` | opencodex | Init creates via private temp plus no-replace hard link; dashboard and explicit updates use atomic replacement. |
| `~/.opencodex/auth.json` | opencodex | OAuth tokens; not committed. Multiauth shape: `provider -> { activeAccountId, accounts[] }` (legacy single-credential values normalize on load; a one-time `auth.json.pre-multiauth` backup guards downgrades). ChatGPT scratch OAuth stays separate from the Codex account store. For multi-slot providers, credentials without `accountId`/email replace the active slot on a normal login; an explicit add-account login preserves the prior slot and appends a distinct one. Single-slot providers such as ChatGPT remain replacement-only. |
| `~/.opencodex/codex-accounts.json` | opencodex | Hardened main-plus-added credential store used by `openai` in Pool mode. |
| `~/.opencodex/catalog-backup.json` | opencodex | One-time pristine Codex catalog backup for restore; per-catalog copies are hashed variants (see [`catalog.md`](catalog.md)). |
| `~/.opencodex/usage.jsonl` | opencodex | Append-only request usage log (0o600); request metadata + token counts only, never prompts or auth. |
| `~/.opencodex/ocx.pid`, `runtime-port.json`, `system-env-port` | opencodex runtime | Live process identity and the port a client should reach; rewritten on start. `runtime-port.json` also carries the protected per-process listener-attestation key used before CLI diagnostics attach a management bearer. |
| `~/.opencodex/codex-runtime.json`, `codex-runtime-clamp.json` | opencodex Codex runtime | Selected Codex executable/version state and effort-clamp diagnostics. Not process identity: these persist a resolved choice and a diagnostic, so losing them changes behavior until re-resolved. |
| `~/.opencodex/service-state.json`, `service.log`, `service-api-token`, `opencodex-service-launcher.vbs`, `opencodex-service-task.xml`, `opencodex-service.cmd`, `winsw`, `tray-state.json`, `tray-heartbeat.json`, `opencodex-tray.ps1`, `opencodex-tray-*.ico`, `update-job.json` | opencodex operators | Installed-service, Windows tray, and self-update artifacts and bookkeeping. The update record carries its worker PID so a dead worker recovers instead of blocking later runs. |
| `~/.opencodex/responses-state.json`, `responses-state-spill/`, `usage-debug.jsonl`, `crash.log`, `artifacts/` | opencodex diagnostics and artifacts | Bounded caches, diagnostics, and generated image/video artifacts served locally. The spill directory holds continuation state demoted out of the in-memory cap and is bounded in aggregate, not only per file. |
| `~/.opencodex/codex-shim.json`, `*.lock`, `kimi-device-id`, `mimo-client-id`, `.star-prompted` | opencodex bookkeeping | Shim restore obligations, cross-process locks, per-install client identifiers, one-shot UI flags. |
| `~/.opencodex/.opencodex-owner.json`, `.opencodex-uninstall.json` | opencodex | Ownership marker and the manifest that bounds what uninstall may remove. Both live in the OpenCodex state root, not in `$CODEX_HOME`. |
| `$CODEX_HOME/config.toml` | Codex, edited by opencodex | Active provider and provider table. |
| `$CODEX_HOME/opencodex.config.toml` | opencodex | Optional profile for explicit Codex opt-in. |
| `$CODEX_HOME/opencodex-catalog.json` | opencodex | Shared native+routed model catalog. |
| `$CODEX_HOME/opencodex-journal.json` | opencodex | Injection journal used by restore to strip only marker-owned values while preserving later user edits. |
| `$CODEX_HOME/models_cache.json` | Codex, invalidated by opencodex | Cache invalidated after model/catalog changes. |
| `dist/`, `gui/dist/`, `node_modules/` | generated | Build output/dependencies. |

OrcaRouter login returns credentials for storage only after bounded response ingestion and payload
validation. The shared reader's cancellation contract and the login-specific byte/deadline limits
are defined in [bounded response ingestion](transports/inventory.md#bounded-response-ingestion-and-orcarouter-login).

## Non-negotiable invariants

Each invariant carries a stable id. A bound invariant names one test, and that test names the id
back, so deleting or renaming the test fails `bun run structure:check` instead of quietly unbinding the
rule. The binding proves the test EXISTS and is claimed; it does not prove the assertions inside it
still cover the rule, which is a judgement only review makes.

- **INV-WS-01** — `websockets` defaults to `false`; only `true` advertises `supports_websockets`.
  Enforced by `tests/codex-integration/codex-catalog.test.ts`.
- **INV-TOML-01** — Root TOML keys such as `model_provider` and `model_catalog_json` must stay
  before any table.
  Enforced by `tests/codex-integration/codex-inject.test.ts`.
- **INV-OPENAI-01** — OpenAI has one `openai` Codex-login provider with Pool(default)/Direct modes
  and a separate `openai-apikey`; see [`openai-tiers.md`](providers/openai-tiers.md).
  Enforced by `tests/adapters/openai/openai-provider-option.test.ts`.
- **INV-AGENT-01** — Codex `spawn_agent` visibility depends on the first five featured catalog
  entries.
  Enforced by `tests/codex-integration/catalog-full-picker-order.test.ts`.
- **INV-AUTH-01** — The management plane (`/api/*`) and the data plane (`/v1/*`) never share an
  admission credential.
  Enforced by `tests/server/server-management-auth.test.ts`.
- **INV-LAB-01** — The protected core entrypoints carry no load-time import chain into optional
  Lab code (static, side-effect, and re-export edges are walked transitively) and never name
  Lab even in a direct dynamic import; deferred lazy edges through non-Lab modules behind
  activation checks are the sanctioned pattern. Gated Lab activation also stays synchronous
  until `startServer` returns; see [`compatibility-lab.md`](adapters/compatibility-lab.md).
  Enforced by `tests/lab/core-lab-boundary.test.ts`.
- **INV-RESTORE-01** — `ocx restore` restores native Codex from the pristine catalog with
  retired bare/account-qualified native rows omitted from the output; the original backup stays
  unchanged. The service-stop and uninstall paths of the same promise are covered
  separately in `tests/cli/restore-completes-shared-teardown.test.ts` and are not bound to this id.
  Enforced by `tests/codex-integration/codex-catalog-restore.test.ts`.
- **INV-TESTS-01** — `tests/` is organised by domain (`tests/<domain>/`, mirroring `src/`); the map
  is `scripts/test-layout/layout.json` and `tests/test-layout.test.ts` rejects a test outside its
  domain. Only the two layout guards sit at the root. Source-oracle tests reach the repository
  through `tests/helpers/repo-root.ts`, never `import.meta.dir + "/.."`. Provider additions register
  their focused test in both the explicit layout map and its expected-map fixture.
  Enforced by `tests/test-layout.test.ts`.
- **INV-START-01** — `ocx start` never answers a busy preferred port by starting on another one. It
  identifies the holder first and stops either way: refused as a duplicate when an opencodex answers
  there, reported as an unidentified holder otherwise. A configured `port: 0` still asks the OS for a
  port, and an explicit `--port` still waits for its pin instead of hopping.
  Enforced by `tests/cli/cli-dispatch.test.ts`.
- **INV-RESEND-01** — One vocabulary states how far a failed request got, why it failed, and whether
  it may be sent again. The rosters are declared in the import-free `src/usage/telemetry-contract.ts`
  so the dashboard can name their members, and `src/lib/request-failure-model.ts` re-exports them and
  owns the decision. Once the caller has observed output or an externally visible effect, no cause
  automatically permits a resend, and a cause whose upstream execution state is unknown is not made
  replayable by having budget left. A refusal names which of the three refusals it is. The decision is
  derived from per-stage and per-cause facts rather than written out as a stage-by-cause matrix, so a
  new member cannot leave a stale cell.
  Enforced by `tests/lib/failure-stage-model.test.ts`.
- **INV-ATTRIBUTION-01** — `src/lib/request-failure-attribution.ts` derives the persisted failure
  stage and cause from closed recorder facts only, never from `errorCode` or `upstreamError`, which
  are assembled partly from upstream text. An unknown upstream execution state is attributed to a
  cause that refuses an automatic resend rather than to one that permits it, and the resend verdict
  the pair implies is computed at read time and never persisted.
  Enforced by `tests/lib/failure-attribution.test.ts`.
- **INV-RESEND-02** — One logical request holds one operator-granted replacement for an ambiguous
  failure, however many stages ask for it. `src/lib/request-resend-gate.ts` is the only place
  that override is applied, it claims the grant at the moment it authorises rather than earlier,
  and a stage the caller observed something at refuses without spending it. The grant never
  widens a send budget: an authorised replacement still has to fit the allowance the leg already
  had. The ceiling is the request's, not the asking leg's: a leg reads its number from the
  provider row it is currently running against, rotation, refresh, transport resolution and each
  combo target reassign that row, so the request keeps the smallest ceiling any leg presented and
  a more permissive row arriving later buys nothing.
  Enforced by `tests/lib/ambiguous-resend-gate.test.ts`.
- **INV-CHAT-01** — One developer-role policy governs the translated Chat wire and every document
  that describes it. `foldDeveloperRoleToSystem` unset and `true` send `system`, `false` sends
  `developer`, and the message never leaves the slot it arrived in. The documented sentence is
  built from the role the adapter serializes rather than written out again, and the translated
  pages are compared against their English source, so a changed default fails a check instead of
  leaving two documents to disagree; see [`chat-compat.md`](providers/chat-compat.md).
  Enforced by `tests/ci-workflows/docs-developer-role-policy.test.ts`.

CI enumerates that domain layout through `scripts/ci/run-bun-test-batches.sh`. Its default general
scope and 12-file/120-second process shape leave the dedicated Linux storage-policy and api-usage
jobs out of the general shards. The manual Windows matrix selects all-file scope and overrides the
process shape to six files and 480 seconds, so batching changes process size without changing the
platform suite's file set. Its dedicated batch step sets `OCX_TEST_NO_QUEUE=1`: those sequential
processes are one logical runner, while each process still installs its own isolated home and test
guards. The workflow contract and process bounds live in
[`ops/docs-and-release.md`](ops/docs-and-release.md#cross-platform-ci).

`structure/manifest.json` declares both source-review coverage and cross-cutting contract authority.
`scripts/structure-ssot.ts` validates that topology, and generated `structure/INDEX.md` publishes it.
The [structure rules](AGENTS.md#the-source-to-doc-map) define when review requires a content edit;
contract authority never reduces the source map's many-to-many review fan-out.

Two invariants are stated here without a binding, and `grace.unboundInvariants` in
[`manifest.json`](manifest.json) carries the reason for each. They are true statements about the system;
no test in this repository currently pins them, and saying so is more useful than naming a test that
would pass while the rule was violated.

- **INV-HOME-01** — `CODEX_HOME` wins over `~/.codex` when present and valid.
- **INV-SLUG-01** — Routed model slugs use `provider/model`.

Codex plan exclusions constrain automatic pool selection without deleting credentials; [account-policy reasons](providers/openai-tiers.md#automatic-pool-plan-exclusions) remain distinct from health and pause.

Connected CLI usage follows the [client-scoped hub usage contract](gui-and-management-api.md#usage-accounting); local management and account data remain separate.

The shared atomic replacement publisher also identifies explicit Remote Workspace file writes as `remote-workspace`; its isolated owner and support limits are documented in [Remote Workspace](remote-workspace.md).

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](remote-workspace.md) owns that integration.

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](gui-and-management-api.md#usage-accounting); readable totals are not represented as a complete ledger.

Listener startup diagnostics follow [the runtime lifecycle contract](runtime.md#lifecycle); malformed optional listener blocks follow [config loading](config.md#config-surface).
The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](gui-and-management-api.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](providers/openai-tiers.md#reset-first-account-ordering), including independent-quota fallback, preserved affinity, strategy-specific threshold summaries, and shared short-observation freshness for switch warnings.

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](transports/responses.md).

Raw reasoning content and provider-authored summaries remain distinct on the Responses wire. See [reasoning presentation](providers/chat-compat.md).

Connected-browser pairing and dashboard failure meanings follow the [management UI contract](gui-and-management-api.md#dashboard-surfaces); machine enrollment alone does not authenticate a browser.

Native-main reauthentication keeps its existing polling cadence when a non-2xx status races with retryable cancellation for the same owned flow; the [dashboard flow-ownership contract](gui-and-management-api.md#dashboard-surfaces) defines terminal release and completion notification.

Cline CLI is a managed file integration: its provider settings and catalog share one recoverable journal operation. The [paired-file contract](clients/integrations.md#cline-paired-files) defines its stop/restart requirement.
Pool quota producers and account commands follow the [bounded raw-observation contract](providers/openai-tiers.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

Account quota surfaces use [safe probe diagnostics](transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Translated Chat request construction uses the [inline-image budget](transports/streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached, rejects inputs above the safe decoded-pixel ceiling, caps native decode work process-wide, and stops queued work when the request is cancelled.

The [explicit model-capability contract](config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](gui-and-management-api.md#fast-selector-rows-setting).

Codex compaction can select a request-local model through the
[existing Responses handlers](transports/responses.md#compaction-routing-overrides) for the configured
manual and automatic triggers, while subsequent turns keep their conversation settings.
