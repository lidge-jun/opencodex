# GUI And Management API

The companion settings contract in `src/companion/` persists menu-bar and widget display
preferences, while `src/server/management/companion-routes.ts` exposes those settings and the
usage timeline assembled by `src/usage/timeline.ts` to local clients. Query, filter-echo and
missing-measurement behavior follows the [companion usage contract](companion.md).

Native result continuations and function-result injection follow [the mode-specific result and control contract](transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.
Explicit Codex CLI installation observation is a local CLI surface, not a management API or GUI update permission. See the [read-only observation contract](runtime.md#explicit-codex-cli-installation-observation).

Native steering follows [the shared WebSocket contract](transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

The shared server request path follows the Responses
[core module ownership](transports/responses.md#core-module-ownership). This surface retains its existing behavior. The configuration-only [priority failback](providers/openai-accounts.md#ongoing-priority-failback) preference adds no new dashboard control or account-eligibility override.

The configuration-only [plaintext V2 contract](subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged. Response-attached WebSocket telemetry follows the [stage record identity contract](transports/responses-wire-shapes.md#passthrough-sse-stream-shapes-314). Management provider-validation calls use the [initialization-independent relative send-path validation](config.md#provider-relative-send-paths) before persistence. Catalog HTTP acquisition follows the [proxy-routing contract](catalog.md#remote-catalog-http-proxy-routing). CLI installation inspection reason codes, including Windows deferral, follow the [runtime inspection contract](runtime.md#lifecycle).

The [Orca importer](codex-home.md#orca-source-owned-account-import) is a local CLI operation with
no management route. Imported accounts use existing quota validation; deferred warmups reread
linked sources after the quota await to reject revoked or rotated captures.

## Compact desktop usage

The standalone `/#/tray` GUI route presents local usage and account limits without the
full dashboard navigation. It reuses the existing API session and fetch wrapper; it
has no Tauri IPC capability. Companion settings control its sections and chart. Account
limits use account-level management reads rather than attributing aggregate provider
quotas to individual accounts. Missing usage is distinct from measured zero. The popup
shares the existing timeline renderer with the companion settings preview.
`gui/src/pages/tray.css` keeps the document/root within the viewport and gives the page its
own vertical scroll area. Long account lists can reach Refresh and Dashboard in both opaque
and vibrant web windows without scrolling a second outer document.

The macOS desktop uses a SwiftUI/AppKit panel for the same information, with transport owned
by the existing Rust desktop client; the native boundary is described in
[the desktop shell](desktop-shell.md#the-tray-icon-opens-a-usage-popup). Windows/Linux retain
the web route. The native panel introduces no management endpoint or credential surface.

## Dashboard serving

Account refresh actions follow the [credential refresh-lock identity contract](catalog.md#accounts-namespaces-and-pool-rotation): a held unreadable lock is distinct from one this process may release, and path-probe errors preserve the callback outcome. Cooperating lock metadata changes serialize through the existing SQLite mutation transaction; release keeps the descriptor open through identity comparison and any unlink, then closes it. Failed metadata writes remove only a matching owned path after successful coordination; unknown identity, failed probes or unavailable coordination retain the path for stale recovery. Async refresh work holds no metadata transaction. The bundled React dashboard is built into `gui/dist` and served by the same Bun proxy. `ocx gui` starts
the proxy when needed and opens `http://localhost:<port>`, or `http://127.0.0.1:<management port>` when `hub.managementIngress.enabled` is true — see [the hub management dashboard address](runtime.md#hub-management-dashboard-address).

Inside the Tauri shell, the sidebar and Dashboard maintenance update entries navigate to
the bundled desktop update page. The sidebar reads the session-scoped desktop badge;
an absent session remains unknown. Ordinary browser dashboards retain package badge and
`/api/update/check`/`/api/update/run`. No proxy route installs a desktop update.

All ordinary HTTP responses (excluding successful WebSocket upgrades) include `X-Frame-Options: DENY` and
`Content-Security-Policy: frame-ancestors 'none'`. This prevents another page from framing the local
dashboard or management responses. Embedding the dashboard in an iframe is intentionally
unsupported; deployments that previously relied on such embedding must open it as a top-level page.

## Authentication boundaries

OpenCodex uses three mutually exclusive reusable admission credential classes:

| Credential class | Sources | Allowed surface |
| --- | --- | --- |
| Data plane | `OPENCODEX_API_AUTH_TOKEN`, the `service-api-token` file loaded through `OCX_API_TOKEN_FILE`, and `config.apiKeys` | `/v1/*` HTTP endpoints and new data-plane WebSocket handshakes only |
| Management plane | `OPENCODEX_ADMIN_AUTH_TOKEN` or the independent protected `admin-api-token` file | `/api/*` only |
| GUI session | A short-lived token issued only with a legitimate same-origin local dashboard page | `/api/*` only, bound to the issuing origin |

The service token file remains a delivery mechanism for the data-plane environment token; it is not
a fourth credential class. A management credential that equals any configured data-plane credential
does not enable management access. The data plane may continue to start, but `/api/*` remains closed.
CLI health collection follows the same boundary without transporting the reusable management
credential. Its local-read HMAC capability is an additional single-use, route-scoped admission
mechanism, not a reusable credential class. `ocx doctor` and OAuth health derive these capabilities
from the protected `runtime-port.json` secret for exactly two read-only GETs:
`/api/codex-auth/accounts` and `/api/system/memory`. Each capability is bound to its method, path,
nonce, proxy PID, and port. A short expiry is part of the HMAC, and the server consumes each
capability once. A capability cannot authorize another management route or survive process
replacement. These probes connect directly to the selected listener instead of delegating local
identity to an environment HTTP proxy. Their output distinguishes a missing proxy, rejected local
capability, and an unexpected management response so a reachable `401` cannot be reported as
"proxy not running." Legacy or configured-port-only listeners still satisfy ordinary liveness, but
their detailed CLI health remains unavailable until restarted with an attested runtime record and
capability-aware server.

The desktop tray uses the same read-v1 contract for its fixed GET allowlist in
`src/lib/local-management-capability.ts`, including `/api/oauth/accounts` and
`/api/providers/keys`. Provider selectors and `quota=1` remain signed into the
exact query; these grants authorize no account or API-key mutations.

OAuth and API-key login use the same process-bound pattern for live provider
convergence without transporting provider credentials. After the CLI durably saves
`config.json`, it challenges the exact runtime listener and sends one bodyless
`POST /api/providers/reload` capability bound to the provider name, method, path,
nonce, PID, port, and short expiry. The server consumes it once, re-reads that named
provider from the protected disk config, and updates only live state; the request
contains no provider object, API key, OAuth value, custom header, reusable management
credential, or config digest. Both the proof and reload request use the direct local
transport so environment HTTP proxies cannot observe or fabricate the exchange.

> Decision record: [ADR-0073](decisions/ADR-0073-authentication-boundaries.md)

Management authentication never has a loopback bypass. If no management credential is available, or
management token creation, validation, or permission hardening fails, `/api/*` requests without a
valid scoped capability return 503 while `/v1/*` and unauthenticated `/healthz` continue to operate.
Windows ACL hardening results must be checked explicitly because an `icacls` timeout is a soft failure in the shared secret helper.

Local dashboard page entry requires a loopback binding, a valid parseable loopback `Host`, and an
exact request origin. A hub may additionally enable `hub.managementIngress`, a second management
surface bound exactly to `127.0.0.1` for a local Tailscale Serve or operator TLS frontend. That
listener serves only packaged GUI/SPA routes, `GET`/`POST /opencodex-session`, and `/api/*`; all data,
health, readiness, WebSocket, and unknown-static routes receive a JSON 404 before dispatch.

Tailscale identity headers authorize session issuance only when the request arrived on that specific
listener and the exact login appears in `remoteGui.allowedTailscaleUsers`. The public listener and
the unauthenticated data-loopback listener always pass `trustedTailscaleIngress: false`, regardless
of `Host`, `Origin`, `Forwarded`, `X-Forwarded-*`, or `Tailscale-User-*` values. A generic TLS proxy
cannot establish that identity and uses the existing single-use, digest-only, origin-bound pairing
exchange. Pairing accepts no admin/data credential substitute and consumes a grant only after the
full origin predicate succeeds.

The server issues a local in-memory session for five minutes or a remote session for twelve hours,
with 128 live sessions maximum. Every session is bound to the exact server and browser origins;
state-changing requests additionally require the session CSRF token. A raw admin token remains
ordinary management authority only and cannot satisfy consent routes. The dashboard never attaches
its management session to `/v1/*` requests, and pages containing a session bootstrap are served with
`Cache-Control: no-store`.

Proxy admission credentials must never reach an upstream provider. The forwarding guard rejects the
`ocx_data_`, `ocx_admin_`, and `ocx_session_` prefixes, historical keys matching
`^ocx_[0-9a-f]{40}$`, both environment tokens by constant-time comparison, and manually configured
data keys by constant-time comparison.

Admission records HOW the credential was presented, not only which one matched
(`DataPlaneAdmission.source`: `loopback | dedicated | bearer | x-api-key`). The Responses and Chat
transports accept a bearer that is one of our own admission secrets; the dedicated header still
wins when both are present, and `x-api-key` is still refused there. That admission is safe only
because `materializeCodexUpstreamAuth` SUBSTITUTES the stored main credential for it and throws
before any upstream I/O when none is usable — the forwarding guard is NOT relaxed, and widening
admission without guaranteed substitution would create exactly the leak it prevents. A bearer that
is not one of our secrets stays unadmitted and remains Codex Direct passthrough, so the two bearer
domains never mix.

Audit item #16 remains partially deferred. This credential split protects new WebSocket handshakes,
but the following established-connection controls are intentionally outside this batch and must not
be treated as implemented:

- revoke an already established connection when its data key is deleted;
- enforce an idle timeout;
- reauthenticate subsequent frames after the handshake.

## API ownership

API-key PATCH validates the entire rename/scope patch on a detached entry before replacing live configuration. A rejected field changes neither the existing name nor either scope, including a later unrelated save.


The provider editor admits `googleToolSchemaPolicy` as an editor-safe, non-secret field. Its value
is validated as `compatible` or `reject-lossy` before live adoption and persistence; an invalid
value changes neither state. Omission remains absent and is resolved by the Google adapter rather
than materialized by the management API.

`GET /api/providers` reports `upstreamWebsocket` as configured rather than coerced, and omits the
key when it is unset: on the canonical `openai` row an absent value already means the upstream
WebSocket transport, so answering `false` there would let a save that round-trips the row write
that disable back to disk.

`src/server/index.ts` authenticates and routes `/api/*`, then delegates to
`src/server/management-api.ts`, which composes the route modules under `src/server/management/`.
Codex account routes live in `src/codex/auth-api/routes.ts` because they own the credential store, not
because they are a different plane. Upstream account response reads and OrcaRouter key exchange follow the [bounded ingestion contract](transports/inventory.md#bounded-response-ingestion-and-orcarouter-login).

The registered route set is larger than the areas described below; the code is the route SOT. What
this document owns is which module holds which area and what invariant that area must not break.

`GET /api/native-integrations` reads the Codex, Grok and Claude Desktop desired switch states from persisted configuration because those toggles write intent independently of the server's startup config snapshot; every other field still comes from that snapshot, and without a config file the snapshot's own intent stands. The dashboard can therefore refresh a switch immediately after a successful toggle while its routing badge remains based on observed routing. The Codex row reports the state its latest toggle in this process reported while the persisted intent still matches it, so a skipped or failed enable stays `absent` and an incomplete restore stays `unsafe` instead of being re-derived from intent alone.

| Endpoint area | Responsibility |
| --- | --- |
| Config/settings | Read safe config/settings views; mutate supported settings only. Full `PUT /api/config` is disabled so masked secrets are not round-tripped. `PUT /api/settings` accepts `codexAutoStart`, `streamMode`, integer `appOwnedMemoryBudgetMb` (64..4096), strict boolean `codexAccountPickerEnabled`, strict boolean `fastRows`, and a validated per-account `codexQuotaAutoRefresh` toggle (each optional, at least one required). `fastRows` defaults on when absent: false is persisted, true deletes the key, and successful writes echo the effective boolean. An effective change converges the Codex catalog and refreshes enabled or already-owned client integrations after persistence. Picker enable initializes an empty UI-managed selector map, persists before one bounded catalog convergence, and reports only `catalogRefreshPending`; allocation/save failure restores every touched live field and skips convergence. Budget changes synchronously enforce the process-wide evictable retained-state cap; this is separate from RSS/native memory. `streamMode` persists the #314 stream-shape selection in config.json (Windows services need persisted input; macOS eager relay is explicit-only). |
| Startup safety | `GET /api/startup-health` reports whether injected Codex routing is restart-safe, with secret-free service/shim diagnostics. `POST /api/startup-action` provides allowlisted one-click installation for the background service or launcher shim. On Windows a healthy script shim is CLI-only; Codex Desktop requires the background service for full protection. |
| Windows tray | `GET/POST /api/windows-tray` controls an owned, per-user HKCU login tray. The tray delegates fixed actions to the CLI and is never a proxy supervisor or restart-protection signal. |
| Updates | `GET /api/update/check`, `POST /api/update/run`, and `GET /api/update/status` own dashboard self-update state. A launched worker PID is persisted in `update-job.json`; dead PIDs recover immediately, while legacy active records without a PID recover only after ten minutes. Live PIDs remain exclusive regardless of record age. `GET /api/update/check` and `POST /api/update/run` await one per-channel asynchronous registry lookup and write successful results through to the package cache; run passes that result to the job starter. `GET /api/update/badge` only reads the cache and reports unknown after 40 hours, on missing cache, or on channel mismatch. The badge links to the update surface rather than gating other actions. `GET /api/update/badge?surface=desktop&session=<id>` projects only that process-local Tauri session; missing or expired state is unknown and never falls back to the package cache. `POST /api/update/desktop-snapshot` is a 1 KiB bounded display-state mutation with no install permission. It accepts the existing admin-token principal or a dedicated single-use, ten-second snapshot capability bound to nonce, method, path, PID, port and the SHA-256 digest of the exact body bytes; that capability cannot authorize another route. |
| Providers | Create/update/delete ordinary provider configs and enrich registry metadata. A `POST /api/providers` overwrite of an existing name keeps the five operator compatibility settings (`PROVIDER_COMPAT_CARRY_FIELDS` in `src/server/management/provider-overwrite-carry.ts`) and the stored key pool only while the destination (adapter, normalized base URL, auth mode when named) is unchanged; it never merges the rest of the old row. `PATCH` is a field mask and keeps every field it does not name. The reserved `openai` card exposes Pool(default)/Direct account mode; `openai-apikey` remains the separate API route. |
| Models | Fetch routed model lists, disabled model visibility, and catalog-facing ids. New non-OAuth registration holds exposure until authoritative discovery; 20 or more distinct switch rows start OFF without disabling the provider. Pending rows cannot accept visibility changes. |
| OAuth | Login/status/logout for OAuth-backed providers, plus multiauth account management: `GET /api/oauth/accounts`, `PUT /api/oauth/accounts/active`, `PUT /api/oauth/accounts/alias`, `DELETE /api/oauth/accounts` list masked accounts per provider, switch the active one, edit its display-only alias, and remove one. The login flow itself is `GET /api/oauth/providers`, `POST /api/oauth/login`, `POST /api/oauth/login/code`, `POST /api/oauth/login/cancel`, `POST /api/oauth/logout`, and `GET /api/oauth/status`; pool controls are `GET/PUT/PATCH /api/oauth/accounts/pool` and `POST /api/oauth/accounts/clear-cooldown`. Login accepts `addAccount: true` to force a fresh browser identity. Meta Muse login start and manual-code continuation require the server-resolved `gui-session` principal before credential acquisition or code submission (including reauth); see the [provider contract](providers-and-adapters.md). Device flows return a structured `deviceCode`; the GUI highlights and copies it before the user opens the verification page. |
| Key providers | `GET /api/key-providers` exposes API-key provider presets for setup and dashboard flows, and `GET/POST/DELETE /api/keys` owns the proxy's own admission keys. Machine links live in `src/server/management/link-routes.ts`: paired dashboard sessions reach `GET /api/link/candidates`, `POST /api/link/probe`, `POST /api/link/confirm-host` and `POST /api/link/apply`; `GET /api/link/status` and `DELETE /api/link/{id}` also accept the admin token on a trusted loopback ingress; `POST /api/link/issue` accepts only that admin token. Tailscale-identity sessions are refused on every link route. See [Remote Link](remote-link.md). Multi-key pool per key-auth provider: `GET /api/providers/keys`, `POST /api/providers/keys`, `PUT /api/providers/keys/active`, `PUT /api/providers/keys/alias`, `DELETE /api/providers/keys` masked list, add (upsert + activate), switch, rename, and remove keys. `provider.apiKey` always mirrors the active pool entry so routing stays single-key. |
| OpenAI account mode | Report one OpenAI Codex card with Pool/Direct controls and one API-key card. Mode PATCH persists live without restart or catalog identity changes; Pool owns account/quota controls and Direct uses caller/main login only. Main-account DTOs report real credential presence and terminal `needsReauth` state instead of treating missing/invalid native auth as an unknown quota. Selection order has its own route: `PUT /api/codex-auth/accounts/priority` takes `{ id, priority }`, where `priority` is an integer -100..100 or `null` to restore the default, accepts `__main__`, 404s an unknown id, and echoes the stored value. Re-ordering never clears thread affinity, so the response carries no `appliesImmediately`, but it does release any pin — see [`openai-tiers.md`](providers/openai-tiers.md) for why. `PUT /api/codex-auth/active` with a null id releases one too, but that drops the operator's account selection along with it, so this route is the only operator-facing way to clear a pin while leaving the selected account in place. `GET /api/codex-auth/active` reports `pinned`, true only while the manually selected account is still the effective active one, plus `pinnedAccountId`, which names the pinned account whether or not it is the active one. Surfaces should render `pinnedAccountId`: under round-robin and fill-first the pin caps the tier ceiling at its own tier while the strategy cursor moves freely inside that tier, so `pinned` goes false on a sibling's turn even though the pin is still suppressing every higher tier — which is why the dashboard badges `pinnedAccountId` and the GUI controller tracks only the id. `pinned` answers the narrower question of whether routing is *currently* on the operator's choice; no surface in this repo asks it, and a new one almost certainly wants the id instead. |
| Subagents | Read/write the featured `subagentModels` list capped at five ids. `GET/PUT /api/injection-model` manages the shared delegation model/effort selection, the independent OpenCodex guidance switch, and the default-off `syncCodexSubagentDefaults` opt-in for native Codex subagent defaults. When OpenCodex owns the active Codex routing, native `[agents]` defaults apply to newly created Codex tasks after sync/restart; external user-managed provider configs remain untouched. The defaults do not cause delegation and preserve existing user-owned defaults rather than overwriting them. PUT is partial-update: absent keys are unchanged, `null` clears, and non-object bodies are rejected with 400 before field validation. `syncCodexSubagentDefaults: true` requires a nonblank `model` and a supported Codex reasoning effort when effort is set; clearing `model` (null/empty) always clears effort and disables native-default sync even when the stored effort was invalid. |
| V2 / Multi-agent mode | `GET/PUT /api/v2` — reports/sets the codex `multi_agent_v2` feature flag, the 3-state `multiAgentMode` override (`v1`/`default`/`v2`), the `keepNativeChatGptOnV1` hybrid pin, and the logical maximum thread count. Selecting `v2` normally enables the native flag; with the hybrid pin it disables that global override so native rows can resolve to v1 while routed rows resolve to v2. Selecting `v1` disables the flag; `default` leaves it unchanged. PUT rejects an explicit enabled flag that conflicts with the selected mode or hybrid pin. Every transition preserves the logical thread limit, is rollback-safe, and resyncs the catalog. GET and successful PUT also return stored `multiAgentModeHintText` plus response-only `multiAgentModeHintRecommendation: { text, revision }`; the recommendation is not a writable or persisted config field. Both also return response-only `multiAgentSurfaceAdvisory: { required, mode, recommended, version, docsUrl }`, true while the resolved mode is not v1 and the stored acknowledgement version is behind; PUT accepts `multiAgentSurfaceAdvisoryAcknowledged`, where only `true` stores the current version and `false` is an explicit no-op, and it composes with a `multiAgentMode` write in the same body so the dialog's recommended answer is one request. |
| Logs & Debug | One sidebar entry (`/#logs`) with two tabs. Logs tab: request/runtime logs for local diagnosis. `LogsFilterBar` owns controls over the shared `LogFilterState`; `filterLogs` composes filters over the loaded ring. The logs envelope adds `generatedAt` (proxy epoch milliseconds); the page advances that sample with monotonic elapsed time and retains a browser-clock fallback for older proxies. Reset returns focus to the stable All surface radio. Provider/model options include attempts, model choices match normalized complete identities, and relative-time filtering refreshes every 30 seconds while the Logs tab is active, independently of network auto-refresh. Debug tab (`/#logs/debug`; legacy `/#debug` deep links redirect there): provider + usage toggles, refresh/follow log viewer. `GET/PUT /api/debug`; `GET /api/debug/logs` and `GET /api/debug/usage-logs` (monotonic `after` cursor, legacy `since` accepted). CLI: `ocx debug provider|usage …` (both streams via running proxy API). |
| Usage | `GET /api/usage` read-only aggregates of readable rows from `~/.opencodex/usage.jsonl`; the ledger is streamed in fixed 1 MiB chunks, so the former read-byte and parsed-row caps cannot omit its prefix. Oversized skipped rows produce positive `usageIncomplete` metadata. The response includes measured / reported / unreported / unsupported / estimated counts, a daily zero-filled grid, and model and provider breakdowns. `GET /api/usage/timeline` uses the same ledger and canonical attribution helpers for bounded bucketed model series. Never exposes prompts. |
| Request metrics | `GET /api/metrics` exposes process-local Prometheus text format v0.0.4 only when `metricsExport.enabled` was true at startup. The ordinary management gate applies; data-plane credentials do not grant access, and disabled mode is 404. `src/server/request-metrics.ts` owns fixed counters/histograms and receives a narrow final-request fact from `src/server/request-log.ts`; `src/server/index/serve-options.ts` creates one owner and injects the recorder and read-only snapshot into the request and management paths. |
| System | `POST /api/system/restart` restarts the proxy in place. Local CLI/tray callers first attest the exact runtime PID and port, then send a process-scoped HMAC capability bound to that method, path, PID, and port; the capability authorizes no other management route and is invalid after replacement. The caller observes one absolute deadline and accepts success only after a different runtime PID is healthy on the same port. `GET /api/system/health` is the authenticated scalar-only identity used by shared-plane Dashboard status and restart reconnect polling; its `spendLedger` block reports only ownership held/unheld, initialized/configured/degraded booleans and bounded persistence/corruption counters. Reading it never constructs, replays or prunes the ledger. Paths, scopes, accounts and request ids are absent, and the block never moves to unauthenticated `/healthz`. `GET /api/system/memory` — service-process runtime/memory identity (pid, Bun version/revision, optional `bunRuntimeSource` provenance, platform, RSS/heap/external/ArrayBuffers scalars, observed memory = max(RSS, external, ArrayBuffers), `bun:jsc` heap context, streamMode + eager-relay gate decision, watchdog snapshot sliced to the last 60 samples) plus privacy-safe `appOwnedBytes` retained-store totals/counters under static store ids. Its response-state block also reports spill-write `initial`/`healthy`/`degraded` status, a consecutive-failure streak, fixed error class, and failure/success timestamps. A successful publication clears the streak in the same process; raw error text and paths never enter this surface. Scalar-only payload; dashboard/admin callers use the standard management gate, while `ocx doctor` may use only the exact process-scoped local-read capability. It must never move to unauthenticated `/healthz`. |
| Stop | `POST /api/stop` — restore native Codex, stop any installed service, and exit the proxy. |
| Diagnostics/sync | `src/server/management/config-routes.ts` — `GET /api/diagnostics/project-config` reports project-level Codex config that bypasses managed routing; `POST /api/sync` re-runs catalog/config sync. The diagnostic reports the bypass; it does not rewrite the project file. |
| Sidecar/shadow-call settings | `src/server/management/config-routes.ts` — `GET/PUT /api/sidecar-settings` and `GET/PUT /api/shadow-call-settings`. PUT accepts model and backend (web-search union: openai/anthropic/xai/gemini/exa; xAI is live through stored Grok OAuth, while Gemini/Exa remain inert until their executors ship) plus validated `webSearch.xSearch`, optional `webSearch.exaApiKey` (write/clear only — never echoed by GET or the PUT response; redact.ts strips it from logs), `webSearch.reasoning`, `vision.reasoning`, `vision.enabled`, `vision.maxDescriptionsPerTurn`, and `vision.timeoutMs`; the read and PUT-response payload reports model, backend, reasoning, enabled, the vision per-turn limit, and timeout. `timeoutMs` is validated against the runtime integer bounds in `src/vision/timeout-bounds.ts`. Provider/OAuth credentials live in their stores; `exaApiKey` is the one sidecar-owned secret and follows the write-only contract above. Both shadow-call responses also report the resolved `sourceModels` — the prefixes the runtime actually intercepts (`src/lib/shadow-call.ts`, default `gpt-5.6-luna`; the retired `gpt-5.4-mini` stays available as an explicit `sourceModels` entry for 0.144.x clients), so no client hard-codes a helper slug that a Codex release can invalidate. PUT refuses a qualified target that only the router's default-provider fallback accepts. Provider disable and delete report the target they leave behind as `dependentShadowIntercept` (`shadowInterceptProviderDependency` in `src/server/management/shadow-call-validation.ts`), and at request time an unresolvable target returns `409 intercept_target_unavailable` before any send (`src/server/responses/shadow-target-availability.ts`); it never falls back to the native source model or the default provider. |
| Storage | `src/server/management/logs-usage-routes.ts` — `GET /api/storage`, `POST /api/storage/cleanup/preview` and `/api/storage/cleanup`, `GET /api/storage/trash`, `POST /api/storage/trash/restore`, and `GET/PUT /api/storage/cleanup-policy` plus `POST /api/storage/cleanup-policy/run`. `GET /api/storage/cleanup-policy/test-stream` and `GET /api/storage/trash/restore/test-stream` exist for progress-stream testing. Cleanup takes an explicit `mode`: `quarantine` moves to trash and is restorable, `permanent` is not. The caller must name the mode — there is no default that silently deletes. |
| Provider quotas and tests | `src/server/management/provider-routes.ts` — `GET /api/provider-quotas`, `POST /api/providers/test`, `GET/PUT /api/provider-context-caps`, `GET /api/provider-presets`. A quota read may be served from cache or force-refreshed; absent quota data is reported as unknown rather than as a measured zero. |
| Models and visibility | `src/server/management/model-routes.ts` — `GET /api/models`, `PUT /api/disabled-models`, `PUT /api/model-visibility`, `PUT /api/selected-models`, `GET/POST /api/custom-models`. Visibility writes trigger catalog sync through the owning server path. |
| Effort and fallback | `src/server/management/agent-settings-routes.ts` — `GET/PUT /api/effort-caps`, `/api/subagent-models`, `/api/subagent-model-fallback`. Caps clamp; they do not reject. |
| Grok and Claude integrations | `src/server/management/agent-settings-routes.ts` — `GET /api/grok`, `PUT /api/grok/selection`, `POST /api/grok/apply`, `GET/PUT /api/claude-desktop`, `POST /api/claude-desktop/apply` (`mode`: `gateway` default for new installs, `first-party` opt-in, or legacy shapes), `GET /api/claude-desktop/status` (`mode`, `riskWarning`, `firstParty`), `GET/PUT /api/claude-code`. Gateway apply writes an external app's profile, so its status probe must read the same resolved path it writes (see [`responses.md`](transports/responses.md)); first-party apply writes only the Claude Code proxy env, see [`clients/claude-desktop.md`](clients/claude-desktop.md#desktop-modes-gateway-and-first-party). `gui/src/pages/ClaudeDesktop.tsx` renders the mode selector and sends the chosen `mode` with apply. `PUT /api/claude-code` re-runs macOS system-env reconciliation (`src/server/system-env.ts`) whenever the body carries `systemEnv`, `authMode`, a model slot or a lever field: keys opencodex tracks as injected are refreshed or unset once the config stops producing them, and a launchd value the user set before injection is never touched. |

| File-integration plans | `src/server/management/integration-routes.ts` and `aside-profile-routes.ts` — `POST /api/client-integrations/preview`, `POST /api/client-integrations/restore/preview`, and `POST /api/client-integrations/aside/profiles/{profileId}/preview`. Management-authenticated, declared non-mutating, and they write nothing: no snapshot, no lock, no maintenance, no recovery. They answer `409 integration_preview_unavailable` rather than gathering a model roster, because discovery refreshes credentials and writes the provider cache. Responses carry only declared managed schema paths, closed change kinds and an opaque fingerprint; no value, filesystem location or selected member identity appears. Mutation routes accept `operation` and `planFingerprint` together or not at all, reject a half-bound request and an operation that disagrees with the change, and answer `409 integration_preview_stale` with a freshly computed plan. Binding is an optimistic token, never authorization. [The integration contract](clients/integrations.md) owns the ordering. |
| Grok reset coupons | `src/server/management/grok-coupon-routes.ts` — `GET /api/grok/reset-coupons`, `POST /api/grok/reset-coupons/consume`. The dashboard owner is `gui/src/hooks/useGrokResetCoupons.ts` with `gui/src/components/provider-workspace/GrokResetCoupons.tsx`, wired into the xAI OAuth rows of `ProviderAuthPanel`. Redemption truth is the settled ledger `code`, not the HTTP status: a replayed failure returns 200 with `replayed: true`. See [`providers/xai-grok.md`](providers/xai-grok.md). |
| Claude reset grants | `src/server/management/anthropic-reset-grant-routes.ts` — `GET /api/anthropic/reset-grants`, `POST /api/anthropic/reset-grants/consume` (lazy-loaded). Wire and fail-closed parsing live in `src/providers/anthropic-reset-grants.ts` (the Claude Code 2.1.278 `cedar_ember` contract, sent with `CLAUDE_CLI_USER_AGENT` from `src/providers/claude-cli-identity.ts`); the journal is `src/providers/anthropic-reset-grant-ledger.ts`: a cross-process `BEGIN IMMEDIATE` lock around every synchronous read-modify-write, a 90 s lease, the operation id reused as the upstream `request_id`, same-id retry only inside the vendor's ten-minute window, no settlement inferred from a re-read, and a fail-closed `500 journal_write_failed` when an answer cannot be recorded. Spending requires the `gui-session` principal. The dashboard owner is `gui/src/hooks/useAnthropicResetGrants.ts` with `gui/src/components/provider-workspace/AnthropicResetGrants.tsx` on the Anthropic OAuth rows of `ProviderAuthPanel`; after an unknown outcome the dialog only retries the same id. Design and audit record: [`../devlog/_plan/260923_claude_reset_grants/010_plan.md`](../devlog/_plan/260923_claude_reset_grants/010_plan.md). |
| Combos | `src/server/management/combo-routes.ts` — `GET/PUT/DELETE /api/combos` own provider combination and failover definitions. `PUT` keeps a stored field the body omits (`cooldownMs`, `waitForCooldownMs`, `defaultEffortMode`, `reasoningEffortMode`, `imageInput`, `cooldownWaitPolicy`, per-target `lastResort`); explicit values replace it and defaults are stored sparse. |
| Protocol paths | `src/server/management/protocol-routes.ts` (lazy-loaded) — `GET /api/protocols` returns the contract version, the resolved API surfaces and protocol settings, the policy revision and the feature vocabulary; with `?provider=<name>` (one non-empty name of at most 200 characters without control characters, else 400 `invalid_provider`; an unconfigured name is 404 `unknown_provider`, neither echoing the name) it adds a `provider` block from `src/protocols/provider-summary.ts` ([Protocol Paths](data-planes/protocol-paths.md#provider-wire-summary)); `POST /api/protocols/plan` takes `{ model, inbound, features? }` (model at most 200 characters, at most 24 features, any other key refused with 400) and returns a `ProtocolPlanV1` with `basis: "preview"` from `src/protocols/plan-snapshot.ts`. Both are read-only, never log their input, and send nothing upstream. `PATCH /api/protocols/settings` takes `{ messagesEnabled?, unrepresentable?, rollout? }` (strict: unknown keys and wrong types are 400), validates and applies through `src/server/management/protocol-settings-patch.ts`, persists with `saveConfigPreservingClaudeCode`, restores the live config if the save fails (409 on lock contention, 500 otherwise), and answers with the fresh `GET /api/protocols` body; closing Messages also writes `claudeCode.enabled = false` through `commitClaudeCodeBlock` ([Protocol Paths](data-planes/protocol-paths.md#settings)). The CLI drives all three through `ocx api protocols`, `ocx api explain` and `ocx api policy` ([Protocol Paths](data-planes/protocol-paths.md#cli)); none carries a route-registry exemption. |
| Workflow budget | `src/server/management/workflow-budget-routes.ts` — `GET /api/workflow-budget` reads the tracked roots or one root, and `POST /api/workflow-budget/clear` clears exactly one. The clear moves the windowed send ring and the child map and nothing else: `active` belongs to turns still in flight, the spend ledger is a token budget an operator did not ask to forgive, and the lifetime send total survives so a clear cannot launder the record. A refusal event carries `spendScope` and `spendLimit` when a token ceiling fired, so the reason is readable without the config open beside it; no scope id is ever attached, because root ids are client thread headers and identity ids are credentials. Both are `deferred-verb` in the route registry — they are owed CLI verbs, and because the ledger is process memory there is no local projection the CLI could read instead. See [`../devlog/_plan/260915_workflow_budget_window/030_wfc_diff_plan.md`](../devlog/_plan/260915_workflow_budget_window/030_wfc_diff_plan.md). |
| Codex accounts | `src/codex/auth-api/routes.ts` — `GET/POST/DELETE /api/codex-auth/accounts`, `PUT /api/codex-auth/accounts/alias`, `PUT /api/codex-auth/accounts/pause`, `PUT /api/codex-auth/accounts/pause-exhausted`, `POST /api/codex-auth/accounts/clear-cooldown`, `GET/PUT /api/codex-auth/active`, `PUT /api/codex-auth/auto-switch`, `PUT /api/codex-auth/pool-strategy`, `PUT /api/codex-auth/failover`, `GET /api/codex-auth/quota`, `GET /api/codex-auth/reset-credits` with `POST /api/codex-auth/reset-credits/consume`, and the login flow `POST /api/codex-auth/login`, `POST /api/codex-auth/login/code`, `POST /api/codex-auth/login/cancel`, `GET /api/codex-auth/login-status`. Per-account quota activation uses the existing `GET/PUT /api/settings` surface and `src/codex/quota-auto-refresh.ts`, keeping scheduled spending separate from credential/authentication mutation. Account ids are opaque handles and are serialized so the GUI can address an account; emails are masked and tokens are never serialized. New-account config commits add UI-managed selector bindings in the same config save; deletion deliberately retains existing bindings for fail-closed exact routing and re-add stability. Account mutations request catalog convergence only after config durability and expose only the boolean `catalogRefreshPending` completion projection. |
| Sidebar | `src/server/management/sidebar-routes.ts` — `GET/POST /api/github/star`, `GET /api/update/badge`, and `POST /api/update/desktop-snapshot`. The snapshot POST accepts the raw admin-token principal or the dedicated `local-desktop-snapshot-capability`; GUI sessions and requests carrying `Origin` cannot publish desktop state. A capability's bounded raw body is verified against its authenticated digest before JSON parsing or storage. Badge state is cosmetic and a failed poll degrades silently. |
| Logs | `src/server/management/logs-usage-routes.ts` — `GET /api/logs`, `GET /api/claude/inbound-debug`, and `GET /api/debug/injection-logs` join the debug streams described above. |

### Claude Desktop picker management

`GET /api/claude-desktop/picker` returns `200 { ok: true, picker }`, where `picker` is the
`DesktopPickerStatus` shown under `firstParty.picker` by `GET /api/claude-desktop/status`. The
dashboard's first-party card is `gui/src/components/ClaudeDesktopPicker.tsx`; it renders the
status, model count, trust hint, restart requirement, and the offline note, and its toggle sends
`PUT /api/claude-desktop/picker` with `{ enabled: boolean, persist: boolean, trustedLocally?, callerAddedTrust? }`.
Unknown request keys are rejected with `400`. A successful mutation or a reported refusal returns
`200 { ok: true, picker }`; enabling without the controller returns `503` with
`{ ok: false, code: "picker_proxy_unavailable", picker }`. First-party
`POST /api/claude-desktop/apply` also returns `picker`, so the dashboard can render the committed
mode and picker state together. The card is mounted only for first-party mode and tells the operator
to fully quit and reopen Desktop after selecting the picker profile.

> Decision record: [ADR-0074](decisions/ADR-0074-api-ownership.md)

Provider writes must not round-trip masked API keys as real secrets. Dashboard actions that change
model visibility or subagent selection should trigger catalog/cache sync behavior through the server
path that owns it.

### Fast selector rows setting

The Models Dashboard loads `fastRows` only from a strict boolean settings response. It optimistically
updates the switch, then trusts the successful PUT echo; if the response is lost or malformed after
persistence, it reads settings again and refreshes the displayed catalog. The copy still directs the
operator to refresh the integration or client catalog when an external picker has not regenerated.

The UI must show one provider card and one Models group for Codex-login OpenAI, describe Pool and
Direct accurately, and keep the main account inside Pool. Public model state keeps virtual Pro ids
even though transport logs may additionally report the resolved base model. Detailed rules live in
[`openai-tiers.md`](providers/openai-tiers.md).

User aliases are display metadata only. Codex pool aliases live on `CodexAccount`, OAuth aliases on
`ProviderAccount`, and API-key aliases reuse the existing key `label`; account ids, credential
identity, active selection, and routing never consult these fields. The matching CLI is
`ocx account alias <provider> <id> <display-name|->` (`rename` is accepted as a synonym).

OAuth manual and automatic selection share `commitOAuthAccountSelection` in the auth store.
The caller resolves a usable credential, commits its matching selection, then dispatches it;
request-local token replacement must not leave a different dashboard account selected.
Opaque selection revisions protect manual reselection and A→B→A changes from older requests.
Credential-only refresh preserves the revision. Generic proactive routing is opt-in and retains
a healthy selected account; reactive 429 recovery remains available even when the pool is off.
API-key manual selection and failover similarly share `commitProviderApiKeySelection`, carrying
stable entry identity and selection revision instead of comparing a resolved secret with an env reference.

The authenticated `GET /api/accounts/events` stream invalidates account/key selection after
successful persistence. Events contain provider/kind/revision only. The dashboard immediately
reconciles the cheap local roster and preserves its quota rows; no upstream quota probe is caused
by an event. One screen-owned stream has disconnect cleanup and bounded server subscribers;
reconnection and the existing shared scheduler provide recovery. Codex retains its own established
selection controller. These events cannot change credentials or select an account.

Selection order is the opposite case and must not be folded into the alias route. `codexAccountPriorities`
is routing metadata that Pool selection consults, it lives in config rather than on `CodexAccount` so the
`__main__` Desktop login can carry one, and the alias route's rejection of `__main__` would be wrong for
it. The matching CLI is `ocx account priority <provider> <id|main> [<value>]`, reading the current order
when the value is omitted. Ordering invariants live in
[`openai-tiers.md`](providers/openai-tiers.md).

## The client role owns no management plane

A connected client machine runs `src/client/machine-listener.ts` instead of the standalone server.
It binds the address the standalone proxy would (`port ?? config.port ?? 10100`) and serves
`GET /healthz`, `/readyz`, the packaged GUI/SPA routes, and `/api/machine/*`. Every other `/api/*`
and `/v1/*` path is refused before dispatch with a JSON 404 naming the method and path. There is no
second management port on such a machine: management rides the same listener a standalone or hub
install runs, so a connected client has no `/api/*` management surface at all.

The discriminator is `role` on `/healthz` and `/readyz`. The machine listener reports
`role: "client"`; the standalone and hub server omit the field. `src/server/proxy-liveness.ts` parses
it into `HealthzIdentity.role` and carries it on `LiveProxy.role`. `isOpencodexHealthz` still accepts
a client-role body: liveness answers "is one of our processes listening here", which is what `ocx stop`,
orphan cleanup, and duplicate-start avoidance need, and narrowing it would make them blind to a real
opencodex process and let them shadow-start over it. Refusing the client role belongs to the caller
that needs a management plane, which is the [CLI management client](config.md#management-backed-cli-commands-need-a-management-plane).

## Sidebar stop button

The dashboard sidebar includes a stop button that calls `POST /api/stop`. The button shows a
confirmation prompt, then fires the request and accepts the connection drop (the proxy exits). The
endpoint restores native Codex config, stops any installed service to prevent respawn, and exits.

## Bun runtime provenance

`GET /api/system/memory` may report `bunRuntimeSource` — one of `override`, `bundled`, or
`process` — describing how the **running service** obtained its Bun binary.

The value is stamped into the launched process's environment as a pair —
`OCX_BUN_RUNTIME_SOURCE` plus `OCX_BUN_RUNTIME_PATH`, the binary it was minted for — by whichever
launcher selected that binary: the npm Node launcher, the Windows Task Scheduler wrapper, the
native WinSW service, launchd, systemd, the Codex autostart shim, and the Windows tray host. Both
halves come from a single `durableBunRuntime()` resolution at each site, so the marker can never
describe a different binary than the one actually baked.

Launchers that re-exec `process.execPath` instead of resolving a binary — `ocx ensure`, GUI/Claude/
OpenCode start, `POST /api/system/restart`, and the update relaunch — go through
`withProcessRuntimeProvenance()`. An inherited marker is carried forward only when its recorded
path is the executable about to run, compared through `realpath` so symlinks, junctions, and
Windows case differences do not break a valid match. The recorded path is what settles this rather
than re-deriving the original selection: a service installed with a shell-local override keeps
neither that shell nor its `OPENCODEX_BUN_PATH`, so re-deriving would demote a correct `override`
to `process` on the first relaunch. A marker that describes some other binary — inheritance
travels down a process tree and can outlive the binary it was minted for — is dropped in favor of
what is actually executing.

The Codex shims scope the pair to their `ensure` invocation (an assignment prefix in `sh`,
`setlocal`/`endlocal` in `cmd`, save-and-restore in PowerShell) rather than exporting it. A shim
wraps the real `codex`, so an exported marker would be inherited by Codex and everything it
spawns.

**Trust rule: a reporting surface must never resolve provenance for itself.** Calling
`durableBunRuntime()` at report time answers "what would this process pick right now", which is
a different question from "what was the service started with" — and the two diverge exactly when
the answer matters, such as a `doctor` run in a shell whose `OPENCODEX_BUN_PATH` differs from the
installed service's. Read-back goes through `reportedBunRuntimeSource()`, which allowlists the
three values and returns `undefined` for anything else.

**Backward compatibility: absent is a real answer.** A service installed before this marker
existed reports no provenance, the endpoint omits the field, and consumers must say the origin is
unknown rather than infer one. `ocx doctor` relies on this to avoid its previous behavior of
telling a user to set `OPENCODEX_BUN_PATH` when the override was already active (#848). An
unrecognized wire value is treated as absent rather than passed through.

`bunRevision` remains informational and carries no capability meaning. Provenance does not feed
the eager-relay decision: the conservative `auto-known-bad` result for canary and otherwise
unvalidated Bun builds is unchanged (`src/lib/bun-stream-caps.ts`).

## Startup safety

**Startup safety** is reachable by route (`/#startup`) and rendered by the app, but it is not a
sidebar entry: it is entered from the dashboard's startup-state row, which links there whether the
current state needs remediation or merely reports how routing is protected. Its warning state is derived from active
Codex routing plus the actual service and launcher-shim installation state; the
`codexAutoStart` preference alone is never presented as proof of restart protection. Desktop restart target selection follows the [runtime membership contract](runtime.md#codex-desktop-process-membership); finding an installed app does not establish background-service protection. The page shows
copyable repair commands (`ocx service repair` for an installed service or `ocx service install` when none is registered, `ocx codex-shim install`, and `ocx restore`). On
Windows it can also install an owned, per-user system tray. The resident tray owns only its icon,
home-scoped singleton, and HKCU Run registration; fixed proxy actions delegate to the CLI so drain,
service conflict handling, native restore, and PID identity remain centralized. Tray presence never
makes `startup.status` protected.

Windows Task Scheduler create failures must not depend solely on localized `schtasks.exe` text.
When the owned fixed-shape `/create /tn opencodex-proxy /xml ... /f` command exits with status 1,
the effective-token elevation probe may classify it as access denied only when the token is known
to be non-elevated. An unavailable probe remains `other` and cannot trigger UAC. Query, run, delete,
native-service, file-write, and foreign task failures never use this fallback.

For a fresh scheduler install whose task is proven absent, registration is the non-destructive
first phase. OpenCodex writes a unique temporary XML definition in an ACL-hardened private directory
outside its config root and asks Task Scheduler to create the owned task without running it. Only
after that succeeds may it discard
the consumed staging XML, require scheduler ownership for a config root that was absent at entry,
stop existing service managers and the proxy, remove and boundedly re-verify any native WinSW
registration, publish the canonical scheduler assets, run the task, and write install state. A
legacy non-empty unowned root remains conservatively unclaimed. This prevents the fresh path from
leaving either an unowned new installation or two registered managers that can both respawn the
proxy.
UAC cancellation or create failure removes the temporary XML before any manager/proxy stop, so the
working proxy's shutdown cleanup cannot strip Codex routing merely because elevation was refused.
The Dashboard does not apply its ordinary 60-second child timeout to this Windows service command:
killing only the CLI could orphan the already-launched elevated child, which might register a task
after the UI reported failure. The asynchronous request and install-attempt lock remain pending
until Windows returns approval or cancellation; other proxy requests keep running normally.
Existing or conflicting registrations stay on the older fail-closed path because deleting or
replacing them cannot be called a rollback without an exact prior-registration snapshot.

> Decision record: [ADR-0075](decisions/ADR-0075-startup-safety.md)

> Decision record: [ADR-0076](decisions/ADR-0076-startup-safety.md)

Dashboard updates persist their detached worker PID before returning success. This lets a later run
distinguish a live installer from a worker that crashed. Records created by older versions do not
have a PID, so they remain exclusive for a conservative ten-minute window before automatic
recovery; operators no longer need to delete `update-job.json` after a dead worker.

> Decision record: [ADR-0077](decisions/ADR-0077-startup-safety.md)


Aside refresh from `ocx sync` also uses a one-shot process-bound capability for its exact POST route.
It never sends the reusable management credential to a listener selected through public liveness
discovery, and configured-port-only legacy proxies must be restarted before they can own this mutation.

The `kimi-responses` preset shares Kimi's icon and display brand while its provider id remains distinct.

The dashboard's auto-switch route accepts `{ threshold }` for the global value and `{ id, threshold }`
for an account override. Account thresholds are integers 0..100 or `null` to inherit, and account-list
DTOs always expose `autoSwitchThresholdOverride` as that integer or `null`; account controls are
specified in [Codex account controls](codex-account-controls.md).

A GET with HTTP 404 and code `unknown_flow` is terminal even during cancellation ownership: the flow
no longer exists, so polling stops, the flow is released, and the existing generic failure state
appears, as on the DELETE path. Other retryable non-2xx GET errors cannot expose a replacement login
POST before a concurrent DELETE settles. Retryable GET/DELETE races preserve same-flow cancellation
retry, last trusted device details, and the existing poll cadence. Outside same-flow cancellation
ownership, a GET HTTP failure stops polling without starting a second login POST.

Pairing-grant source limiting applies only to invalid guesses from an allowed browser origin; disallowed
origins record no limiter state, and a valid grant redeems even from a throttled source.