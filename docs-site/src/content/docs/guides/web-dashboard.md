---
title: Web Dashboard
description: The opencodex GUI for proxy health, providers, models, delegation guidance, auth pools, usage, and logs.
---

opencodex ships a local web dashboard (a Vite/React app under `gui/`) served from the proxy. It is the
shortest path to managing providers, Codex/ChatGPT accounts, catalog models, sidecars, sub-agent
settings, and request traffic.

## Opening it

```bash
ocx gui
```

This opens `http://localhost:<port>` in your browser, auto-starting the proxy first if needed. In
development you can run the GUI dev server separately against a running proxy:

```bash
ocx start
bun run dev:gui
```

## Sign-in

On the default loopback bind (`localhost` / `127.0.0.1`) the dashboard never asks for a token:
the proxy mints short-lived GUI sessions into the served page and renews them silently when
they expire or the proxy restarts. Only a dashboard bound to a non-loopback hostname requires
the admin token (`OPENCODEX_ADMIN_AUTH_TOKEN`, or the auto-generated
`~/.opencodex/admin-api-token` file).

When a remote dashboard needs that credential, it presents a standard password form so a browser
password manager can offer to save and autofill it. The dashboard itself still keeps the token only
in memory and does not write it to `localStorage` or `sessionStorage`; whether it is saved is entirely
the browser or password manager's decision.

### Finding the admin token

