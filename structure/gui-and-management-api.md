# GUI And Management API

## Dashboard serving

The bundled React dashboard is built into `gui/dist` and served by the same Bun proxy. `ocx gui`
starts the proxy when needed and opens `http://localhost:<port>`.

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
management token creation, validation, or permission hardening fails, every `/api/*` request returns
503 while `/v1/*` and unauthenticated `/healthz` continue to operate. Windows ACL hardening results
must be checked explicitly because an `icacls` timeout is a soft failure in the shared secret helper.

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

`src/server/index.ts` authenticates and routes `/api/*`, then delegates to
`src/server/management-api.ts`, which composes the route modules under `src/server/management/`.
Codex account routes live in `src/codex/auth-api.ts` because they own the credential store, not
because they are a different plane.

The registered route set is larger than the areas described below; the code is the route SOT. What
this document owns is which module holds which area and what invariant that area must not break.

| Endpoint area | Responsibility |
| --- | --- |
| Config/settings | Read safe config/settings views; mutate supported settings only. Full `PUT /api/config` is disabled so masked secrets are not round-tripped. `PUT /api/settings` accepts `codexAutoStart`, `streamMode`, integer `appOwnedMemoryBudgetMb` (64..4096), strict boolean `codexAccountPickerEnabled`, and a validated per-account `codexQuotaAutoRefresh` toggle (each optional, at least one required). Picker enable initializes an empty UI-managed selector map, persists before one bounded catalog convergence, and reports only `catalogRefreshPending`; allocation/save failure restores every touched live field and skips convergence. Budget changes synchronously enforce the process-wide evictable retained-state cap; this is separate from RSS/native memory. `streamMode` persists the #314 stream-shape selection in config.json (Windows services need persisted input; macOS eager relay is explicit-only). |
| Startup safety | `GET /api/startup-health` reports whether injected Codex routing is restart-safe, with secret-free service/shim diagnostics. `POST /api/startup-action` provides allowlisted one-click installation for the background service or launcher shim. On Windows a healthy script shim is CLI-only; Codex Desktop requires the background service for full protection. |
| Windows tray | `GET/POST /api/windows-tray` controls an owned, per-user HKCU login tray. The tray delegates fixed actions to the CLI and is never a proxy supervisor or restart-protection signal. |
| Updates | `GET /api/update/check`, `POST /api/update/run`, and `GET /api/update/status` own dashboard self-update state. A launched worker PID is persisted in `update-job.json`; dead PIDs recover immediately, while legacy active records without a PID recover only after ten minutes. Live PIDs remain exclusive regardless of record age. `GET /api/update/badge` backs the sidebar badge: it reports that an update exists and links to the update surface rather than gating other actions. |
| Providers | Create/update/delete ordinary provider configs and enrich registry metadata. The reserved `openai` card exposes Pool(default)/Direct account mode; `openai-apikey` remains the separate API route. |
| Models | Fetch routed model lists, disabled model visibility, and catalog-facing ids. New non-OAuth registration holds exposure until authoritative discovery; 20 or more distinct switch rows start OFF without disabling the provider. Pending rows cannot accept visibility changes. |
| OAuth | Login/status/logout for OAuth-backed providers, plus multiauth account management: `GET /api/oauth/accounts`, `PUT /api/oauth/accounts/active`, `PUT /api/oauth/accounts/alias`, `DELETE /api/oauth/accounts` list masked accounts per provider, switch the active one, edit its display-only alias, and remove one. The login flow itself is `GET /api/oauth/providers`, `POST /api/oauth/login`, `POST /api/oauth/login/code`, `POST /api/oauth/login/cancel`, `POST /api/oauth/logout`, and `GET /api/oauth/status`; pool controls are `GET/PUT/PATCH /api/oauth/accounts/pool` and `POST /api/oauth/accounts/clear-cooldown`. Login accepts `addAccount: true` to force a fresh browser identity. Device flows return a structured `deviceCode`; the GUI highlights and copies it before the user opens the verification page. |
| Key providers | `GET /api/key-providers` exposes API-key provider presets for setup and dashboard flows, and `GET/POST/DELETE /api/keys` owns the proxy's own admission keys. Multi-key pool per key-auth provider: `GET /api/providers/keys`, `POST /api/providers/keys`, `PUT /api/providers/keys/active`, `PUT /api/providers/keys/alias`, `DELETE /api/providers/keys` masked list, add (upsert + activate), switch, rename, and remove keys. `provider.apiKey` always mirrors the active pool entry so routing stays single-key. |
| OpenAI account mode | Report one OpenAI Codex card with Pool/Direct controls and one API-key card. Mode PATCH persists live without restart or catalog identity changes; Pool owns account/quota controls and Direct uses caller/main login only. Main-account DTOs report real credential presence and terminal `needsReauth` state instead of treating missing/invalid native auth as an unknown quota. Selection order has its own route: `PUT /api/codex-auth/accounts/priority` takes `{ id, priority }`, where `priority` is an integer -100..100 or `null` to restore the default, accepts `__main__`, 404s an unknown id, and echoes the stored value. Re-ordering never clears thread affinity, so the response carries no `appliesImmediately`, but it does release any pin — see [`openai-tiers.md`](providers/openai-tiers.md) for why. `PUT /api/codex-auth/active` with a null id releases one too, but that drops the operator's account selection along with it, so this route is the only operator-facing way to clear a pin while leaving the selected account in place. `GET /api/codex-auth/active` reports `pinned`, true only while the manually selected account is still the effective active one, plus `pinnedAccountId`, which names the pinned account whether or not it is the active one. Surfaces should render `pinnedAccountId`: under round-robin and fill-first the pin caps the tier ceiling at its own tier while the strategy cursor moves freely inside that tier, so `pinned` goes false on a sibling's turn even though the pin is still suppressing every higher tier — which is why the dashboard badges `pinnedAccountId` and the GUI controller tracks only the id. `pinned` answers the narrower question of whether routing is *currently* on the operator's choice; no surface in this repo asks it, and a new one almost certainly wants the id instead. |
| Subagents | Read/write the featured `subagentModels` list capped at five ids. `GET/PUT /api/injection-model` manages the shared delegation model/effort selection, the independent OpenCodex guidance switch, and the default-off `syncCodexSubagentDefaults` opt-in for native Codex subagent defaults. When OpenCodex owns the active Codex routing, native `[agents]` defaults apply to newly created Codex tasks after sync/restart; external user-managed provider configs remain untouched. The defaults do not cause delegation and preserve existing user-owned defaults rather than overwriting them. PUT is partial-update: absent keys are unchanged, `null` clears, and non-object bodies are rejected with 400 before field validation. `syncCodexSubagentDefaults: true` requires a nonblank `model` and a supported Codex reasoning effort when effort is set; clearing `model` (null/empty) always clears effort and disables native-default sync even when the stored effort was invalid. |
| V2 / Multi-agent mode | `GET/PUT /api/v2` — reports/sets the codex `multi_agent_v2` feature flag, the 3-state `multiAgentMode` override (`v1`/`default`/`v2`), the `keepNativeChatGptOnV1` hybrid pin, and the logical maximum thread count. Selecting `v2` normally enables the native flag; with the hybrid pin it disables that global override so native rows can resolve to v1 while routed rows resolve to v2. Selecting `v1` disables the flag; `default` leaves it unchanged. PUT rejects an explicit enabled flag that conflicts with the selected mode or hybrid pin. Every transition preserves the logical thread limit, is rollback-safe, and resyncs the catalog. GET and successful PUT also return stored `multiAgentModeHintText` plus response-only `multiAgentModeHintRecommendation: { text, revision }`; the recommendation is not a writable or persisted config field. |
| Logs & Debug | One sidebar entry (`/#logs`) with two tabs. Logs tab: request/runtime logs for local diagnosis. `LogsFilterBar` owns controls over the shared `LogFilterState`; `filterLogs` composes filters over the loaded ring. The logs envelope adds `generatedAt` (proxy epoch milliseconds); the page advances that sample with monotonic elapsed time and retains a browser-clock fallback for older proxies. Reset returns focus to the stable All surface radio. Provider/model options include attempts, model choices match normalized complete identities, and relative-time filtering refreshes every 30 seconds while the Logs tab is active, independently of network auto-refresh. Debug tab (`/#logs/debug`; legacy `/#debug` deep links redirect there): provider + usage toggles, refresh/follow log viewer. `GET/PUT /api/debug`; `GET /api/debug/logs` and `GET /api/debug/usage-logs` (monotonic `after` cursor, legacy `since` accepted). CLI: `ocx debug provider|usage …` (both streams via running proxy API). |
| Usage | `GET /api/usage` aggregate read-only summary derived from the complete `~/.opencodex/usage.jsonl`; the ledger is streamed in fixed 1 MiB chunks, so the former read-byte and parsed-row caps cannot omit its prefix. The response includes measured / reported / unreported / unsupported / estimated counts, a daily zero-filled grid, and model and provider breakdowns. Never exposes prompts. |
| System | `POST /api/system/restart` restarts the proxy in place. Local CLI/tray callers first attest the exact runtime PID and port, then send a process-scoped HMAC capability bound to that method, path, PID, and port; the capability authorizes no other management route and is invalid after replacement. The caller observes one absolute deadline and accepts success only after a different runtime PID is healthy on the same port. `GET /api/system/health` is the authenticated scalar-only identity used by shared-plane Dashboard status and restart reconnect polling; it does not widen a Remote Hub management ingress to unauthenticated `/healthz`. `GET /api/system/memory` — service-process runtime/memory identity (pid, Bun version/revision, optional `bunRuntimeSource` provenance, platform, RSS/heap/external/ArrayBuffers scalars, observed memory = max(RSS, external, ArrayBuffers), `bun:jsc` heap context, streamMode + eager-relay gate decision, watchdog snapshot sliced to the last 60 samples) plus privacy-safe `appOwnedBytes` retained-store totals/counters under static store ids. Its response-state block also reports spill-write `initial`/`healthy`/`degraded` status, a consecutive-failure streak, fixed error class, and failure/success timestamps. A successful publication clears the streak in the same process; raw error text and paths never enter this surface. Scalar-only payload; dashboard/admin callers use the standard management gate, while `ocx doctor` may use only the exact process-scoped local-read capability. It must never move to unauthenticated `/healthz`. |
| Stop | `POST /api/stop` — restore native Codex, stop any installed service, and exit the proxy. |
| Diagnostics/sync | `src/server/management/config-routes.ts` — `GET /api/diagnostics/project-config` reports project-level Codex config that bypasses managed routing; `POST /api/sync` re-runs catalog/config sync. The diagnostic reports the bypass; it does not rewrite the project file. |
| Sidecar/shadow-call settings | `src/server/management/config-routes.ts` — `GET/PUT /api/sidecar-settings` and `GET/PUT /api/shadow-call-settings`. PUT accepts model and backend (web-search union: openai/anthropic/xai/gemini/exa; xAI is live through stored Grok OAuth, while Gemini/Exa remain inert until their executors ship) plus validated `webSearch.xSearch`, optional `webSearch.exaApiKey` (write/clear only — never echoed by GET or the PUT response; redact.ts strips it from logs), `webSearch.reasoning`, `vision.reasoning`, `vision.enabled`, `vision.maxDescriptionsPerTurn`, and `vision.timeoutMs`; the read and PUT-response payload reports model, backend, reasoning, enabled, the vision per-turn limit, and timeout. `timeoutMs` is validated against the runtime integer bounds in `src/vision/timeout-bounds.ts`. Provider/OAuth credentials live in their stores; `exaApiKey` is the one sidecar-owned secret and follows the write-only contract above. Both shadow-call responses also report the resolved `sourceModels` — the prefixes the runtime actually intercepts (`src/lib/shadow-call.ts`, default `gpt-5.6-luna`; the retired `gpt-5.4-mini` stays available as an explicit `sourceModels` entry for 0.144.x clients), so no client hard-codes a helper slug that a Codex release can invalidate. |
| Storage | `src/server/management/logs-usage-routes.ts` — `GET /api/storage`, `POST /api/storage/cleanup/preview` and `/api/storage/cleanup`, `GET /api/storage/trash`, `POST /api/storage/trash/restore`, and `GET/PUT /api/storage/cleanup-policy` plus `POST /api/storage/cleanup-policy/run`. `GET /api/storage/cleanup-policy/test-stream` and `GET /api/storage/trash/restore/test-stream` exist for progress-stream testing. Cleanup takes an explicit `mode`: `quarantine` moves to trash and is restorable, `permanent` is not. The caller must name the mode — there is no default that silently deletes. |
| Provider quotas and tests | `src/server/management/provider-routes.ts` — `GET /api/provider-quotas`, `POST /api/providers/test`, `GET/PUT /api/provider-context-caps`, `GET /api/provider-presets`. A quota read may be served from cache or force-refreshed; absent quota data is reported as unknown rather than as a measured zero. |
| Models and visibility | `src/server/management/model-routes.ts` — `GET /api/models`, `PUT /api/disabled-models`, `PUT /api/model-visibility`, `PUT /api/selected-models`, `GET/POST /api/custom-models`. Visibility writes trigger catalog sync through the owning server path. |
| Effort and fallback | `src/server/management/agent-settings-routes.ts` — `GET/PUT /api/effort-caps`, `/api/subagent-models`, `/api/subagent-model-fallback`. Caps clamp; they do not reject. |
| Grok and Claude integrations | `src/server/management/agent-settings-routes.ts` — `GET /api/grok`, `PUT /api/grok/selection`, `POST /api/grok/apply`, `GET/PUT /api/claude-desktop`, `POST /api/claude-desktop/apply`, `GET /api/claude-desktop/status`, `GET/PUT /api/claude-code`. Apply writes an external app's profile, so its status probe must read the same resolved path it writes (see [`responses.md`](transports/responses.md)). |
| Grok reset coupons | `src/server/management/grok-coupon-routes.ts` — `GET /api/grok/reset-coupons`, `POST /api/grok/reset-coupons/consume`. The dashboard owner is `gui/src/hooks/useGrokResetCoupons.ts` with `gui/src/components/provider-workspace/GrokResetCoupons.tsx`, wired into the xAI OAuth rows of `ProviderAuthPanel`. Redemption truth is the settled ledger `code`, not the HTTP status: a replayed failure returns 200 with `replayed: true`. See [`providers/xai-grok.md`](providers/xai-grok.md). |
| Combos | `src/server/management/combo-routes.ts` — `GET/PUT/DELETE /api/combos` own provider combination and failover definitions. |
| Codex accounts | `src/codex/auth-api.ts` — `GET/POST/DELETE /api/codex-auth/accounts`, `PUT /api/codex-auth/accounts/alias`, `PUT /api/codex-auth/accounts/pause`, `PUT /api/codex-auth/accounts/pause-exhausted`, `POST /api/codex-auth/accounts/clear-cooldown`, `GET/PUT /api/codex-auth/active`, `PUT /api/codex-auth/auto-switch`, `PUT /api/codex-auth/pool-strategy`, `PUT /api/codex-auth/failover`, `GET /api/codex-auth/quota`, `GET /api/codex-auth/reset-credits` with `POST /api/codex-auth/reset-credits/consume`, and the login flow `POST /api/codex-auth/login`, `POST /api/codex-auth/login/code`, `POST /api/codex-auth/login/cancel`, `GET /api/codex-auth/login-status`. Per-account quota activation uses the existing `GET/PUT /api/settings` surface and `src/codex/quota-auto-refresh.ts`, keeping scheduled spending separate from credential/authentication mutation. Account ids are opaque handles and are serialized so the GUI can address an account; emails are masked and tokens are never serialized. New-account config commits add UI-managed selector bindings in the same config save; deletion deliberately retains existing bindings for fail-closed exact routing and re-add stability. Account mutations request catalog convergence only after config durability and expose only the boolean `catalogRefreshPending` completion projection. |
| Sidebar | `src/server/management/sidebar-routes.ts` — `GET/POST /api/github/star` and `GET /api/update/badge`. Sidebar state is cosmetic; a failed fetch degrades silently. |
| Logs | `src/server/management/logs-usage-routes.ts` — `GET /api/logs`, `GET /api/claude/inbound-debug`, and `GET /api/debug/injection-logs` join the debug streams described above. |

