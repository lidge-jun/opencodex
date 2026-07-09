---
title: Web Dashboard
description: The opencodex GUI — proxy status, provider management, model picker, and request logs.
---

opencodex ships a local web dashboard (a Vite/React app under `gui/`) served from the proxy. It's the
easiest way to add providers, manage Codex/ChatGPT auth accounts, choose subagent models, and watch
traffic.

## Opening it

```bash
ocx gui
```

This opens `http://localhost:<port>` in your browser (auto-starting the proxy first if needed). In
development you can run the GUI dev server separately against a running proxy:

```bash
ocx start
bun run dev:gui
```

## What you can do

| Area | What it does |
| --- | --- |
| **Status** | Live proxy state, port, uptime, and PID. |
| **Providers** | Add, edit, enable/disable, and remove providers. |
| **Add provider** | A searchable picker of presets — OAuth login (xAI / Anthropic / Kimi), ChatGPT forward, the API-key catalog (incl. Ollama Cloud), local servers, and Custom. |
| **OAuth login** | Opens the provider's auth page and polls until the token lands; or imports an existing local CLI/keychain token. |
| **Codex Auth** | Add ChatGPT/Codex pool accounts, choose the next-session account, refresh 5h / weekly / 30d quotas, and set auto-switch / failover thresholds. |
| **Subagent models** | Pick the ≤5 routed models Codex's `spawn_agent` advertises. |
| **Models** | Enable/disable individual routed models (hidden ones are excluded from the catalog and `/v1/models`). |
| **Multi-agent mode** | A 3-position selector (All v1 / Default / All v2) on the Models page that forces the multi-agent surface for all models. Default respects upstream pins (sol/terra=v2, luna=v1). |
| **Request log** | Auto-refreshing view of recent requests (model, provider, status). |
| **Stop** | A sidebar button that gracefully shuts down the proxy, stops the background service if installed, and restores native Codex — all in one click (`POST /api/stop`). |

## Codex Auth and account pools

The **Codex Auth** page is for the native ChatGPT/Codex path. It separates existing sessions from
new sessions:

- Existing Codex thread ids keep their selected account, which makes SSH, tmux, and mobile-attached
  sessions stable. A long-running conversation does not silently move between accounts.
- New sessions can automatically use the lowest-usage eligible account when auto-switch is enabled.
  The score uses the hottest known quota window across 5h, weekly, and 30d usage.
- The quota refresh button calls the proxy to re-read account usage immediately, so routing and the
  visible account cards stay in sync.
- Pool request logs use non-PII labels such as `chatgpt-1`, not account emails.

## How the dashboard talks to the proxy

The GUI is a thin client over the proxy's management API. Useful endpoints (all JSON):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/providers` | List configured providers. |
| `POST /api/providers` | Add or overwrite a provider (catalog entries are enriched with their model classification automatically). |
| `DELETE /api/providers?name=…` | Remove a provider. |
| `GET /api/key-providers` | The API-key catalog (incl. Ollama Cloud). |
| `GET /api/oauth/providers` | Which providers support OAuth login. |
| `POST /api/oauth/login` · `GET /api/oauth/status` | Start an OAuth flow and poll for completion. |
| `GET /api/codex-auth/accounts?refresh=1` | List main + pool accounts and force quota refresh. |
| `PUT /api/codex-auth/active` | Choose the account used for the next new Codex session. |
| `PUT /api/codex-auth/auto-switch` | Set the quota threshold for automatic new-session account selection. |
| `PUT /api/codex-auth/failover` | Set how many transient upstream failures trigger future-session failover. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | Add a pool account through the browser login flow. |
| `GET /api/logs?tail=50&provider=…&status=5xx` | Read recent request metadata with optional tail, provider, and status filters. |
| `GET` / `PUT /api/subagent-models` | Read / set the featured subagent models. |
| `POST /api/stop` | Gracefully stop the proxy (and the background service if installed), restore native Codex, then exit. |

:::tip
Adding **Ollama Cloud** (or any catalog provider) from the dashboard automatically copies its
text-vs-vision model classification into your config, so the [vision sidecar](/opencodex/guides/sidecars/)
is gated correctly without any manual setup.
:::
