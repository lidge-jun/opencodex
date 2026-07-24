---
title: Grok Build
description: Use any opencodex-routed model from xAI's Grok Build CLI — models are auto-registered into ~/.grok/config.toml while the proxy runs.
---

opencodex serves an OpenAI-compatible `POST /v1/chat/completions` (and `/v1/responses`) on its
local port, and Grok Build supports custom models against OpenAI-compatible servers. Starting
with this integration, opencodex registers its whole visible catalog into Grok Build
automatically — no manual config editing required.

## Auto-registration

When `~/.grok` exists, `ocx start` (and `ocx ensure` / `ocx restart`) writes a managed block
into `~/.grok/config.toml`:

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "chat_completions"
api_key = "opencodex-loopback"
name = "OCX gpt-5.6-sol"
# ... one [model.ocx-*] table per visible model ...
# <<< opencodex managed block <<<
```

- **Additive:** your own config outside the fence is never touched. Before the first
  injection into a pre-existing file, a one-time backup is written to
  `~/.grok/config.toml.bak-opencodex`.
- **Idempotent:** every `ocx start` (and `ocx ensure` while autostart is enabled) replaces
  the fenced block with the current catalog.
- **Removed on teardown:** `ocx stop`, `ocx eject`, `ocx uninstall`, and graceful
  non-service daemon shutdown strip the fenced block and restore your file
  byte-for-byte. Under a service manager, teardown goes through `ocx stop`/`ocx
  uninstall` (service-mode processes intentionally keep the block across respawns).
- **Conflict-safe:** aliases already defined by your own `[model.*]` tables are respected
  (opencodex suffixes its own entries); a damaged fence (begin marker without end marker)
  refuses any automatic change and asks for manual repair.

Then pick a model inside Grok Build:

```bash
grok models          # lists ocx-* entries alongside native grok models
grok -m ocx-anthropic-claude-opus-4-8 -p "hello"
# or in the TUI: /model ocx-anthropic-claude-opus-4-8
```

## Authentication note

Grok Build requires a non-empty API key for custom models even on loopback. The injected
entries carry a placeholder (`opencodex-loopback`) — opencodex ignores admission keys for
loopback connections, so no real secret is involved. If you bind the proxy on a
non-loopback host, replace the per-model `api_key` with your opencodex admission token.

The injected per-model `api_key` sits first in Grok's credential chain for these models,
so turns against opencodex need no additional Grok login. Keep your normal `grok login` /
`XAI_API_KEY` setup for native grok models and any harness features that contact xAI
directly.

## Manual recipe (without auto-registration)

If you manage `~/.grok/config.toml` yourself, add per-model tables with **direct fields**:

```toml
[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "chat_completions"
api_key = "opencodex-loopback"
```

Do not rely on `[model_providers.<id>]` inheritance for the endpoint: as of Grok Build
0.2.101 the inherited `base_url` is not applied to inference routing (requests fall
through to the default xAI proxy and fail with 401). Direct per-model fields route
correctly.

## Known limitations

- **Responses backend and keep-alives:** opencodex emits a `response.heartbeat` keep-alive
  on `/v1/responses` streams during upstream silence. Grok Build's Responses decoder
  rejects unknown event types, so a manually configured `api_backend = "responses"` model
  can fail mid-turn on slow upstreams. The auto-registered entries pin
  `api_backend = "chat_completions"`, which never surfaces raw heartbeat frames.
- **Service-installed `ocx restart`:** when opencodex runs under a service manager,
  `ocx restart` currently stops the service and replaces it with an unmanaged process —
  service persistence (auto-restart, start-at-login) is lost until the next
  `ocx service` setup, and if that unmanaged process dies the managed block can point at
  a dead proxy until the next `ocx start`/`ocx ensure` refreshes it.
- **Config read timing:** start opencodex first, then launch `grok` for the most
  predictable results. Recent Grok Build versions watch `config.toml` and hot-reload
  `[model.*]` changes into an open session; older builds may need a restart.
- **Catalog updates:** the fenced block reflects the catalog at injection time. After
  adding providers or models, run `ocx ensure` (or restart the proxy) to refresh it.
