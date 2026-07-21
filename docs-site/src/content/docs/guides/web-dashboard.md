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

## What you can do

| Area | What it does |
| --- | --- |
| **Dashboard summary** | Multi-agent mode, online state, version, uptime, provider count, 30-day token total, active providers, and available native/routed models. |
| **Sub-agent delegation** | Choose a native or routed guidance model and an optional reasoning effort for v1 delegation prompts. This is not a per-spawn router; see below. |
| **Sidecars** | Choose the web-search model and effort plus the vision-description model. Changes apply on the next request. |
| **Maintenance** | Resync the Codex model catalog, inspect project-local config bypass warnings, check the latest or preview release, and run an update with optional proxy restart. |
| **Codex autostart** | Enable or disable the Codex launcher shim that runs `ocx ensure` before Codex CLI/App starts. |
| **Providers** | Add, edit, enable/disable, and remove providers; manage OAuth account pools and API-key pools where supported. |
| **Add provider** | Search registry-backed presets for account login, API-key services, local servers, or a custom endpoint. |
| **Codex Auth** | Add ChatGPT/Codex pool accounts, select the next-session account, refresh 5h / weekly / 30d quotas, and configure quota auto-switch and transient-failure failover. |
| **Subagents** | Feature up to five bare native or namespaced routed models in the `spawn_agent` override list. |
| **Models** | Toggle native GPT and routed models, set provider allowlists and context caps, choose v1/base/v2, and configure the v2 thread limit. |
| **Logs** | Auto-refresh recent requests with tokens, requested effort, resolved model, provider, status, request id, duration, and error details. |
| **Usage / Debug** | Inspect token-usage coverage and trends, or enable opt-in provider transport and usage-extraction diagnostics. |
| **Stop** | Gracefully stop the proxy and installed background service, restore native Codex, and exit (`POST /api/stop`). |

Cost values in **Logs** and **Usage** are API list-price equivalents calculated from reported tokens.
They are not billing receipts or evidence of an actual charge; subscription usage or provider credits
may apply instead.

## Delegation picker vs spawn routing

The Dashboard's **Sub-agent delegation** picker stores `injectionModel` and, optionally,
`injectionEffort`. On a v1 turn, opencodex injects guidance telling the parent agent which exact
model and reasoning effort to pass to `spawn_agent`. Choosing a model enables that guidance at any
parent reasoning effort; clearing the model also clears the stored effort.

:::caution
This picker is delegation guidance for the v1 compatibility surface. On `multi_agent_v2`, the
current proxy does not append the v1 injection message, and every spawned sub-agent inherits the
parent session's model. It is not a proxy-side cross-model router. See
[Sub-agent Surface](/opencodex/guides/sub-agent-surface/) for the canonical v1/base/v2 behavior.
:::

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
- **Refresh quotas** re-reads account usage immediately so routing and the account cards use the same
  values.
- Pool request logs use opaque labels such as `p3fa91c`, never account emails.

## How the dashboard talks to the proxy

The GUI is a thin client over the proxy's JSON management API. Useful endpoints include:

| Endpoint | Purpose |
| --- | --- |
| `GET` / `PUT /api/settings` | Read settings or toggle Codex autostart. |
| `POST /api/sync` | Rebuild the shared model catalog and stale the Codex model cache. |
| `GET /api/update/check` · `POST /api/update/run` · `GET /api/update/status` | Check, run, and monitor self-update jobs. |
| `GET` / `PUT /api/sidecar-settings` | Read or set search/vision sidecar model settings. |
| `GET` / `PUT /api/injection-model` | Read or set the v1 delegation guidance model and optional effort. |
| `GET` / `PUT /api/v2` | Read or set the surface mode, Codex feature flag, and v2 thread limit. |
| `GET /api/providers` · `POST /api/providers` · `PATCH /api/providers?name=...` · `DELETE /api/providers?name=...` | List, add/replace, enable/disable, or remove providers. |
| `GET /api/models` · `PUT /api/disabled-models` | List native/routed model rows and update the shared disabled-model set. |
| `GET /api/key-providers` · `GET /api/oauth/providers` | Read the API-key and OAuth provider catalogs. |
| `POST /api/oauth/login` · `GET /api/oauth/status` | Start a provider OAuth flow and poll for completion. |
| `GET /api/codex-auth/accounts?refresh=1` | List main and pool accounts and force quota refresh. |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | Select the next-session account and configure pool routing. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | Add a pool account through browser login. |
| `GET /api/logs?tail=50&provider=...&status=5xx` | Read recent request metadata with optional tail, provider, and exact/class status filters. |
| `GET` / `PUT /api/subagent-models` | Read or set the five featured `spawn_agent` override models. |
| `POST /api/stop` | Stop the proxy/service, restore native Codex, and exit. |

:::tip
Adding **Ollama Cloud** or another catalog provider from the dashboard copies its text-versus-vision
classification into the saved provider config, so the [vision sidecar](/opencodex/guides/sidecars/)
is gated correctly without manual classification.
:::
