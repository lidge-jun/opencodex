---
title: Management API
description: Authentication, errors, and endpoint reference for the opencodex control plane.
---

The Management API is opencodex's control plane. The dashboard at
`http://localhost:10100` is one client of it; headless `ocx` provider, model, combo, account,
settings, diagnostics, and lifecycle commands are clients too. The API is available only while the
proxy is running.

Use the [Web Dashboard](/guides/web-dashboard/) for an interactive client, or this reference when
building automation. Persistent values ultimately follow [Configuration](/reference/configuration/).

## Authentication model

The Management API has its own admin credential, independent of data-plane API keys. At startup,
opencodex resolves it in this order:

1. `OPENCODEX_ADMIN_AUTH_TOKEN`, when set.
2. A generated `ocx_admin_*` token in a hardened secret file.

The file-backed token is accepted only after its directory and file permissions or ACLs have been
hardened. If that cannot be guaranteed, management authentication fails closed and the API returns
503 until an environment token is supplied or the file state is repaired.

Send the admin token in either form:

```http
X-OpenCodex-API-Key: <admin-token>
```

```http
Authorization: Bearer <admin-token>
```

:::caution
The admin token must differ from every data-plane credential. Startup rejects a management
credential that conflicts with a proxy admission key. Do not put the admin token in Codex,
Claude Code, or another model client; it authorizes control-plane mutations.
:::

### Loopback dashboard sessions

On a loopback bind, the dashboard bootstrap can receive a short-lived `ocx_session_*` credential.
Each session lasts five minutes and is bound to the exact dashboard origin. Safe requests must
match that origin. Unsafe methods also require the browser `Origin` and the session's CSRF token.

Session issuance is disabled whenever data-plane authentication is required, which includes remote
binds. A remote operator must authenticate with the raw admin token; no loopback-style GUI session
is minted.

## Common errors

All endpoint rows below inherit these boundary errors. The “Notable errors” column lists additional
route-specific results rather than repeating this table.

| Status | Type or code | Meaning |
| --- | --- | --- |
| 401 | `opencodex admin token required` | The admin token or GUI session is missing, invalid, expired, origin-mismatched, or missing CSRF evidence |
| 403 | `cross-origin request blocked` | The request origin is outside the management allowlist |
| 404 | `not_found` | No management route matched the method and path |
| 413 | `request body too large` | A POST, PUT, or PATCH body exceeds the 2 MiB management limit |
| 503 | `management API unavailable` | Admin credential initialization or hardening is unavailable |
| 503 | `oauth_mutation_busy` | Another OAuth credential mutation holds the writer; response includes `Retry-After: 1` |
| 503 | `catalog_busy` | Catalog gathering is already at capacity; response includes `Retry-After: 1` |

## Endpoint matrix

### Agent and client settings

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET, PUT /api/v2` | Read or change native multi-agent v2 mode and thread settings | 400 invalid settings; 502 transition or persistence failure |
| `GET, PUT /api/injection-model` | Read or set the injected sub-agent model, effort, prompt, and guidance settings | 400 invalid model, effort, or body |
| `GET, PUT /api/effort-caps` | Read or set global and sub-agent reasoning-effort ceilings | 400 invalid ladder value |
| `GET, PUT /api/subagent-models` | Read or order the models advertised to sub-agents | 400 invalid list or more than five models |
| `GET, PUT /api/subagent-model-fallback` | Read or set the ordered fallback chain and poll interval | 400 invalid list or poll interval |
| `GET /api/grok` | Read Grok managed-config status and candidate models | 400 status read failure |
| `PUT /api/grok/selection` | Persist the excluded Grok models | 400 invalid or oversized selection |
| `POST /api/grok/apply` | Apply persisted Grok configuration through the managed sync | 409 `grok_apply_busy`; 400/500 apply failure |
| `GET, PUT /api/claude-desktop` | Read or persist the Claude Desktop routed/native profile | 400 invalid or unavailable assignment |
| `POST /api/claude-desktop/apply` | Write the saved profile to Claude Desktop's managed config | 400/500 write failure |
| `GET /api/claude-desktop/status` | Inspect saved-versus-applied profile and Desktop health | 400 status read failure |
| `GET, PUT /api/claude-code` | Read or update Claude Code gateway, auth-mode, model-map, context, agent, and sidecar settings | 400 invalid field or shape |

For the concepts behind the model roster and encrypted worker-task behavior, see
[Sub-agent Surface](/guides/sub-agent-surface/).

### Combos

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/combos` | List normalized combos and their public model ids | Catalog work can return `catalog_busy` |
| `PUT /api/combos` | Create, replace, or rename one combo | 400 invalid id, target, config, rename, or ordinary collision; 409 Codex-account namespace collision |
| `DELETE /api/combos?id=...` | Delete one combo and clear its selection/cooldown state | 400 missing id; 404 unknown combo |