> Decision record: [ADR-0074](decisions/ADR-0074-api-ownership.md)

Provider writes must not round-trip masked API keys as real secrets. Dashboard actions that change
model visibility or subagent selection should trigger catalog/cache sync behavior through the server
path that owns it.

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
`codexAutoStart` preference alone is never presented as proof of restart protection. The page shows
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

## UX boundary

The dashboard is a local control surface, not a separate service. It should reflect the same config
and catalog invariants documented in this folder rather than inventing parallel state.

Codex quota cards consume the display cache from `src/codex/quota.ts`. A partial refresh
removes an omitted short tuple whose reset deadline has elapsed, so a stale Spark-derived
5h row does not persist on a weekly-only account. This is independent of the main-account
hard-lock evidence and reset-notification history; their retention rules are documented in
[OpenAI account modes](providers/openai-tiers.md#quota-cache-and-short-window-history).

## Dashboard surfaces

Provider Overview consumes the existing shared `add-provider-presets` resource for sponsor
presentation. `matchingWorkspacePreset` requires the configured id, adapter and normalized
endpoint to match; a custom endpoint or absent sponsor metadata suppresses the introduction.
`ProviderSponsor` keeps localized promotional copy and outbound HTTP(S) links separate from
operator notes. Notes remain complete and editable once in the main column; stats and current
account quota remain in the side column. This presentation does not write provider configuration
or participate in routing.

The sidebar exposes eleven pages (`gui/src/App.tsx` `NAV`). Several are workspace shells rather than
single forms, and the shell pattern is the part worth keeping stable:

| Surface | Shape |
| --- | --- |
| Providers | Rail of configured providers plus a detail pane whose tabs are Overview, Models, Usage, then Accounts or API Keys when the provider has an auth surface, then Settings (`gui/src/components/provider-workspace/ProviderDetails.tsx`). |
| API keys | Rail plus per-key detail; masked values only (`gui/src/components/apikeys-workspace/`). |
| Storage | Rail plus cleanup and trash detail (`gui/src/components/storage-workspace/`). |
| Subagents | Featured-roster selection workspace (`gui/src/components/subagents-workspace/`). |
| Combos | Rail, detail panel, and an add flow (`gui/src/components/ComboWorkspace.tsx`). |
| Add provider | Catalog browser plus form and OAuth panes (`gui/src/components/provider-catalog/`, `gui/src/components/AddProviderModal.tsx`). The catalog browses four tabs — Accounts, Free, Local, Paid — where Local is a catalog-only bucket peeled out of `bucketPresets` after `presetTier` has classified; the workspace `providerTier` stays three-way, so the rail, the free-paid sort and the Free count still treat a local runtime as free. Search sits above the tabs and reaches every tab at once: while a query is live the list renders all four groups with headings and the strip becomes jump chips with counts rather than a tablist, because moving the selected tab would change the row kind under the user (a preset-select button becomes a login row). ArrowDown from the search input focuses the first enabled result action; if none is available, focus stays in the input. The tab strip wraps within narrow modals. Every nonempty note has a full-text button so narrow rows never hide content permanently; the native note dialog closes during teardown and restores focus to its trigger. Provider notes clamp to two lines and open in full in a stacked native `<dialog>` owned by `AddProviderModal`, which also owns the search text so its `window` Escape handler can unwind popup, then query, then dialog. |
| Codex accounts | Account pool cards, add-account flow, switch and reset modals (`gui/src/components/CodexAccountPool.tsx`, `gui/src/components/AddCodexAccountModal.tsx`), plus the generic account-targeting picker opt-in on `gui/src/pages/codex-set-multiauth.tsx`. Add/delete/login completion is projected to one boolean before presentation; pending catalog work is a warning, not a failed account mutation. |
| Dashboard overview | Overview, Providers, and Models tabs at the page level (`gui/src/pages/Dashboard.tsx`), the 30-day token and coverage stats in the overview head (`gui/src/pages/dashboard-overview-head.tsx`), and the effort-cap, injection, maintenance, sidecar, and memory panels below it (`gui/src/pages/dashboard-overview-panels.tsx`). |

Rail selection is component-local state today, so a reload returns to the workspace's default
selection rather than the previously selected row. An OAuth ToS warning is shown before a login that
requires acceptance (`gui/src/components/OAuthTosWarningModal.tsx`).

The `/#codex-auth` add-account modal has a three-step manual-code UX contract on top of the existing
OAuth polling API: submit request, waiting-for-login completion, and terminal success/failure. Once
`POST /api/codex-auth/login/code` succeeds, the GUI must keep the input disabled, expose an
`aria-live` status message that the code was accepted, and surface repeated `login-status` polling
network failures as a visible warning instead of silently looking idle again.

Fixed provider redirect URIs keep their registered port. If that port is already in use, a login
controller with `onManualCodeInput` enters manual-only mode: it must still publish the authorization
URL and accept the final redirect URL or code through the same state/PKCE session. A controller
without manual input must fail closed; it must not silently move a fixed redirect URI to another port.

The account-targeting control reads the effective flag from `GET /api/settings`; it must not infer
state from the redacted config DTO or expose selector mappings. It renders no actionable off switch
before hydration, serializes rapid clicks, rejects stale poll results that started before a mutation,
and accepts the server-confirmed state after PUT. Product copy describes arbitrary public selectors
and exact account binding only—there are no built-in Personal/Work roles. A pending catalog refresh
keeps the saved state and renders fixed `ocx sync` guidance without server/account detail.

## Usage accounting

Custom usage windows are immutable bounds on the streaming accumulator, applied to each
ledger entry before attribution and daily aggregation. The filtered aggregate cache includes
both inclusive millisecond bounds in its identity and retains the existing ledger revision,
overlay-version and timezone checks. Preset warming never consumes custom summaries.
The response retains its preset range discriminator for compatibility and explicitly marks
`customWindow`, `since`, and `until`; the chart uses the window's local calendar days with
the existing 366-day cap. GUI custom reports bypass the held preset/session cache.
Both dashboard and CLI reject a custom report unless the server echoes `customWindow: true`
and the exact requested numeric `since` and `until`. An older daemon that silently returns a
preset report cannot supply totals labelled with the requested custom interval.

Resetting a manual model price keeps the map, even when temporarily empty, through persistence
reconciliation. This removes only the requested entry and preserves sibling rates independently
written to disk. The Desktop sign-in preference likewise distinguishes saved from applied state:
its pending flag survives cache refresh/remount until a successful sync confirms application.

Subagent fallback settings load independently of the main roster. Their failure disables only
fallback controls and provides a retry; available fallback options come from that endpoint's
availability list while already-configured stale values remain editable.

Subagents → Advanced uses the current API server's recommendation for **Always proactive
delegation** (formerly Ultra mode). Enabling requires the native v2 flag, explicit v2 mode
and a recommendation with nonblank string text and revision. Missing or malformed
recommendations disable preset installation and restoration while existing custom hints
remain editable and clearable. Restore changes only the editor draft; Save writes it.
Recommendation-only refreshes preserve unsaved drafts. Switching API servers hides the
previous hint and blocks mode writes until the new server's settings arrive.

An explicit `multiAgentModeHintText` write canonicalizes only the two byte-exact legacy
OpenCodex presets; other valid custom text keeps its bytes. GET, unrelated PUTs and upgrades
leave stored hints unchanged. `null` clears the hint, blank strings are rejected, and the
existing native capability check still precedes writes. The text and revision recommendation
is supplied independently of stored TOML and is not evidence of native runtime support.

Account quota discovery is capability-based. Cheap OAuth and provider-key lists include
`quotaMode` (`probe`, `passive`, or `unsupported`) without contacting upstream quota APIs.
`GET /api/oauth/accounts?provider=...&quota=1` and
`GET /api/providers/keys?name=...&quota=1` enrich each supported credential separately;
`refresh=1` bypasses settled quota cache while joining a current same-identity read.
OAuth readers use the named stored account; key readers use isolated per-key configuration,
never active-key mutation or the provider-wide cache. Response projection rechecks key identity
and exposes only quota/availability fields, not its internal identity guard. Passive observations
retain their original timestamp and never trigger inference or token renewal. Unsupported,
unobserved, failed and measured-zero readings remain distinct; multiple keys are not summed
because they may share one upstream balance.

Provider details use one account-quota reading renderer for Overview, Usage and Accounts/API
keys. Current-account usage sits below usage statistics; a known-mode active row is authoritative
even when empty, so a newly selected passive account cannot inherit a previous account's cached
report. Pool reports project only `aggregation.currentAccount.quota` with its own timestamp;
missing or malformed aggregation stays unknown rather than using total capacity. Shared states
include credits-only and measured-zero readings, unsupported, unobserved, explicit pending and
unavailable-with-last-good. Forced account/key enrichment settles before its control reports a
completed check, and provider-report waiters are bound to the exact refresh epoch.

Main-account WHAM refresh diagnostics are an ephemeral `quotaRefresh` outcome carried
from `fetchMainAccountInfoWhileOwned` to the generation-checked account DTO and the
opt-in CLI quota JSON. They are not persisted or consumed by admission/rotation.
A private per-dispatch identity generation fences the diagnostic independently of ordinary
quota metadata. Both snapshot and account DTO publication omit externally invalidated
attempts; the generation itself is never serialized or stored in the quota cache.
The CLI reconstructs the object using a fixed vocabulary and bounded numeric HTTP
status, so an unexpected management response cannot add raw upstream material.

> Decision record: [ADR-0078](decisions/ADR-0078-usage-accounting.md)

`src/usage/log.ts` writes append-only JSONL to `~/.opencodex/usage.jsonl` with file mode `0o600`.
An opt-in shadow-call rewrite persists the bounded, redacted original helper model as
`shadowCallRewrittenFrom`, so helper traffic remains identifiable after restart without storing
request content or inferring a helper subtype from timing.
`src/usage/summary.ts` turns that file into the `/api/usage` shape — totals, daily zero-filled
grid, model and provider breakdowns, and `measured / reported / unreported / unsupported / estimated` counts.
The management route streams the complete ledger from its beginning in fixed 1 MiB chunks on a
cold rebuild, then retains compact numeric aggregate state and resumes at the last verified LF for
ordinary appends. It does not retain the full input or a normalized object for every request, and
neither the old byte window nor the parsed-entry cap can discard an earlier prefix before range and
surface filtering. `managementUsageMaxReadBytes` remains a recognized compatibility setting for
bounded legacy readers, but it is not an accuracy limit or tuning knob for `GET /api/usage`.
A Codex-surface response also includes an `accounts` breakdown keyed by the stable non-PII
`accountLogLabel`; current cards join those rows to the management account DTO and show the 30-day
token total, API-equivalent cost estimate, and measurement coverage. New main-pool rows use `main`,
while legacy bare `openai` rows stay ambiguous rather than being reassigned from current config.
A missing `usage.jsonl` returns a zeroed summary with 200, not an error: a fresh install has no
usage and must not render as a failure. What the shape must never do is present an unmeasured
request as a measured zero — that is what the `measured / reported / unreported / unsupported /
estimated` split exists for, and why coverage is reported alongside totals. The dashboard Usage tab renders the same shape, and the
main Dashboard surfaces a 30d token / coverage summary. The in-memory `requestLog` is capped at
200 entries and is **not** the source of truth for aggregation — the JSONL on disk is.

Usage aggregation does not infer confirmed model identity merely from a requested selector.
Model rows with saved unchanged
default-provider route evidence carry `hasUnresolvedRequestedModel`: their tokens stay under
the recorded serving provider, with an unresolved-request annotation. For those slash-containing
selectors, a vendor-only inferred price is unavailable; exact provider and user prices remain
eligible. Missing trace evidence is not reconstructed from today's configuration. Provider-detail
model shares use that provider's token total, not the global total. Unknown reserved `policy/`
selectors are rejected before upstream dispatch; historical rows remain unchanged.

The management API retains the compact accumulator plus bounded query summaries; it never retains
normalized per-request rows after a response. File identity changes, shrinkage, same-size metadata
changes, pricing-overlay changes, and local-time-zone changes force a cold rebuild. Ordinary growth
is treated as an append: the scanner verifies the previous LF and its trailing 64 KiB digest, then
folds only the suffix into a cloned accumulator and publishes it after validation. Concurrent callers
share that work. Cold rebuilds scan the whole ledger in fixed-size chunks and yield between bounded
batches, so memory stays bounded and unrelated management requests remain serviceable even for a
large existing log. The first read is proportional to ledger size; steady-state refresh work is
proportional to newly appended bytes. The Dashboard polls its 30-day usage summary independently once
per minute, so usage work cannot delay health/provider/settings state or run every five seconds.

`usage.jsonl` is an append-only runtime ledger. A manual in-place edit earlier than the trailing
64 KiB checkpoint followed by file growth is intentionally outside the incremental detector's
contract: validating arbitrary historical rewrites on every refresh would require rereading the
whole prefix. Replace or truncate the file, or restart the proxy, after manually changing historical
rows so the next request performs a cold rebuild.

The wire fields `historyTruncated`, `truncatedPrefixBytes`, `entriesTruncated`, and `entriesDropped`
remain in the response for compatibility with older GUI and CLI clients. A successful whole-ledger
scan reports `false`, `0`, `false`, and `0`; clients must not interpret those fields as evidence that
`managementUsageMaxReadBytes` was raised or that a bounded tail was selected.

> Decision record: [ADR-0079](decisions/ADR-0079-usage-accounting.md)

For diagnosing upstream-shape / usage-extraction issues run `ocx debug usage on` (or set
`OPENCODEX_USAGE_DEBUG=1` before start). The proxy then writes a rolling debug record per finalized
request to `~/.opencodex/usage-debug.jsonl` (mode `0o600`, auto-trimmed to the most-recent 100 lines
once it exceeds 200) with the upstream content-type, body kind (`sse / json / other / none`), a 2KB
body sample, and the extracted usage. Off by default; the hot path is guarded so production stays
untouched.

## Z.ai quota destination ownership

`src/providers/quota.ts` uses one exact normalized-base mapping for both Z.ai quota
eligibility and monitor selection. International root, coding Chat, Anthropic and
Responses bases use `api.z.ai` with Bearer authentication. Existing BigModel CN root,
coding Chat and Responses bases use `open.bigmodel.cn` with the raw key. Unsupported
bases produce no probe; redirect refusal and quota parsing/cache semantics are unchanged.

> Decision record: [ADR-0096](decisions/ADR-0096-z-ai-quota-destination-ownership.md)

## Provider debug logging

Provider transport diagnostics (dropped SSE frames, adapter dial/stream events, etc.) are opt-in:
`ocx debug provider on` / `ocx debug provider off` on the running proxy, the Debug-page toggle, or `OCX_DEBUG=1` on
the next start (legacy `OCX_DEBUG_FRAMES` still enables the same path). Lines
use the `[ocx:<adapter>:<event>]` prefix, go to the proxy terminal, and are buffered for
`ocx debug provider logs` / `ocx debug provider logs -f`. Usage JSONL tails with
`ocx debug usage logs [-f]`. Separate from provider buffered logs above.

## Remote credentials and bounded sessions

Data keys authorize only the data matrix and authenticated catalog. Admin credentials authorize ordinary management and key rotation but cannot mint, exchange, or refresh a `gui-session`. Pairing grants are digest-only, origin-bound, one-use, capped at 128 live grants, burned after five grant failures, and source-limited after ten failures in ten minutes with at most 1,024 source buckets. `POST /api/session/logout` invalidates only the current origin/CSRF-authorized browser session.


### Model picker ordering settings

`GET /api/subagent-models` retains `chosen`, `available`, and `catalogState`, and adds routed-only
`pickerAvailable`, saved `pickerOrder`, and nullable `pickerOrderMode`. `available` still includes
saved disabled/missing roster choices; it is not the eligible-picker set. Bare aliases are excluded
from the routed preset surface because a bare id activates complete Codex-picker ordering.

PUT accepts `models` and/or `pickerOrder`; `pickerOrderMode` requires `pickerOrder` and accepts
`alphabetical`, `provider`, `most-used`, or null. Roster arrays keep their existing exact string
values and five-slot cap. Picker arrays reject blank, duplicate or ineligible ids. Null/empty
order clears order and mode; a nonempty order without a mode clears only the mode. Validation
finishes before a synchronous live mutation/save. An unsupported future deletion-provenance format
returns 409 for picker writes instead of losing clear intent. Deletion intent is staged separately and
materialized as existing config rebase provenance, so failed persistence restores the touched
fields without contaminating the live object's pending-deletion state. Absent fields are not
copied back from a snapshot taken before discovery, preserving concurrent roster changes.

Only roster writes sync Claude agent definitions/auto-apply Desktop profiles. Picker writes
converge the Codex catalog once and return its disposition. The Models UI owns a separate bounded
picker data resource so failure cannot erase the ordinary model inventory; Apply publishes through
the resource's generation fence, and Most used reads usage only on explicit Apply. Stored mode
survives availability drift, while complete/native custom orders await explicit replacement.

Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

## Combo editor routing quota

`src/server/management/provider-routes.ts` projects `routingQuota` after each quota read using the
current provider configuration and [scoped inference evidence](runtime.md#scoped-provider-quota-for-combo-selection).
The DTO carries only state, observation time and an exclusive `validUntil`; cached display reports
and private credential bindings are unchanged. Known states expire within 30 minutes; exhaustion
may expire earlier when the runtime predicate clears at a reset boundary, accounting for other
windows and persistent USD blockers.

`gui/src/combo-workspace-data.ts` accepts only this projection for quota-based Save/Create blocking.
Missing, invalid or expired evidence is unknown. `gui/src/pages/Combos.tsx` wakes at the rendered
expiry, including a deadline crossed before effects run, rechecks activation and visibility, and
refreshes quota with Combo data while preserving drafts. Each successful quota snapshot also
advances the observation clock, so a retained older row cannot defer evaluation of a fresh row.

## Paginated history writer boundary

`src/codex/history-provider.ts` refuses external writes to paginated or migration-capable history. `src/codex/inject.ts` checks affected rows and manifest-owned restore targets before artifact changes and compensates detected migration. Failed config restore stops later catalog/history work. See the [history writer contract](codex-home.md#paginated-history-writer-boundary) for guarantees and concurrent-writer limits.

Claude replay carries [Go conversation affinity](data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Cline journal Undo eligibility reads both native configuration files through the paired
integration IO adapter. Its snapshot fingerprint cannot be checked against providers.json alone;
[the integration contract](clients/integrations.md#cline-paired-files) defines recovery.

The existing dashboard file-client maps include Cline CLI and reuse its committed color mark. The export panel labels its download as a settings/catalog bundle; all locales explain that Undo restores both original files.
