---
title: Server and Runtime Configuration
description: Listener, remote access, admission keys, timeouts, storage, sidecars, shadow calls, and startup behavior.
---

Server settings control how the local proxy listens, protects remote traffic, manages resources, and
runs helper features around provider requests.

## Server fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | Proxy listen port. |
| `hostname?` | `string` | `"127.0.0.1"` | Bind address. A non-loopback bind requires a data-admission token, resolved from `OPENCODEX_API_AUTH_TOKEN`, then `OCX_API_TOKEN_FILE`, then the installed owner-only `service-api-token` — nothing has to be exported by hand. See [Remote access](#remote-access). |
| `proxy?` | `string` | — | Outbound HTTP(S) or SOCKS5 proxy URL (`socks5://host:port`), `${ENV_VAR}`, or `"auto"`. HTTP URLs apply to `HTTP_PROXY` / `HTTPS_PROXY` when those are unset. SOCKS5 URLs use OpenCodex's real SOCKS5 transport and are also exposed through `ALL_PROXY` (`ocx start --socks5`); inherited `HTTP(S)_PROXY` is cleared in this process. Loopback stays in `NO_PROXY`. `"auto"` reads the Windows system proxy (WinINET `ProxyEnable`/`ProxyServer`) once at process start, preserves distinct `http=` and `https=` entries, and logs the hosts it chose. A bare `ProxyServer` value applies to both schemes. On other platforms, or when the system proxy is off, SOCKS-only, or unreadable, it uses direct egress and says so. PAC/WPAD and live proxy changes are not followed; restart the service after changing the system proxy. |
| `noProxy?` | `string \| string[]` | — | Hosts that bypass `proxy`, merged with inherited `NO_PROXY` and loopback entries. A string may use comma-separated `NO_PROXY` syntax or `${ENV_VAR}`. |
| `emptyCompletionRetry?` | `boolean` | `false` | Opt in to one identical Responses retry when a turn has no text or tool call, including a stream that ends before a terminal event. The retry may be billable. `OCX_EMPTY_COMPLETION_RETRY=0` disables it without changing config; combo and routed-compaction turns remain excluded. |
| `dropCodexSafetyBuffering?` | `boolean` | `false` | Remove optional client-facing hints from canonical Codex Responses passthrough: the two `x-codex-safety-buffering-enabled` / `x-codex-safety-buffering-faster-model` response headers, `response.metadata` events whose metadata type is `safety_buffering`, and top-level `safety_buffering` fields. Other headers, response data, policy refusals and failures are preserved. This does not disable provider safety enforcement or upstream buffering. Native `codex.response.metadata.headers` WebSocket metadata and `/responses/compact` are outside this filter. |
| `stallTimeoutSec?` | `number` | `300` | Seconds without meaningful upstream progress (Responses and native Chat). Minimum 1. |
| `oauthOpenBrowser?` | `boolean` | `true` | Whether a login may open a browser on the machine running the proxy. Absent and `true` both open, so an existing install is unchanged; only an explicit `false` declines. Decline when you need the authorization link in a different browser profile, or when the dashboard is not on the proxy's machine — the login still starts and the URL is still returned and displayed. `POST /api/oauth/login` and `POST /api/codex-auth/login` accept a per-request `openBrowser` boolean that overrides this, and the dashboard exposes the same choice beside the login button. Device-code flows never open a browser either way. |
| `connectTimeoutMs?` | `number` | `200000` | Per-attempt DNS/TCP/TLS/final-header deadline; it ends before body generation. |
| `shutdownTimeoutMs?` | `number` | `5000` | Graceful drain deadline before active turns are aborted. |
| `websockets?` | `boolean` | `false` | Advertise and admit the client-facing Responses WebSocket path. False keeps clients on HTTP/SSE; it does not disable an eligible canonical ChatGPT upstream WS optimization. Complete-input requests may reuse an upstream connection within the same selected credential, account, thread and turn; changed handshake policy or missing identity keeps requests on separate connections. This does not trim HTTP input or create previous-response IDs. |
| `codexNativeSteering?` | `boolean` | `false` | Experimental, native-only mid-turn steering on the Responses WebSocket endpoint. Requires `websockets: true`, a compatible upstream/client, and a pinned account/model/tool surface. Validated generation settings can change in explicit saved-result continuations. Does not enable translated models or HTTP fallback. See [native steering](/guides/codex-integration/#experimental-native-mid-turn-steering). |
| `codexNativeInjection?` | `boolean` | `false` | Experimental saved function-result injection on compatible native multi-agent WebSocket turns. Requires `websockets: true`, explicit `multi_agent.enabled`, and an eligible provider. Separate from steering; no automatic tool rerun or recovery create. See [native injection](/guides/codex-integration/#experimental-native-function-result-injection). |
| `corsAllowOrigins?` | `string[]` | `[]` | Additional exact origins allowed by CORS. Loopback origins are always allowed. Authority-based browser extension origins such as `chrome-extension://<extension-id>` are supported; `*` is not a wildcard. Firefox and Safari regenerate the extension UUID (per install / per browser launch), so update the entry when the origin changes. |
| `apiKeys?` | `OcxApiKey[]` | `[]` | Generated `ocx_…` data-plane admission credentials on non-loopback binds. They do not authorize management APIs; management access uses the separate credential documented in the [management reference](/reference/management-api/). Dashboard-managed. |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | disabled | Opt-in archived-session cleanup policy. Never enabled implicitly. |
| `usageLedgerMaxBytes?` | `number` | unset | Opt-in ceiling in bytes for `usage.jsonl`. Absent means the request history grows without limit, which stays the default. See [usage history size](#usage-history-size). |
| `appOwnedMemoryBudgetMb?` | `number` | `256` | Cap in MiB for evictable app-owned logs, caches, blobs, and continuation payloads. Range 64–4096; not an RSS cap. |
| `metricsExport.enabled?` | `boolean` | `false` | Enable process-local aggregate request metrics at authenticated `GET /api/metrics`. Restart required; disabled mode returns 404 and starts no exporter activity. |
| `spend?` | `{ root?: { maxTokens?: number }; identity?: { maxTokens?: number }; pool?: { maxTokens?: number }; retentionDays?: number }` | unset | Durable token ceilings, off unless you write one. Each scope bounds settled spend plus in-flight reservations plus unresolved spend: `root` is one task including its whole fan-out, `identity` is one account across every task it serves, and `pool` is one provider pool. They intersect, so a request is admitted only when all three have room — which is what holds a ceiling against a client that mints a new task id per request. A reservation is the request's whole input plus its enforceable output ceiling, counted as if every cached prefix misses. Observe-only mode still journals, so every server owns the state directory's single-writer lease; an explicit sibling must use a separate `OPENCODEX_HOME`. Spend survives an ordinary process restart when its writes reached the filesystem, but the journal does not promise survival across host power loss because each append is not fsynced. Raising or removing the value is what grants more. `maxTokens` must be a positive integer (0 would refuse everything), `retentionDays` is 1–365 and defaults to 7, and an unknown key in this section is rejected rather than ignored. A refusal is a local HTTP 429 carrying `x-opencodex-local-refusal: workflow_spend_exhausted`, and its message names the scope and the ceiling; no provider is contacted. |

| `codexAutoStart?` | `boolean` | `true` | Let the Codex shim run `ocx ensure` before launching Codex. False makes ensure a no-op. |
| `codexShimAutoRestore?` | `boolean` | `true` | Restore an installed shim after a completed external Codex update replaces it. Environment opt-out: `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`. |
| `codexDesktopAuthless?` | `boolean` | `false` | Opt-in authless Codex Desktop routing on a loopback bind: inject the dedicated `opencodex` provider with `requires_openai_auth = false` so Desktop opens without a ChatGPT login. Ignored on non-loopback binds. `ocx system settings --desktop-authless on`. See [Codex integration](/guides/codex-integration/#authless-codex-desktop-opt-in). |
| `codexAccountPickerEnabled?` | `boolean` | unset | Whether generated account-qualified catalog rows (`<selector>/<model>`) are advertised. Enabling it once fills an absent or empty `codexAccountNamespaces` with default selectors; `false` hides the generated rows without deleting exact routing bindings. An omitted flag keeps a non-empty hand-written selector map enabled. The Luna Reserve row is account-qualified, so it is written only when a selector targets the main Codex account; when it is suppressed, catalog sync logs the reason and the action that restores it. |
| `codexAccountNamespaces?` | `Record<string, string>` | unset | Public selector to Codex account mapping. The main login maps to the config-only sentinel `@main`; added accounts map to their account id. Normally generated by enabling `codexAccountPickerEnabled` rather than hand-authored. An empty map means no account-qualified rows exist, including the Luna Reserve row. |
| `codexClientCompaction?` | `boolean` | `false` | Opt into Codex client-side compaction on an authenticated loopback bind. Uses the dedicated `opencodex` provider identity with `requires_openai_auth = true`, preventing new routed compactions from storing OpenCodeX-owned `ocx1:` state. `codexDesktopAuthless` takes precedence when both are enabled and keeps `requires_openai_auth = false`. V2 sub-agent routing is unchanged. `ocx system settings --client-compaction on`. See [Codex integration](/guides/codex-integration/#client-side-compaction-opt-in). |
| `codexProviderDisplayName?` | `string` | `"OpenCodex Proxy"` | Label Codex shows for the injected `opencodex` provider, written as its `name` field in `config.toml` and the reference profile. Presentation only: routing resolves through the provider id `opencodex`, so a rename never moves `model_provider = "opencodex"` or the `[model_providers.opencodex]` header and cannot orphan threads already tagged with that id. Codex refuses to load a provider with no name, so there is no way to omit the field — choose a neutral label instead. A blank, over-128-character, or control-character value is ignored and the default label is written. |
| `resetCreditAutoRedeem?` | `{ enabled?: boolean; leadTimeMinutes?: number }` | off | Opt-in: redeem the main Codex account's soonest-expiring reset credit `leadTimeMinutes` (1–60, default 10) before it expires. Every attempt re-reads the upstream credit list first and skips when the credit is gone (for example, redeemed by hand); the `redeem_request_id` is journaled in `$OPENCODEX_HOME/reset-credit-auto-redeem.json` before the call so a crash replays the same idempotent request instead of spending a second credit. Servers sharing this configuration directory coordinate reservations and settlements so one process does not replace another's request record. Logs carry a hashed account key only. |
| `syncResumeHistory?` | `boolean` | `true` | Reversible Codex App history compatibility. Original metadata is backed up and restored by `ocx stop` / `ocx restore`. |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` | off | Redirect recognized Codex helper/shadow calls to a chosen model while preserving the request's configured reasoning effort. The default source prefix is `gpt-5.6-luna`; older clients through 0.144.x used `gpt-5.4-mini`, which `sourceModels` can restore. |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | on when usable | Web-search sidecar options. |
| `visionSidecar?` | `OcxVisionSidecarConfig` | on when usable | Image-description sidecar options. |
| `images?` | `OcxImagesConfig` | automatic OpenAI selection | Standalone Images relay options for Codex `image_gen`. |

While the canonical ChatGPT upstream WebSocket waits for the first Responses event after
sending the create frame, it watches for liveness rather than a fixed deadline. When the socket
supports protocol pings, the proxy pings it every 15 seconds. Any inbound frame — quota,
response metadata, or a pong — resets a 90-second silence clock, so a socket without ping
support still stays alive on its own frames, and only 90 seconds with nothing at all settles the request as an
HTTP 504 with an `upstream_no_response` error. A slow but alive origin therefore waits for the
client's own deadline or for `connectTimeoutMs` (default 200s), whichever comes first; a
connect timeout that fires after the create frame was sent settles as the same 504. A socket
that closes or errors before the first Responses event settles as an HTTP 502 with
`upstream_closed_before_response`. The proxy does not retry either status on its own: the frame
may already be executing upstream, so the client applies its own retry policy exactly as it would
when connected to the backend directly. The one exception is that 502 on a provider that opted
into `retryOnReset`, described below. Once the response has started, a later drop
surfaces inside the stream as before. `stallTimeoutSec` is unrelated to this window.

An ordinary HTTP send has a third case. When the connection dies before any response header
arrives, the proxy cannot tell whether the model already processed the request, so it refuses
to send it again and answers HTTP 429 with `upstream_reset_replay_refused`. The status is
deliberate: a 5xx here is an instruction to most clients, including Codex, to send the whole
turn again, which is the duplicate the refusal exists to prevent. No `Retry-After` is
attached, and the response carries `x-should-retry: false`, which the official OpenAI and
Anthropic SDKs read before their own status rules — without it those clients retry a 429 on
their own schedule and resend the turn anyway. The same replay-refusal behavior applies on
`/v1/responses` and `/v1/chat/completions`, whether the request is forwarded natively or translated.
Routed `/v1/messages` requests translate through Responses and project the same status, code, and
retry headers into an Anthropic-shaped error envelope. The proxy
performs no key rotation, account failover or same-target replay on it, nor does it record the
refusal as rate-limit or quota evidence against the credential it was holding. Tool-call side
requests such as vision and web search are replayed normally, because repeating them cannot
duplicate a turn.

A native Responses provider can opt into replacing that send with
[`retryOnReset`](/reference/configuration/providers/#provider-entries-ocxproviderconfig). The same grant covers the
case where the connection survives the header and the SSE body then dies carrying only control
events, because the caller has observed nothing in either one. It also covers the canonical
ChatGPT WebSocket above: a socket that closes or errors before the first Responses event is
replaced by one HTTP send, never by a second socket. A silent socket keeps its 504, and a native
steering or injection turn is never replaced. A replacement happens only when
the request is self-contained (`store: false`, complete input, client-executed tools only, no
server-side continuation state), and one logical request gets the configured number of
replacements in total — across every recovery leg and every combo child, not one each. The
refusal returns as soon as that grant is spent, the leg has no send left, or a replacement fails
for any other reason. A request that already emitted output or a tool call keeps the refusal
regardless. A caller that cancels mid-replacement gets the cancellation, not the refusal.

`noProxy` accepts either a comma-separated string or an array. Both forms add entries without
replacing an inherited `NO_PROXY`:

```jsonc
{ "proxy": "http://proxy.corp:8080", "noProxy": "internal.example,10.0.0.0/8" }
```

```jsonc
{ "proxy": "http://proxy.corp:8080", "noProxy": ["internal.example", "10.0.0.0/8"] }
```

SOCKS5 (Clash mixed-port listeners included) belongs on `ALL_PROXY`, not `HTTP_PROXY`:

```jsonc
{ "proxy": "socks5://127.0.0.1:10808" }
```

`ocx start --socks5` writes that value; `ocx start --socks5-off` clears it.

If an older development build changed resume-history metadata before backup support existed, run
`ocx recover-history --legacy-openai --yes` to force native-provider recovery.
It force-relabels every user-message `opencodex` row, including legitimate dedicated-provider
history; review the full-scope warning in the lifecycle reference before running it.

### Native Chat timeouts and completion

Native Chat also uses `stallTimeoutSec` while waiting for upstream output. Nonempty text, reasoning, refusal, tool updates, and finish frames renew the allowance; keepalive comments, role-only frames, and usage alone do not. Waiting for a slow client to read pauses the allowance. A stall produces `upstream_stall_timeout`: an error frame for streaming clients, or HTTP 502 for non-streaming clients. Cancellation before a terminal result returns a cancellation error instead of a successful partial answer. Buffered Chat results accept both LF and CRLF SSE framing, including multiline data.

## Codex quota network diagnostics

The main Codex account row may include `quotaRefresh` when a quota fetch was
attempted. This describes that fetch, not remaining quota, model access or
permission to retry. Cached reads and rows without a fetch may omit it; absence
does not mean success. A `null` quota value means unavailable, not zero quota.

To request fresh data and display only the diagnostic in PowerShell:

```powershell
$quotaReport = ocx account list openai --quota --refresh --json | ConvertFrom-Json
$quotaReport.accounts |
    ForEach-Object { if ($_.quotaRefresh) { $_.quotaRefresh } } |
    ConvertTo-Json -Depth 3
```

If no diagnostic is present, this projection produces no diagnostic object. Share
only these fields when comparing network modes, rather than the full account list.

| `quotaRefresh.status` | Meaning |
| --- | --- |
| `ok` | The fetch completed and a quota object was parsed. |
| `not_reported` | The response contained no usable quota object. |
| `http_error` | The upstream returned an HTTP failure; `httpStatus` contains its status code. |
| `timeout` | The quota fetch timed out. |
| `network_error` | The request failed before a classified HTTP response. |
| `invalid_response` | The response was not a usable quota document. |
| `internal_error` | An internal refresh step failed. |

Only `http_error` includes `httpStatus`. Other statuses do not imply HTTP 0 or an
account entitlement problem.

### Which proxy path is used?

The running proxy service fetches quota. It uses its own environment, not the
interactive shell that later runs `ocx account list`. Configure the service's
proxy setting or environment, then restart it; changing variables in another
terminal does not update an already running service.

An unset `proxy` leaves inherited proxy variables unchanged. An explicit HTTP(S)
proxy URL fills `HTTP_PROXY` and `HTTPS_PROXY` only where they are unset.
`"proxy": "auto"` reads the Windows static WinINET proxy once at startup; existing
proxy environment variables take precedence. Auto discovery does not resolve
PAC/WPAD, SOCKS-only settings or live proxy changes. Use a supported static HTTP
proxy setting or an explicit HTTP(S) proxy URL when needed.

Compare the diagnostic on the same machine and account under the two network
modes. A successful TUN test alone does not identify why the service's HTTP proxy
path failed, and does not establish a general fix.

## Connection reuse for specific upstream hosts

Some upstreams keep a connection open after they have stopped serving it. The next request reuses
that pooled socket and fails without reaching the provider. `OCX_FRESH_CONNECTION_HOSTS` names the
hosts that should never reuse a pooled connection, as an environment variable rather than a config
field, so it can be applied to one machine without editing shared configuration:

```bash
OCX_FRESH_CONNECTION_HOSTS="api.example.com, relay.example.net" ocx start
```

The value is a comma-separated list of hostnames. Matching is case-insensitive, covers each named
host and its subdomains, and ignores leading dots, so `.example.com` and `example.com` both match
`api.example.com`. Do not include a scheme, port or path. An unset or empty variable leaves the
default connection behavior unchanged.

A matching send carries `Connection: close` and is dispatched with keep-alive disabled. The
decision is made against the address actually used on the wire, so it still applies when a provider
transport rewrites the destination after credential selection. Per-request latency rises slightly
for those hosts, since each request pays a fresh TCP and TLS handshake; name only the hosts that
need it.

## Remote access

The default `127.0.0.1` bind is loopback-only. A non-loopback address such as `0.0.0.0` or a tailnet
IP requires token authentication on both `/api/*` and the data plane.

You do not have to produce that token. `ocx service install` provisions one on a non-loopback bind,
in this order: `OPENCODEX_API_AUTH_TOKEN` from the installing shell, then an existing owner-only
`service-api-token` file, then 32 fresh random bytes. The result is written `0600` and the launch
wrapper (launchd plist, systemd unit, Windows wrapper) reads the file at start, so the value never
enters a service definition or argv. A foreground `ocx start` applies the same precedence —
environment, then `OCX_API_TOKEN_FILE`, then the installed `service-api-token` — so it binds a
non-loopback hostname without an exported token too.

A **management admin token** is refused in either place it can appear — the environment variable or
a reused `service-api-token` file — and the message names the remedy for that place: unset the
variable, or delete the file and run `ocx service repair`. Both checks run before the loopback
short-circuit, because the launch wrapper reads the file into `OPENCODEX_API_AUTH_TOKEN` whatever
the hostname, so an admin-token file fences the management API closed even on a loopback bind.
`ocx status` reports that state as `admin-collision (file)` on a hub.

Setting the variable yourself is still supported for an operator who wants to own the value:

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

Clients should send:

```text
x-opencodex-api-key: your-secret-token
```

| Endpoint | `Authorization: Bearer` | `x-opencodex-api-key` | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` | not accepted | **required** | not accepted |
| `/v1/chat/completions` | not accepted | **required** | not accepted |
| `/v1/messages` | accepted | accepted | accepted |
| `/v1/messages/count_tokens` | accepted | accepted | accepted |
| `/v1/models` | accepted | accepted | accepted |

Responses and Chat Completions reserve `Authorization` for possible Codex Direct passthrough, so only
the dedicated admission header is accepted there. Dashboard-generated `apiKeys` may replace the
environment token after startup; candidates are compared in constant time.

Messages and `count_tokens` keep accepting all three admission forms for routed-client compatibility. Native
Anthropic passthrough is stricter on a non-loopback bind: proxy admission must use
`x-opencodex-api-key`, while `Authorization` and `x-api-key` are reserved for Anthropic credentials.
Any proxy admission secret placed in those provider headers is removed before forwarding.

:::caution[LAN exposure]
A `0.0.0.0` bind exposes the proxy and configured provider access to the LAN. Use it only on trusted
networks with a strong token.
:::

### Local clients that cannot receive the token

A remote bind requires a credential from every caller, including local ones. That breaks a specific
case: a `codex app-server` launched by a host process that resolves the Codex entrypoint directly
(`require.resolve('@openai/codex/bin/codex.js')`) never passes through the generated `codex` shim,
so it never inherits `OPENCODEX_API_AUTH_TOKEN` and every model call fails with `401` before a
stream opens.

`unauthenticatedLoopbackListener` opens a second listener bound to `127.0.0.1` that admits without a
credential. The main listener is untouched — remote callers still need the token.

```json
{
  "hostname": "0.0.0.0",
  "port": 10100,
  "unauthenticatedLoopbackListener": { "enabled": true, "port": 10200 }
}
```

`ocx sync` then writes `base_url = "http://127.0.0.1:10200/v1"` into the managed Codex provider block
and omits the auth header, so a directly spawned app-server works without any credential plumbing.

When you set `port`, it must differ from the proxy port. It is never OS-assigned: an ephemeral port
would change across restarts while already-running app-servers kept the previous `base_url`.

Omitting `port` selects the **companion** form — the listener binds the proxy port on `127.0.0.1`:

```json
{
  "hostname": "100.76.170.81",
  "port": 10100,
  "unauthenticatedLoopbackListener": { "enabled": true }
}
```

Remote clients dial `100.76.170.81:10100` with a credential; local processes dial
`127.0.0.1:10100` without one. That is the address every local integration already writes, so
`ocx claude`, Claude Desktop, Cursor and the system-env injection keep working on a host whose
public bind they cannot reach. The companion form is accepted only when `hostname` is a specific
non-loopback, non-wildcard address: on `127.0.0.1`, `localhost` or `0.0.0.0` the public listener
already holds that loopback address, so OpenCodex refuses the pair at write time and at startup
rather than failing the second bind. On those binds you do not need the listener at all — a
loopback bind already admits local callers.

With a `port` set, the local integrations follow the listener: `ocx claude`, the `system-env`
injection, the Claude Desktop profile, the Cursor gateway value and the routed vision helper all
write `http://127.0.0.1:<listener port>`, the same port `ocx sync` writes into Codex. In the
companion form those same integrations keep writing the proxy port, which is where the companion
socket is.

**Restart the proxy after changing this field, in either form.** The sockets are bound once at
startup and the exported client values are written from the resolved port, so a running proxy keeps
its previous answer — on a ported listener that is the difference between a served request and a
`404` from the listener.

On a `runtimeRole: "hub"`, this field is also the gate on whether the hub rewrites **its own** local
client configuration. With the listener off, `ocx sync`, `ocx ensure` and `ocx restore back` skip the
hub's own Codex/Grok/Claude writes and say so, naming
`unauthenticatedLoopbackListener` rather than the `clientIntegrations` toggle.

The listener serves only `POST /v1/responses`, its WebSocket upgrade, `POST /v1/responses/compact`,
`POST /v1/messages` (the Anthropic wire Claude Code and Claude Desktop speak),
`POST /v1/chat/completions` (the OpenAI chat wire Cursor and the vision helper speak),
`POST /v1/alpha/search` (the native Codex web-search relay), `GET /v1/models`, and the realtime
voice surface: the standalone WebSocket upgrades, WebRTC call creation (`POST /v1/live`,
`POST /v1/realtime/calls`), and the keyed sideband join upgrades (`/v1/live/{callId}`,
`/v1/realtime/calls/{callId}`, `/v1/realtime?call_id=`). Everything else, including `/api/*`,
`/healthz`, `/readyz` and the dashboard, returns `404` — local management reads such as
`ocx claude`'s discovery call go to the authenticated management surface with a management
credential, never here.

:::danger[This is an unauthenticated surface]
Every process on the machine can use this listener. It spends account quota and paid provider
credentials, and it can exhaust the shared turn capacity that authenticated remote clients depend
on. Do not enable it on a shared or multi-tenant host.

Binding to `127.0.0.1` means the kernel refuses remote connections, but it does not stop a browser:
a page you visit can make your browser connect to `127.0.0.1`. The listener therefore applies the
same `Host` and `Origin` checks as an ordinary loopback bind. Off by default.
:::

### SSH port forwarding

Remote use does not require a remote bind. Keep loopback and forward it:

```bash
ssh -L 20100:localhost:10100 you@remote
```

Any local port works. Requests whose Host resolves to `localhost`, `127.0.0.1`, or `::1` remain
loopback regardless of port, so `http://localhost:20100/v1` works. Set that base URL in the client;
`ocx` writes only the default local `127.0.0.1` address into managed client config.

Provider OAuth callbacks listen on a fixed remote port. Log in on the remote machine or forward that
port too:

```bash
ssh -L 20100:localhost:10100 -L 1455:localhost:1455 you@remote
```

If a registered callback port is already in use and the login surface offers manual input, OpenCodex
keeps the registered redirect URI and still returns the provider authorization URL. Complete the
provider login, then paste the final redirect URL from the browser address bar or the authorization
code into OpenCodex. The pending flow preserves state and PKCE validation. Callers without manual
input still fail closed.

:::caution[Forwarded loopback is unauthenticated]
Plain `ssh -L` listens on your local loopback and is safe for the default unauthenticated bind. Do not
use `ssh -g -L`, broad container publishing, or forwarding modes that expose the client side on
`0.0.0.0`. Bind explicitly with `ssh -L 127.0.0.1:20100:localhost:10100` when unsure.
:::

## Account email masking (`privacy`)

Stored account emails are masked everywhere they leave the proxy — the dashboard account lists,
`GET /api/codex-auth/accounts`, `GET /api/oauth/status`, and the `ocx status` logins section all
show `p***n@example.com` rather than the address on file.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `privacy.maskEmails?` | `boolean` | `true` | Set to `false` to show stored account emails in full. Absent, `true`, and any malformed value all keep masking, so only a deliberate `false` reveals an address. |

Turn it off when you run many accounts on a machine you control and cannot tell them apart from
masked forms. Read the flag as a disclosure decision rather than a display preference: management
is not always loopback, so on a hub configured with `remoteGui` an unmasked address reaches every
management principal that can reach the hub, not only someone sitting at the machine. The flag
moves only the email field — tokens, refresh tokens, and account identifiers stay redacted either
way.

```json
{ "privacy": { "maskEmails": false } }
```

`ocx config set privacy.maskEmails false` fails with `config parent path not found` until the
block exists, because `config set` walks into existing objects and never creates them. Write the
whole object instead — `ocx config set privacy '{"maskEmails":false}'` — or add the block to
`config.json` by hand.

## Storage cleanup

`storageCleanupPolicy` is disabled by default. When enabled, it runs on `startup`, `daily`, `weekly`,
or `manual` after archived bytes exceed `trigger.archivedBytesOver`. It selects oldest archives toward
either `target.reduceToBytes` or `target.removeOldestPercent`. `mode` defaults to `quarantine`; use
`permanent` only as an explicit destructive choice. The policy persists `lastRun` and `nextRun`.
Configure it on the Storage page or with `GET`/`PUT /api/storage/cleanup-policy`; trigger a manual run
with `POST /api/storage/cleanup-policy/run`.

## Usage history size

`usageLedgerMaxBytes` is unset by default, and unset means the request history in `usage.jsonl`
grows without limit. Nothing deletes history you did not ask to have deleted.

Set it to a byte ceiling and the proxy trims the file after an append crosses it, keeping the
newest whole rows and dropping the oldest. It trims a little below the ceiling rather than exactly
to it, so the next append does not immediately re-cross the line. The minimum accepted value is
1 MiB; a smaller number, or one that is not a safe integer, leaves the limit off rather than
failing the configuration.

Rows are copied byte for byte and never rewritten, so every field survives a trim — including
fields a newer build wrote that an older one does not understand. The replacement is refused
outright if anything appended to the ledger while it ran, so a request logged during a trim is
never lost; the next append tries again. Trimming also refreshes what the dashboard shows, so
`/api/logs` stops serving rows the ledger no longer has.

There is no dashboard control for this yet; set it in `config.json` or with
`ocx config set usageLedgerMaxBytes <bytes>`.

## Quota-reset notifications (`quotaResetNotify`)

Off by default. When the section is absent, no detection runs, no timer starts, and no state
file is written.

Enable it to be told when a usage window resets — both the scheduled rollover you can predict
and an out-of-band reset you cannot:

```json
{
  "quotaResetNotify": {
    "enabled": true,
    "webhookUrl": "https://hooks.slack.com/services/...",
    "kinds": ["scheduled", "surprise"],
    "pollSeconds": 900
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. Also requires at least one sink, below. |
| `kinds` | both | `scheduled` (the deadline passed) or `surprise` (quota returned early). |
| `pollSeconds` | `900` | Idle poll interval; floor 600. `0` observes live traffic only. |
| `webhookUrl` | — | `https` POST target for the event JSON. Treated as a secret. |
| `allowPrivateNetwork` | `false` | Permit a loopback or private-network webhook target. |
| `timeoutMs` | `5000` | Webhook timeout. |
| `command` | — | Argv array run with the event JSON on stdin. |

`enabled: true` with neither `webhookUrl` nor `command` resolves to off: an enabled subsystem
with nowhere to deliver is a misconfiguration, not a half-on state.

The floor is 600 seconds because a faster poll cannot see anything new: observation is bounded
by the 10-minute per-account cache, so a shorter interval only adds load to a quota endpoint
that rate-limits. A configured value is adopted on the next tick without a restart.

Set `pollSeconds` to `0` only if you accept that a reset happening while the proxy is idle is
noticed on the next request rather than when it happens. The poll exists because the overnight
case is the one worth knowing about.

### The delivered event

```json
{
  "type": "quota_reset",
  "kind": "surprise",
  "scope": "codex",
  "accountTag": "k3f9x2ab",
  "window": "weekly",
  "percentBefore": 96,
  "percentAfter": 4,
  "previousResetAt": 1772000000000,
  "resetAt": 1772400000000,
  "detectedAt": 1771900000000
}
```

`accountTag` is a per-install salted hash, not an account identifier: it distinguishes your
accounts from each other without telling the receiver who they are. No email, token, path, or
URL is ever included.

`detectedAt` is when the proxy NOTICED, not when the reset happened. Observation is bounded by
the 5-minute provider cache and the 10-minute per-account cache, so the reset instant can only
be bracketed between two observations.

### Security notes

`webhookUrl` is a credential — for Slack and Discord, holding the URL is sufficient to post —
so it is redacted by `ocx config show` and excluded from `ocx config export`.

A webhook target that resolves to a private or loopback address is refused unless you set
`allowPrivateNetwork: true`. The proxy can reach hosts your browser cannot, including cloud
metadata endpoints, so the default assumes an external receiver.

`webhookUrl` must use `https`. The payload and the URL itself are both sensitive, and an
`http` target would put them in cleartext; an `http` value is rejected when the config is
written rather than downgraded silently.

A redirect is refused rather than followed. The destination check above validates the URL you
configured, so following a `3xx` would deliver the payload somewhere unvalidated — a public
endpoint could bounce the POST to loopback or a metadata address. Configure the final URL
directly; a redirected delivery reports `blocked-destination`.

`command` is an argv array and is never passed through a shell, so its values cannot become a
shell-injection surface. Delivery is attempted once; there is no retry.

Read recent detections with `ocx provider resets` or `GET /api/quota-resets`.

## API surfaces (`apiSurfaces`)

Responses (`/v1/responses`) and Chat Completions (`/v1/chat/completions`) are always served.
The Messages API (`/v1/messages` and `/v1/messages/count_tokens`) can be closed on its own.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `apiSurfaces.messages.enabled?` | `boolean` | inherit | `true` serves the Messages API, `false` refuses both routes with 403. Unset inherits `claudeCode.enabled`, so a Claude integration that is off also closes Messages. |

A present but malformed value (a non-object `apiSurfaces` or `messages`, or a non-boolean
`enabled`) closes the Messages API rather than falling back to the inherited value. Both
routes always agree.

The dashboard's API page shows one card per API with the setting's source (explicit,
inherited from Claude settings, or invalid) and a toggle for Messages. Turning Messages off
there writes `apiSurfaces.messages.enabled: false` **and** `claudeCode.enabled: false` in the
same save, so a proxy version older than this setting, which only reads `claudeCode.enabled`,
keeps the endpoint closed after a downgrade. Turning it on writes only
`apiSurfaces.messages.enabled: true`; an older version then still follows
`claudeCode.enabled` and may keep Messages closed, which is the safe direction.

## Protocol paths (`protocols`)

How a Chat Completions or Messages request may reach a provider. Every value defaults to the
behavior before these keys existed; see [Protocol paths](/guides/protocol-paths/) for the delivery
modes, the preview, and the per-request trace.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `protocols.unrepresentable?` | `"legacy" \| "reject"` | `"legacy"` | `legacy` sends a request whose path drops a feature and records the loss in the trace. `reject` refuses it with HTTP 400 before any send, naming only the feature keys. |
| `protocols.rollout.nativeChatCombos?` | `boolean` | `false` | Send an eligible Chat candidate inside a combo natively from its own copy of the client body. |
| `protocols.rollout.managedMessagesNative?` | `boolean` | `false` | Send Messages natively to a direct, key-authenticated Anthropic provider instead of through the internal Responses bridge. |
| `protocols.rollout.managedMessagesNativeOAuth?` | `boolean` | `false` | Native Messages for the unpooled `anthropic` OAuth provider on `api.anthropic.com`. Read as off unless `managedMessagesNative` is on; a pooled account set stays on the bridge. |
| `protocols.rollout.directEncoders?` | `boolean` | `false` | Encode Chat and Messages answers from a non-Responses upstream directly from adapter events. |
| `protocols.rollout.shadowPlan?` | `boolean` | `false` | Compare each Chat or Messages request's path with the plan a preview predicts and mark a disagreement as `planMismatch` on its log row. Sends nothing extra. |

A malformed `protocols` block is dropped to these defaults, because each default is the
conservative one. Only `true` turns a switch on.

```json
{
  "protocols": {
    "unrepresentable": "legacy",
    "rollout": { "shadowPlan": true }
  }
}
```

`ocx api policy` shows the resolved values and changes them through the running proxy
(`--unrepresentable <legacy|reject>`, `--rollout <switch>=<on|off>`, `--messages <on|off>` for
[`apiSurfaces`](#api-surfaces-apisurfaces)). It writes only when a setting flag is given. The
dashboard's API page and `PATCH /api/protocols/settings` use the same validation.

## Claude Code (`claudeCode`)

These settings govern `/v1/messages`, `/v1/messages/count_tokens`, the `ocx claude` launcher, and the Claude dashboard page. Whether the Messages API is served at all is decided by [`apiSurfaces`](#api-surfaces-apisurfaces), which inherits `claudeCode.enabled` while unset.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` | Native-passthrough body inactivity budget in seconds while a read is pending, not total duration. Minimum 1; exactly `0` disables. |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` | Cumulative native-passthrough body cap for streamed and buffered responses. Exactly `0` disables. |
| `claudeCode.compatibility?` | `"shadow" \| "enforce"` | unset | Optional compatibility admission for translated `/v1/messages` requests. `shadow` records unsupported features and continues; `enforce` returns an Anthropic-shaped 400 before inference. Native Anthropic passthrough remains unchanged. |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` | auto | How launch handles `ANTHROPIC_AUTH_TOKEN`. Auto detects auth each launch; an explicit value is never overridden. |
| `claudeCode.authModeMigratedAt?` | `string` | unset | Internal one-time upgrade marker. Do not set manually. |
| `claudeCode.classifierModel?` | `string` | unset | Explicit target for Claude Code Auto Mode classifier turns, as a qualified `provider/model` (for example `RelayA/claude-opus-5`). Auto Mode sends bare safety checks such as `claude-opus-5` with no provider, so without this they fall through to `defaultProvider` — which may not speak Anthropic at all. Nothing is inferred automatically: only a target you declare here is used. |
| `claudeCode.classifierFallbacks?` | `string[]` | unset | Ordered classifier targets used when `classifierModel` is not set. Same qualified `provider/model` form; the first usable entry wins. An explicit `modelMap` entry for the classifier model still outranks both. |
| `claudeCode.subagentEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | inherit | Effort written to generated `~/.claude/agents/ocx-*.md`; separate from Codex guidance and proxy caps. Restart through `ocx claude` to regenerate. |

The compatibility policy applies to Claude Code, Desktop and other clients using translated
Messages, including `?beta=true` and non-streaming requests. Every translated target uses the
same conservative policy, including Anthropic and native Responses adapters. It rejects
document content, thinking/redacted-thinking replay, hosted search and execution tools,
tool-search references, active deferred loading, strict tools, non-default caller modes,
structured-output formats, explicit service-tier intent, MCP connector features, context
management, containers, inference placement and unsupported protocol fields or blocks.

Unset preserves legacy translation. Cache hints, tool input examples and ordinary
thinking/effort settings are deliberately admitted with possible degradation: this setting
does not guarantee cache breakpoints or TTL, retained examples, exact thinking budgets or
lossless translation. Beta headers alone are not validated for feature support. Shadow
evidence contains only fixed protocol codes and derived reasons, retained in request logs
and `usage.jsonl` and restored on restart. An invalid non-unset mode returns a fixed 503
configuration error on translated Messages. Configure the value in `config.json` and
restart the proxy to load it; there is no dedicated GUI setter. Count-tokens and direct
Responses/Chat APIs are outside this policy; successful token counting does not imply
Messages admission. This setting does not add a global authorization boundary.

Auto auth selects subscription when stored Claude auth is found, proxy when none is found, and
subscription with a warning when detection is inconclusive. See
[Claude Code auth mode](/guides/claude-code/#auth-mode).

## Compaction routing

In **Dashboard → Overview → Compaction routing**, choose a model, which triggers it applies to,
and an optional reasoning effort, then click **Save**. Select **Use conversation model** and save
to remove the override. Changes apply to the next compaction request without restarting the proxy.

Set `compactionRouting` in OpenCodex `config.json` to override the model Codex's compaction
requests use. The setting is disabled when omitted.

```json
{
  "compactionRouting": {
    "model": "provider/model-id",
    "reasoningEffort": "low",
    "triggers": ["manual"]
  }
}
```

`model` accepts native model IDs, provider-qualified model IDs, and configured combos.
`reasoningEffort` is optional; omit it to preserve the incoming effort. Supported declarations
are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.
Existing provider effort rules still apply. The native `/responses/compact` endpoint keeps
its existing behavior and does not forward reasoning settings.

`triggers` names which compaction requests the override covers, using Codex's own
`compaction.trigger` values: `"manual"` for a `/compact` you typed, `"auto"` for the automatic
compaction Codex runs when a thread approaches its context limit. Omit `triggers` and the
override applies to manual `/compact` only, leaving automatic compaction exactly where it
routes today. Use `["auto"]` or `["manual", "auto"]` to route automatic compaction as well.

Routing automatic compaction is what lets a long thread on a routed provider keep going when
the canonical OpenAI quota is exhausted. Codex picks a bare native model for the compaction
turn, and OpenCodex reserves that for an enabled canonical `openai` provider whenever one
exists, so the compaction fails with a quota error before the routed turn begins even though
the thread itself runs elsewhere. Naming `"auto"` here points the compaction at a
provider-qualified model with its own credentials and quota.

OpenCodex changes only requests with explicit `request_kind: "compaction"` metadata whose
`compaction.trigger` is one of the values you listed, sent to `/v1/responses/compact` or to
`/v1/responses` with a `compaction_trigger` input item. Later conversation turns keep their
original routing and settings. Missing, malformed, or conflicting metadata does not activate the
override, including on older clients without trigger metadata; when several copies of the
metadata are supplied they must name the same trigger. WebSocket requests use each frame's
metadata rather than the connection's earlier handshake metadata.

The selected model's provider receives the entire conversation for summarization, including
conversations that normally run on another provider. A combo selector sends it to every combo
target, including failover targets. The dashboard panel states this next to the model picker
and names the destination provider, or the combo's target providers, once a model is chosen.
When the override covers automatic compaction, that transfer happens without you asking for it,
at whatever point Codex decides to compact; the dashboard panel says so as well.
The override reuses the existing compaction handlers and summary formats. When the selected
model shares the conversation model's provider and account-routing identity (provider name,
Codex account mode, and account namespace), the request keeps the caller's credential and may
use that backend's native compact endpoint. Otherwise, including when either side is a combo or
the conversation model is remembered as a combo target, OpenCodex runs the portable summarizer
instead, so the summary stays readable when the conversation resumes on its own model, and the
caller's credential does not cross to the other provider. The selected model must support the
input size and content. Restart the proxy after editing
`config.json` by hand. Dashboard saves apply immediately.

## Shadow calls

Codex uses small helper models for tasks such as titles and commit messages. Enable
`shadowCallIntercept` to redirect recognized source-model prefixes to another configured model. The
replacement keeps the request's configured reasoning effort. Set `sourceModels` only when a client
uses different helper ids. A non-empty `sourceModels` replaces the default prefixes instead of
extending them, so include `gpt-5.6-luna` in the list when current clients should still be
intercepted.
Interception is model-based: every request whose bare model id matches `sourceModels` can be
redirected, including normal `request_kind: "turn"` requests. `x-codex-turn-metadata` does not exempt
a matching request.

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-5.6-luna"]
  }
}
```

### When the target is unavailable

The replacement is the one destination the operator chose, so a target that stops resolving fails
the helper call instead of sending it elsewhere. When the target's provider is disabled or deleted,
or its combo no longer exists, an intercepted request returns `409` with error code
`intercept_target_unavailable` before anything is sent upstream. The request log records the same
code. The request is not passed through to the native helper model and does not fall back to the
default provider, because either would change the destination, credentials and cost without your
choice. A combo or routing-profile target still fails over among its own members. A qualified
target such as `provider/model` whose provider segment names nothing configured is treated the same
way, and the settings API refuses to save one. A bare model id that resolves through the default
provider stays valid.

Disabling (`PATCH /api/providers?name=<provider>` with `disabled: true`) or deleting a provider that the
target resolves to still succeeds; the response adds `dependentShadowIntercept: { model, enabled }`
and the dashboard shows a warning. Re-enabling the provider, or choosing another target, restores
interception.

## Sidecars

### `images` (`OcxImagesConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `provider?` | `string` | automatic OpenAI selection | Explicit custom API-key `openai-responses` provider for `/v1/images/generations` and `/v1/images/edits`. Registry-managed ids are rejected. |
| `timeoutMs?` | `number` | `300000` | Whole-request timeout for one standalone Images request. |

Explicit selection fails closed when the provider is missing, disabled, incompatible, or lacks a
usable key; it never falls back to another paid upstream. The endpoint must implement the OpenAI
Images API paths and response shape expected by Codex.

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

RunTurn adapters also use the configured search sidecar. Search turns preserve progress heartbeats. A first-event OAuth 429 rotates the account on the initial request and on each post-search answer request. The replay keeps the search tool and the gathered results. With `emptyCompletionRetry: true`, an empty answer before the search limit receives one retry using the current conversation and gathered results. The existing tool-free recovery after the search limit remains available independently of that setting. Upstream failures stop the turn instead of triggering another search.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when usable | Master switch. When false, OpenCodex stops intercepting `web_search` AND the Codex integration writes `web_search = "disabled"` into `~/.codex/config.toml`. |
| `backend?` | `"openai" \| "anthropic" \| "xai" \| "gemini" \| "exa"` | `openai` | Explicit wins; unset always resolves to `openai`. `anthropic` and `xai` run only when explicitly configured; `gemini` and `exa` remain reserved until their executors ship. |
| `model?` | `string` | backend-dependent | `gpt-5.6-luna` for OpenAI, `claude-sonnet-5` for Anthropic, or `grok-4.6` for xAI. Legacy explicit `gpt-5.4-mini` migrates on start. |
| `exaApiKey?` | `string` | none | Operator key for the `exa` backend. Write-only: management reads never return the stored value. |
| `xSearch?` | `object` | omitted | xAI-only opt-in for hosted `x_search`: `enabled`, mutually exclusive `allowedXHandles` / `excludedXHandles` arrays (maximum 20), and ISO `fromDate` / `toDate` (`YYYY-MM-DD`). |
| `reasoning?` | `string` | `low` | Sidecar effort. `minimal` is rejected with web search. |
| `maxSearchesPerTurn?` | `number` | `3` | Real searches allowed per main-model turn. |
| `routedModelStallTimeoutMs?` | `number` | `200000` | Config-file-only routed-model raw-body inactivity deadline. Integer 1–2147483647; every non-empty chunk resets it. |
| `timeoutMs?` | `number` | `60000` | Deadline for one hosted search. |

The OpenAI backend requires a ChatGPT login and enabled ChatGPT `forward` provider. Claude-inbound
routed replays inject main ChatGPT auth into the internal request. The Anthropic backend uses the
active stored credential from an enabled Anthropic OAuth provider. An explicitly selected Anthropic
backend with no usable account fails closed instead of falling back. The Anthropic executor uses its
native `web_search_20250305` tool. The xAI backend requires a usable stored Grok OAuth account, uses
hosted `web_search`, and adds hosted `x_search` when `xSearch.enabled` is true. Malformed `xSearch`
management input returns `400`; a malformed persisted block fails closed during planning. The
`gemini` and `exa` lanes never activate from credential discovery or fallback; the operator must
select them explicitly. `exaApiKey` is accepted on writes but omitted from management responses.

Four clocks govern search: base `stallTimeoutSec`, `connectTimeoutMs`, routed-model inactivity, and
hosted-search timeout. The effective bridge watchdog is the maximum plus 30 seconds. Routed stall is
an inactivity guard, not a total generation deadline.

### `visionSidecar` (`OcxVisionSidecarConfig`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | on when usable | Master image-description switch. |
| `backend?` | `"openai" \| "anthropic"` | auto | Explicit wins; unset prefers a usable stored Anthropic OAuth credential, else `openai`. |
| `model?` | `string` | backend-dependent | `gpt-5.6-luna` for OpenAI or `claude-sonnet-5` for Anthropic. |
| `maxDescriptionsPerTurn?` | `number` | `8` | New description cache misses admitted per main turn. `0` disables calls; invalid values use default. |
| `timeoutMs?` | `number` | `45000` | Sidecar fetch timeout. Integer 1–2147483647. |

Vision activates only for images sent to a model in its provider's `noVisionModels`. OpenAI has the
same login/forward requirements as search; explicitly selected Anthropic fails closed without a usable
credential. Successful `data:` descriptions use a bounded cache keyed by backend, model, detail,
image bytes, and normalized message context. Hits and same-turn duplicates do not consume the limit.
Remote `https:` images and failed or empty descriptions are not cached.

Anthropic OAuth sidecars reuse opencodex's existing Claude Code OAuth fingerprint. Soak-test the
intended account and workload.

## Remote Hub keys and defaults

`runtimeRole` defaults to `standalone`. A hub uses `hub.managementPublicOrigin`, loopback-only `hub.managementIngress` (`enabled:false` when absent), and exact `remoteGui.allowedTailscaleUsers` (empty when absent). A client data key lives in `service-api-token`, never `config.json`; rotation may temporarily create `service-api-token.prev`. Usage stores are not mirrored.

| Key | Type | Default when absent | What it does |
| --- | --- | --- | --- |
| `hub.managementPublicOrigin` | string | unset | The canonical browser-reachable management origin a hub advertises, for example the HTTPS origin Tailscale Serve prints. It is what `/readyz` reports as `managementUrl` while `runtimeRole` is `hub`; with it unset the hub falls back to whatever origin each request arrived on, so a client behind a different frontend can be handed an address it cannot reach. |
| `hub.dataPublicOrigin` | string | unset | The canonical origin a remote client should dial for the **data** plane, for example the HTTPS origin a TLS frontend publishes in front of the tailnet bind. Advisory only: it is never a bind address and changing it moves no socket. `ocx hub invite` prints it as the positional URL of the `ocx connect` line, falling back to `http://<hostname>:<port>` — which is a LAN/tailnet address a remote machine may not be able to reach over TLS, so set this on any hub with a frontend. Unlike most optional keys it is **not** silently dropped when malformed: a typo is rejected at write time, because falling back to the bind address is exactly what the field exists to avoid. |
| `hub.managementIngress` | `{enabled:false}` or `{enabled:true, port}` | `{enabled:false}` | An extra management-only listener for a local HTTPS frontend. The hostname is not configurable: when enabled the socket always binds `127.0.0.1`, and only GUI, session-bootstrap, and management API routes are admitted. Data-plane routes are rejected before dispatch. |
| `remoteGui.allowedTailscaleUsers` | string[] | `[]` (empty — nobody) | Exact Tailscale login identities allowed to be issued an automatic remote GUI session. The `Tailscale-User-Login` header is trusted **only** on the separate management ingress; an empty list means no remote identity can mint a session, which is the safe default rather than an oversight. Identities are compared exactly, so a typo silently denies access. |
| `remoteGui.allowInsecureHttp` | boolean | unset | **Retired — has no effect.** It once permitted a one-time pairing exchange over non-loopback plaintext HTTP. A pairing grant now crosses loopback or authenticated HTTPS only. The key is still parsed so an existing `config.json` keeps loading (the schema is strict, and dropping the key outright would make an older config fail to load entirely); a persisted `true` is reported once and then ignored. Remove it from your config. |

A hub that is reachable from a browser needs `hub.managementPublicOrigin` and at least one entry
in `remoteGui.allowedTailscaleUsers`. Setting the origin without the user list produces a hub that
advertises itself correctly and then refuses every session; setting the user list without the
origin produces sessions pointed at whichever origin the request happened to use.

`dataPublicOrigin` and `managementPublicOrigin` are two independent advertisements, and on a real
deployment they are two different sockets: management is the loopback-only ingress published on 443,
data is the tailnet bind published on its own HTTPS port. They are the two halves of what
`ocx hub invite` prints, and `managementPublicOrigin` is the stricter of the two — a pairing grant
records it as the grant's own server origin and the exchange compares against it, which is why
`ocx hub invite --management-url` can only *confirm* the configured value and refuses one that
differs. `--data-url` really is an override, because nothing is bound to it. With neither
`dataPublicOrigin` nor `--data-url` set, `invite` falls back to the bind address — and on a
loopback or wildcard bind, where that would resolve to this machine's own loopback, it refuses
rather than advertising an address the other machine cannot use.

A hub that serves its own local clients also sets
[`unauthenticatedLoopbackListener`](#local-clients-that-cannot-receive-the-token). Its port-less
companion form is what makes a hub a single-port deployment, and it is refused on a loopback or
wildcard `hostname`, where the public listener already holds `127.0.0.1:<port>`.


## Experimental native response controls

`codexNativeSteering` and `codexNativeInjection` enable separate, default-off native
WebSocket control paths. See the canonical guide for
[supported steering routes and settings](/guides/codex-integration/#steering-continuation-settings),
[typed result and approval continuations](/guides/codex-integration/#rich-tool-results-and-explicit-approvals-after-response-completion),
and [confirmation deadlines and retained context](/guides/codex-integration/#steering-confirmation-deadlines-and-retained-context).