See [Combos](/guides/combos/) for target strategies, cooldowns, aliases, and routing failures.

### Configuration, startup, sync, and updates

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/config` | Return the redacted, management-safe configuration DTO | — |
| `PUT /api/config` | Disabled full-config replacement guard | 405; use focused endpoints instead |
| `GET, PUT /api/settings` | Read runtime/startup settings or update auto-start, stream mode, app-owned memory budget, and `codexAccountPickerEnabled` | 400 invalid, non-object, or empty update |
| `GET /api/startup-health` | Read cached service/shim startup health | — |
| `POST /api/startup-action` | Install or repair the service or Codex shim | 400 invalid action; 500 action failure |
| `GET, POST /api/windows-tray` | Read Windows tray state or install/start/stop/uninstall it | 400 unsupported platform/action; 500 operation failure |
| `GET /api/diagnostics/project-config` | Read cached project configuration warnings | — |
| `POST /api/sync` | Sync the current model catalog into Codex | 500 failed sync |
| `GET /api/update/check` | Check the `latest` or `preview` update channel | 400 invalid tag |
| `POST /api/update/run` | Start an update job, optionally followed by restart | 400 invalid body; job-specific conflict/error status |
| `GET /api/update/status` | Poll an update job by id | 404 unknown job |
| `GET, PUT /api/sidecar-settings` | Read or update web-search and vision sidecar model/backend settings | 400 invalid shape, backend, or limit |
| `GET, PUT /api/shadow-call-settings` | Read or update shadow-call interception settings | 400 invalid shape or value |

### Logs, usage, and storage

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/logs` | Query filtered in-memory request logs | — |
| `GET, PUT /api/debug` | Read debug flags; set, clear, or reset capture categories | 400 invalid or empty update |
| `GET /api/debug/logs` | Read bounded provider/debug log entries | — |
| `GET /api/debug/usage-logs` | Read bounded usage-debug entries | — |
| `GET /api/debug/injection-logs` | Read bounded guidance-injection debug entries | — |
| `GET /api/claude/inbound-debug` | Read Claude inbound debug state and entries | — |
| `GET /api/usage` | Stream the complete usage ledger into compact aggregates, then incrementally fold verified appends; summarize by range and client surface, with a Codex `accounts` breakdown keyed by stable non-PII log labels | Returns an `error: "read_failed"` summary if storage cannot be read |
| `GET /api/storage` | Scan Codex storage usage by bucket | Returns an `error: "scan_failed"` payload on scan failure |
| `POST /api/storage/cleanup/preview` | Preview archived-session cleanup and return a binding digest | 400 `invalid_json` or `invalid_percent` |
| `POST /api/storage/cleanup` | Quarantine or permanently remove the previewed archived set | 400 invalid input; 409 stale/busy/referenced state; 500 filesystem/database failure |
| `GET /api/storage/trash` | List quarantined cleanup entries | 500 `trash_list_failed` |
| `POST /api/storage/trash/restore` | Restore one quarantined entry | 400 invalid id; 404 missing trash; 409 busy/destination conflict; 500 restore failure |
| `GET /api/storage/trash/restore/test-stream` | Test-only restore stream hook | 404 `not_available` when test hooks are off |
| `GET, PUT /api/storage/cleanup-policy` | Read or update scheduled cleanup policy and job state | 400 invalid policy |
| `POST /api/storage/cleanup-policy/run` | Start a manual cleanup-policy run | 409 `already_running`; 500 `cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` | Test-only policy stream hook | 404 `not_found` when unavailable |

