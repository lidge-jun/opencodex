---
title: Codex Integration
description: How opencodex injects itself into Codex, syncs the model catalog, drives the subagent picker, and restores cleanly.
---

opencodex makes Codex route through the proxy by editing two things Codex reads: its config
(`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`) and its model catalog. Every edit is
idempotent and reversible.

The proxy exposes one bare `openai` Codex-login route with Pool(default) and Direct account modes,
plus `openai-apikey/<model>` for the configured API key. Pool includes main plus added accounts;
Direct uses only the caller/main bearer. The routes do not fall back to one another. Shipped v1
configs migrate to marker 2 and preserve `config.json.pre-openai-tiers-v2.bak` for manual restore.

## Config injection

`ocx init`, `ocx start`, and `ocx sync` call the injector. On the default loopback bind, it keeps
Codex's built-in `openai` provider id and points that provider at opencodex:

```toml
# root keys, before the first table
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"

[features]
fast_mode = true
```

The proxy listens on port `10100` by default and serves `POST /v1/responses`,
`POST /v1/responses/compact`, `POST /v1/images/generations`, `POST /v1/images/edits`,
`GET /v1/models`, `GET /healthz`, and the `/api/*` management surface.

### Built-in image generation (`image_gen`)

Codex's built-in `image_gen` tool does not go through `/v1/responses` — the codex-rs extension
POSTs `{base_url}/images/generations` (or `/images/edits` when reference images are attached)
directly, with the same ChatGPT bearer auth it uses for chat. Because the injected `base_url`
points at opencodex, the proxy relays those calls to the OpenAI upstream:

- **One mode-aware forward candidate:** Pool selects an eligible main/added account; Direct uses the
  caller OAuth bearer. The configured mode applies consistently to the image request.
- **OpenAI API-key provider:** it is used only when no forward candidate owns an authentication
  failure. A broken/expired Pool credential is never hidden behind separately billed API usage.
- **Neither:** the proxy returns a clear error instead of a generic 404. Routed providers
  (Cursor, Gemini, Kiro, …) cannot serve the `image_generation` tool relay; if you don't want the
  tool offered at all, disable it in Codex with `codex features disable image_generation`
  (`[features] image_generation = false` in `config.toml`).

  > **Note:** This refers only to the Codex `image_generation` tool (`/images/generations` relay).
  > Gemini models that are image-capable produce inline images natively through the `google` adapter
  > (via `responseModalities: ["TEXT", "IMAGE"]`), independent of this relay — see
  > [Adapters](/reference/adapters/#google).

For a non-loopback `hostname`, Codex must send the generated API auth header. The injector therefore
uses a dedicated provider instead:

```toml
# root keys
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# appended at the end of the file
# Auto-injected by opencodex
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
# supports_websockets = true   # only when config.websockets is true
```

When OpenCodex owns routing, both modes write `$CODEX_HOME/opencodex.config.toml` as a
reference/fallback config. On loopback it contains the root keys you can merge manually if automatic
injection was removed; on non-loopback it contains the dedicated provider form. External-provider
mode leaves this profile untouched.

:::caution
Root keys such as `openai_base_url`, `model_provider`, and `model_catalog_json` **must** sit before the
first `[table]` header. The injector guarantees that placement, removes its own stale/duplicate
copies, and never overwrites a user-owned root `openai_base_url`; if one exists, sync updates the
catalog but reports that routing was not injected.
:::

## Shared model catalog

Codex CLI, TUI, App, and SDK all read the same Codex home. opencodex resolves that directory from
`CODEX_HOME`, falling back to `~/.codex`, and manages:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

On WSL, if `CODEX_HOME` is unset and the Linux `~/.codex/config.toml` is absent, opencodex also
checks for a single Windows Codex Desktop home at `/mnt/c/Users/*/.codex/config.toml`. When exactly
one candidate exists, it uses that directory so WSL app-server mode and Windows Codex Desktop share
the same config and auth files. Set `CODEX_HOME` explicitly to override this detection.

In dedicated-provider mode, `requires_openai_auth = true` keeps Codex App/TUI account-gated surfaces
aligned with native Codex. opencodex also serves `/v1/responses` over WebSocket. The dedicated
provider advertises `supports_websockets = true` only when `"websockets": true`; on loopback Codex's
built-in provider may try WebSocket first, and a disabled proxy returns `426` so Codex falls back to
HTTP/SSE.

## Thread identity and history

The default loopback form keeps new threads tagged with Codex's native `openai` provider, so normal
resume history needs no remapping. On first sync it also migrates threads tagged by older opencodex
builds back to `openai`. Non-loopback dedicated-provider mode still mirrors history under the
`opencodex` provider while active and restores the backed-up metadata on exit. Set
`syncResumeHistory: false` to leave history untouched.

## Model catalog sync

Codex shows models from an on-disk catalog (`$CODEX_HOME/opencodex-catalog.json` by default). On
start and on `ocx sync`, opencodex:

1. **Backs up** the pristine catalog once to `~/.opencodex/catalog-backup.json` (so featuring is
   reversible).
2. **Fetches** eligible providers' live model catalogs (cached ~5 min; falls back to the last good
   list, then configured `models[]`). Forward auth has no model endpoint, and Cursor uses its
   `GetUsableModels` RPC rather than `/models`.