You only need this on a non-loopback bind. A local dashboard never asks, and if a local one
*does* ask, the token is not the problem — see [When a local dashboard cannot start a
session](#when-a-local-dashboard-cannot-start-a-session) below.

The proxy generates the token for you the first time it starts. It is not printed anywhere,
by design, so read it from the file:

```bash
cat ~/.opencodex/admin-api-token
```

If `OPENCODEX_HOME` is set, the file lives at `$OPENCODEX_HOME/admin-api-token` instead. On
Windows that is `%USERPROFILE%\.opencodex\admin-api-token`. A generated token looks like
`ocx_admin_` followed by 43 characters; the proxy refuses a file that does not match that
shape rather than silently regenerating one.

To choose the value yourself, set `OPENCODEX_ADMIN_AUTH_TOKEN` before starting the proxy. It
takes precedence over the file, and the file is then neither read nor created. Pick something
distinct from your data-plane credential (`OPENCODEX_API_AUTH_TOKEN` or a configured API key) —
reusing one is rejected.

There is no CLI command that prints the token. `ocx doctor` deliberately reports whether a
credential is present without ever revealing its value.

### When a local dashboard cannot start a session

A dashboard on `localhost` mints its own session, so it will not prompt you for a token. If it
reports that it could not start a session, the cause is the address you are using rather than a
missing credential — the proxy did not recognise the request as loopback. Open the dashboard at
the address the proxy prints on startup (usually `http://127.0.0.1:<port>`), and prefer that exact
host and port over a LAN IP or an alias.

## Dashboard layout

Overview uses matching status cards and full-width settings rows. On wide screens, labels share
one column and model/effort controls share another. On narrower screens, controls move below their
labels in the same reading order. Long version labels are shortened visually; hover the version
badge or the Version card to read the full value.

## What you can do

| Area | What it does |
| --- | --- |
| **Dashboard summary** | Multi-agent mode, online state, version, uptime, provider count, 30-day token total, active providers, and available native/routed models. |
| **Sub-agent delegation** | Choose a native or routed model and optional reasoning effort shared by OpenCodex delegation guidance and the separate native-default opt-in. This is not a proxy-side per-spawn router; see below. |
| **Sidecars** | Choose the web-search model and effort plus the vision-description model. Changes apply on the next request. |
| **Maintenance** | Resync the Codex model catalog, inspect project-local config bypass warnings, check the latest or preview release, and run an update with optional proxy restart. |
| **Startup safety** | Show whether injected Codex routing survives a restart, with separate service and launcher-shim health plus exact repair commands. |
| **Windows tray** | Install a per-user login tray for one-click proxy start, stop, restart, dashboard access, and status. The tray is a controller, not a proxy restart service. |
| **Codex autostart** | Allow an already-installed Codex launcher shim to run `ocx ensure`. This toggle does not install a shim or background service. |
| **Providers** | Add, edit, set the default (enabled providers only), enable/disable, and remove providers; manage OAuth account pools and API-key pools where supported. Removing the current default switches to the first remaining enabled provider when one exists; otherwise deletion is refused and the current default is kept. Provider Settings can disable live model discovery for endpoints with missing, slow, or oversized `/models` catalogs. For Claude (Anthropic) OAuth pools, each logged-in account shows its own 5-hour and weekly rate-limit bars (usage is per credential); a failed probe keeps the last-known bars and marks them unavailable until the next successful refresh. The Provider Overview shown when no provider is selected carries a **Refresh all quotas** control that forces one server-side re-read of every configured provider; a provider whose upstream probe fails keeps its last-good row, so the status line reports that the check completed rather than claiming every value is fresh, and each row's own age stays the per-provider freshness signal. |
| **Add provider** | Search registry-backed presets for account login, API-key services, local servers, or a custom endpoint. |
| **Codex Auth** | Add ChatGPT/Codex pool accounts, select the next-session account, refresh 5h / weekly / 30d quotas, enable or disable quota auto-switch, set its 1–100% threshold, and configure transient-failure failover. |
| **Subagents** | Feature up to five bare native or namespaced routed models in the `spawn_agent` override list. |
| **Models** | Toggle native GPT and routed models, set provider allowlists and context caps, choose v1/base/v2, and configure the v2 thread limit. Configured providers stay visible as zero-model groups when discovery is off or returns no rows. |
| **Logs** | Auto-refresh recent requests with tokens, requested effort and (when available) effective outbound effort, resolved model, provider, status, request id, duration, and error details. The detail view includes the exact reasoning wire field when the adapter emits one. Filter by opaque conversation/session id (when the client sends one) to total tokens and estimated list-price cost for the currently loaded Logs ring. |
| **Usage / Debug** | Inspect token-usage coverage and trends, or enable opt-in provider transport and usage-extraction diagnostics. |
| **Storage** | Read-only CODEX_HOME disk breakdown (sessions, archives, DBs, attachments). Optional archived cleanup: preview the oldest N%, then quarantine to `CODEX_HOME/.trash` (default) or permanently delete behind an explicit checkbox. **Auto-cleanup policy** is opt-in and **default OFF** (`storageCleanupPolicy.enabled`); configure threshold/target/schedule/mode on the Storage page, or trigger **Run now**. Quarantined entries can be restored from the Storage page (JSONL + threads). Active sessions stay read-only. Cleanup and restore are refused while Codex holds the newest/active `state_*.sqlite` locked. |
| **Stop** | Gracefully stop the proxy and installed background service, restore native Codex, and exit (`POST /api/stop`). On Windows with the Task Scheduler backend the dashboard refuses and asks you to run `ocx stop` instead: that wrapper can respawn the proxy after the task ends, and only a stop running outside this process can verify the restart window before restoring your client config. Nothing is changed when it refuses. |

### Filtering request logs

Logs filters combine surface, intercepted requests, provider, exact model, status, time,
speed, and conversation ID over the currently loaded request ring. Provider and model
choices also include fallback attempts; model matching ignores case and surrounding spaces
but does not match partial names. Choices that disappear from the ring reset to All.

Time windows cover the last 15 minutes, hour, or day and refresh every 30 seconds while the
Logs tab is active, even with auto-refresh off. Windows use the proxy timestamp from
the logs response and advance with elapsed browser time, so a different browser clock
does not shift the cutoff. Older proxies without that timestamp retain the browser-clock
fallback until a valid sample is available. Speed uses output tokens per second over the
full request duration: below 15, 15 to below 50, or at least 50. Unavailable speed values are
excluded when a speed filter is active. Success means 2xx; errors mean 4xx or 5xx.

Active filters show the matching count out of the loaded total. Reset filters restores all
rows and returns keyboard focus to the All surface control; “No matching requests”
differs from an empty log ring. Use arrow keys or Home/End in
the surface selector. These controls do not query historical records beyond the loaded ring.

### Linking to a section

There is a single layout, so there is no layout switch to configure. Dashboard sections are
addressable instead: `#dashboard` opens Overview, and `#dashboard/providers` and
`#dashboard/models` open the other two. Reload, bookmark, and Back all keep the section you were
on. **Logs** works the same way with `#logs` and `#logs/debug`. An older `#providers/workspace`
bookmark now lands on `#providers`.

Cost values in **Logs** and **Usage** are API list-price equivalents calculated from reported tokens.
They are not billing receipts or evidence of an actual charge; subscription usage or provider credits
may apply instead.

Provider model rows may include **unresolved requested model usage**: the saved route sent the
requested name unchanged to the default provider. These tokens belong to that serving provider,
not necessarily the vendor named in the request. The dashboard preserves the original name and
usage rather than guessing which model ran. For slash-containing unresolved names, a different
vendor's model price alone is not enough to estimate cost; an exact provider or configured price
still applies. Model shares are calculated within the selected provider. Requests for an unknown
reserved `policy/` name now fail before reaching an upstream provider; historical usage is retained.

The selected provider's **Overview** and **Usage** tabs show **Current account usage** below the
usage statistics. **Accounts** and **API keys** show each supported credential's own quota,
including credit balances. The provider-wide overview still shows pooled capacity where available;
it is not substituted for a missing current-account reading. Unsupported lookup, no passive
observation yet, loading, failed lookup with last-known values, and measured zero are separate
states. **Quota check completed** means the read settled—not that a passive observation became
new or that every upstream measurement was refreshed.

## Model visibility

The **Models** switches show final Codex visibility: a routed model is on only when its provider allowlist includes it (or no allowlist is set) and it is not disabled. Turning a model on reconciles both filters atomically; **All on** clears the provider allowlist so newly discovered models are also on.

### Managing models in a provider workspace

In a provider’s **Models** tab, **Delete** removes the stored custom definition. An underlying
native or live-discovered model may then appear again, so the model count can stay the same.
**Hide** changes catalog visibility only: it does not delete the definition or change direct
routing policy. Use **Manage visibility in Models** to open the **Models** page and restore
visibility, even when the provider tab has no rows left.

**Add** saves a custom definition; it does not clear an existing hide or provider selection rule.
A saved model can therefore remain hidden. If the model is already known, manage its visibility
in **Models**. A confirmed save with a failed catalog refresh is still saved: follow the refresh
message instead of adding it again. If the change cannot be confirmed, refresh the model state
before retrying.

The provider’s model count is the number of unique, non-disabled entries in the current model
inventory returned by the server, before search or display truncation. It is not the provider
allowlist size, a live-discovery count, or proof that an entry was discovered upstream. Selection
badges and discovery information remain separate from that count.

## Delegation picker vs spawn routing

The Dashboard's **Sub-agent delegation** picker stores `injectionModel` and, optionally,
`injectionEffort`. **OpenCodex multi-agent guidance** independently controls the delegation
instructions that use those values. On eligible v2 turns, that guidance tells the parent
agent which exact model and reasoning effort to pass to `spawn_agent`; clearing the model also clears
the stored effort.

The default-off **Use as native Codex subagent defaults** switch applies the same selection to Codex's
native `[agents]` defaults on the next sync/restart when OpenCodex manages the active Codex routing.
External user-managed provider configs remain untouched. Those defaults affect newly created Codex tasks
and do not themselves cause delegation. Existing user-owned `[agents]` defaults are preserved rather
than overwritten, so they may continue to override the requested defaults.

:::caution
Neither control is a proxy-side cross-model spawn router. OpenCodex guidance asks Codex to pass
overrides to `spawn_agent`; native `[agents]` defaults apply only when Codex creates a new task after
they have been synchronized. See
[Sub-agent Surface](/guides/sub-agent-surface/) for the canonical v1/base/v2 behavior.
:::

## Remote Hub sessions, keys, and usage

The dashboard's management plane is separate from direct client→hub model traffic. **Integrations → API Keys** shows pending rotations, displays a replacement secret only once, and requires explicit commit or abort. Browser logout invalidates only the current remote session. Connected usage is the hub store filtered by the client's `apiKeyId`; disconnected usage is local, with no mirroring.

The spawn override guarantee applies to the **built-in** v2 guidance text. A custom
`injectionPrompt` replaces that text entirely and must include `{{model}}` and `{{effort}}`
placeholders (and optionally `{{roster}}`) or those values will not appear in the injected
guidance.

The picker offers enabled native and routed models plus the global Codex effort ladder. The API
validates the selected effort globally; Codex still validates a spawn effort against the target
catalog entry.

## Codex Auth and account pools

The **Codex Auth** page manages the native ChatGPT/Codex route:

Pool mode selects across the main and added Codex accounts; Direct uses only the caller/main login.
In-flight requests keep their captured credentials, and a 401/403 reauthentication or 429 cooldown
may clear affinity and rotate to another eligible Pool account. This is separate from `openai-apikey`
and other providers.

:::caution[Provider-policy responsibility]
The account pool is a technical account-management, routing, and resilience feature. It does not
claim that having multiple accounts is itself prohibited; compliance depends on the account setup and
use pattern. OpenCodex does not endorse using additional accounts to circumvent rate limits, quotas,
plan limits, or other provider restrictions, or sharing account credentials between people. You are
responsible for complying with the provider's current terms for every connected account and use
pattern. Provider restrictions, suspension, or termination are outside OpenCodex's control;
maintainers do not provide policy advice and cannot resolve provider enforcement. Review
[OpenAI's current Terms of Use](https://openai.com/policies/terms-of-use/).
:::

- Manually choosing an account applies immediately: an already-bound thread moves to it on its next
  request, and only requests already in flight keep the account they captured. A manual choice is also
  pinned: the card shows a **PINNED** badge, and a higher selection order cannot preempt that account
  until it is drained, you select another account, or you change any account's selection order.
- Each account card carries a **Selection order** control (First, Earlier, Normal, Later, Last).
  Higher order is used first, and the pool drops to a lower order only once every account above it is
  drained or unavailable. A changed order applies from the next unbound request and never moves a
  thread that is already bound. The Codex Desktop (main) account is ordered like any other, so it can
  be set to **Last** and kept as the reserve. An order set from `ocx account priority` outside those
  five presets stays visible and selectable on the card.
- Thread affinity prevents per-request flapping. With quota auto-switch enabled, a long-running
  thread is periodically re-evaluated and may rebind after its relevant usage reaches the threshold
  and a strictly lower-usage eligible account exists.
- New sessions can choose the lowest-usage eligible account. Paid plans score the hottest known 5h,
  weekly, or 30d window; Go/Free plans use the 30d window only.
- When WHAM supplies `limit_window_seconds`, Codex Auth classifies a primary window of at least 28
  days as 30d instead of assuming every primary window is weekly. Responses without a duration keep
  the legacy weekly interpretation.
- **Refresh quotas** re-reads account usage immediately so routing and the account cards use the same
  values.
- Pool request logs use opaque labels such as `p3fa91c`, never account emails.
- Each account card also shows that stable log label, the observed 30-day token total, an approximate
  API-equivalent cost using currently configured display pricing, and the fraction of attempts with
  measured usage. Active user `modelCosts` overlays take priority over bundled verified catalog and
  price fallbacks, and historical usage is re-estimated from the pricing active when the summary is
  read. The cost is an estimate for reconciliation, not a ChatGPT Plus/Pro subscription invoice.
  Historical bare `openai` rows that predate explicit attribution remain ambiguous rather than being
  assigned to the current main account.
- **Target a specific Codex account from the model picker** is an explicit opt-in. When enabled,
  ordinary supported GPT picker rows are replaced by one entry per public account selector.
  Choosing one locks that conversation to the mapped account: it does not rotate, fall back, or
  change the active Pool account. The built-in Codex App login has its own selector; generated maps
  normally use `main`, with a collision-safe suffix such as `main-2` when needed. Added accounts
  receive stable, privacy-safe labels, and existing custom selector labels are preserved.
  Existing conversations and saved model selections continue routing. Turning the setting off
  hides generated picker entries without deleting accounts, selectors, or exact routes. Plain GPT
  model ids continue to use the configured Pool or Direct behavior.
- Account add, remove, and picker-setting changes are saved before the model catalog is refreshed.
  If that bounded refresh cannot finish, the dashboard shows an amber success-with-recovery notice;
  run `ocx sync` to retry. The account or setting change itself remains saved.

The Providers overview separately summarizes Pool-mode usage as a display-only weighted capacity
estimate, alongside the effective account's raw quota and the next capacity recovery. See
[Providers overview pool capacity](/guides/providers/#providers-overview-pool-capacity) for the
visible fields, incomplete-coverage meaning, and routing boundary.

## Starring is yours to decide, not an agent's

The sidebar's star button — and the one-time question `ocx start` asks in an interactive
terminal — goes through **your own `gh` login**. opencodex holds no GitHub token, and the
only thing it learns is your yes or no.

Because that writes to your GitHub account, agent-driven callers are refused rather than
allowed to answer for you:

- `ocx start` and `ocx service install` **skip the prompt entirely** when an agent or CI
  harness is driving them (`CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_TRACE_ID`, `CI`, and
  similar). The one-time marker stays unwritten, so the real prompt still shows up on your
  next hand-typed run. The agent is told to ask you instead — and to ask as a plain Yes/No
  choice you have to answer, not as a soft aside it can slip past you. If you never get
  around to answering, the agent is told to re-ask rather than treat your silence as a no.
- `POST /api/github/star` answers `403` with `code: "agent_consent_required"` when the proxy
  runs under an agent session and the request has no dashboard browser session. Possessing
  the admin token is not consent: an agent on your machine can read that file.
- The dashboard button keeps working normally. A real click carries same-origin session
  evidence, so it is recognized as you even when an agent started the proxy.
- Saying no ends it. Nothing is persisted and nothing is added to any model prompt to nudge
  you later.

## How the dashboard talks to the proxy

The GUI is a thin client over the proxy's JSON management API. Useful endpoints include:

| Endpoint | Purpose |
| --- | --- |
| `GET` / `PUT /api/settings` | Read settings or update Codex autostart, stream/memory settings, and account-targeting picker visibility. |
| `GET` / `POST /api/github/star` | Read the `gh`-derived star state, or star the repository. The POST is refused with `403` `agent_consent_required` for agent-driven callers without a dashboard session. |
| `GET /api/startup-health` | Read secret-free routing, service, shim, and restart-safety diagnostics. |
| `POST /api/startup-action` | Install the background service or Codex launcher shim through fixed, allowlisted actions. |
| `GET` / `POST /api/windows-tray` | Read or change the Windows tray installation and visible-process state. POST accepts `install`, `start`, `stop`, or `uninstall`. |
| `POST /api/sync` | Rebuild the shared model catalog and stale the Codex model cache. |
| `GET /api/update/check` · `POST /api/update/run` · `GET /api/update/status` | Check, run, and monitor self-update jobs. Worker PIDs are persisted so a crashed job recovers automatically; legacy no-PID jobs recover after ten minutes. |
| `GET` / `PUT /api/sidecar-settings` | Read or set search/vision sidecar model settings. |
| `GET` / `PUT /api/injection-model` | Read or set the shared sub-agent model/effort selection and the independent guidance/native-default switches. |
| `GET` / `PUT /api/v2` | Read or set the surface mode, Codex feature flag, and v2 thread limit. |
| `GET /api/providers` · `POST /api/providers` · `PATCH /api/providers?name=...` · `DELETE /api/providers?name=...` | List, add/replace, enable/disable, set the default, or remove providers. `PATCH` uses standalone `{ "setDefault": true }` on an enabled provider; `POST` may include `setDefault` when creating/replacing (also enabled-only). Deleting the current default reassigns to the first remaining enabled provider when one exists; otherwise the API returns `409` with `code: "last_provider"` and keeps the current default. |
| `GET /api/models` · `PUT /api/disabled-models` | List native/routed model rows and update the shared disabled-model set. |
| `GET /api/selected-models` · `PUT /api/model-visibility` | Read provider allowlists and atomically change the final visibility of one model or provider group. |
| `GET /api/key-providers` · `GET /api/oauth/providers` | Read the API-key and OAuth provider catalogs. |
| `GET /api/oauth/accounts?provider=...&quota=1` · `GET /api/providers/keys?name=...&quota=1` | Read each account or key's quota where supported, without changing the active credential. Add `refresh=1` to bypass settled quota cache; an in-flight same-credential read can be shared. Omit `quota=1` for a cheap local list with each row's `quotaMode`: `probe`, `passive`, or `unsupported`. Passive reads return existing observations without a network probe. No reading is not the same as 0% used, and quotas for multiple keys are not summed. |
| `POST /api/oauth/login` · `GET /api/oauth/status` | Start a provider OAuth flow and poll for completion. |
| `GET /api/codex-auth/accounts?refresh=1` | List main and pool accounts, force quota refresh, and report main-account `hasCredential` / terminal `needsReauth` state. |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | Select the account for the next request and configure pool routing. |
| `GET /api/codex-auth/active` · `PUT /api/codex-auth/accounts/priority` | Read the effective account (including `pinned` and which account is `pinnedAccountId`) and set one account's selection order. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | Add a pool account through browser login. |
| `GET /api/logs?tail=50&limit=20&offset=0&provider=...&status=5xx` | Read recent request metadata with optional tail, provider, and exact/class status filters. With `limit`/`offset`, paging walks backward from the newest row (`offset=0` returns the latest page). Response shape: `{ timeZone, generatedAt, total, logs }` where `total` is the filtered row count before pagination. |
| `GET` / `PUT /api/subagent-models` | Read or set the five featured `spawn_agent` override models. |
| `POST /api/stop` | Stop the proxy/service, restore native Codex, and exit. Refused with `respawnable_service` on the Windows Task Scheduler backend, and with `service_state_unknown` when that state cannot be read; nothing is changed either way. |

:::tip
Adding **Ollama Cloud** or another catalog provider from the dashboard copies its text-versus-vision
classification into the saved provider config, so the [vision sidecar](/guides/sidecars/)
is gated correctly without manual classification.
:::