`GET /api/usage` reads `~/.opencodex/usage.jsonl` from the beginning through the current ledger
snapshot on a cold start. It processes fixed 1 MiB chunks and retains compact aggregate state rather
than every normalized request row. Later refreshes validate the previous line boundary and fold only
newly appended complete rows. Concurrent callers share the same refresh. Range and surface predicates
are applied to the complete aggregate, so the former read-byte window and parsed-row cap cannot omit
an earlier file prefix from 7-day, 30-day, or all-history totals. `managementUsageMaxReadBytes` remains
accepted for compatibility with bounded legacy readers, but changing it no longer expands or reduces
the history summarized by this endpoint.

The runtime ledger is append-only. Replacing or truncating it, or changing local pricing/time-zone
inputs, triggers a complete rebuild. If you manually edit an older row in place while the proxy is
running, restart the proxy (or replace the file) before relying on the new total; incremental refreshes
verify the append boundary, not every previously aggregated byte.

The response still includes `historyTruncated`, `truncatedPrefixBytes`, `entriesTruncated`, and
`entriesDropped` so older clients can consume the same wire shape. A successful whole-ledger scan
reports `false`, `0`, `false`, and `0`, respectively. These are legacy compatibility fields, not a
signal that the endpoint read only a configured-size tail.

For `GET /api/usage?range=30d&surface=codex`, `accounts` contains one row per observed Codex
pool label. Each row reports `accountLogLabel`, token totals, `usageCoverageRatio`, and an optional
`estimatedCostUsd` based on the currently configured display pricing. Active user `modelCosts`
overlays take priority over bundled verified catalog and price fallbacks, and historical usage is
re-estimated from the pricing active when the summary is read. This is an API-equivalent estimate,
not a subscription charge. New main-pool requests use the reserved `main` label; legacy bare
`openai` rows remain in an ambiguous bucket instead of being reassigned from current configuration.

Rows in `models`, `providers`, and `days[].models` also carry `cacheHitRate`: the share of input
tokens served from the provider's prompt cache, clamped to `[0, 1]`. It is `null` — never `0` —
when the provider reported no cache telemetry or the row has no input tokens, because "no cache
data" and "a genuine 0% hit rate" are different facts and a chart that renders them alike is
misleading.

:::caution
Storage cleanup endpoints can move or permanently remove archived session data. Always preview
first and submit the returned digest. Prefer quarantine when recovery may be needed.
:::

### Models and catalog

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/catalog` | Return the installed Codex catalog document. Remote clients should prefer the data-plane `GET /v1/catalog`, which still requires an ordinary data-plane credential but not an admin token. | 404 catalog not found |
| `GET /api/models` | Return the dashboard/CLI model rows | `catalog_busy` when gathering is saturated |
| `GET /api/client-config?client=...` | Build a read-only client config for any supported file integration | 400 unsupported client; 503 catalog unavailable |
| `PUT /api/disabled-models` | Replace the shared disabled-model list | 400 invalid JSON |
| `PUT /api/model-visibility` | Atomically change provider- or model-level visibility | 400 invalid provider, scope, target, or body |
| `GET, POST /api/custom-models` | List custom models or add one | 400 invalid fields; 404 provider missing; 409 duplicate model |
| `PUT, DELETE /api/custom-models/{id}` | Edit or delete one custom model | 400 invalid id/fields; 404 not found; 409 duplicate model |
| `GET, PUT /api/selected-models` | Read provider allowlists and availability, or replace one allowlist | 400 missing provider/body; 404 unknown provider |

### OAuth accounts, provider keys, and data-plane keys

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/oauth/providers` | List providers with public OAuth login flows | — |
| `GET /api/key-providers` | List providers configured through API-key login | — |
| `POST /api/oauth/login` | Start an OAuth login or account-add flow | 400 unknown/invalid provider; `oauth_mutation_busy` |
| `POST /api/oauth/login/code` | Submit a manual callback URL or authorization code | 400 invalid provider/code; `oauth_mutation_busy` |
| `POST /api/oauth/login/cancel` | Cancel a public in-progress OAuth flow | 400 unknown provider |
| `GET /api/oauth/status` | Poll one provider's OAuth flow | 400 unknown provider |
| `POST /api/oauth/logout` | Remove the selected provider credential | 400 unknown provider; `oauth_mutation_busy` |
| `GET, DELETE /api/oauth/accounts` | List masked accounts or remove one account | 400 invalid provider/id; 404 account missing; `oauth_mutation_busy` |
| `PUT /api/oauth/accounts/active` | Select the active OAuth account | 400 invalid provider/account; `oauth_mutation_busy` |
| `GET, PUT, PATCH /api/oauth/accounts/pool` | Read or update Anthropic OAuth pool policy | 400 non-Anthropic provider or invalid policy |
| `POST /api/oauth/accounts/clear-cooldown` | Clear one OAuth account's runtime cooldown | 400 invalid provider/account |
| `PUT /api/oauth/accounts/alias` | Set or clear an OAuth account alias | 400 invalid provider/account/alias |
| `GET, POST, DELETE /api/providers/keys` | List masked provider keys, add/activate one, or remove one | 400 invalid input; 404 provider/key missing |
| `PUT /api/providers/keys/active` | Select a provider's active key | 400 invalid input; 404 provider/key missing |
| `PUT /api/providers/keys/alias` | Set or clear a provider-key alias | 400 invalid input; 404 provider/key missing |
| `GET, POST, PATCH, DELETE /api/keys` | List, create, edit, or delete data-plane admission keys | 400 invalid body/id; 404 key missing |