3. **Merges** routed models in as namespaced entries (`provider/model`), cloned from a native Codex
   catalog template so Codex's strict parser accepts them.
4. **Filters** `config.disabledModels` and each provider's non-empty `selectedModels` allowlist.
5. **Re-ranks** so featured models sort first (see below), then writes the merged catalog back.

Routed catalog entries also get their GPT-5 identity rewritten to the real upstream model name.
Reasoning controls come from provider/model metadata across Codex's `low | medium | high | xhigh |
max | ultra` ladder; unsupported values are mapped or clamped before the upstream request.

### Custom model display names

A custom model can carry a human-readable **display name** that overrides the label Codex shows in
its model picker, without changing anything about how the model is routed. The display name maps to
the catalog entry's `display_name` field only — the routing slug (`<provider>/<model>`), alias
collision order, provider, and native OpenAI marketing names are all left untouched.

Add a display name from the CLI (the proxy syncs the catalog right away when live):

```bash
ocx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

You can also set or edit it through the management API (`POST /api/custom-models`,
`PUT /api/custom-models/<id>` with a `displayName` string) and the web dashboard. A `/` is rejected
because it would collide with the routed-slug separator.

The display name is **display-only and stable across regeneration**. Every `ocx sync` and catalog
refresh re-derives routed entries from `config.json` (including `customModels`), so the configured
name is reapplied instead of drifting back to the routed slug. A managed service restart also attempts
this sync shortly after the proxy binds. If that best-effort boot sync fails, for example during an
offline login, the previously persisted catalog is retained and the next successful `ocx sync`
reapplies the configured name. Genuine upstream native names (e.g. `gpt-5.6-sol` →
"GPT-5.6-Sol") come from the pinned upstream snapshot and are never overridden by a custom display
name.

### External provider managers

If `config.toml` already selects a provider other than `openai` or `opencodex`, OpenCodex leaves the
file unchanged and skips profile writes, catalog/cache refresh, and both immediate and background
Codex history migration. Tools that manage a custom provider often tag existing sessions with that
provider id; replacing the active id can make those intact sessions disappear from Codex's history
view. The same protection applies to an external provider selected by a legacy root profile.

