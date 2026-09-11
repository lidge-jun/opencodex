---
title: Codex Integration
description: How opencodex injects itself into Codex, syncs the model catalog, installs shims, and restores cleanly.
---

opencodex makes Codex route through the proxy by editing two things Codex reads: its config
(`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`) and its model catalog. Every edit is
idempotent and reversible.

The **Integrations** overview has a Codex switch for this native integration. Its switch shows
the desired state from OpenCodex's configuration, while the badge reports whether Codex is
currently observed using the proxy; during cleanup those can briefly differ while the badge
continues to report the observed state. Disabling names the effective Codex config
file, removes OpenCodex's generated routing artifacts, and leaves the proxy running for other
clients. Re-enabling rebuilds the catalog from the models available at that time, so it does not
restore the Codex files byte for byte.

The proxy exposes one bare `openai` Codex-login route with Pool(default) and Direct account modes,
plus `openai-apikey/<model>` for the configured API key. Pool includes main plus added accounts;
Direct uses only the caller/main bearer. The routes do not fall back to one another. Shipped v1
configs migrate to marker 2 and preserve `config.json.pre-openai-tiers-v2.bak` for manual restore.

Within Pool mode, a request carrying a validated native Codex login can use that login when the
selected stored account is cooling down and no eligible stored alternative or recovery probe is
available. This also covers a new request blocked before sending, following the same caller
validation used after an upstream rejection. Existing model-permission and main-account policy
checks still apply. The fallback preserves the stored account's cooldown and does not persist the
caller credential as the Pool selection. An exact account binding remains bound to that account.

## Config injection

`ocx init`, `ocx start`, and `ocx sync` call the injector. On the default loopback bind, it keeps
Codex's built-in `openai` provider id and points that provider at opencodex:

```toml
# root keys, before the first table
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"
# Auto-injected by opencodex
experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"

# only when fastMode is set; unset adds no [features] table
[features]
fast_mode = true
```

