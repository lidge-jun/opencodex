# GUI And Management API SOT

## Dashboard serving

The bundled React dashboard is built into `gui/dist` and served by the same Bun proxy. `ocx gui`
starts the proxy when needed and opens `http://localhost:<port>`.

All ordinary HTTP responses (excluding successful WebSocket upgrades) include `X-Frame-Options: DENY` and
`Content-Security-Policy: frame-ancestors 'none'`. This prevents another page from framing the local
dashboard or management responses. Embedding the dashboard in an iframe is intentionally
unsupported; deployments that previously relied on such embedding must open it as a top-level page.

## Authentication boundaries

OpenCodex uses three mutually exclusive admission credential classes:

| Credential class | Sources | Allowed surface |
| --- | --- | --- |
| Data plane | `OPENCODEX_API_AUTH_TOKEN`, the `service-api-token` file loaded through `OCX_API_TOKEN_FILE`, and `config.apiKeys` | `/v1/*` HTTP endpoints and new data-plane WebSocket handshakes only |
| Management plane | `OPENCODEX_ADMIN_AUTH_TOKEN` or the independent protected `admin-api-token` file | `/api/*` only |
| GUI session | A short-lived token issued only with a legitimate same-origin local dashboard page | `/api/*` only, bound to the issuing origin |

The service token file remains a delivery mechanism for the data-plane environment token; it is not
a fourth credential class. A management credential that equals any configured data-plane credential
does not enable management access. The data plane may continue to start, but `/api/*` remains closed.
CLI health collection follows the same boundary: `ocx status` and `ocx doctor` use the configured
management credential for `/api/codex-auth/accounts`, never the service/data-plane token. Their
output distinguishes a missing proxy, rejected management authentication, and an unexpected
management response so a reachable `401` cannot be reported as "proxy not running."

Management authentication never has a loopback bypass. If no management credential is available, or
management token creation, validation, or permission hardening fails, every `/api/*` request returns
503 while `/v1/*` and unauthenticated `/healthz` continue to operate. Windows ACL hardening results
must be checked explicitly because an `icacls` timeout is a soft failure in the shared secret helper.

Local dashboard page entry requires a loopback binding, a valid parseable loopback `Host`, and an
exact request origin. A non-loopback dashboard uses the management token flow instead. The server
issues an in-memory session for five minutes, capped at 128 live sessions. The session is bound to the
exact protocol, host, and port; state-changing requests additionally require the session CSRF token.
The dashboard never attaches its management session to `/v1/*` requests, and pages containing a
session bootstrap are served with `Cache-Control: no-store`.

