---
title: Codex Integration
description: How opencodex injects itself into Codex, syncs the model catalog, installs shims, and restores cleanly.
---

opencodex makes Codex route through the proxy by editing two things Codex reads: its config
(`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`) and its model catalog. Every edit is
idempotent and reversible.

The **Integrations** overview has a Codex switch for this native integration. Its switch shows
the latest saved desired state from OpenCodex's configuration, including immediately after a toggle, while the badge reports whether Codex is
currently observed using the proxy; during cleanup those can briefly differ while the badge
continues to report the observed state. Disabling names the effective Codex config
file, removes OpenCodex's generated routing artifacts, and leaves the proxy running for other
clients. Re-enabling rebuilds the catalog from the models available at that time, so it does not
restore the Codex files byte for byte.

For bare native Codex models and OpenCodex-generated account-selector rows, the catalog carries
authenticated access program metadata. Bare models use the main Codex account; account-qualified
models use their selected account. Refreshing the integration updates these rows when upstream
changes the account's access programs.

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
# Auto-injected by opencodex (undo: ocx restore)
openai_base_url = "http://127.0.0.1:10100/v1"
# Auto-injected by opencodex (undo: ocx restore)
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

To keep the built-in ChatGPT provider on HTTP/SSE, set `providers.openai.upstreamWebsocket`
to `false` in `~/.opencodex/config.json` and restart the proxy. Merge this field into the
existing `openai` provider; preserve its account mode and other settings. Omit the field
to restore the default upstream WebSocket selection. This setting does not change the
client-facing `websockets` switch or the ChatGPT account used for the request. Native
mid-turn steering and injection need upstream WebSocket and are unavailable while it is off.

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

### Experimental context management (Codex 0.153+)

For an eligible ChatGPT account, enable the experimental feature in Codex's own
`config.toml` (merge this into an existing `[features]` table):

```toml
[features]
context_management.experimental_mode = true
```

On the default built-in loopback integration, the next `ocx sync` or proxy start changes the
managed root `openai_base_url` to `http://127.0.0.1:10100/backend-api/codex`. Codex checks this
backend path before enabling its `new_context`, history, and notes tools. Start a new Codex
session after synchronization. The feature remains opt-in; user-owned base URLs and remote
custom-provider injection are not rewritten. No context-window or compaction-limit override
is needed or added.

The backend prefix aliases the existing data-plane routes, including Responses WebSocket
upgrades. The original `/v1` routes and the realtime sideband override remain available. The
proxy also relays the ten native `alpha/history/v2/*` and `alpha/notes/v2/*` POST endpoints
through the built-in `openai` provider with the `openai-responses` adapter and canonical
ChatGPT forward destination. Direct uses the current caller/main login; Pool selects a Codex
account. `openai-apikey` uses its configured API key, and custom or noncanonical Responses
providers are not candidates for this context relay and receive no Codex-account credentials
from it. These private endpoints are not implemented by other model providers or the OpenAI
API-key route.

Caller headers are restricted to the shared Codex forward allowlist: `authorization`,
`chatgpt-account-id`, and approved OpenAI beta, originator, session, and Codex protocol metadata.
The context relay additionally forwards `x-openai-encrypted-tool-arguments` and
`x-openai-tool-output-truncation-policy`; arbitrary caller headers such as cookies are not
forwarded. A proxy data-plane key presented as a bearer is replaced with the selected Codex
credential (the stored main login in Direct); missing credentials fail before forwarding.
Proxy admission credentials never go upstream. Encrypted arguments, response bodies, and
upstream error statuses are preserved.

A successful ChatGPT model response records the root session's actual serving account in a
bounded, process-local ownership registry. History and notes use that recorded owner, including
an explicitly selected account, even when the current active account changes. Stored-account token
refresh may continue for the same physical account; a replaced account identity is rejected.
Direct caller-owned sessions keep the caller credential and cannot be taken over by a proxy bearer.
This does not migrate server-side history between accounts.

Ownership is partitioned by the opencodex API key that admitted the request, so two keys never
reach each other's sessions even when both resolve to the same ChatGPT workspace. A workspace id
names an organization rather than a person, so the registry also binds the stable user carried by
the credential upstream accepted: an ordinary token refresh for that same user continues the
session, while a different user in the same workspace does not. When the accepted credential
proves no stable user, only that exact credential continues. That principal is the opencodex API key the request presents. A remote bind already requires one,
so ownership works there. On the default loopback bind opencodex admits requests without reading a
key, and the built-in loopback injection cannot carry the `x-opencodex-api-key` header, so Codex
presents no opencodex key and context history returns HTTP 403. **The relay is therefore available
on a remote bind with a configured key, or to a client that sends `x-opencodex-api-key` itself, and
not through the default built-in loopback integration.** Whether a loopback-bound proxy should be
able to name a caller at all is an open maintainer decision, so the current behaviour refuses
rather than guessing.

