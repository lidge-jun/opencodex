---
title: Quickstart
description: Configure your first provider and route OpenAI Codex through opencodex in three commands.
---

This guide takes you from a fresh install to running Codex against a non-OpenAI model.

## 1. Run the setup wizard

```bash
ocx init
```

`ocx init` walks you through:

1. **Pick a provider** — choose one of the 50 built-in registry presets or `custom` to type a base
   URL and adapter.
2. **API key** — paste a key, or reference an environment variable like `${ANTHROPIC_API_KEY}`.
3. **Default model** — for key, local, and custom providers, accept the preset or enter a model id.
4. **Proxy port** — defaults to `10100`.
5. **Inject into Codex?** — on a normal loopback setup, opencodex adds a root `openai_base_url` to
   `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) so Codex's built-in `openai` provider
   targets the proxy. Remote/LAN binds use a dedicated provider entry with an API-auth header instead.
6. **Install the autostart shim?** — when enabled, launching `codex` runs `ocx ensure` first.

The result is saved to `$OPENCODEX_HOME/config.json` (default `~/.opencodex/config.json`).

:::note[GPT-5.6 rollout entries]
Stable v2.7.1 seeds GPT-5.6 Sol/Terra/Luna for ChatGPT passthrough, OpenAI API-key, OpenRouter, and
the experimental Cursor adapter. They work only when that upstream account has access. The OpenAI
API-key and OpenRouter presets advertise a 372,000-token usable context window; Cursor keeps its own
adapter metadata.
:::

## 2. Start the proxy

```bash
ocx start            # defaults to port 10100
ocx start --port 8080
```

On start, opencodex:

- writes its PID to `~/.opencodex/ocx.pid` (and refuses to start twice),
- discovers live models where the provider supports it and **syncs native and routed entries into
  Codex's model catalog**,
- listens on `http://localhost:<port>/v1`.

If the requested port is busy, `ocx start` selects a free port, records it in `runtime-port.json`,
and updates Codex to use the live listener.

Check it:

```bash
ocx status
ocx gui       # open the dashboard on the live port
```

## 3. Use Codex

Codex now talks to opencodex transparently:

```bash
codex "Refactor this function for readability"
```

To target a specific routed model, use the `provider/model` form Codex's model picker shows:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

## Choose sub-agent models (optional)

A fresh config features five native models in Codex's sub-agent picker: `gpt-5.5`,
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-5.4-mini`. Open `ocx gui` to replace or
reorder up to five native or routed models. The dashboard can also set one preferred sub-agent model
and reasoning effort; opencodex adds that guidance to v1 collaboration requests.

## Logging in instead of pasting a key

Some providers support real account login (OAuth, auto-refreshed):

```bash
ocx login xai          # or: anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

OpenAI itself needs **no key** — the default provider forwards your existing `codex login`
credentials straight through (see [Providers](/guides/providers/)).

## Stopping & restoring

```bash
ocx stop          # stop the proxy and restore native Codex
ocx restore       # restore native Codex without stopping (alias: ocx eject)
ocx restore back  # route Codex through the still-running proxy again
```

## Next

- [How It Works](/getting-started/how-it-works/) — what happens to each request.
- [Providers](/guides/providers/) — every way to authenticate.
- [Configuration](/reference/configuration/) — the full `config.json` reference.