Keep one tool as the owner of Codex provider configuration. To use OpenCodex behind an existing
provider manager, point that provider at `http://127.0.0.1:10100/v1` with Responses passthrough
(`wire_api = "responses"` in Codex TOML), not Chat Completions translation. When proxy API auth is
enabled, also pass `x-opencodex-api-key` from `OPENCODEX_API_AUTH_TOKEN`, matching the non-loopback
provider form above. To let OpenCodex inject routing directly, first switch Codex back to its
built-in `openai` provider and remove any user-owned root `openai_base_url`, then rerun `ocx start`.

### Catalog troubleshooting

If a model is missing from Codex, or the catalog order/visibility looks wrong, check in order:

1. **`selectedModels`** on the provider — a non-empty allowlist exposes only those ids to Codex;
   empty or omitted exposes all discovered models. An id not in the allowlist never reaches the
   catalog.
2. **`disabledModels`** (top level) — hides models from both the catalog and `/v1/models`, and flips
   bare native GPT slugs to `visibility: "hide"`.
3. **`liveModels: false` with empty `models`** — when live discovery is off and `models` is empty or
   omitted, opencodex exposes no routed models for that provider.
4. **Cursor `GetUsableModels`** — the Cursor adapter discovers models through its protobuf
   `GetUsableModels` RPC, not `/models`, so a Cursor-side change can alter which ids are visible
   independently of other providers.
5. **Cache and `ocx sync`** — live catalogs are cached for about five minutes (`modelCacheTtlMs`,
   default `300000`). Run `ocx sync` to force a fresh fetch and rewrite the catalog immediately.

:::caution[Other local writers]
Catalog writes (`opencodex-catalog.json`, `config.toml`) are atomic **inside** opencodex, which only
prevents half-written files when two opencodex-owned writers race. That does **not** stop another
local process, file watcher, or sync agent from rewriting catalog visibility or order after opencodex
has written. Codex keeps its separate `models_cache.json` and can refresh it independently, changing
the visible list without rewriting `opencodex-catalog.json`. If models flip unexpectedly while the
proxy is running, stop or reconfigure the competing writers, then run `ocx sync` — this is an
external-writer hazard, not a confirmed opencodex defect.
:::

## The subagent picker

Codex's `spawn_agent` advertises the first **5 picker-visible catalog models** after sorting by
priority. `subagentModels` accepts up to five ids, either bare native GPT slugs or namespaced
`provider/model` routes, and gives them priorities 0–4 so they sort first:

```json
{
  "subagentModels": [
    "gpt-5.5",
    "gpt-5.6-sol",
    "anthropic/claude-opus-5",
    "xai/grok-4.5",
    "cursor/gpt-5.6-terra"
  ]
}
```

Priority ranking: featured (0–4) < other routed (5) < native (9). You can also manage this from the
[web dashboard](/guides/web-dashboard/).

## Codex account warmup

When a ChatGPT account is added to the Codex account pool, opencodex verifies it before persistence
with a small streaming request to the Codex Responses backend. The request uses a real Responses
item array (`input: [{ type: "message", ... }]`), waits for `response.completed`, and defaults to
`gpt-5.4-mini`. If that model returns HTTP 400, it retries with `gpt-5.5`; structured upstream error
details are surfaced without exposing raw response bodies. Background revalidation is separate and
off by default; it runs only when Token Guardian is enabled, the `chatgpt` refresh policy is
`proactive`, and `tokenGuardian.codexWarmupEnabled` is true.

## Restoring native Codex

opencodex never traps you. **`ocx stop` is the single command that fully reverts to native Codex** — it
stops the proxy, stops the background service if one is installed, and strips every injected line and
routed catalog entry so plain `codex` works exactly as if opencodex was never there:

```bash
ocx stop       # stop the proxy + service, restore native Codex
ocx restore    # restore without stopping  (alias: ocx eject)
ocx restore back # point plain Codex at the running proxy again
```

When opencodex runs as a managed [background service](/reference/cli/#ocx-service), it sets
`OCX_SERVICE=1` so a service-driven restart does **not** thrash the Codex config — only an explicit
`ocx stop` / `ocx service stop` restores native Codex.