The second key is the voice sideband override. Codex creates a WebRTC voice call through
`openai_base_url`, but since codex 0.146 (openai/codex#35830) it joins that call's sideband
WebSocket at `api.openai.com` directly unless `experimental_realtime_ws_base_url` redirects it. In
Pool mode the call is created under the account opencodex selects, so a direct join under the app's
own login fails with `realtime websocket handshake failed` (404). The injected key sends the join
back through opencodex (`GET /v1/live/{callId}`), where the Pool reuses the account it bound to that
session/thread pair (a process-local binding). In Direct mode both legs already use the caller's
current bearer, so the key only keeps the join on the proxy path. It is written only on the loopback
`openai_base_url` form, is removed together with it, and a user-owned
`experimental_realtime_ws_base_url` is never overwritten.

### Voice transport and task handoffs

Codex owns the microphone and speaker, WebRTC media negotiation, captions, mute controls, and
voice cleanup when switching threads. OpenCodex relays call creation and the sideband connection;
work delegated by voice uses the normal Responses routing path. Choosing a text provider does
not replace the realtime speech model or enable voice in a client that does not support it.

The upstream [WebRTC helper change](https://github.com/openai/codex/commit/1b53f6a44eff890b5169bde8d3bd5b12b8766946)
and [TUI voice integration](https://github.com/openai/codex/commit/b01c3986fd2e79b8a477a08d81430f52f22bc0dc)
describe these client responsibilities, including speaking final answers from voice handoffs.
Their merge dates do not establish when the same behavior reached the desktop app.

Optional `OCX_LIVE_FRAME_LOG` diagnostics write only frame timestamp, direction, kind, byte count,
and a replacement-character flag (`ts`, `dir`, `kind`, `bytes`, `fffd`). They do not store voice
text or frame excerpts. For binary frames, UTF-8 decoding can itself produce replacement
characters, so the flag alone does not identify where corruption occurred. Existing log files
are not rewritten.

### Fast mode

The injected `fast_mode` follows the tri-state `fastMode` setting: `true` writes `fast_mode = true`,
`false` writes `fast_mode = false`, and unset leaves an existing `fast_mode` untouched without
adding a `[features]` table.

Fast mode is separate from voice transport. A supported model's service-tier speed description
does not guarantee lower microphone, WebRTC, or end-to-end voice latency through OpenCodex.

### ChatGPT-family channel and latency

Requests routed through opencodex via the canonical ChatGPT-login `openai` provider — adapter
`openai-responses`, `authMode: "forward"`, and the `https://chatgpt.com/backend-api/codex`
endpoint, covering both Pool and Direct modes — use the public ChatGPT endpoint. Provider routing
or account selection does not bypass the upstream ChatGPT channel. The upstream may spend time
queueing a request before the first output even when the local proxy and network path are healthy.

Only some turns take the ChatGPT websocket transport — the same `responses_websockets` lane Codex
CLI defaults to. A turn is eligible when the Bun runtime supports the bounded relay, the request
is a `POST` to the canonical Responses URL or a configured WebSocket route, and its JSON body sets
`stream` to `true` at the root. Everything else stays on SSE over HTTP, and an eligible turn still
falls back to it when the request cannot be prepared, the `response.create` frame exceeds its size
limit, or the proxy route cannot carry the socket.

Local provider pacing can also hold a request before it is dispatched at all. So a slow first
output has several possible contributors, and upstream queueing is only one of them. `ocx doctor`
classifies configuration and measures none of these: compare actual transport, pacing, network,
and provider observations before concluding.

What decides whether a request takes that public channel is the destination it resolves to, not
the name of the provider entry. A provider that resolves somewhere else — `openai-apikey`, or a
custom entry pointing at its own API — reaches that endpoint directly and sees no ChatGPT queueing.
A custom-named entry that resolves to `https://chatgpt.com/backend-api/codex` with forward auth
takes the same public channel as the built-in row, because the classification reads the adapter,
auth mode and destination rather than the entry's name.

The `ocx doctor` hint is narrower than the endpoint behavior it describes: it inspects only the
built-in `openai` row, so its absence tells you nothing about where any other provider resolves.

`service_tier: priority` is a request preference. On the ChatGPT backend the echoed
`service_tier` cannot confirm or deny the granted tier: turns scheduled as priority can still
echo `default`, so request logs show the response tier as an observation with confirmation
`assumed`. For latency-sensitive work, compare observed first-output times across the providers you
actually use rather than assuming any particular channel is faster.

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
- **xAI Imagine (Grok OAuth) relay:** when `images.bridgeEnabled` is `true`, `images.provider` is
  omitted, and an `xai` provider is configured, `/v1/images/generations` and `/v1/images/edits`
  are sent to `https://api.x.ai/v1`. The credential depends on the provider's `authMode`: with
  `"oauth"` the relay reuses the Grok CLI grant from `ocx login xai`; with any other mode it uses
  the provider's API key. An OAuth login does not arm a keyed provider, and vice versa. ChatGPT
  credentials are not forwarded. If the credential is missing, the proxy returns 400 instead of
  billing ChatGPT. Setting `images.provider` explicitly hands `/v1/images` to that provider; its
  own validation errors are returned as-is and the xAI relay is never tried.
  The relay maps Codex `size` / `aspect_ratio` onto xAI's Imagine body and returns
  the same `{created, data:[{b64_json}]}` shape. Combined decoded bytes and base64-encoded output
  across the batch (inline `b64_json` and downloaded URLs) stay under 100 MiB; a batch that would
  exceed that cap returns 502. When xAI returns an image URL instead of inline bytes, the proxy
  fetches it itself with no credential: the URL must be public HTTPS (no redirects, no
  `file:`, no loopback or private addresses), each download is capped at 50 MiB, and the result is
  materialized as a local artifact that is served only through the authenticated management
  endpoint. This is independent of the Responses Image Bridge loop (which remains API-key-only).
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

If a canonical ChatGPT forward continuation references expired or missing local replay state,
opencodex returns `previous_response_not_found` before sending anything upstream. Codex's
WebSocket client recognizes this error and can reconnect with its full retained context,
including completed tool calls and their results, within its normal stream retry budget. An
idle task therefore does not need a new task solely because the proxy's one-hour cache expired.
The cache remains bounded; this does not extend retention or recover history the client no
longer has. HTTP clients must handle the error explicitly and resend their full context without
`previous_response_id`. Retrying only the same ID cannot recover missing state.

### Client-side compaction (opt-in)

Authenticated loopback routing normally keeps Codex on its built-in `openai` provider identity.
That preserves native thread identity, but it also makes Codex request native remote compaction.
When a routed provider cannot return a native compaction blob, OpenCodeX stores the summary in its
own `ocx1:` envelope. Native ChatGPT cannot verify that envelope if OpenCodeX is later removed from
the request path.

On an authenticated loopback route, enable client-side compaction to keep V2 sub-agent routing while preventing new `ocx1:` compaction summaries. Non-loopback and API-key routes retain their existing provider and authentication behavior:

```bash
ocx system settings --client-compaction on   # or "codexClientCompaction": true in config.json
ocx sync                                     # rewrites the active config (default: ~/.codex/config.toml); restart Desktop
```

The setting defaults to off. For authenticated loopback routing, OpenCodeX selects its existing
dedicated provider form with `requires_openai_auth = true`. If `codexDesktopAuthless` is also
enabled, that stronger compatibility setting takes precedence and writes
`requires_openai_auth = false`:

```toml
model_provider = "opencodex"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = true
```

Codex then owns compaction and stores a portable plaintext summary rather than a new OpenCodeX
envelope. The compacting request still routes through OpenCodeX and can consume quota on the
selected provider. V2 sub-agent requests keep their existing provider selection and quota
accounting. Client-side compaction does not change plaintext delivery, encrypted task passthrough
through `allowEncryptedV2AgentTasks`, or configured recovery and fallback behavior.

This preference affects future compactions only, and it rewrites no existing `ocx1:` payload in
any configuration, so use the explicit history recovery workflow for a thread that needs one.

Whether resume-history metadata is re-tagged depends on which form the injection takes. On its
own, on an authenticated loopback bind, client-side compaction re-tags nothing: it keeps the root
override instead, as described below. Enabled together with `codexDesktopAuthless`, or on a
non-loopback bind, the stronger form wins and those forms behave exactly as they do today,
including their existing forward-tagging of resume history with originals backed up for restore.

Going back from one of those forms to plain Design B migrates the re-tagged threads back. Turning
off `codexDesktopAuthless` while leaving client-side compaction on does not: that lands on the
compaction-only form, which skips the history unit, so threads already tagged `opencodex` keep
that tag. They still reach this proxy, through the provider table rather than the root override.

On the compaction-only form, existing threads keep working because the injection keeps the root
`openai_base_url` override alongside the provider table. New threads default to `opencodex` and
get client-side compaction, while a thread already tagged `openai` still resolves to Codex's
built-in provider — which the retained override still points at this proxy. Without it that
thread would resume against OpenAI directly, taking configured routing with it. The authless and
non-loopback forms cannot use the root key, which is why they keep re-tagging instead.

That guarantee covers the override OpenCodeX manages. A root `openai_base_url` you wrote
yourself is never replaced, and in that case the built-in provider keeps the destination you
chose, so an `openai`-tagged thread follows your configuration rather than this proxy. Turning
the setting off and syncing removes the table and returns to the plain Design B override, unless
`codexDesktopAuthless` or non-loopback admission still requires the provider-table form; those
two forms cannot use the root key and are unchanged.

While the mode is active, the realtime voice sideband override
(`experimental_realtime_ws_base_url`) is not injected — the dedicated provider-table form cannot
carry it — so Codex Desktop voice uses its native endpoint rather than the proxy.

### Authless Codex Desktop (opt-in)

In **Dashboard → Overview**, **Open Codex without signing in** controls this existing
opt-in preference. The switch defaults to **off** when the setting is absent or false;
an existing explicit `codexDesktopAuthless: true` stays enabled. The dashboard saves
the preference and runs a full sync. Restart Codex Desktop after changing it.
If synchronization fails, the saved preference remains and the dashboard shows the error;
retry **Sync** before restarting. Account-gated Desktop features may be unavailable
when enabled. Upstream credentials, local eligibility, remote admission authentication
and user-owned gateway settings retain their existing requirements.

Codex Desktop shows its ChatGPT login screen whenever the active provider requires OpenAI auth. If
your OpenCodex setup never uses ChatGPT credentials (routed providers only, or a blocked
`chatgpt.com`), you can opt out of that gate:

```bash
ocx system settings --desktop-authless on    # or "codexDesktopAuthless": true in config.json
ocx sync                                     # rewrites ~/.codex/config.toml; restart Desktop
```

With the switch on, a loopback bind injects the dedicated provider form instead of the root
`openai_base_url` override:

```toml
model_provider = "opencodex"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = false
```

Desktop then starts without a login and routes every turn through the proxy. The setting survives
`ocx start`, restart, `ocx sync`, and `ocx ensure`; turning it off (`--desktop-authless off`) makes the
next sync restore the default loopback form, and `ocx restore` strips it like any other injected
routing. What to expect while it is on:

- ChatGPT-gated Desktop chrome (account, usage, Fast mode) stays dark: Codex derives those surfaces
  from the provider's auth requirement.
- New threads are tagged with the `opencodex` provider, as on a non-loopback bind, and history is
  handled the same way.
- Desktop releases that filter the model picker against a native-only allowlist may show an empty
  or `Custom` picker in this mode as well; requests still use the configured model. Set
  `model = "<provider>/<id>"` in `config.toml` as described in
  [Desktop remote servers](/guides/codex-app-models/#desktop-remote-servers).

This only changes the Desktop login gate. Non-loopback binds keep `requires_openai_auth = true` and
the `env_key` admission credential regardless of the switch; it never exposes an OpenCodex listener
without authentication.

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

If a routed model sends a complete patch as the entire code-mode `exec` input, opencodex
converts it to the nested `tools.apply_patch` call before the tool-completion events reach
Codex. Native custom calls and converted function calls use the same completion rule;
patch previews are held while their executable form is unresolved. JavaScript that merely
contains patch text and unrelated native custom payloads stay unchanged.

Routed code-mode turns are also told the host's rules for the nested helpers before the first
call: `tools.apply_patch` takes one string that opens and closes with the bare patch marker lines,
the isolate has no `import`, and long-running commands are polled through `write_stdin`. When a
code-mode exec result on the native routed Responses, Kiro, or Cursor path still carries one of the host's
failure messages, opencodex appends a one-line hint naming the rule. This change does not rewrite
the model's code or its patch text.

Ordinary routed Responses function calls also use the original declared parameter schema at
completion: integral floats in integer fields and integral numbers in string-only fields are
normalized, while fractions and numeric unions stay unchanged. An explicitly empty completed
argument string becomes `{}`. Final events and locally stored continuation history agree.
Unambiguous dotted namespace spellings are restored to the declared namespace and tool name.

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
3. **`liveModels: false`** — With `liveModels: false`, an empty or omitted `models` list seeds the configured `defaultModel`
   first, followed by `retainModels`; duplicate ids are removed while preserving first occurrence.
   A nonempty explicit `models` list instead seeds `models` followed by `retainModels`, without
   implicitly adding a different `defaultModel`. That default can still be listed explicitly in
   `models` or `retainModels`. If none of these fields supplies an id, the static seed is empty.
   This is seed order, not a promise of final picker order. `selectedModels`, `disabledModels` and
   provider-disabled policy still apply. `authMode: "forward"` keeps its separate branch and does
   not use this routed static seed. These rules do not change live-discovery failure fallback.
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

## Routed models during Codex reserve mode

When the ChatGPT 5-hour quota is exhausted, Codex may offer a reserve fallback model
(`gpt-reserve` / Luna Reserve). While that state is active, the Codex model picker can make
**every other entry unselectable — including opencodex routed models**, even though those
run on independent providers and credentials and consume none of the exhausted quota.

**This is a Codex client behavior and the proxy cannot change it.** The reserve state
arrives from the ChatGPT backend on the client's own authenticated connection, not through
the proxy. The desktop app polls `backend-api/wham/usage` and treats reserve as active when
the response carries `rate_limit_upsell.banner_type = "luna_reserve"`, the primary
`rate_limit.allowed` is `false`, and `additional_rate_limits[]` contains an entry with
`limit_name = "gpt-reserve"` that is still allowed. While that holds, the app forces the
conversation's model setting to `gpt-reserve` and rewrites any other pick back to it — the
picker is collapsed to the reserve entry by the client, and a `model =` value in
`config.toml` is overridden the same way. None of this consults the model catalog, so no
representation on our side participates in the decision. opencodex has no reserve concept to
adjust, and the alternative — misreporting your own quota back to your own client — would be
a worse bug than the one it papered over.

**Workaround:** the models themselves stay fully usable; only the Codex app's model
selection is gated. Reach them from a client that does not consult the ChatGPT usage
snapshot:

- Claude Code through the proxy (`ocx claude`).
- Any HTTP client against the local `/v1` endpoint.
- The dashboard's own request paths.

Normal picker behavior returns when the 5-hour window resets.

## The subagent picker

Catalog sync makes the selected sub-agent models available to Codex; see [Codex App model picker](/guides/codex-app-models/#subagent-selection) for picker ordering and [Sub-agent Surface](/guides/sub-agent-surface/) for v1/base/v2 delegation and fallback behavior.

## Codex account warmup

When a ChatGPT account is added or reauthenticated, OpenCodex normally verifies it before saving with a small streaming request to the Codex Responses backend. It waits for `response.completed`, defaults to `gpt-5.4-mini`, and retries with `gpt-5.5` and `gpt-5.6-luna` on HTTP 400 or HTTP 404. Public errors contain fixed failure categories rather than raw upstream response bodies.

If the new OAuth credential's authenticated usage lookup confirms an exhausted 5-hour, weekly, or monthly quota, the account is saved without this model request and shows **Validation pending**. It cannot serve pool requests, even after a restart or token refresh. Once quota recovers, **Refresh quotas** finishes validation: a fresh, complete usage reading with headroom permits one small model request, and only a completed response enables the account. Failed or incomplete readings and failed validation preserve the restriction. Passive account polling does not trigger deferred validation. Unknown usage during initial registration retains the normal warmup gate.

`ocx account refresh openai` and `ocx account list openai --quota --refresh` only read usage. Model validation spends quota and requires a human dashboard session: open `ocx gui` and click **Refresh quotas** after recovery. For a headless host, access its dashboard from your browser; an admin token alone does not authorize validation. Validation can complete while an account is paused without resuming or selecting it. Model authorization failures remain visible until successful validation or reauthentication clears them.

Background revalidation is separate and off by default. It requires Token Guardian, the `openai` provider's `proactive` refresh policy, and `tokenGuardian.codexWarmupEnabled`. It skips accounts awaiting deferred registration validation.

### Why an account stopped serving requests

When an account leaves pool selection, the reason travels with the decision instead of being recomputed for display, so a surface can never report an account healthy while routing is dropping it. `GET /api/codex-auth/accounts` carries `reauthReason` next to `needsReauth` on each account: `missing_credential` for a credential that was never stored, `refresh_failed` for a credential refresh that keeps failing, and `quota_unauthorized` when the usage lookup itself was rejected.

A main-account refresh that does not complete still answers `503` with `Retry-After`, because a retry may still succeed. The message now adds that a failure which persists means the main account needs reauthentication, rather than only asking for another attempt.

### Keeping a downgraded account out of rotation

`codexPool.excludedPlans` lists plan keys that automatic pool selection skips, matched case-insensitively against the plan stored on each account. It is absent by default, so an existing install rotates exactly as before.

```bash
ocx config set codexPool '{"excludedPlans":["free"]}'
```

This is a selection policy, not a block. An excluded account keeps its credential, quota history, and thread affinity, stays visible on the account surface, and is still reachable by explicit account selection such as `work/gpt-5.4`. What changes is that automatic rotation stops choosing it, including when it is already the active account or already bound to a thread — which is the state a lapsed subscription leaves behind.

Two deliberate limits. The main Codex account is never excluded by plan, because selection-only routing withholds its plan rather than reading the fenced native credential, so a rule covering it would disagree with itself. And when no unexcluded account remains, the excluded one still answers rather than failing closed; pausing every account is still the way to stop serving entirely. There is no `minimumPlan` counterpart, because ranking ChatGPT plans against each other needs a total ordering that does not exist here.

## Restoring native Codex

`ocx stop` stops the proxy and any installed background service, then attempts to restore native Codex. OpenCodex removes verified routing artifacts and reports an incomplete restore when it cannot safely recover configuration files.

Recovery may require manual review when the journal cannot verify the current files; see [recovery without injection hashes](#recovery-without-injection-hashes).

```bash
ocx stop       # stop the proxy + service, restore native Codex
ocx restore    # restore without stopping  (alias: ocx eject)
ocx restore back # point plain Codex at the running proxy again
```

When opencodex runs as a managed [background service](/reference/cli/#ocx-service), it sets
`OCX_SERVICE=1` so a service-driven restart does **not** thrash the Codex config — only an explicit
`ocx stop` / `ocx service stop` restores native Codex.

### Recovery without injection hashes

The journal saves the original `config.toml` and `opencodex.config.toml` plus hashes of the state
OpenCodex injected. A legacy journal or an interruption before those hashes were recorded cannot
prove that later file contents belong to OpenCodex. If either file differs from its saved original
and lacks its own injected-state hash, automatic journal recovery and native restore report failure
without changing either file or the journal. The saved original remains available for comparison;
review it alongside the current files before choosing a manual recovery action.

Files already equal to their saved originals are accepted without rewriting them. A missing file
is distinct from an empty file. Verified injected hashes still allow normal snapshot restoration,
and later edits in hash-backed configurations retain the existing owned-field cleanup behavior.

Sync and `ocx restore back` also reject an existing routed configuration whose hashless journal
does not match the pre-injection baseline. This prevents a new injection hash from being attached
to an older original. A genuinely native configuration can be saved as a fresh baseline before
injection. Explicit external-provider opt-out behavior is unchanged.


### Sub-agent fallback and V2 compatibility

In **Subagents → Delegation settings**, edit the ordered fallback chain and its availability polling interval (5000–600000 ms), then save it separately from the featured roster. A configured target that is no longer advertised remains in the chain until you remove it. The roster and fallback chain are separate settings; this editor does not make the roster replace the fallback policy.

When a routed preferred model may receive V2 work from a native ChatGPT parent, the panel explains the upstream encrypted-task limitation. Readable tasks from routed parents are unaffected. The guidance uses `/api/v2` mode and native V1 pin state; the current API does not expose recovery activation or request-specific eligibility, so the panel reports those as unknown. V1/plaintext-compatible delegation remains an alternative. Experimental V2 recovery, where eligible and explicitly enabled, adds quota usage, latency, backend dependence and possible fidelity loss; it does not repair the upstream protocol. See [sub-agent surfaces](/guides/sub-agent-surface/) and [the upstream limitation](https://github.com/lidge-jun/opencodex/issues/92).
