# opencodex Structure

This folder is the maintainer source of truth for the current system shape. Public user workflows
belong in `docs-site/`; historical investigations belong in `docs/`.

## Reading order

| File | Purpose |
| --- | --- |
| [`00_overview.md`](00_overview.md) | Product boundary, local state, and non-negotiable invariants. |
| [`01_runtime.md`](01_runtime.md) | Process lifecycle, CLI, server endpoints, config, providers, adapters. |
| [`02_config-and-codex-home.md`](02_config-and-codex-home.md) | `CODEX_HOME`, config injection, profile files, restore rules. |
| [`03_catalog-and-subagents.md`](03_catalog-and-subagents.md) | Shared Codex catalog, Codex App picker, subagent ordering. |
| [`04_transports-and-sidecars.md`](04_transports-and-sidecars.md) | Responses HTTP/SSE, WebSocket opt-in, sidecars, compatibility guards. |
| [`05_gui-and-management-api.md`](05_gui-and-management-api.md) | Dashboard serving and `/api/*` management surface. |
| [`06_docs-and-release.md`](06_docs-and-release.md) | Public docs site, GitHub Pages, README ownership, release flow. |
| [`07_design-methodology.md`](07_design-methodology.md) | Design process discipline for new GUI, CLI, and user-facing surfaces. |
| [`08_openai-provider-tiers.md`](08_openai-provider-tiers.md) | OpenAI Pool/Direct account-mode and API credential/routing invariants. |

## Product boundary

opencodex is a local Responses-compatible proxy for Codex. It does not patch Codex binaries. It
changes local Codex state by writing a provider table and model catalog, then serves:

```text
Codex CLI / TUI / App / SDK
  -> http://127.0.0.1:<port>/v1/responses
  -> opencodex routing + adapter bridge
  -> upstream provider
```

The default install keeps native OpenAI/ChatGPT passthrough working through one option-aware
`openai` provider. Pool is the default and selects across main plus added accounts; Direct uses only
the current caller/main login. `openai-apikey` explicitly selects API-key transport, and the two
credential routes never fall through into one another. Built-in provider presets include Anthropic,
Google, Azure, and Neuralwatt Cloud. Additional
providers are routed by explicit `provider/model`, provider model lists, or the configured
`defaultProvider`.

## Local state

| Path | Owner | Notes |
| --- | --- | --- |
| `~/.opencodex/config.json` | opencodex | Main config written by `ocx init` and the dashboard. |
| `~/.opencodex/auth.json` | opencodex | OAuth tokens; not committed. Multiauth shape: `provider -> { activeAccountId, accounts[] }` (legacy single-credential values normalize on load; a one-time `auth.json.pre-multiauth` backup guards downgrades). ChatGPT scratch OAuth stays separate from the Codex account store; identity-less providers (kimi/kiro/cursor) replace their active slot. |
| `~/.opencodex/codex-accounts.json` | opencodex | Hardened main-plus-added credential store used by `openai` in Pool mode. |
| `~/.opencodex/catalog-backup.json` | opencodex | One-time pristine Codex catalog backup for restore. |
| `~/.opencodex/usage.jsonl` | opencodex | Append-only request usage log (0o600); request metadata + token counts only, never prompts or auth. |
| `$CODEX_HOME/config.toml` | Codex, edited by opencodex | Active provider and provider table. |
| `$CODEX_HOME/opencodex.config.toml` | opencodex | Optional profile for explicit Codex opt-in. |
| `$CODEX_HOME/opencodex-catalog.json` | opencodex | Shared native+routed model catalog. |
| `$CODEX_HOME/models_cache.json` | Codex, invalidated by opencodex | Cache invalidated after model/catalog changes. |
| `dist/`, `gui/dist/`, `node_modules/` | generated | Build output/dependencies. |

## Non-negotiable invariants

- `websockets` defaults to `false`; only `true` advertises `supports_websockets`.
- `CODEX_HOME` wins over `~/.codex` when present and valid.
- Root TOML keys such as `model_provider` and `model_catalog_json` must stay before any table.
- Routed model slugs use `provider/model`.
- OpenAI has one `openai` Codex-login provider with Pool(default)/Direct modes and a separate `openai-apikey`; see [`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).
- Codex `spawn_agent` visibility depends on the first five featured catalog entries.
- `ocx stop`, `ocx restore`, and service stop/uninstall must leave native Codex usable.

## Writing rule

Keep this directory flat. Add or extend lexicographically ordered `NN_topic.md` files; do not add
subdirectories. If one file grows too broad, split the next stable topic into the next unused number
instead of creating nested folders.
