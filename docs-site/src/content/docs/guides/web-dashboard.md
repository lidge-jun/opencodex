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
| **Providers** | Add, edit, set the default (enabled providers only), enable/disable, and remove providers; manage OAuth account pools and API-key pools where supported. Removing the current default switches to the first remaining enabled provider when one exists; otherwise deletion is refused and the current default is kept. Provider Settings can disable live model discovery for endpoints with missing, slow, or oversized `/models` catalogs. For Claude (Anthropic) OAuth pools, each logged-in account shows its own 5-hour and weekly rate-limit bars (usage is per credential); a failed probe keeps the last-known bars and marks them unavailable until the next successful refresh. |
| **Add provider** | Search registry-backed presets for account login, API-key services, local servers, or a custom endpoint. |
| **Codex Auth** | Add ChatGPT/Codex pool accounts, select the next-session account, refresh 5h / weekly / 30d quotas, enable or disable quota auto-switch, set its 1–100% threshold, and configure transient-failure failover. |
| **Subagents** | Feature up to five bare native or namespaced routed models in the `spawn_agent` override list. |
| **Models** | Toggle native GPT and routed models, set provider allowlists and context caps, choose v1/base/v2, and configure the v2 thread limit. Configured providers stay visible as zero-model groups when discovery is off or returns no rows. |
| **Logs** | Auto-refresh recent requests with tokens, requested effort and (when available) effective outbound effort, resolved model, provider, status, request id, duration, and error details. The detail view includes the exact reasoning wire field when the adapter emits one. Filter by opaque conversation/session id (when the client sends one) to total tokens and estimated list-price cost for the currently loaded Logs ring. |
| **Usage / Debug** | Inspect token-usage coverage and trends, or enable opt-in provider transport and usage-extraction diagnostics. |
| **Storage** | Read-only CODEX_HOME disk breakdown (sessions, archives, DBs, attachments). Optional archived cleanup: preview the oldest N%, then quarantine to `CODEX_HOME/.trash` (default) or permanently delete behind an explicit checkbox. **Auto-cleanup policy** is opt-in and **default OFF** (`storageCleanupPolicy.enabled`); configure threshold/target/schedule/mode on the Storage page, or trigger **Run now**. Quarantined entries can be restored from the Storage page (JSONL + threads). Active sessions stay read-only. Cleanup and restore are refused while Codex holds the newest/active `state_*.sqlite` locked. |
| **Stop** | Gracefully stop the proxy and installed background service, restore native Codex, and exit (`POST /api/stop`). |

### Linking to a section

There is a single layout, so there is no layout switch to configure. Dashboard sections are
addressable instead: `#dashboard` opens Overview, and `#dashboard/providers` and
`#dashboard/models` open the other two. Reload, bookmark, and Back all keep the section you were
on. **Logs** works the same way with `#logs` and `#logs/debug`. An older `#providers/workspace`
bookmark now lands on `#providers`.

Cost values in **Logs** and **Usage** are API list-price equivalents calculated from reported tokens.
They are not billing receipts or evidence of an actual charge; subscription usage or provider credits
may apply instead.

## Model visibility

The **Models** switches show final Codex visibility: a routed model is on only when its provider allowlist includes it (or no allowlist is set) and it is not disabled. Turning a model on reconciles both filters atomically; **All on** clears the provider allowlist so newly discovered models are also on.

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

The spawn override guarantee applies to the **built-in** v2 guidance text. A custom
`injectionPrompt` replaces that text entirely and must include `{{model}}` and `{{effort}}`
placeholders (and optionally `{{roster}}`) or those values will not appear in the injected
guidance.

The picker offers enabled native and routed models plus the global Codex effort ladder. The API
validates the selected effort globally; Codex still validates a spawn effort against the target
catalog entry.

## Codex Auth and account pools

The **Codex Auth** page manages the native ChatGPT/Codex route:

- Manually choosing an account changes the next new Codex session; an already-bound thread keeps its
  current account for that manual switch.
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
| `GET` / `PUT /api/settings` | Read settings or toggle Codex autostart. |
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
| `POST /api/oauth/login` · `GET /api/oauth/status` | Start a provider OAuth flow and poll for completion. |
| `GET /api/codex-auth/accounts?refresh=1` | List main and pool accounts, force quota refresh, and report main-account `hasCredential` / terminal `needsReauth` state. |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | Select the account for the next request and configure pool routing. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | Add a pool account through browser login. |
| `GET /api/logs?tail=50&limit=20&offset=0&provider=...&status=5xx` | Read recent request metadata with optional tail, provider, and exact/class status filters. With `limit`/`offset`, paging walks backward from the newest row (`offset=0` returns the latest page). Response shape: `{ timeZone, total, logs }` where `total` is the filtered row count before pagination. |
| `GET` / `PUT /api/subagent-models` | Read or set the five featured `spawn_agent` override models. |
| `POST /api/stop` | Stop the proxy/service, restore native Codex, and exit. |

:::tip
Adding **Ollama Cloud** or another catalog provider from the dashboard copies its text-versus-vision
classification into the saved provider config, so the [vision sidecar](/guides/sidecars/)
is gated correctly without manual classification.
:::