Credential list responses are deliberately masked. OAuth access tokens and complete provider API
keys are not returned to dashboard clients.

### Providers

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/providers` | List redacted provider configuration and discovery state | — |
| `POST /api/providers` | Add or replace one validated provider and optionally make it default | 400 invalid/dangerous destination or config; 409 namespace collision |
| `PATCH /api/providers?name=...` | Update allowed provider fields (including a merged `headers` block), enabled/default state, or OpenAI account mode | 400 invalid field or transition; 404 unknown provider |
| `DELETE /api/providers?name=...` | Delete a provider, reassigning the default when possible | 404 unknown provider; 409 `last_provider`; 409 `provider_has_dependent_combos` |
| `POST /api/providers/test?name=...` | Perform a bounded live provider connectivity/model-discovery probe | 404 unknown provider; failures are normally returned as `ok: false` evidence |
| `GET /api/provider-quotas` | Read provider quota reports; `refresh=1` forces refresh | — |
| `GET, PUT /api/provider-context-caps` | Read or update global, all-provider, or one-provider context caps | 400 invalid request; 404 unknown provider |
| `GET /api/provider-presets` | Return GUI provider presets derived from the runtime registry | — |

`provider_has_dependent_combos` is a safety barrier: remove or edit the dependent combos before
deleting their provider.

### Sidebar and consent-bound actions

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/github/star` | Read repository star status through the user's `gh` session | Status-specific fixed result codes |
| `POST /api/github/star` | Star the repository only from an authenticated human action | 403 `agent_consent_required` for agent-driven callers without dashboard-session evidence |
| `GET /api/update/badge` | Read the cheap sidebar update-badge state | — |

:::caution
Management authentication proves access to the proxy; it does not prove consent to spend the
user's identity. An agent must not route around `agent_consent_required`. The user must choose
whether to star the repository.
:::