Unknown, expired, evicted, conflicting, or restart-lost ownership returns HTTP 409 before account
selection or upstream I/O. The relay does not guess from the current active account. Existing
sessions should save a checkpoint or other durable summary before enabling the feature or resetting
context. Enabling it does not backfill earlier history or notes, and a new ownership observation
does not prove that older backend content exists. After a restart, establish ownership with a
successful model request before using context tools; start a new session when ownership conflicts.

Existing model affinity, cooldown, and retry rules are unchanged. Context requests are not
automatically retried, including notes writes; ChatGPT forward requests do not use same-key 429
replay. History traffic does not consume or settle a model quota-recovery probe.

One 35-second deadline covers the whole relay operation, starting before the request body is read
and covering credential selection, so a stalled client cannot hold an admitted turn slot open.
A client disconnect returns 499 and an expired deadline returns 504; nothing is dispatched
upstream after either.

To disable the feature, remove the experimental key (or set it to `false`), run `ocx sync`,
and start a new Codex session. The managed root base returns to `/v1`.

While the key is absent or `false` the relay does not exist: the ten endpoints answer 404 for any
caller, including one that posts them directly, and a model turn records no history ownership.
opencodex decides this by reading Codex own config itself, so the switch does not depend on the
injected URL or on anything a client sends, and turning it off takes effect without a restart.

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
# Auto-injected by opencodex (undo: ocx restore)
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

On WSL, if `CODEX_HOME` is unset and the Linux `~/.codex` directory is absent or holds no Codex state
(`config.toml`, `auth.json`, `sessions`, `history.jsonl`), opencodex also
checks for a single Windows Codex Desktop home at `/mnt/c/Users/*/.codex/config.toml`. When exactly
one candidate exists, it uses that directory so WSL app-server mode and Windows Codex Desktop share
the same config and auth files. Set `CODEX_HOME` explicitly to override this detection. When Windows Codex Desktop runs its app-server inside WSL, it ships the Linux Codex binary under that home as `bin/wsl/<hash>/codex`; opencodex finds it there when the service PATH has no `codex`, after any explicitly configured runtime and PATH.

If the Codex home exists but Codex has not written `config.toml` yet (for example a fresh Desktop install
that was never signed in to OpenAI), opencodex creates an empty `config.toml` there and continues. If
the home directory itself does not exist, start Codex once so it creates it, or set `CODEX_HOME`.

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
idle task therefore does not need a new task solely because the proxy's replay cache expired.
Replayed continuation state is retained for 24 hours and stays bounded by its existing memory,
disk, and entry ceilings; this does not recover history the client no longer has. HTTP clients
must handle the error explicitly and resend their full context without `previous_response_id`.
Retrying only the same ID cannot recover missing state.

The same refusal applies when the referenced state belongs to a different client task scope,
including when the new request appears to carry complete input. The proxy cannot prove that input
is complete, so it does not silently remove `previous_response_id` or reveal whether matching state
exists. Retry with the complete conversation and omit `previous_response_id`; matching scopes and
legacy continuations where both scopes are absent or blank continue to replay normally.

The same recovery signal applies to every routed destination, because only the native Responses
passthrough can answer a turn whose history this proxy lost — it forwards `previous_response_id`
to a backend that stored the chain. Every other wire rebuilds the conversation from each request's
own input, so a missed expansion there would otherwise send the current turn alone and silently
lose the conversation. That includes the three that look stateful: Devin re-sends the whole
conversation every turn, Cursor's checkpoint reference lives in the same expired store and falls
back to full replay without it, and Kiro rebuilds its conversation history from the turns it was
handed. It also applies to routed Responses providers configured with
`statelessResponses: true`, and to routed requests where a custom tool was lowered to a function
but a delta result has no local call to establish its original type. Full replay preserves the
call, result, and reasoning together; opencodex does not guess the result type or drop it.
Stateful providers still resolve native function and native-only custom continuations themselves.
These checks follow the selected wire protocol and tool declarations, not the model name. For a
gateway that cannot resolve stored response IDs, enable `statelessResponses` on that provider;
other providers keep their defaults.

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

