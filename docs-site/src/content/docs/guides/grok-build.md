---
title: Grok Build
description: Use any opencodex-routed model from xAI's Grok Build CLI — models are auto-registered into ~/.grok/config.toml while the proxy runs.
---

opencodex serves an OpenAI-compatible `POST /v1/responses` on its local port, and Grok Build
supports custom models against OpenAI-compatible servers. Starting with this integration,
opencodex registers its whole visible catalog into Grok Build automatically — no manual config
editing required.

## Auto-registration

When `~/.grok` exists, `ocx start` (and `ocx ensure` / `ocx restart`) writes a managed block
into `~/.grok/config.toml`:

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
extra_headers = { "x-opencodex-grok" = "1" }

[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
model_provider = "opencodex"
name = "OCX gpt-5.6-sol"
context_window = 272000
supports_reasoning_effort = true
reasoning_effort = "low"

[[model.ocx-gpt-5-6-sol.reasoning_efforts]]
id = "low"
value = "low"
label = "Low"
description = "Quick, fast implementations"
default = true
# ... remaining rungs for this model, then one [model.ocx-*] table per visible model,
# each referencing model_provider = "opencodex" ...
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

## Reasoning effort

Grok Build's `/effort` (and `--effort`) only works for models whose catalog entry
advertises the ladder: its model list fetch reads the raw `GET /v1/models` response, and
entries there must carry `supports_reasoning_effort` plus `reasoning_efforts` menu
options. A Grok-compatible projection of that ladder is written into each managed
`[model.*]` table
(`supports_reasoning_effort`, default `reasoning_effort`, and
`[[model.<alias>.reasoning_efforts]]` picker rows) so the menu is present when Grok
reads the model from `config.toml`. For routed model entries, opencodex mirrors the
configured provider tiers (`reasoningEfforts` / `modelReasoningEfforts`, and the default
from `modelDefaultReasoningEfforts`). This metadata describes the proxy-configured
routed ladder. Adapters may emulate reasoning or map levels onto provider-specific
fields. Routed models with a configured ladder show the effort control in Grok Build
just like they do in Codex.
Models with an empty tier list keep no effort control, matching Codex behavior. Native
GPT-5.6 entries are separate: they preserve and expose their pinned upstream reasoning
ladders rather than provider-configured routed metadata. Valid Grok rungs, including
`none` and `minimal`, are preserved when advertised. Unsupported or duplicate rungs,
including Codex-only `ultra`, are omitted from the file, keeping every emitted picker
option selectable.

Grok Build talks to opencodex over the Responses API. When the route advertises a reasoning
ladder, the Responses passthrough forwards `reasoning.summary` as configured, so thinking
traces reach Grok natively as Responses reasoning items. Set `reasoning.summary: "none"` if
a client wants the model to think without returning the trace. An explicit `reasoning.summary`
wins over the route default.

## Authentication note

Grok Build requires a non-empty API key for custom models even on loopback. The injected
entries carry a placeholder (`opencodex-loopback`) — opencodex ignores admission keys for
loopback connections, so no real secret is involved.

**Auto-registration is loopback-only.** When opencodex binds a non-loopback host — including
the wildcards `0.0.0.0` and `::`, which expose every interface — requests need your real
admission token, and a managed block cannot carry one safely. Writing the literal token would
put your secret into `~/.grok/config.toml` and overwrite whatever you set there on the next
`ocx start`/`ensure`/`restart`. So opencodex writes nothing at all in that case (and removes
any block left over from an earlier loopback bind), and you configure the models yourself
outside the managed markers, where nothing opencodex does can clobber them. See
[Manual recipe](#manual-recipe-without-auto-registration) for the exact table, and set both
`base_url` (a host that is actually reachable from where you run `grok`) and `api_key`
(your `OPENCODEX_API_AUTH_TOKEN`).

Do not replace `api_key` with `env_key` here. An `env_key` that fails to resolve does not
stop the request — Grok falls through to your xAI session
token and sends it to whatever `base_url` the entry names, which for a LAN deployment is a
plaintext HTTP endpoint that is not xAI.

The injected `api_key` on the provider entry sits first in Grok's credential chain for
these models, so turns against opencodex need no additional Grok login. Keep your normal
`grok login` / `XAI_API_KEY` setup for native grok models and any harness features that
contact xAI directly.

## Manual recipe (without auto-registration)

If you manage `~/.grok/config.toml` yourself — or opencodex is on a non-loopback bind — add
a `[model_providers.opencodex]` block and per-model tables that reference it, outside the
`# >>> opencodex managed block` markers:

```toml
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

For a proxy reachable over the network, point `base_url` at the address `grok` can actually
dial and use your admission token:

```toml
[model_providers.opencodex]
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "responses"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

This uses `[model_providers.<id>]` inheritance, which requires Grok Build 0.2.109 or later
(released 2026-07-21). On older versions the inherited `base_url` is not applied to inference
routing — upgrade, or fall back to per-model direct fields (`base_url`/`api_backend`/`api_key`
on each `[model.*]` table).

Quote any alias containing a dot: bare `[model.grok-4.5]` is a three-segment key path, not
the id `grok-4.5`. Generated aliases avoid dots entirely for this reason.

## Known limitations

- **Service-installed `ocx restart`:** the running proxy owns restart authorization and drain
  coordination, while the installed service manager launches the replacement after the old process
  exits. Service supervision remains installed. On loopback auto-registration, the managed block
  also remains in place across the handoff; non-loopback deployments use manually managed Grok
  configuration instead. The command succeeds only after a different, identity-verified process is
  healthy on the same port.
- **Config read timing:** start opencodex first, then launch `grok` for the most
  predictable results. Grok Build watches `~/.grok/config.toml` and reloads when the
  `[model]` table actually changes (roughly a one-second debounce, compared by content), so
  a refreshed block reaches an open session without a restart. To confirm what Grok parsed,
  run `grok inspect`: it lists the config sources it loaded and warns about any field it
  rejected. It does not print the resolved model list. Current Grok Build reports and skips
  invalid model fields while retaining the rest of the model entry. A TOML syntax error still
  prevents the file from loading. opencodex writes atomically, so Grok observes a complete
  document on every reload.
- **Catalog updates:** the fenced block reflects the catalog at injection time. After
  adding providers or models, run `ocx ensure` (or restart the proxy) to refresh it.
