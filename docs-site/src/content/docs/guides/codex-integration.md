---
title: Codex Integration
description: How opencodex injects itself into Codex, syncs the model catalog, installs shims, and restores cleanly.
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

# only when fastMode is set; unset adds no [features] table
[features]
fast_mode = true
```

The injected `fast_mode` follows the tri-state `fastMode` setting: `true` writes `fast_mode = true`,
`false` writes `fast_mode = false`, and unset leaves an existing `fast_mode` untouched without
adding a `[features]` table.

The proxy listens on port `10100` by default and serves `POST /v1/responses`,
`POST /v1/responses/compact`, `POST /v1/images/generations`, `POST /v1/images/edits`,
`GET /v1/models`, `GET /healthz`, and the `/api/*` management surface.

### Built-in image generation (`image_gen`)

Codex's built-in `image_gen` tool does not go through `/v1/responses` — the codex-rs extension
POSTs `{base_url}/images/generations` (or `/images/edits` when reference images are attached)
directly, with the same ChatGPT bearer auth it uses for chat. Because the injected `base_url`
points at opencodex, the proxy relays those calls to the OpenAI upstream.

This is separate from the [Image Bridge](/guides/image-bridge/), which only activates when a
**Responses** turn lists the hosted `image_generation` tool while a non-OpenAI model is selected.
Standalone `/images/generations` calls never enter that bridge.

- **One mode-aware forward candidate:** Pool selects an eligible main/added account; Direct uses the
  caller OAuth bearer. The configured mode applies consistently to the image request.
- **OpenAI API-key provider:** it is used only when no forward candidate owns an authentication
  failure. A broken/expired Pool credential is never hidden behind separately billed API usage.
- **Explicit custom provider:** set `images.provider` to the id of a custom API-key
  `openai-responses` provider whose endpoint implements the OpenAI Images API. Explicit selection
  fails closed and never falls back to a different paid upstream. Registry-managed provider ids
  are not accepted here; omit `images.provider` to use the built-in OpenAI tiers.
- **Google Antigravity (CCA) fallback:** when neither an OpenAI forward candidate nor a keyed
  provider is configured, `/v1/images/generations` (not `/images/edits`) falls back to the
  Antigravity **Cloud Code Assist** endpoint using the `gemini-3.1-flash-image` model. The fallback
  also fires after OpenAI auth resolution fails (e.g. an expired or missing ChatGPT credential),
  not only when no OpenAI candidate is configured. This
  requires `ocx login google-antigravity`; the OAuth token is sent only to the pinned CCA registry
  host, never to a config-level `baseUrl` override. The response is returned in the same
  `{created, data:[{b64_json}]}` shape Codex expects.
- **Neither:** the proxy returns a clear error instead of a generic 404. Routed providers
  (Cursor, Gemini, Kiro, …) cannot serve the `image_generation` tool relay; if you don't want the
  tool offered at all, disable it in Codex with `codex features disable image_generation`
  (`[features] image_generation = false` in `config.toml`).

The tool declaration still travels with the model's Responses request. For API-key Responses
providers, opencodex lowers Codex's private `image_gen` namespace to an upstream-safe
`image_gen__<inner-name>` alias (for example `image_gen__imagegen`). When that usable alias replaces
the client declaration, opencodex removes a duplicate hosted `image_generation` declaration. It maps
the function call to the explicit `image_gen` namespace before Codex sees it, and encodes the native
call again when later history is replayed upstream. This keeps client-side image generation callable
on public-compatible upstreams that reserve the namespace or reject dotted function names. ChatGPT
forward mode remains untouched and keeps its native Responses Lite shape.

For an OpenAI-compatible custom gateway, configure a dedicated provider and select it only for
standalone Images requests:

```json
{
  "providers": {
    "custom-images": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "authMode": "key",
      "apiKey": "${IMAGE_GATEWAY_API_KEY}"
    }
  },
  "images": {
    "provider": "custom-images",
    "timeoutMs": 300000
  }
}
```

The custom endpoint must accept `POST /v1/images/generations` and `/v1/images/edits` and return the
OpenAI Images response shape expected by Codex. The provider's configured key replaces any caller
bearer before the upstream request.

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
env_key = "OPENCODEX_API_AUTH_TOKEN"
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

Codex can keep SQLite-backed thread state in a separate directory. OpenCodex history operations use
the same precedence as Codex: root `sqlite_home` in `config.toml`, then `CODEX_SQLITE_HOME`, then the
effective `CODEX_HOME`. Relative SQLite homes resolve from the current working directory. When an
explicit `CODEX_SQLITE_HOME` is present during service installation or repair, the durable launcher
stores its install-time absolute path so the background proxy continues to address the same database.
If `config.toml` or its root `sqlite_home` key is absent, OpenCodex continues to the
environment/home fallback. If the file cannot be read or parsed, or the key is present but blank or
not a string, SQLite-home resolution stops instead of risking history operations against a different
database.

On Windows, an Orca shell can set both `CODEX_HOME` and `ORCA_CODEX_HOME` to Orca's bundled runtime
home while the ChatGPT/Codex app still reads `%USERPROFILE%\\.codex`. `ocx status` and `ocx doctor`
warn about this exact mismatch and print redacted target paths. If a background service was installed
from that Orca shell, uninstall it from the original shell first, then set `CODEX_HOME` to the app
home, unset `ORCA_CODEX_HOME`, rerun sync/restore, and install the service again.

In dedicated-provider mode, `requires_openai_auth = true` keeps Codex App/TUI account-gated surfaces
aligned with native Codex. opencodex also serves `/v1/responses` over WebSocket. The dedicated
provider advertises `supports_websockets = true` only when `"websockets": true`; on loopback Codex's
built-in provider may try WebSocket first, and a disabled proxy returns `426` so Codex falls back to
HTTP/SSE.

## Thread identity and history

The default loopback form keeps new threads tagged with Codex's native `openai` provider, so normal
resume history needs no remapping. Sync and restore apply only a matching backup manifest and
restore each thread's exact original provider, source, and event marker. A bare `opencodex` row with
no manifest is left unchanged; use `ocx recover-history --legacy-openai --yes` only when you explicitly
intend to force that legacy relabel. The command is intentionally broad: it rewrites every thread
with a user message currently tagged `opencodex` to `openai`, normalizes `exec` to `cli`, and sets
the event marker—including legitimate dedicated-provider history. Back up the state and use it only
when that full scope is intended. Non-loopback dedicated-provider mode still mirrors history
under the `opencodex` provider while active and restores the backed-up metadata on exit. Set
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

### Coordinator diagnosis and recovery

Native config/history writes use a per-user SQLite coordinator keyed by the canonical `CODEX_HOME`.
If a process terminates in SQLite's initial creation window, a zero-byte coordinator can remain even
though it contains no authoritative transition row. `ocx doctor` reports the exact coordinator path
and distinguishes zero-byte, unversioned, rowless, valid, unsafe, and unreadable states without
creating SQLite sidecars. Automatic sync tolerates only an identity-stable zero-byte file that has
settled for at least one second and whose immutable SQLite snapshot has version zero with no tables;
a newly created zero-byte file remains on the locked coordinator path.

For a state that doctor proves is a zero-byte creation remnant, stop the OpenCodex proxy/service
and run:

```bash
ocx doctor --recover-zero-byte-coordinator --yes
ocx sync
```

Recovery moves the still-identical zero-byte file to a same-directory `.zero-byte-backup-*` path;
it does not delete the evidence or adopt legacy routed state. It refuses a running proxy, lock
contention, symlinks/reparse points, foreign ownership, changed files, every non-empty database,
and any coordinator that already has an authoritative row. Desktop renderer filtering is a
separate layer: a correct catalog and coordinator do not by themselves bypass the Codex App model
allowlist.

### Routed local tools

Non-native routed catalog rows use `tool_mode: "code_mode_only"`. This lets Codex expose its official
`exec` entrypoint and nested MCP tools, including Browser and Computer Use, while opencodex routes
only the model's ordinary function call. Tool execution, permissions, and confirmations remain
local to Codex; opencodex does not implement a second browser or desktop-control executor.

For key-auth Responses providers that do not accept Codex's `exec` custom-tool grammar, opencodex
encodes that declaration and its history as an upstream function tool, then restores the streamed
function-call lifecycle to `custom_tool_call` before Codex sees it. Native OpenAI forward routing
and the supported `apply_patch` custom tool stay unchanged.

The selected provider must support function/tool calling. A text-only provider without tool-call
support cannot use `exec`, Browser, or Computer Use. Native OpenAI rows keep their upstream tool
mode unchanged.

After `ocx sync` changes this metadata, restart Codex App and open a fresh task. Existing app-server
processes and tasks may retain the catalog and tool plan they loaded at startup.

### Custom model display names

A custom model can carry a human-readable **display name** that overrides the label Codex shows in
its model picker, without changing anything about how the model is routed. The display name maps to
the catalog entry's `display_name` field only — the routing slug (`<provider>/<model>`), alias
collision order, provider, and native OpenAI marketing names are all left untouched.

Add a display name from the CLI (the proxy syncs the catalog right away when live):

```bash
ocx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

Remote Codex clients can fetch the same generated catalog with an ordinary **data-plane** key
— the same credential they already use for `/v1/responses`, not an admin token:

```bash
dest="${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json"
tmp="$(mktemp "${dest}.XXXXXX")"
curl -fsS -H "x-opencodex-api-key: $OPENCODEX_API_AUTH_TOKEN" \
  "https://proxy.example.com/v1/catalog" > "$tmp" \
  && mv "$tmp" "$dest"
ocx sync-cache
```

The response is the raw `opencodex-catalog.json` document (no provider credentials). When
available, the `x-opencodex-codex-version` header reports the Codex runtime version on the
server so clients can spot version skew.

`GET /v1/catalog` exists so that reading a list of models does not cost an admin token. It is
read-only (`GET` and `HEAD`), accepts `x-opencodex-api-key`, a bearer token, or
`x-api-key`, and serves exactly the same bytes as the management route. Responses carry a
strong `ETag` — pass it back as `If-None-Match` to re-validate and get a `304` instead of the
full document — and `Cache-Control: private, no-cache`, since the body sits behind a
credential.

A data-plane key admitted here gains **nothing** on the management plane: `/api/catalog` and
every other `/api/*` route still require the admin token or a dashboard session. The older
`/api/catalog` route keeps working unchanged for the dashboard and for scripts that already
hold an admin token.

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
Codex history metadata restoration. Tools that manage a custom provider often tag existing sessions with that
provider id; replacing the active id can make those intact sessions disappear from Codex's history
view. The same protection applies to an external provider selected by a legacy root profile.

Keep one tool as the owner of Codex provider configuration. To use OpenCodex behind an existing
provider manager, point that provider at `http://127.0.0.1:10100/v1` with Responses passthrough
(`wire_api = "responses"` in Codex TOML), not Chat Completions translation. When proxy API auth is
enabled, also pass `x-opencodex-api-key` from `OPENCODEX_API_AUTH_TOKEN`, matching the non-loopback
provider form above. To let OpenCodex inject routing directly, first switch Codex back to its
built-in `openai` provider and remove any user-owned root `openai_base_url`, then rerun `ocx start`.

### Explicit `tool_search` troubleshooting

Routed local tooling has two distinct discovery paths. In normal routed code mode, Codex can expose
deferred MCP/app tools through the official `exec` tool's `tools` global and `ALL_TOOLS`; that path
does not require the model to see or call `tool_search`.

Separately, `tool_search` is a client-executed Codex discovery surface. It is not an OpenCodex
feature flag, and an upstream `tool_choice: "auto"` value does not create or enable it. OpenCodex can
relay the explicit surface only when Codex already included a declaration like this in the incoming
Responses request:

```json
{
  "tools": [
    { "type": "tool_search", "description": "Load deferred tools" }
  ]
}
```

For routed chat/local models, OpenCodex exposes that declaration as a normal function named
`tool_search`. If the model calls it, OpenCodex converts the call back to a Responses
`tool_search_call`; Codex executes the search and supplies the resulting tool definitions in a
later `tool_search_output`. Definitions loaded that way are then available on the next model turn.

Check the failure boundary before changing provider settings:

1. **No `type: "tool_search"` in the incoming request:** the active Codex client/session did not
   advertise the explicit `tool_search` surface. OpenCodex cannot invent that declaration. This
   does not mean normal code-mode tools are unavailable: check whether the routed model can use
   `exec` and discover the needed nested tool through `tools` / `ALL_TOOLS` first.
2. **The incoming declaration exists, but no `tool_search` function reaches the routed request:**
   capture only the redacted tool-type/name list and open an OpenCodex bug. Never attach the bearer,
   account id, conversation input, full headers, or complete request body.
3. **The routed request contains `tool_search`, but the local model never calls it:** the relay is
   working. Use a model/template with reliable function calling and instructions that explicitly
   tell it to search for a deferred tool it needs. LM Studio's `tool_choice: "auto"` permits tool use;
   it does not force the model to call this function.
4. **A call is emitted repeatedly or loaded tools never become usable:** capture the redacted
   `tool_search_call` / `tool_search_output` item types and call ids. OpenCodex preserves both in
   history so the model should see the completed search instead of issuing it forever.

See [The parser and bridge](/reference/architecture/#the-parser) for the explicit wire mapping.
There is no provider-level setting that can add a missing `tool_search` declaration; ordinary
code-mode discovery remains a separate path.

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
6. **Running Codex `app-server`** — rewriting the on-disk catalog is not enough while a long-lived
   Codex `app-server` (Desktop / CLI background host) keeps the previous list in memory. `ocx sync`
   and `ocx sync-cache` warn when those processes are detected. Restart them with
   `ocx sync --restart-codex` (or stop the matching `app-server` processes yourself), then let Codex
   recreate them so the new list appears.

:::caution[Other local writers]
Catalog writes (`opencodex-catalog.json`, `config.toml`) are atomic **inside** opencodex, which only
prevents half-written files when two opencodex-owned writers race. That does **not** stop another
local process, file watcher, or sync agent from rewriting catalog visibility or order after opencodex
has written. Codex keeps its separate `models_cache.json` and can refresh it independently, changing
the visible list without rewriting `opencodex-catalog.json`. If models flip unexpectedly while the
proxy is running, stop or reconfigure the competing writers, then run `ocx sync` — this is an
external-writer hazard, not a confirmed opencodex defect.
:::

## Proxy connection errors

If Codex retries and then fails with an error like
`stream disconnected before completion: error sending request for url (http://127.0.0.1:10100/v1/responses)`
— or Claude Code reports a similar connection failure — the opencodex proxy is not
running: nothing is listening on the configured port, so the client renders that raw
connection error itself. Restart the proxy:

```bash
ocx start              # foreground
ocx service install    # persistent: auto-starts on login and respawns on crash
```

`ocx status` shows whether the proxy is running and prints the same restart hint when
it is not; `ocx doctor` reports restart safety (service/shim coverage).

## The subagent picker

Catalog sync makes the selected sub-agent models available to Codex; see [Codex App model picker](/guides/codex-app-models/#subagent-selection) for picker ordering and [Sub-agent Surface](/guides/sub-agent-surface/) for v1/base/v2 delegation and fallback behavior.

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