A routed model can also mistakenly send a shell-argument object such as
`{"cmd":"git status --short"}` to code-mode `exec`. For a verified code-mode catalog,
opencodex converts an unambiguous shell object into `tools.exec_command(...)` JavaScript
and forwards its output through `text(...)`. Shell options are preserved, and Codex still
executes and authorizes the command. Valid JavaScript fallback fields, ambiguous objects,
and unrelated tool namespaces are not converted. This compatibility repair does not bypass
provider rate limits or change the configured retry policy.

The same repair covers the goal helpers. A routed model that calls `create_goal`, `get_goal`, or
`update_goal` (or a `default.`-prefixed spelling of one) as a tool while the catalog declares only
code-mode `exec` has the call converted into the matching `tools.<helper>(...)` call inside
`exec`. A catalog that genuinely declares the bare goal tool keeps it, and a catalog that declares
neither the tool nor `exec` still rejects the call as undeclared.

For routed Responses turns, an explicit tool-enforcement policy also rejects client tool calls if
the request's declared-tool catalog is unavailable. An empty declared catalog rejects every client
tool call; Chat and Anthropic clients retain their own tool-validation responsibility.

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

While an external provider owns `config.toml`, the settings report that
`GET /api/settings` and `ocx system settings --json` return a description of the Desktop authless and
client-compaction switches — and the Codex sign-in requirement — as controlled by that
provider instead of showing the effective state OpenCodex would produce. Flipping either
switch still stores the preference, but `config.toml` is not rewritten; the stored value
takes effect if you switch Codex back to a provider OpenCodex manages and rerun `ocx start`.

If `config.toml` exists but cannot be read (permissions, or a delete racing the read), the same
report withholds the effective values and the sign-in answer as undetermined instead of showing
the state OpenCodex would compute locally. The apply record keeps that explanation — including on
a save whose injection gate is already closed by a disabled integration or a stopped proxy — and
marks it retryable, so a later `ocx system settings --json` read reports the settled answer once
the file is readable again. With Codex integration disabled, `ocx sync` is catalog-only and cannot apply it.

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

### Cache-read diagnostics

Set `OPENCODEX_CACHE_DEBUG=1` before starting the proxy to write one diagnostic record per
finalized request to `<config-dir>/cache-debug.jsonl`. The switch is off by default; set it to `0`
or remove it to disable capture. The file is owner-only (`0600`) in the hardened config directory
and rolls after 200 lines, retaining the newest 100.

Each JSONL record contains the protocol, routed provider/model, cache-counter presence and
provenance, process-local equality tags for the account, prompt-cache key, and allowlisted session
headers, plus ordered fingerprints for instructions, tools, and message/input blocks. Prefix
sections retain at most 128 tags and identify only the first divergent section/index. The
diagnostic never stores prompt or message text, tool names, raw headers, raw cache/session/account
identifiers, or a durable tag derived from them. Its random HMAC key is created at process start,
separate from other debug keys, and is never persisted; tags therefore compare values only within
one proxy process.

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
   and `ocx sync-cache` warn when those processes are detected. `ocx sync --restart-codex` restarts
   those processes and fully quits and relaunches the Codex desktop app on macOS, Linux, and
   Windows so the picker re-reads the catalog. To leave the desktop app running, pass
   `--restart-app-server-only` or stop the matching `app-server` processes yourself.

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