Proxy admission credentials must never reach an upstream provider. The forwarding guard rejects the
`ocx_data_`, `ocx_admin_`, and `ocx_session_` prefixes, historical keys matching
`^ocx_[0-9a-f]{40}$`, both environment tokens by constant-time comparison, and manually configured
data keys by constant-time comparison.

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
| Config/settings | Read safe config/settings views; mutate supported settings only. Full `PUT /api/config` is disabled so masked secrets are not round-tripped. `PUT /api/settings` accepts `codexAutoStart`, `streamMode`, and/or integer `appOwnedMemoryBudgetMb` (64..4096; each optional, at least one required). Budget changes synchronously enforce the process-wide evictable retained-state cap; this is separate from RSS/native memory. `streamMode` persists the #314 stream-shape selection in config.json (Windows services need persisted input; macOS eager relay is explicit-only). |
| Startup safety | `GET /api/startup-health` reports whether injected Codex routing is restart-safe, with secret-free service/shim diagnostics. `POST /api/startup-action` provides allowlisted one-click installation for the background service or launcher shim. On Windows a healthy script shim is CLI-only; Codex Desktop requires the background service for full protection. |
| Windows tray | `GET/POST /api/windows-tray` controls an owned, per-user HKCU login tray. The tray delegates fixed actions to the CLI and is never a proxy supervisor or restart-protection signal. |
| Updates | `GET /api/update/check`, `POST /api/update/run`, and `GET /api/update/status` own dashboard self-update state. A launched worker PID is persisted in `update-job.json`; dead PIDs recover immediately, while legacy active records without a PID recover only after ten minutes. Live PIDs remain exclusive regardless of record age. `GET /api/update/badge` backs the sidebar badge: it reports that an update exists and links to the update surface rather than gating other actions. |
| Providers | Create/update/delete ordinary provider configs and enrich registry metadata. The reserved `openai` card exposes Pool(default)/Direct account mode; `openai-apikey` remains the separate API route. |
| Models | Fetch routed model lists, disabled model visibility, and catalog-facing ids. |
| OAuth | Login/status/logout for OAuth-backed providers, plus multiauth account management: `GET /api/oauth/accounts`, `PUT /api/oauth/accounts/active`, `PUT /api/oauth/accounts/alias`, `DELETE /api/oauth/accounts` list masked accounts per provider, switch the active one, edit its display-only alias, and remove one. The login flow itself is `GET /api/oauth/providers`, `POST /api/oauth/login`, `POST /api/oauth/login/code`, `POST /api/oauth/login/cancel`, `POST /api/oauth/logout`, and `GET /api/oauth/status`; pool controls are `GET/PUT/PATCH /api/oauth/accounts/pool` and `POST /api/oauth/accounts/clear-cooldown`. Login accepts `addAccount: true` to force a fresh browser identity. Device flows return a structured `deviceCode`; the GUI highlights and copies it before the user opens the verification page. |
| Key providers | `GET /api/key-providers` exposes API-key provider presets for setup and dashboard flows, and `GET/POST/DELETE /api/keys` owns the proxy's own admission keys. Multi-key pool per key-auth provider: `GET /api/providers/keys`, `POST /api/providers/keys`, `PUT /api/providers/keys/active`, `PUT /api/providers/keys/alias`, `DELETE /api/providers/keys` masked list, add (upsert + activate), switch, rename, and remove keys. `provider.apiKey` always mirrors the active pool entry so routing stays single-key. |
| OpenAI account mode | Report one OpenAI Codex card with Pool/Direct controls and one API-key card. Mode PATCH persists live without restart or catalog identity changes; Pool owns account/quota controls and Direct uses caller/main login only. Main-account DTOs report real credential presence and terminal `needsReauth` state instead of treating missing/invalid native auth as an unknown quota. |
| Subagents | Read/write the featured `subagentModels` list capped at five ids. `GET/PUT /api/injection-model` manages the shared delegation model/effort selection, the independent OpenCodex guidance switch, and the default-off `syncCodexSubagentDefaults` opt-in for native Codex subagent defaults. When OpenCodex owns the active Codex routing, native `[agents]` defaults apply to newly created Codex tasks after sync/restart; external user-managed provider configs remain untouched. The defaults do not cause delegation and preserve existing user-owned defaults rather than overwriting them. PUT is partial-update: absent keys are unchanged, `null` clears, and non-object bodies are rejected with 400 before field validation. `syncCodexSubagentDefaults: true` requires a nonblank `model` and a supported Codex reasoning effort when effort is set; clearing `model` (null/empty) always clears effort and disables native-default sync even when the stored effort was invalid. |
| V2 / Multi-agent mode | `GET/PUT /api/v2` — reports/sets the codex `multi_agent_v2` feature flag, the 3-state `multiAgentMode` override (`v1`/`default`/`v2`), and the logical maximum thread count. Selecting `v2` enables the native flag and migrates `[agents] max_threads` to the v2 key; selecting `v1` disables it and migrates the same value back. `default` leaves the native flag unchanged. PUT accepts `enabled`, `multiAgentMode`, and/or the compatibility-named `maxConcurrentThreadsPerSession`; contradictory mode/flag pairs are rejected before writes. Every transition is rollback-safe and resyncs the catalog. |
| Logs & Debug | One sidebar entry (`/#logs`) with two tabs. Logs tab: request/runtime logs for local diagnosis. Debug tab (`/#logs/debug`; legacy `/#debug` deep links redirect there): provider + usage toggles, refresh/follow log viewer. `GET/PUT /api/debug`; `GET /api/debug/logs` and `GET /api/debug/usage-logs` (monotonic `after` cursor, legacy `since` accepted). CLI: `ocx debug provider|usage …` (both streams via running proxy API). |
| Usage | `GET /api/usage` aggregate read-only summary derived from `~/.opencodex/usage.jsonl`; measured / reported / unreported / unsupported / estimated counts, daily zero-filled grid, model and provider breakdowns. Never exposes prompts. |
| System | `POST /api/system/restart` restarts the proxy in place. `GET /api/system/memory` — service-process runtime/memory identity (pid, Bun version/revision, platform, RSS/heap/external/ArrayBuffers scalars, observed memory = max(RSS, external, ArrayBuffers), `bun:jsc` heap context, streamMode + eager-relay gate decision, watchdog snapshot sliced to the last 60 samples) plus privacy-safe `appOwnedBytes` retained-store totals/counters under static store ids. Scalar-only payload; rides the standard management auth gate and must never move to unauthenticated `/healthz`. Consumed by `ocx doctor`'s Memory/runtime section and the dashboard Memory observability card. |
| Stop | `POST /api/stop` — restore native Codex, stop any installed service, and exit the proxy. |
| Diagnostics/sync | `src/server/management/config-routes.ts` — `GET /api/diagnostics/project-config` reports project-level Codex config that bypasses managed routing; `POST /api/sync` re-runs catalog/config sync. The diagnostic reports the bypass; it does not rewrite the project file. |
| Sidecar/shadow-call settings | `src/server/management/config-routes.ts` — `GET/PUT /api/sidecar-settings` and `GET/PUT /api/shadow-call-settings`. PUT accepts model and backend plus optional `webSearch.reasoning` and `vision.maxDescriptionsPerTurn`; the read and PUT-response payload reports model, backend, and the vision per-turn limit. Credentials live in the provider and OAuth stores instead. Both shadow-call responses also report the resolved `sourceModels` — the prefixes the runtime actually intercepts (`src/lib/shadow-call.ts`, default `gpt-5.4-mini` + `gpt-5.6-luna`), so no client hard-codes a helper slug that a Codex release can invalidate. |
| Storage | `src/server/management/logs-usage-routes.ts` — `GET /api/storage`, `POST /api/storage/cleanup/preview` and `/api/storage/cleanup`, `GET /api/storage/trash`, `POST /api/storage/trash/restore`, and `GET/PUT /api/storage/cleanup-policy` plus `POST /api/storage/cleanup-policy/run`. `GET /api/storage/cleanup-policy/test-stream` and `GET /api/storage/trash/restore/test-stream` exist for progress-stream testing. Cleanup takes an explicit `mode`: `quarantine` moves to trash and is restorable, `permanent` is not. The caller must name the mode — there is no default that silently deletes. |
| Provider quotas and tests | `src/server/management/provider-routes.ts` — `GET /api/provider-quotas`, `POST /api/providers/test`, `GET/PUT /api/provider-context-caps`, `GET /api/provider-presets`. A quota read may be served from cache or force-refreshed; absent quota data is reported as unknown rather than as a measured zero. |
| Models and visibility | `src/server/management/model-routes.ts` — `GET /api/models`, `PUT /api/disabled-models`, `PUT /api/model-visibility`, `PUT /api/selected-models`, `GET/POST /api/custom-models`. Visibility writes trigger catalog sync through the owning server path. |
| Effort and fallback | `src/server/management/agent-settings-routes.ts` — `GET/PUT /api/effort-caps`, `/api/subagent-models`, `/api/subagent-model-fallback`. Caps clamp; they do not reject. |
| Grok and Claude integrations | `src/server/management/agent-settings-routes.ts` — `GET /api/grok`, `PUT /api/grok/selection`, `POST /api/grok/apply`, `GET/PUT /api/claude-desktop`, `POST /api/claude-desktop/apply`, `GET /api/claude-desktop/status`, `GET/PUT /api/claude-code`. Apply writes an external app's profile, so its status probe must read the same resolved path it writes (see [`04_transports-and-sidecars.md`](04_transports-and-sidecars.md)). |
| Combos | `src/server/management/combo-routes.ts` — `GET/PUT/DELETE /api/combos` own provider combination and failover definitions. |
| Codex accounts | `src/codex/auth-api.ts` — `GET/POST/DELETE /api/codex-auth/accounts`, `PUT /api/codex-auth/accounts/alias`, `PUT /api/codex-auth/accounts/pause`, `PUT /api/codex-auth/accounts/pause-exhausted`, `POST /api/codex-auth/accounts/clear-cooldown`, `GET/PUT /api/codex-auth/active`, `PUT /api/codex-auth/auto-switch`, `PUT /api/codex-auth/pool-strategy`, `PUT /api/codex-auth/failover`, `GET /api/codex-auth/quota`, `GET /api/codex-auth/reset-credits` with `POST /api/codex-auth/reset-credits/consume`, and the login flow `POST /api/codex-auth/login`, `POST /api/codex-auth/login/code`, `POST /api/codex-auth/login/cancel`, `GET /api/codex-auth/login-status`. Account ids are opaque handles and are serialized so the GUI can address an account; emails are masked and tokens are never serialized. |
| Sidebar | `src/server/management/sidebar-routes.ts` — `GET/POST /api/github/star` and `GET /api/update/badge`. Sidebar state is cosmetic; a failed fetch degrades silently. |
| Logs | `src/server/management/logs-usage-routes.ts` — `GET /api/logs`, `GET /api/claude/inbound-debug`, and `GET /api/debug/injection-logs` join the debug streams described above. |