### System lifecycle

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET /api/system/memory` | Return scalar process, heap, stream, response-state, watchdog, and active-turn metrics | — |
| `POST /api/system/restart` | Begin a drain-aware process restart without removing client injection | Returns 202; repeated calls report the existing drain |
| `POST /api/stop` | Stop the service, restore native Codex, remove managed Grok injection, and drain the proxy | 409 service ownership conflict; 409 `respawnable_service` when a Windows Task Scheduler wrapper could respawn the proxy and the caller is not `ocx stop` (nothing is changed); 409 when the installed manager refuses to stop; 409 `service_state_unknown` when the Task Scheduler state cannot be read (nothing is changed; repair the query and retry) |
| `GET /api/system/codex-app-server` | Report whether running Codex app-servers predate the current model catalog | — |
| `POST /api/system/codex-restart` | Refresh the catalog, then ask stale Codex app-servers to exit so the model picker reloads | Returns 200 with `code: partially_stopped` when a target survives |

### Codex authentication delegation

`GET /api/settings` reports the effective `codexAccountPickerEnabled` boolean. A `PUT` containing
that strict boolean initializes privacy-safe account selectors when enabling an empty map, preserves
existing selector labels when disabling or re-enabling, persists first, and then requests one bounded
catalog convergence only when effective picker visibility changed. The successful response includes
`catalogRefreshPending`: `false` means the catalog commit completed (or no refresh was needed), while
`true` means the setting was saved but `POST /api/sync` should be used to retry the catalog refresh.
Persistence or selector-allocation failure rolls the in-memory settings back and does not run
convergence.

The root management dispatcher delegates every `/api/codex-auth/*` request to the Codex account
manager. Its routes are:

| Method and path | Purpose | Notable errors |
| --- | --- | --- |
| `GET, POST, DELETE /api/codex-auth/accounts` | List/refresh or delete Codex accounts. POST is retained as a disabled compatibility endpoint; successful DELETE responses include `catalogRefreshPending`. | POST always returns 403 `manual_import_disabled`; 400 invalid DELETE input |
| `PUT /api/codex-auth/accounts/alias` | Set or clear an account alias | 400 invalid account/alias |
| `PUT /api/codex-auth/accounts/pause` | Pause or resume one account | 400 invalid account/state; 404 missing account |
| `PUT /api/codex-auth/accounts/pause-exhausted` | Pause accounts whose quota is exhausted | Mutation-lock failures become 503 |
| `POST /api/codex-auth/accounts/clear-cooldown` | Clear runtime cooldown for one account or all accounts | 400 invalid id |
| `GET, PUT /api/codex-auth/active` | Read or select the active account | 400 invalid or missing account; 409 paused/legacy-row conflict |
| `PUT /api/codex-auth/auto-switch` | Set the quota threshold for automatic account switching | 400 invalid threshold |
| `PUT, PATCH /api/codex-auth/pool-strategy` | Update Codex account-pool selection strategy | 400 invalid strategy/config |
| `PUT /api/codex-auth/failover` | Set the account failover threshold | 400 invalid threshold |
| `GET /api/codex-auth/quota` | Read cached quota state by account | — |
| `GET /api/codex-auth/reset-credits` | Inspect reset-credit eligibility for an account | 400 missing account id; upstream status passthrough; 500 lookup failure |
| `POST /api/codex-auth/reset-credits/consume` | Consume an eligible reset credit | 400 missing account id; upstream status passthrough; 503 `server_busy`; 500 consume failure |
| `POST /api/codex-auth/login` | Start Codex login or reauthentication | 400 invalid request; conflict/busy login states |
| `POST /api/codex-auth/login/code` | Submit a manual code for a Codex login flow | 400 invalid flow/code |
| `POST /api/codex-auth/login/cancel` | Cancel a Codex login flow | — |
| `GET /api/codex-auth/login-status` | Poll a flow or account login state. A completed new-account flow includes `catalogRefreshPending: true` only when recovery is needed. | Unknown flows report `expired`; no active flow reports `idle` |

If a new account config row is saved but credential setup cannot finish, OAuth `login-status` reports
`status: "error"` with
`code: "codex_credential_persistence_failed"`, `accountId`, `needsReauth: true`, and optional
`catalogRefreshPending: true`; storage-error details are not exposed. The account row remains saved:
reauthenticate or delete it before retrying account creation.

Configuration-writer or credential-refresh lock timeouts under this delegated family return HTTP
503 with code `CONFIG_MUTATION_LOCK_UNAVAILABLE`. Clients should retry shortly rather than treating
that response as a permanent account failure.

Account creation and deletion commit credentials/configuration before catalog convergence. A failed or
deferred catalog attempt never rolls back the durable account mutation and never reflects internal
provider, account, path, or credential details; clients receive only the completion boolean. Deleting
an account retains its selector binding so exact routes fail closed while the account is absent and the
same selector is restored if that account id is added again.

## Choosing a client

For ordinary administration, the [Web Dashboard](/guides/web-dashboard/) gives the safest guided
workflow. For headless hosts and automation, use the corresponding `ocx` commands: they call this
same live API and return a nonzero result when the proxy is unreachable or the operation fails.
Direct HTTP is most useful for integrations that need the exact endpoint contracts above.

## Remote sessions and data-key rotation

`POST /api/keys/rotate {id}` starts a ten-minute overlap and returns the new data secret once. `POST /api/keys/rotate/commit {id,rotationId}` commits it; `DELETE /api/keys/rotate {id,rotationId}` aborts it. All require management authentication; data keys cannot call them. `POST /api/session/logout` requires the current `gui-session`, matching Origin, and CSRF. An admin token receives 403 and can never mint or exchange into a consent session.