**What the proxy answers while that state holds.** Once the app has collapsed the picker it sends
`gpt-reserve`, and without the [authless Desktop opt-in](#authless-codex-desktop-opt-in) opencodex
holds no Reserve entitlement to send with it. That request used to be forwarded as an ordinary
native model and come back as the upstream's own `The usage limit has been reached`, which names
neither the real cause nor the setting that would change it. It is now refused locally with an HTTP
400 that says `codexDesktopAuthless` is off and gives the command that turns it on
(`ocx system settings --desktop-authless on`). Nothing is sent upstream and no quota is spent.

The refusal is deliberately narrow. It applies only to `gpt-reserve` on a loopback-admitted request
that would reach the canonical ChatGPT forward route. A `gpt-reserve` selector an operator has
aliased or routed onto another provider keeps working, a request admitted on a non-loopback listener
still forwards, and a proxy running in the `client` runtime role is unchanged. Enabling the opt-in
restores the normal Reserve path rather than the refusal.

## The subagent picker

Catalog sync makes the selected sub-agent models available to Codex; see [Codex App model picker](/guides/codex-app-models/#subagent-selection) for picker ordering and [Sub-agent Surface](/guides/sub-agent-surface/) for v1/base/v2 delegation and fallback behavior.

## Codex account warmup

When a ChatGPT account is added or reauthenticated, OpenCodex normally verifies it before saving with a small streaming request to the Codex Responses backend. It waits for `response.completed`, defaults to `gpt-5.6-luna`, and retries with `gpt-5.5` on HTTP 400 or HTTP 404. Public errors contain fixed failure categories rather than raw upstream response bodies.

An HTTP 429 from an attempted warmup is reported as `codex_warmup_rate_limited`. Retry after the temporary restriction clears or the usage limit resets; signing in again does not reset these limits. A failed attempted warmup does not add a new account or replace existing credentials. This differs from quota-confirmed deferred registration below, which can save a restricted account without a model request. HTTP 401/403 failures retain the authentication guidance.

If the new OAuth credential's authenticated usage lookup confirms an exhausted 5-hour, weekly, or monthly quota, the account is saved without this model request and shows **Validation pending**. It cannot serve pool requests, even after a restart or token refresh. Once quota recovers, **Refresh quotas** finishes validation: a fresh, complete usage reading with headroom permits one small model request, and only a completed response enables the account. Failed or incomplete readings and failed validation preserve the restriction. Passive account polling does not trigger deferred validation. Unknown usage during initial registration retains the normal warmup gate.

`ocx account refresh openai` and `ocx account list openai --quota --refresh` only read usage. Model validation spends quota and requires a human dashboard session: open `ocx gui` and click **Refresh quotas** after recovery. For a headless host, access its dashboard from your browser; an admin token alone does not authorize validation. Validation can complete while an account is paused without resuming or selecting it. Model authorization failures remain visible until successful validation or reauthentication clears them.

Background revalidation is separate and off by default. It requires Token Guardian, the `openai` provider's `proactive` refresh policy, and `tokenGuardian.codexWarmupEnabled`. It skips accounts awaiting deferred registration validation.

### Cancelling main-account device reauthentication

When cancelling main-account device reauthentication, a temporary DELETE or network failure, or a response with an unknown or nonterminal status, keeps the active flow and the cancellation-failure indication so cancellation can be retried. Status polling normally continues so a login that completes can still be detected. If a retryable cancellation failure overlaps a non-2xx GET status response while the flow is `pending` or `committing`, either response order preserves cancellation retry on that same flow, with its last server-provided device code, verification URL, and phase. The GET HTTP failure still stops polling, but cancellation can be retried without starting a second login POST. A terminal `failed` response releases the flow and displays the normalized failure reason; only `succeeded` reports login success. A confirmed `cancelled` response releases the flow so a new device login can be started. A definitive HTTP 404 response with code `unknown_flow` also releases the expired flow ID so a new device login can be started, but does not report a successful login or confirmed cancellation. Late POST, GET, or DELETE responses from an earlier flow cannot change the new flow or report login success for it.

### Why an account stopped serving requests

When an account leaves pool selection, the reason travels with the decision instead of being recomputed for display, so a surface can never report an account healthy while routing is dropping it. `GET /api/codex-auth/accounts` carries `reauthReason` next to `needsReauth` on each account: `missing_credential` for a credential that was never stored, `refresh_failed` for a credential refresh that keeps failing, and `quota_unauthorized` when the usage lookup itself was rejected.

A main-account refresh that does not complete still answers `503` with `Retry-After`, because a retry may still succeed. The message now adds that a failure which persists means the main account needs reauthentication, rather than only asking for another attempt.

### Optional idle-window steering

`codexPool.startIdleWindows` is an optional boolean and defaults to `false`. When enabled, a new
unbound real request may be placed on an eligible account whose observed short quota window is at
0% with evidence that its five-hour clock has not started. This check runs after conversation and family affinity, so an existing
binding remains authoritative; an explicit account pin or manual account preference also wins.
Independent model quota scopes are skipped, and the shared active cursor is unchanged. After the
idle-window choice, normal strategy selection resumes for other conversations.

The observation must be no older than five minutes, and the short window must explicitly be
18,000 seconds. Its reset must be observed within 60 seconds of `observation + 5h` (rather than an already ticking or elapsed reset). A synchronous,
process-local reservation prevents duplicate selections for the same account and window. The
reservation deadline is at least 5h plus one minute after selection; a fresh observation is
required after that deadline before the same account can be steered again. Reservations are cleared when the proxy
process restarts and are never persisted to disk.

Enable it in your existing configuration:

```json
{
  "codexPool": { "startIdleWindows": true }
}
```

If no account meets the criteria, ordinary routing applies. This feature only steers an actual incoming request. It creates no synthetic request and no timer.

### Keeping a downgraded account out of rotation

`codexPool.excludedPlans` lists plan keys that automatic pool selection skips, matched case-insensitively against the plan stored on each account. It is absent by default, so an existing install rotates exactly as before.

```bash
ocx config set codexPool '{"excludedPlans":["free"]}'
```

This is a selection policy, not a block. An excluded account keeps its credential, quota history, and thread affinity, stays visible on the account surface, and is still reachable by explicit account selection such as `work/gpt-5.5`. What changes is that automatic rotation stops choosing it, including when it is already the active account or already bound to a thread — which is the state a lapsed subscription leaves behind.

The main Codex account remains exempt from plan exclusion; selection-only routing does not read its fenced native credential. If every eligible pool account is excluded, automatic selection returns no account. Explicit account-qualified routes remain available and still enforce pause, authentication and model entitlement. The account card and CLI show the excluded routing plan separately from credential health. There is no `minimumPlan` setting because the plan names do not define a total order.
## Restoring native Codex

`ocx stop` stops the proxy and any installed background service, then attempts to restore native Codex. OpenCodex removes verified routing artifacts and reports an incomplete restore when it cannot safely recover configuration files.

Recovery may require manual review when the journal cannot verify the current files; see [recovery without injection hashes](#recovery-without-injection-hashes).

```bash
ocx stop       # stop the proxy + service, restore native Codex
ocx restore    # restore without stopping  (alias: ocx eject)
ocx restore back # point plain Codex at the running proxy again
```

When opencodex runs as a managed [background service](/reference/cli/lifecycle/#background-service), it sets
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

## Paginated history safety refusal

When an affected history store supports paginated records, a provider transition may return `history_paginated_requires_native_writer`. That reason no longer refuses the Codex configuration, the reference profile, or the model catalog. `ocx sync` and `ocx start` still write those files and set `model_catalog_json`, so the Codex model picker keeps showing every OpenCodex-routed model. Only this one reason stands the conversation-history relabel down, because Codex allocates paginated rollout ordinals in its own writer and no retry changes that. Any other history preflight reason — an unreadable state database, a rollout whose identity changed, or a preflight that could not run — still refuses the whole transition and rolls it back, because those may succeed on a later attempt. OpenCodex never modifies paginated rollout files or thread rows in this state. Existing conversations keep whatever provider they are already tagged with and are not migrated; new conversations route through the proxy normally. When the relabel stands down, a `[model_providers.opencodex]` table that the home already had is kept rather than retired, even in the root-override (loopback) form, so conversations whose rows are tagged `opencodex` keep a provider id that still exists. This includes legacy rows in a migration-capable store. The CLI prints `Codex resume history: left to Codex's native writer (history_paginated_requires_native_writer)`.

When returning to the root-override form, OpenCodex retains an existing `[model_providers.opencodex]` definition before committing the configuration, even if history preflight currently passes. This keeps older `opencodex` conversations resolvable if Codex migrates history after that commit or while the background worker starts. New conversations still use the selected root provider; explicit restore keeps its separate removal guards.

`ocx restore`, `ocx stop` and `ocx uninstall` no longer refuse on `history_paginated_requires_native_writer`. They take every OpenCodex root routing key out and keep the `[model_providers.opencodex]` definition on disk, so conversations whose rows still name that provider keep resolving while plain `codex` stops pointing at the proxy. The result is reported as a partial restore that names the retained lines, and `ocx restore --remove-codex-provider-table` removes them too, after which those conversations stop opening.

Enabling the integration in its provider-table form on a home whose `openai`-tagged conversations Codex has already paginated used to be refused outright with `history_paginated_openai_requires_native_writer`: nothing was written and the integration stayed disabled. OpenCodex now completes that transition by keeping the managed root `openai_base_url` override beside the `[model_providers.opencodex]` table. Codex merges the override onto its built-in `openai` provider, so those conversations keep reaching the proxy without being relabeled and no rollout byte or thread row is touched. Only a routing form that requires the `x-opencodex-api-key` admission header still refuses, because Codex's built-in provider cannot carry that header; its message names the two settings that resolve it — route Codex through the loopback listener so the override can be retained, or set `syncResumeHistory` to `false` to accept that those conversations resume against Codex's own OpenAI endpoint.

Do not rewrite an active paginated rollout or thread row to migrate those conversations yourself. Close the affected conversation before any recovery, and report the exact error and versions without uploading private history. A backup or a successful script alone does not prove the conversation is visible again. Check the restored conversation in Codex after reopening.

## Experimental native mid-turn steering

For a compatible model on the canonical ChatGPT forward route, and a client
that sends `response.steer`, enable both options in `~/.opencodex/config.json` and restart
OpenCodex before starting a fresh turn:

```json
{
  "websockets": true,
  "codexNativeSteering": true
}
```

Merge these keys into the existing configuration; do not replace your provider/account settings.
This option is off by default. It forwards steering to the same explicitly configured native WebSocket
connection and selected account, preserving automatic successor responses and pending
saved-tool-result continuations. Acceptance means queued, not yet applied.

Supply the required tool results or approval decisions **once per parent**, on the same lane.
Results can arrive before `response.steer.pending`: the relay also matches the completed
parent's advertised calls and approvals. A `name` on a pending function-output stub is
optional on the result, as in the native schema. Additional user messages may accompany
these results; system/developer messages, duplicate results and unrelated call IDs are refused.
Do not rerun tools or resend accepted steering text. Model, account, tool declarations and routing stay unchanged. Validated generation settings
may change in an explicit saved-result continuation as described below. Other changes
require an explicitly stopped or finished turn and normal new dispatch. Multiple independent conversations use independent connections.

HTTP fallback, noncanonical gateways, public API-key routes, translated models, sidecars, Combo attempts and plaintext V2
restoration do not support this option. It does not add steering capability to a model or
a client that lacks it. Unsupported routes return a protocol error rather than silently
ignoring input. Disconnected or timed-out delivery may be unknown: never automatically
resubmit tools or steering text. Pending controls have per-submission absolute 90-second confirmation deadlines;
saved-tool-result waits have a 30-minute cap.

The implementation has synthetic protocol and regression coverage, not live Astra/client
certification. Keep the option disabled for production work until your client/model path
has been verified. Set `codexNativeSteering` to `false` and restart to restore the existing
single-response relay; no account or conversation files need to be deleted.


### Steering confirmation deadlines and retained context

Each submitted steer has a fixed 90-second acknowledgement window. Other output
and additional steers do not extend it. Once accepted, the input remains queued
while the current response reaches a safe boundary; ordinary stream-idle checks
still apply. After the response ends, the successor must begin within 90 seconds.
A request for tool results or approval allows 30 minutes from the first such
notification. Repeated notices do not renew this wait. Submitting saved results
starts a new 90-second successor window, including local pacing/auth checks.
Missing acknowledgements remain subject to their earlier individual deadlines.

The owned connection itself has no absolute lifetime cap. Up to 128 responses may share it, and
each may legitimately consume its own acknowledgement, successor, stream-idle and required-input
waits, so the per-stage deadlines above compose to a worst case on the order of tens of hours.
During that time the turn holds one physical socket and one pinned credential that cannot rotate,
because the channel deliberately never re-enters account selection. Treat an enabled steering
connection as a long-lived session resource rather than an ordinary bounded request.

Steering frames also share the proxy's configured body and memory limits. A control frame above
[`maxInboundBodyBytes`](/reference/inbound-body-admission/) is refused before
it is parsed on an established control connection (an initial frame is still parsed before
its type-based limit applies), and the reconstructed body sent upstream is refused when it exceeds
[`maxUpstreamBodyBytes`](/reference/configuration/providers/). Each
connection's replay journal is capped at 32 MiB and counted as pinned state against
[`appOwnedMemoryBudgetMb`](/reference/configuration/server/); admitting a
journal demotes evictable caches first rather than failing, and the aggregate across live journals
is capped at 128 MiB regardless of the configured budget.

A timeout means **delivery is unknown**, not that the server rejected the input.
Do not resend an accepted instruction or rerun a tool automatically. Inspect the
actual task state before deciding how to resume. No account switch or paid API
fallback is performed. Completed output already received on the wire is retained
for local continuation history even when the terminal summary omits it. Conflicting
item content or order causes an explicit failure rather than silent context loss.

For a live comparison, use the same supported client version, model and account
in isolated test conversations, once without the proxy and once with it enabled.
Use a read-only task, steer while output is active, and compare acceptance and the
successor's actual instruction adherence. Repeat while a synthetic tool result or
approval is pending and after an explicit disconnect. Record only event types,
relative times and redacted outcomes, not credentials or task bodies. Passing mock
transport tests does not establish live client/backend support; no real-account
smoke test is implied by these instructions.

## Experimental native function-result injection

For a compatible client that sends OpenAI multi-agent `response.inject` messages,
merge these keys into the existing OpenCodex configuration and restart before a
fresh turn. Do not replace your provider or account settings:

```json
{
  "websockets": true,
  "codexNativeInjection": true
}
```

The initial `response.create` must explicitly include `"multi_agent": { "enabled": true }`.
OpenCodex does not enable it based on a model name. A public OpenAI API provider
must use `adapter: "openai-responses"`, `baseUrl: "https://api.openai.com/v1"`,
its normal API-key authentication and `upstreamWebsocket: true`. Route the initial
model through that provider's configured prefix. The relay adds the required
`responses_multi_agent=v1` beta token on that public API connection only, preserving
other configured beta tokens. It does not substitute a subscription credential,
create an API account or automatically switch to a separately billed API.

Canonical ChatGPT forward connections can opt into the same transport experimentally,
but the public API contract does **not** establish ChatGPT subscription or Codex
App/CLI support. A compatible upstream model and execution mode are still required.
See the [OpenAI multi-agent protocol](https://developers.openai.com/api/docs/guides/responses-multi-agent).

Return a saved tool result after the matching developer function call has completed:

```json
{
  "type": "response.inject",
  "response_id": "resp_example",
  "input": [
    { "type": "function_call_output", "call_id": "call_example", "output": "saved result" }
  ]
}
```

Use the response/call IDs from the **same connection**, not these example IDs.
`response.inject` accepts string-valued `function_call_output` only. User/system
messages, rich output arrays, hosted-tool results and simultaneous `response.steer`
are not accepted by that operation. The wider saved-result continuation below is
a separate `response.create` operation, not a hidden conversion of rejected injection. Multiple saved function results can share a
single injection. Each call can be submitted only once, including while queued.

Parallel tool results are queued and sent one frame at a time, since the success
event identifies the response rather than an individual injection. The relay
preserves `response.inject.created` and `response.inject.failed`. It keeps the
connection alive after a response terminal while submitted results await confirmation
or advertised calls await results, so late asynchronous results are not discarded.

When the server rejects an injection with `response_already_completed`, use its
returned saved outputs in **one client-sent** `response.create` with the completed
`previous_response_id`, unchanged model/settings and the same lane. Include each
outstanding result exactly once; do not include already accepted outputs. The
relay keeps that continuation on the original account/socket and preserves normal
request pacing. It never runs the tool again or creates a recovery request itself.
Other failures remain visible for the client to handle.

A missing acknowledgement or a disconnect means delivery can be **unknown**. Do
not automatically resend a result, restart a tool or change accounts to retry it.
The pending queue is limited to 32 frames and 8 MiB, with 1,024 advertised function
calls, a 32 MiB replay journal and at most 128 responses per owned connection.
Injection journals share the pinned memory budget and 128 MiB aggregate ceiling
with steering journals; see [steering memory limits](#steering-confirmation-deadlines-and-retained-context).
The configured upstream body limit is checked before a result enters the queue,
even while another result awaits acknowledgement. An `outbound_body_too_large`
refusal leaves the connection usable for a corrected result without rerunning its tool.
Each sent injection has a 90-second acknowledgement deadline that unrelated output
cannot extend; a saved-result wait is limited to 30 minutes. Existing frame limits
and stall timeouts still apply.

Translated providers, custom gateways, Combo/sidecar paths and HTTP fallback do
not gain injection support. Unsupported attempts return an explicit error instead
of disappearing. The option stays off by default; synthetic transport tests are
not live compatibility certification. Set `codexNativeInjection` to `false` and
restart to roll back. No account or conversation files need to be removed.


### Rich tool results and explicit approvals after response completion

With `codexNativeInjection` enabled, a client-sent `response.create` on the same
owned connection can now return **unsent** function/custom results containing text,
image or file parts after `response.completed`. Supply the completed response's
`previous_response_id`, the same lane and unchanged model/settings. Include every
outstanding result or requested approval exactly once; omit already accepted
injected results. The proxy forwards this caller-sent continuation using the
original account and socket with the existing dispatch checks.

Supported continuation items are `function_call_output`, `custom_tool_call_output`
and `mcp_approval_response`. Tool output may be a string or an array of `input_text`,
`input_image` and `input_file` parts. Image parts require `detail` (`auto`, `low`,
`high` or `original`); file detail is optional (`auto`, `low`, `high`). Use exactly
one image/file source. Inline file data requires a filename. Optional
`prompt_cache_breakpoint: { "mode": "explicit" }` is preserved. Unsupported fields
are rejected, not removed. References are not downloaded or reuploaded by the proxy.
Each result has at most 1,024 content parts within the existing 8 MiB request limit.
A supplied program caller must match the advertised call; it cannot impersonate
another tool or agent. Content order, file references and original spelling survive.

For a server-issued `mcp_approval_request`, pass its ID as `approval_request_id` and
an explicit `approve: true` or `approve: false`. A refusal is forwarded unchanged.
The proxy does not decide, default, auto-approve or execute the requested tool.
A missing or unrelated decision is rejected. Hosted `multi_agent_call` actions and
other server-run tools are **not** developer functions: their events, outputs and
encrypted agent messages are preserved, never executed or injected by OpenCodex.

This does not enable rich/custom/approval **mid-response injection**, nor simultaneous
steering on a multi-agent response. Those operations have different upstream
contracts. Unsupported injection is refused before reserving a call, so an unsent
result remains available for a later explicit continuation. There is no automatic
conversion, retry, tool rerun or account/API switch. A single-agent steering turn
can follow a completed multi-agent turn as a new explicit request using ordinary
routing. Client support and backend entitlement still require live verification.


## Steering continuation settings

An explicit saved-result `response.create` may override `reasoning` (effort and
summary), `text` (verbosity and supported structured-output format), and
`stream_options`. Subscription routes refuse a `max_output_tokens` override
instead of silently ignoring it. Normal provider pins, subagent caps, effort
mapping and summary/verbosity capability exclusions still apply.

Omitted settings retain the current effective values; explicit null resets that
setting where the upstream accepts null. Overrides replace the supplied setting
object, not individual nested fields. Changed values carry into later explicit
continuations. A rejected override does not reserve the saved result, so a
corrected request can be submitted without rerunning its tool. The server still
decides which settings the chosen model accepts. Changes to model, account,
provider, tools, instructions or service tier require a separate ordinary turn.

Native steering is restricted to the canonical ChatGPT subscription route. Public
API-key and gateway routes are not steerable; their ordinary responses are preserved
and a steering attempt receives an explanatory error. This prevents successor
generations on a retained socket from bypassing normal per-request admission. The
separately gated public API multi-agent injection path remains available.

### Executable direct-versus-proxy wire probe

From a source checkout, run the offline positive control:

```sh
bun scripts/steering-smoke.ts --self-test
```

Plan a comparison without reading tokens or opening any connection:

```sh
bun scripts/steering-smoke.ts --direct wss://api.openai.com/v1/responses \
  --proxy ws://127.0.0.1:1455/v1/responses --model <supported-model> \
  --proxy-model <provider-prefix/same-model>
```

For a subscription comparison the direct URL is
`wss://chatgpt.com/backend-api/codex/responses`. Select the same actual model and
account on both routes; the script cannot prove that a proxy configuration selected
the same account. The proxy URL must be a loopback Responses endpoint and must not
contain credentials, query parameters or a fragment.

Only after reviewing the plan, supply `STEERING_DIRECT_TOKEN` and
`STEERING_PROXY_TOKEN` through your shell environment and add **both** `--live`
and `--allow-model-requests`. A direct ChatGPT connection may additionally need
`STEERING_DIRECT_ACCOUNT_ID`; that header is never copied to the public API or the
proxy. Do not put credentials in command arguments, logs, screenshots or PRs.
The script does not read your saved Codex login, refresh tokens or change settings.

Live execution sends four synthetic initial requests (two scenarios per route),
plus any resulting successors or required-result continuations, and **can consume
model usage**. One scenario checks an automatic successor; the other returns a
fixed synthetic result only for the script's own advertised function and changes
reasoning/verbosity on its explicit continuation. No external tool is executed and
no approval is inferred. There are no retries or automatic recovery requests.
Each scenario is limited to 120 seconds, 5,000 events and 2 MiB received data.

The JSON report contains only outcomes, timing and boolean checkpoints. A pass
requires queued acceptance, a created successor and the synthetic marker in its
completed output. Missing confirmations are `unknown`; if the model never enters
the required-input path the result is `not_exercised`. Neither is counted as pass.
The process exits 0 only if all four live scenarios pass, 1 otherwise, and 2 for
invalid arguments or missing credentials. This is a **wire diagnostic**, not an
end-to-end Codex App/CLI interface test, live certification or instruction to enable
the experimental feature for production work.