Provider writes must not round-trip masked API keys as real secrets. Dashboard actions that change
model visibility or subagent selection should trigger catalog/cache sync behavior through the server
path that owns it.

The UI must show one provider card and one Models group for Codex-login OpenAI, describe Pool and
Direct accurately, and keep the main account inside Pool. Public model state keeps virtual Pro ids
even though transport logs may additionally report the resolved base model. Detailed rules live in
[`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).

User aliases are display metadata only. Codex pool aliases live on `CodexAccount`, OAuth aliases on
`ProviderAccount`, and API-key aliases reuse the existing key `label`; account ids, credential
identity, active selection, and routing never consult these fields. The matching CLI is
`ocx account alias <provider> <id> <display-name|->` (`rename` is accepted as a synonym).

## Sidebar stop button

The dashboard sidebar includes a stop button that calls `POST /api/stop`. The button shows a
confirmation prompt, then fires the request and accepts the connection drop (the proxy exits). The
endpoint restores native Codex config, stops any installed service to prevent respawn, and exits.

## Startup safety

**Startup safety** is reachable by route (`/#startup`) and rendered by the app, but it is not a
sidebar entry: it is entered from the dashboard's startup-state row, which links there whether the
current state needs remediation or merely reports how routing is protected. Its warning state is derived from active
Codex routing plus the actual service and launcher-shim installation state; the
`codexAutoStart` preference alone is never presented as proof of restart protection. The page shows
copyable repair commands (`ocx service install`, `ocx codex-shim install`, and `ocx restore`). On
Windows it can also install an owned, per-user system tray. The resident tray owns only its icon,
home-scoped singleton, and HKCU Run registration; fixed proxy actions delegate to the CLI so drain,
service conflict handling, native restore, and PID identity remain centralized. Tray presence never
makes `startup.status` protected.

Windows Task Scheduler create failures must not depend solely on localized `schtasks.exe` text.
When the owned fixed-shape `/create /tn opencodex-proxy /xml ... /f` command exits with status 1,
the effective-token elevation probe may classify it as access denied only when the token is known
to be non-elevated. An unavailable probe remains `other` and cannot trigger UAC. Query, run, delete,
native-service, file-write, and foreign task failures never use this fallback.

```text
[Decision Log]
- 목적과 의도: Make Windows scheduler installation recovery work on non-English systems without broadening the commands that may request UAC.
- 기존 구현 및 제약 조건: Access-denied classification parsed English and German stderr. Chinese OEM output decoded as UTF-8 became mojibake, so the fixed scheduler-create failure lost its machine marker and the dashboard could not select its existing elevation transaction.
- 검토한 주요 대안: Add translations and code-page decoders; elevate every scheduler failure; always launch installation elevated; or combine a native effective-token probe with the already fixed command shape and exit status.
- 선택한 방식: Preserve text detection, then use the native token probe only for status-1 creation of the owned `opencodex-proxy` XML task. Unknown probe results fail closed.
- 다른 대안 대신 이 방식을 선택한 이유: Windows localization and OEM code pages are open-ended, while the token state and owned command shape are stable security signals already bounded by the elevated transaction protocol.
- 장점, 단점 및 영향: Non-English users receive stable guidance and dashboard UAC recovery. A non-permission status-1 failure from the exact owned command may be retried once elevated, but foreign operations cannot cross the elevation boundary and the elevated transaction still fails closed.
```

Dashboard updates persist their detached worker PID before returning success. This lets a later run
distinguish a live installer from a worker that crashed. Records created by older versions do not
have a PID, so they remain exclusive for a conservative ten-minute window before automatic
recovery; operators no longer need to delete `update-job.json` after a dead worker.

```text
[Decision Log]
- 목적과 의도: Prevent a crashed dashboard update worker from permanently blocking every later update.
- 기존 구현 및 제약 조건: The job file was written before spawn, the returned PID was not persisted, and active status had no liveness or freshness check.
- 검토한 주요 대안: Require manual deletion; expire all jobs by age; or persist PID and use age only for legacy no-PID records.
- 선택한 방식: Persist and verify PID liveness, with a ten-minute fallback only for legacy records.
- 다른 대안 대신 이 방식을 선택한 이유: It recovers known-dead workers promptly without allowing a second installer beside a long-running live worker.
- 장점, 단점 및 영향: New jobs self-recover after worker death and spawn failures become visible; legacy crashes may remain blocked for up to ten minutes.
```

## UX boundary

The dashboard is a local control surface, not a separate service. It should reflect the same config
and catalog invariants documented in this folder rather than inventing parallel state.

## Dashboard surfaces

The sidebar exposes eleven pages (`gui/src/App.tsx` `NAV`). Several are workspace shells rather than
single forms, and the shell pattern is the part worth keeping stable:

| Surface | Shape |
| --- | --- |
| Providers | Rail of configured providers plus a detail pane whose tabs are Overview, Models, Usage, then Accounts or API Keys when the provider has an auth surface, then Settings (`gui/src/components/provider-workspace/ProviderDetails.tsx`). |
| API keys | Rail plus per-key detail; masked values only (`gui/src/components/apikeys-workspace/`). |
| Storage | Rail plus cleanup and trash detail (`gui/src/components/storage-workspace/`). |
| Subagents | Featured-roster selection workspace (`gui/src/components/subagents-workspace/`). |
| Combos | Rail, detail panel, and an add flow (`gui/src/components/ComboWorkspace.tsx`). |
| Add provider | Catalog browser plus form and OAuth panes (`gui/src/components/provider-catalog/`, `gui/src/components/AddProviderModal.tsx`). |
| Codex accounts | Account pool cards, add-account flow, switch and reset modals (`gui/src/components/CodexAccountPool.tsx`, `gui/src/components/AddCodexAccountModal.tsx`). |
| Dashboard overview | Overview, Providers, and Models tabs at the page level (`gui/src/pages/Dashboard.tsx`), the 30-day token and coverage stats in the overview head (`gui/src/pages/dashboard-overview-head.tsx`), and the effort-cap, injection, maintenance, sidecar, and memory panels below it (`gui/src/pages/dashboard-overview-panels.tsx`). |

Rail selection is component-local state today, so a reload returns to the workspace's default
selection rather than the previously selected row. An OAuth ToS warning is shown before a login that
requires acceptance (`gui/src/components/OAuthTosWarningModal.tsx`).

The `/#codex-auth` add-account modal has a three-step manual-code UX contract on top of the existing
OAuth polling API: submit request, waiting-for-login completion, and terminal success/failure. Once
`POST /api/codex-auth/login/code` succeeds, the GUI must keep the input disabled, expose an
`aria-live` status message that the code was accepted, and surface repeated `login-status` polling
network failures as a visible warning instead of silently looking idle again.

## Usage accounting

`src/usage/log.ts` writes append-only JSONL to `~/.opencodex/usage.jsonl` with file mode `0o600`.
`src/usage/summary.ts` turns that file into the `/api/usage` shape — totals, daily zero-filled
grid, model and provider breakdowns, and `measured / reported / unreported / unsupported / estimated` counts.
A missing `usage.jsonl` returns a zeroed summary with 200, not an error: a fresh install has no
usage and must not render as a failure. What the shape must never do is present an unmeasured
request as a measured zero — that is what the `measured / reported / unreported / unsupported /
estimated` split exists for, and why coverage is reported alongside totals. The dashboard Usage tab renders the same shape, and the
main Dashboard surfaces a 30d token / coverage summary. The in-memory `requestLog` is capped at
200 entries and is **not** the source of truth for aggregation — the JSONL on disk is.

The management API caches only the compact summary for an exact file revision and query; it never
retains normalized per-request rows after a response. The cache invalidates on any identity, size, or
timestamp change and at the next range expiry or local-day boundary. Rebuilds parse in bounded
batches and yield between them, so unrelated management requests remain serviceable even for a large
existing log. The Dashboard polls its 30-day usage summary independently once per minute, so usage
work cannot delay health/provider/settings state or run every five seconds.

[Decision Log]
- 목적과 의도: Keep dashboard and management requests responsive as `usage.jsonl` grows.
- 기존 구현 및 제약 조건: The JSONL file remains the durable source of truth and may be truncated, replaced, or hand-edited.
- 검토한 주요 대안: Retain normalized rows, maintain a second database, or cache only revision-keyed summaries and cooperatively rebuild them.
- 선택한 방식: Keep only bounded summary results, share full reads by exact file identity, yield during parsing, and poll usage separately at a slower cadence.
- 다른 대안 대신 이 방식을 선택한 이유: It bounds resident heap and avoids a second persistence format while keeping unrelated endpoints responsive.
- 장점, 단점 및 영향: Unchanged queries are cheap and memory stays bounded; a changed large log still consumes rebuild CPU, but cooperatively and at most once per observed revision/query.

For diagnosing upstream-shape / usage-extraction issues run `ocx debug usage on` (or set
`OPENCODEX_USAGE_DEBUG=1` before start). The proxy then writes a rolling debug record per finalized
request to `~/.opencodex/usage-debug.jsonl` (mode `0o600`, auto-trimmed to the most-recent 100 lines
once it exceeds 200) with the upstream content-type, body kind (`sse / json / other / none`), a 2KB
body sample, and the extracted usage. Off by default; the hot path is guarded so production stays
untouched.

## Provider debug logging

Provider transport diagnostics (dropped SSE frames, adapter dial/stream events, etc.) are opt-in:
`ocx debug provider on` / `ocx debug provider off` on the running proxy, the Debug-page toggle, or `OCX_DEBUG=1` on
the next start (legacy `OCX_DEBUG_FRAMES` still enables the same path). Lines
use the `[ocx:<adapter>:<event>]` prefix, go to the proxy terminal, and are buffered for
`ocx debug provider logs` / `ocx debug provider logs -f`. Usage JSONL tails with
`ocx debug usage logs [-f]`. Separate from provider buffered logs above.
