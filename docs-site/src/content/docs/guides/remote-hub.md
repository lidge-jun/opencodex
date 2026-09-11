---
title: Remote Hub Deployment
description: Run a one-port opencodex hub on Linux, macOS, or Docker with a loopback companion listener, a self-provisioned data token, ocx hub invite, a loopback-only management ingress, Tailscale Serve, and headless OAuth.
---

An opencodex hub keeps provider credentials and usage state on one host while authenticated clients
use its data plane remotely. The browser-facing management plane is separate: an optional listener
binds only `127.0.0.1`, serves the dashboard and `/api/*`, and is intended to sit behind Tailscale
Serve or another operator-owned HTTPS frontend.

The data plane is **one port**. Remote machines dial `hostname:port` with their own per-client key;
the hub's own processes dial `127.0.0.1:<the same port>` with no credential, through the loopback
companion listener. Start from [the recipe below](#linux-systemd-or-macos-launchd), then hand a
second machine a ready-made command with [`ocx hub invite`](#inviting-another-machine).

The management ingress never serves `/v1/*`, `/healthz`, `/readyz`, or WebSockets. Do not publish its
port directly, do not add a cloud-firewall rule for it, and do not use Tailscale Funnel. Funnel is a
public-internet surface and is outside this deployment model.

## Trust and consent boundaries

- Provider and OAuth credentials stay on the hub. Never copy them into a client, image layer,
  service definition, support bundle, screenshot, or command line.
- The data admission token is delivered through the owner-only `service-api-token` file or
  `OCX_API_TOKEN_FILE`. It is not a management credential.
- A raw management admin token can perform ordinary administration, but it cannot mint a browser
  session or authorize consent-bearing actions such as starring the repository. Those actions
  require a server-issued `gui-session`, matching browser origin, and CSRF token.
- `Tailscale-User-Login` is trusted only on the separately bound management ingress. The same header
  on the public listener is ignored. `remoteGui.allowedTailscaleUsers` controls session issuance; it
  does not create a new general-purpose principal.

## Roles and direct data flow

`standalone` keeps data and management on one machine. A `hub` owns provider credentials, the
catalog, and usage records. A `client` stores only its connection metadata and one per-client data
key. Codex and Claude traffic goes directly from the client to the hub data listener; it is not
tunneled through the dashboard or the loopback management relay.

Connect with exactly one transient authority source. The authority is read from stdin and is never
written to config or the token file:

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

You do not have to assemble that line by hand. `ocx hub invite`, run on the hub, mints the code and
prints the exact command — including both origins — for the machine that is joining. See
[Inviting another machine](#inviting-another-machine).

The hub automatically issues a per-client key. The client writes it to the existing owner-only
`service-api-token` file, never `config.json`. While connected, usage comes from the hub usage store
filtered to that client's stable `apiKeyId`. After disconnect, usage comes from the local store.
OpenCodex does not mirror usage between the two stores.

Rotate a connected client with a fresh transient authority:

```bash
ocx connect rotate --pairing-code-stdin
# or, only over HTTPS:
ocx connect rotate --admin-token-stdin
```

Rotation keeps the old and new data keys valid for at most ten minutes under the same `apiKeyId`.
The client backs up the old token as `service-api-token.prev`, atomically installs and probes the new
key, then commits. If a commit response is uncertain, rerun the rotate command with transient
authority; recovery probes both files before committing or restoring. Never delete either file when
recovery reports that both candidates were rejected.

`ocx disconnect` is local and works while the hub is offline. It restores local client state and
does not revoke the hub key. After disconnect, revoke that key from **Integrations → API Keys** on
the hub. `ocx connect revoke --admin-token-stdin` is available only while still connected and uses
the persisted `apiKeyId`; it accepts no id override. Browser session logout/expiry is separate from
data-key rotation, revocation, and disconnect.

### What a connected client shows

A client stores no provider credentials and no catalog of its own, so its local config and
credential store are empty by design — and reading them as the truth produces a confident, wrong
answer about what the hub can serve. On a connected client `ocx status` therefore leads with
`State from hub <origin>` and sources the OAuth-logins, providers and delegable-models lines from
the hub over the data plane, tagging the lines that really describe this machine `(local)`: the
proxy, the service, the Codex binary and shim, and the local ports. `ocx status --json` carries the
same answer as `runtimeRole` plus a `remoteHub` block whose `stateSource` is `hub`, `cache`, or
`unavailable` — never the client's own state. An older hub that does not serve `/v1/hub-state`
reports `unavailable` with an instruction to upgrade the hub rather than silently falling back to
local login state, and `ocx config show` on a client prints a `_remoteHub` note saying the
credentials and model availability live on the hub. The hub read uses the per-client data key
only; no admin token and no provider secret ever reaches a client.

## Linux systemd or macOS launchd

Bind the data listener to the hub's Tailscale address, enable the loopback companion so the hub's
own processes reach that same port without a credential, and publish management separately. The
values below are examples:

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set corsAllowOrigins '["http://localhost:10100"]'

# A fresh standalone config has no `hub` or `remoteGui` object, and `ocx config set` does not
# create a missing parent: a nested set fails with `config parent path not found: hub`. Setting
# `runtimeRole` does not create it either. Create each object first, then set its fields.
ocx config set hub '{}'
ocx config set remoteGui '{}'
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set hub.dataPublicOrigin '"https://hub-name.tailnet-name.ts.net:8443"'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'

# One port. Remote machines dial 100.64.0.10:10100 with their own key; the hub's own local
# processes dial 127.0.0.1:10100 with no credential, on that same port.
ocx config set unauthenticatedLoopbackListener '{"enabled":true}'

# No token to export: install provisions the hub's own data-plane token. See below.
ocx service install
ocx service status
ocx status                # the "Hub:" block summarizes every line above
```

On a genuinely empty configuration you can set each object in one call instead:

```bash
ocx config set hub '{"managementPublicOrigin":"https://hub-name.tailnet-name.ts.net","dataPublicOrigin":"https://hub-name.tailnet-name.ts.net:8443","managementIngress":{"enabled":true,"port":10101}}'
ocx config set remoteGui '{"allowedTailscaleUsers":["operator@example.com"]}'
```

Use that form only when the object does not exist yet. A whole-object set **replaces** the object
rather than merging into it, so running the line above against a config that already had
`hub.managementIngress` silently drops the ingress. When you are adapting an existing
configuration, set one field at a time — the parent is already there, so the nested form works and
touches nothing else.

Two details that decide whether a line is accepted. The value is parsed as JSON first and falls
back to the raw string, which is why a URL is written as `'"https://…"'`: objects, arrays, booleans
and numbers must be valid JSON. And `hub` and `remoteGui` are strict, so a mistyped key is rejected
at write time as `schema_invalid: hub.<field>` instead of becoming a setting that never takes
effect. `managementPublicOrigin` and `dataPublicOrigin` must each be a bare origin with no path,
query or fragment.

### The data-plane token provisions itself

There is no `export OPENCODEX_API_AUTH_TOKEN=…` step before `ocx service install`. On a non-loopback
bind the installer resolves the hub's data-admission token by precedence and writes the result to
the owner-only `service-api-token` file, mode `0600`:

1. **`OPENCODEX_API_AUTH_TOKEN`**, when the installing shell exports one. An operator who wants to
   own that value keeps owning it.
2. **The existing `service-api-token` file.** Reusing it is what makes `ocx service install`,
   `ocx service repair` and a restart idempotent; regenerating would silently invalidate every
   per-client key already exchanged against the old value. A reused file is re-checked, not
   trusted — see the admin-token paragraph below.
3. **32 fresh random bytes, hex.** This is the branch that removes the manual step.

The command prints the **path**, never the value. The launchd plist and the systemd user unit read
that protected file when the process starts; neither embeds the literal token. Do not paste the
value into `ocx config show`, unit/plist output, screenshots, or support bundles. A foreground
`ocx start` on the hub reads the same file, so it binds the non-loopback hostname without an
exported token either.

A **management admin token** is refused wherever it turns up, and the refusal names the remedy for
that place. In `OPENCODEX_API_AUTH_TOKEN`: `unset OPENCODEX_API_AUTH_TOKEN` and rerun. In the
reused `service-api-token` file — the shape of the original incident, and still reachable on a
machine where the admin token was once pasted there by hand — delete the file and run
`ocx service repair`, because unsetting a variable says nothing about a file. Both checks run
ahead of the loopback short-circuit, so a loopback install is checked too: the launch wrapper
reads that file into `OPENCODEX_API_AUTH_TOKEN` whatever the hostname, which is what fences the
management API closed at boot.

The two planes are different credentials — the data token admits `/v1/*` callers and administers
nothing. Since the service provisions its own token, there is no reason to export either one.
`ocx service repair` never demands the variable again once the file exists.

`ocx status` reports the token's state without its value: `present (file)`, `unsafe (file)` (it
exists but is not owner-only — fix the permissions), `admin-collision (file)` (the incident shape;
the block adds the consequence and the fix), or `missing`. The state is always about the **file**,
because the launch wrapper overwrites the environment from it before exec — a separate sub-line
reports `OPENCODEX_API_AUTH_TOKEN` being set in your shell, since that is what a foreground
`ocx start` in that shell would use.

### One port, and the ported alternative

`unauthenticatedLoopbackListener: {"enabled": true}` with **no** `port` is the *companion* form: a
second socket on `127.0.0.1:<proxy port>` — the same port number the public listener uses on the
tailnet address. That is the address every local integration already writes, so nothing on the hub
has to be taught a new port, and one port stays the whole remote data surface.

The companion form is accepted only when `hostname` is a specific non-loopback, non-wildcard
address. On `127.0.0.1`, `localhost`, `0.0.0.0` or `::` the public listener already holds that
loopback address, so opencodex refuses the pair at write time and again at startup — naming the
collision — rather than letting the second bind fail. On those binds you do not need the listener at
all: a loopback bind already admits local callers.

The older *ported* form still works and is the alternative when you want the two surfaces on
separate ports:

```bash
ocx config set unauthenticatedLoopbackListener '{"enabled":true,"port":10104}'
```

With a `port` set, the local integrations follow the listener and write `http://127.0.0.1:10104`
instead. The port must differ from the proxy port and is never OS-assigned: an ephemeral port would
change across restarts while already-running app-servers kept the previous `base_url`.

**Restart the proxy after changing this field.** The sockets are bound once at startup and the local
client files are written from the resolved value, so a running hub keeps its old answer. On a ported
hub that is the difference between `ocx claude` reaching the listener and getting a `404` from it. On
a background service the verb is `ocx service restart`, which always restarts — see
[macOS service operations](#macos-service-operations). `ocx restart` is a different verb: it bounces
the proxy process you started yourself, not the service the manager supervises.

### The hub's own local clients

A hub used to be the one machine that could not use itself: `ocx claude`, Claude Desktop, Cursor,
the `system-env` injection and the routed vision helper all dial `http://127.0.0.1:<port>`, which
does not exist when the listener is bound to a tailnet address. With the loopback listener enabled
they work on the hub:

```bash
ocx sync          # the hub now writes its own Codex/Grok blocks
ocx claude        # Claude Code wired to the hub's own loopback address
```

The listener carries inference wires only: `POST /v1/responses` and its WebSocket upgrade,
`POST /v1/responses/compact`, `POST /v1/messages`, `POST /v1/chat/completions`,
`POST /v1/alpha/search`, `GET /v1/models`, and the realtime voice surface.
`POST /v1/messages/count_tokens` is deliberately **not** admitted, so Claude Code falls back to
local token estimation — a cosmetic loss, not a broken launch. `/api/*`, `/healthz`, `/readyz` and
the dashboard all return `404` there: local management reads such as `ocx claude`'s discovery call go
to the authenticated management surface with a management credential, never to an unauthenticated
socket. That is why the management ingress and this listener remain two different things.

With the listener **off**, a hub deliberately does not rewrite its own client configs, and every
skip names the gate that stopped it:

```text
This machine is a hub; it does not rewrite its own Codex/Grok/Claude configs unless
unauthenticatedLoopbackListener is enabled.
```

That sentence means the hub gate, not your `clientIntegrations` toggle. `ocx ensure` leaves an
existing managed Grok block in place when it is gated rather than stripping it, and
`ocx restore back` reports the gate instead of blaming a competing writer.

### Acceptance on the data plane

Prove liveness and readiness on the public data listener:

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
```

A `200` from `/healthz` proves only that the process is alive. Deployment acceptance also requires
`/readyz`, an authenticated `GET /v1/catalog`, and one real routed response.

## Tailscale Serve

First prove the management socket is loopback-only, then publish it through Serve:

```bash
ss -ltnp | grep 10101        # Linux: expected 127.0.0.1:10101 only
lsof -nP -iTCP:10101 -sTCP:LISTEN  # macOS: expected 127.0.0.1 only

tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

Set `hub.managementPublicOrigin` to the exact HTTPS origin shown by Serve. Add the operator's exact
Tailscale login to `remoteGui.allowedTailscaleUsers`; an empty list means no remote identity can mint
a session. Verify both directions:

```bash
# Negative: the loopback-only port must not be reachable through the node's tailnet address.
curl --fail --connect-timeout 3 http://100.64.0.10:10101/ && echo "unexpected exposure"

# Positive: the HTTPS dashboard loads through Serve from an allowed tailnet user.
curl --fail --silent --show-error https://hub-name.tailnet-name.ts.net/ >/dev/null
```

The positive browser test must use a real signed-in Tailscale session; a bare `curl` may not carry the
identity headers needed for automatic session issuance. Pairing remains the fallback when the HTTPS
frontend cannot provide trustworthy Tailscale identity.

### Giving the data listener TLS

The Serve mapping above publishes the **management** ingress only. That ingress never serves
`/v1/*`, `/healthz` or `/readyz`, so on its own it does not give a remote client a usable data
plane. opencodex also terminates no TLS of its own: the listener is plain HTTP and HTTPS is always
an operator-owned frontend.

Serve can be that frontend for the data plane too, on a second HTTPS port. On macOS it needs one
extra hop, because Tailscale Serve proxies only to `127.0.0.1` — it cannot target the listener you
bound to the node's own tailnet address, and the App Store build of the macOS client refuses a
remote destination outright. Run a loopback forwarder on the hub and point Serve at that:

```bash
# Any loopback TCP forwarder works; socat is one. Pick a port the hub is not already using:
# with the loopback companion enabled, 127.0.0.1:10100 belongs to opencodex itself.
socat TCP-LISTEN:10110,bind=127.0.0.1,fork,reuseaddr TCP:100.64.0.10:10100 &

tailscale serve --bg --https=8443 http://127.0.0.1:10110
tailscale serve status   # expect both mappings: 443 -> 10101, 8443 -> 10110
```

**Do not point Serve at the loopback companion listener instead.** It is a real socket on
`127.0.0.1:10100`, so the mapping would be created and then fail the same way the trap below
describes: the companion runs the loopback admission policy, which requires a loopback `Host`
header, and Serve forwards `Host: hub-name.tailnet-name.ts.net`. The companion exists for processes
*on* the hub, which send a loopback `Host` of their own. The forwarder carries the tailnet-bound
listener, whose credential admission and `Host` handling are what a TLS frontend needs.

Serve accepts a limited set of HTTPS ports; confirm the mapping was actually created with
`tailscale serve status` rather than assuming the port was allowed.

Give the forwarder the same lifetime as the hub. A backgrounded shell job dies on reboot while the
service comes back up, which leaves a hub that is running and unreachable over TLS; run it from
launchd or systemd alongside `ocx service install`.

Then connect with the two origins stated separately. The positional URL is the **data** origin —
it is where `/readyz` and `/v1/catalog` are fetched — and `--management-url` is the dashboard
origin used for pairing and key issuance. They do not have to share a port:

```bash
# This is exactly the line `ocx hub invite` prints, with the code filled in.
echo '<pairing-code>' | ocx connect https://hub-name.tailnet-name.ts.net:8443 \
  --management-url https://hub-name.tailnet-name.ts.net \
  --pairing-code-stdin
```

Record those two origins on the hub as `hub.dataPublicOrigin` and `hub.managementPublicOrigin`, and
`ocx hub invite` will print them for you instead of asking you to remember them.

When `--management-url` is omitted it is taken from the `/readyz` response, which reports
`hub.managementPublicOrigin`. Setting it explicitly is clearer when the two origins differ.

**Do not shortcut this by binding the data listener to `127.0.0.1`.** A loopback bind is how
opencodex recognizes a purely local deployment: it stops requiring a data credential, and it starts
requiring the request's `Host` header to be loopback as well. A TLS frontend forwards
`Host: hub-name.tailnet-name.ts.net`, so `/v1/catalog` answers `403 origin_rejected` — while
`/readyz`, which does not run that check, still returns `200`. The deployment looks healthy and
cannot serve a model. Nothing in the request path reads `X-Forwarded-Host`, so the frontend cannot
repair it. Keep the listener on the tailnet address, where credential admission stays on and the
`Host` check does not apply.

That trap is about the **bind**, and it is still true. Getting a `127.0.0.1` socket on a hub for the
hub's own processes is a different problem, and
[`unauthenticatedLoopbackListener`](#one-port-and-the-ported-alternative) is the sanctioned answer to
it: the public bind stays on the tailnet address with admission on, and a second socket serves local
callers. It is not a TLS target, for the reason given above.

Binding `0.0.0.0` also works and removes the need for a forwarder, since the listener is then
reachable on loopback as well. It publishes the data port on every interface, so prefer it only
where the host has no other network you care about — and note that the companion form of
`unauthenticatedLoopbackListener` is refused on a wildcard bind, because the public listener already
holds `127.0.0.1:<port>` there.

Re-run the acceptance checks against the HTTPS data origin once Serve is up: `/readyz`, an
authenticated `GET /v1/catalog`, and one real routed response.

### Operator-owned ts.net certificate proxy

If you operate your own TLS proxy, obtain a certificate only for the full ts.net FQDN:

```bash
tailscale cert hub-name.tailnet-name.ts.net
```

Protect the private key, renew it through Tailscale's supported mechanism, and proxy only to
`127.0.0.1:10101`. A generic TLS proxy does not supply trustworthy Tailscale identity. Do not
fabricate `Tailscale-User-*` headers; use the single-use, origin-bound pairing flow instead.

## Inviting another machine

Run this on the hub rather than writing an `ocx connect` line by hand:

```bash
ocx hub invite
```

It mints a single-use, short-lived pairing code and prints the command to run on the other machine:

```text
# Run on the other machine:
echo '<code>' | ocx connect https://hub-name.tailnet-name.ts.net:8443 --management-url https://hub-name.tailnet-name.ts.net --pairing-code-stdin
```

The data origin comes from `--data-url`, then `hub.dataPublicOrigin`, then the bind address. That
last fallback only works when the bind **is** an address another machine can dial: on a loopback or
wildcard bind it would resolve to `http://localhost:<port>`, which tells the other machine to dial
itself and spends the single-use code for nothing, so `invite` refuses instead and prints the
`ocx config set hub.dataPublicOrigin` line (plus the per-invite `--data-url` form). An explicit
`--data-url` or `hub.dataPublicOrigin` is never second-guessed — a loopback data origin is
legitimate over an SSH tunnel.

The management origin is `hub.managementPublicOrigin`, and on `invite` the `--management-url` flag
is a **confirmation, not an override**: the grant is bound to the configured origin and the
exchange compares against it, so a value that differs is refused with both origins named rather
than printing a code the hub would then reject.

Every successful invite also prints the **bound browser origin** on stderr. A grant is bound to one
origin, and a remote `ocx connect` presents `Origin: http://localhost:<its own configured port>`,
so if the bound origin is not the default `http://localhost:10100` the other machine has to already
be running on that port before it runs the line — otherwise the hub refuses the exchange and the
code is spent. The note says which port, and offers admitting the default origin instead.

`invite` refuses *before* minting anything when the setup cannot work — a `runtimeRole` that is not
`hub`, a missing `hub.managementPublicOrigin`, a plaintext non-loopback management origin, a
malformed `--data-url`, a data origin that would be this machine's own loopback, or no running
attested proxy. One precondition deserves its own paragraph.

**`corsAllowOrigins` has to name the joining machine's local browser origin.** `ocx connect` sends
`Origin: http://localhost:<its own proxy port>` when it exchanges the grant, and grants are
origin-bound, so only `hub.managementPublicOrigin` itself or a loopback entry of `corsAllowOrigins`
can ever match. With neither present, `invite` exits non-zero, mints nothing, and names the exact
command:

```bash
ocx config set corsAllowOrigins '["http://localhost:10100"]'
```

Use the port the **joining** machine's proxy listens on; `10100` is the default. The setup block
above already sets it. A whole-array set replaces the array, so when the hub already has entries
run the line `invite` prints — it carries the existing ones plus the new origin. `ocx config get
corsAllowOrigins` shows what is there now.

`ocx hub invite --json` emits `{ code, expiresAt, dataUrl, managementUrl, command }` with `expiresAt`
as ISO 8601. The code is a secret: single-use, five-minute lifetime, rate-limited at the hub, and not
to be persisted, logged, or pasted into an issue. `--clients codex,claude` picks which client configs
the printed command will point at the hub.

`invite` is a convenience over the existing pairing flow, not a second mechanism. It drives the same
attested local route `ocx gui pair` uses, so it needs no admin token and nothing has to be exported
into your shell. Everything in [Roles and direct data flow](#roles-and-direct-data-flow) about
rotation, revocation and disconnect applies unchanged to a machine that joined this way.

## macOS service operations

`ocx service install` and `ocx service repair` are safe to re-run against a live hub. A repair
renders the plist first and compares it: when the rendered bytes equal the bytes on disk, the token
file is unchanged, and `launchctl print` reports the job loaded from that plist, the repair re-asserts
`0600`, refreshes its install state, prints `service is already loaded from the current plist;
nothing to do.` and returns — launchd is never touched. Earlier builds evicted a healthy job
unconditionally, which made a diagnostic command an outage.

**`ocx service restart` is the verb that always restarts.** It is no longer an alias of `repair`. It
runs the same refresh, and when that reloaded nothing — the healthy, unchanged case above — it
restarts the already-loaded job in place with `launchctl kickstart -k`, re-reads `launchctl print` to
confirm the job survived, and prints one line:

```bash
ocx service restart
# ℹ️  service restarted (launchctl kickstart -k gui/501/com.opencodex.proxy).
```

That is what to run after changing `unauthenticatedLoopbackListener`, `hostname` or `port`. The
kickstart opens no eviction window, so it is not the outage the old unconditional repair was.

A bare `ocx service` still selects `repair`, not `restart`: it is an idempotent "make it current",
not a request to bounce a healthy hub. Use `ocx service repair` for the case it is actually for — a
job loaded from an older plist, or not loaded at all — and expect it to keep doing nothing on a
healthy one.

`launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy` by hand, or `ocx service stop` followed by
`ocx service start`, both still work and the error path names the first one as a fallback. Neither is
the recommended route any more.

Linux and Windows never had this gap: `ocx service restart` there ends in `systemctl --user restart`
and a stop-then-start of the scheduled task respectively, whichever verb asked.

`ocx service status` distinguishes four launchd states, and the last one is the one people misread:

| Summary | Meaning |
| --- | --- |
| `installed and loaded` | A domain answers and runs the command this plist bakes. Nominal. |
| `installed and loaded from an OLDER plist` | The job is running, from a definition that no longer matches. This is what `ocx service repair` is for. |
| `installed, not loaded` | Every domain answered "absent", which is proof the job is gone. Repair re-registers it. |
| `installed; launchd state could not be verified` | `launchctl` could not be asked — for example from a context that cannot reach the `gui/<uid>` domain. This is **not** evidence the hub is down: nothing recommends a repair, and an unanswerable probe never marks a running proxy as dead. |

A probe that could not run used to be reported as "not loaded", which told operators to repair a
serving hub and let the updater start a competing proxy on the service's own port.

## Headless OAuth

Disable browser launch on the hub:

```bash
ocx config set oauthOpenBrowser false
```

1. From the authenticated remote dashboard or management client, start `POST /api/oauth/login` for
   the provider. The hub returns the authorization URL and instructions without opening a browser.
2. Open the URL on the operator's machine and authorize there.
3. If the loopback callback cannot reach the hub, paste the final redirect URL or code into the
   dashboard/CLI. It sends `POST /api/oauth/login/code` with `{provider,input}`.
4. Poll the existing status endpoint until complete, then make a routed model request.

Never put the OAuth code in shell argv, logs, issue text, screenshots, or deployment evidence. The
manual-code route keeps its existing unknown-provider, no-active-flow, invalid-code, and 4096-byte
input checks.

## Docker Compose

opencodex does not publish an official container image. The repository does maintain a source-build
[`Dockerfile`](https://github.com/lidge-jun/opencodex/blob/main/Dockerfile),
[`compose.yaml`](https://github.com/lidge-jun/opencodex/blob/main/compose.yaml), and a narrow
`.dockerignore`. The build pins the multi-platform Bun 1.4.0 image index by digest, runs the proxy as
the non-root `bun` user, keeps the root filesystem read-only, drops Linux capabilities, and publishes
only the data listener on the host's `127.0.0.1:10100` by default. The foreground process uses
`OCX_SERVICE=1`, so stopping or recreating the container preserves routed Codex state instead
of restoring a native desktop configuration. Docker supplies supervision; no OS service manager
is installed in the image. Use Compose to restart/recreate the container; this does not extend
support to every dashboard restart path.

The image seeds a first-run `hub` configuration that binds the container listener to `0.0.0.0`.
Before the first normal start, stream a freshly generated data-plane token into the bootstrap helper.
The helper accepts at most one 4096-byte line, never prints the token, refuses to replace an existing
token, and persists it as the canonical owner-only `service-api-token` in the `ocx-state` volume.

The deployment persists two separate homes: `ocx-state` at `/home/bun/.opencodex` for
OpenCodex configuration, provider credentials and usage, and `codex-state` at
`/home/bun/.codex` for Codex state and `opencodex-catalog.json`. The image and Compose
explicitly set `CODEX_HOME=/home/bun/.codex`, so this catalog path remains writable
with `read_only: true` and survives container recreation. The image creates both
directories for the non-root `bun` user with mode `0700`; existing volume
ownership and permissions are not migrated automatically.

Do not combine `CODEX_HOME` and `OPENCODEX_HOME`: both products use an `auth.json`
filename with different formats. This packaging change adds persistence, not a
catalog generator. Materialize or import a valid catalog into
`/home/bun/.codex/opencodex-catalog.json` before the catalog acceptance check below;
without one, `catalog_not_found` remains the expected response.

Upgrading preserves the existing `ocx-state` volume and adds `codex-state`; no files
are migrated automatically. If a previous workaround placed a catalog directly
under `/home/bun/.opencodex`, back it up and deliberately copy only the catalog to
the new Codex home, preserving owner-only access. Do not copy either product's
`auth.json` over the other. Deployments with a custom `CODEX_HOME` should retain
their explicit environment and writable volume mapping until migration is complete.
When overriding `CODEX_HOME`, mount that exact directory writable and persist the
default catalog at `${CODEX_HOME}/opencodex-catalog.json`. If `model_catalog_json`
explicitly selects another file, that resolved path must also be persisted.

Keep the Compose project name stable during upgrades so the same named volumes are reused.
Mounts with existing foreign ownership, read-only mounts, and mounts using `volume-nocopy`
are not repaired by the image's directory setup. Persist separately selected catalog or SQLite
paths separately; an OS credential store is not backed up by these two volumes.

When running without Compose, explicitly supply both named mounts. Dockerfile `VOLUME`
declarations alone create anonymous volumes that a later `docker run` does not automatically
reuse. These mount options use standalone example names; to reuse Compose data, substitute
its actual project-prefixed volume names:

```sh
--mount type=volume,src=ocx-state,dst=/home/bun/.opencodex \
--mount type=volume,src=codex-state,dst=/home/bun/.codex
```

Install Git and Bun on the host first. Before **every** image build, run the existing canonical
generator from this Git checkout. It hashes Git-tracked working-tree sources (stage any newly
added source files first), not an arbitrary directory scan. Do not change source files between
generation and build. Only its untracked `src/generated/compatibility-version.json` artifact
enters the image; `.git` remains outside the Docker context. Do not commit or hand-edit the
manifest. The build rejects stale manifests: it verifies every recorded SHA-256 against the
read-only build context and again against the copied runtime files. It requires `package.json`,
`bun.lock`, and `scripts/model-metadata.source.json`; only that exact scripts artifact is
included, not the rest of `scripts/`. Missing or mismatched files, extra source files absent
from the manifest, and symlinks (including parent directories) fail the build. The only source
file exempt from the inventory is the generated manifest itself. If validation fails, reconcile
the tracked sources, remove unintended source files, and rerun the canonical generator.

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

Set an alternate host port without changing the container's fixed `10100` listener:

```bash
OPENCODEX_PORT=10190 docker compose up -d
```

Remote access is an explicit opt-in. Set `OPENCODEX_BIND_ADDRESS` to the host's LAN or Tailscale
IP, or use `0.0.0.0` to publish on **all** host interfaces:

```bash
OPENCODEX_BIND_ADDRESS=0.0.0.0 docker compose up -d
```

Use a firewall and an authenticated TLS/tailnet frontend before exposing the port. The bind
override changes only the host publication; the container listener remains `0.0.0.0:10100`.
Keep the same bind override on subsequent Compose invocations that recreate the hub. To update
an existing deployment, regenerate the manifest, run `docker compose build`, and recreate the
hub with `docker compose up -d`; do not repeat the one-time token initialization.

Configure providers with the dashboard through an operator-owned management frontend, or with
one-shot CLI commands that share the state volume. The commands below show the existing Remote Hub
settings; replace the example origin and identity before enabling them:

```bash
docker compose run --rm hub bun run src/cli/index.ts config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
docker compose run --rm hub bun run src/cli/index.ts config set hub.managementIngress '{"enabled":true,"port":10101}'
docker compose run --rm hub bun run src/cli/index.ts config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
docker compose restart hub
```

These nested sets work because the image seeds a first-run `hub` configuration, so the object
already exists. On a fresh standalone install it does not, and the same lines fail until you create
it — see [Linux systemd or macOS launchd](#linux-systemd-or-macos-launchd) above.

The container listener binds `0.0.0.0`, so it is already reachable on the container's own loopback
address and the companion form of `unauthenticatedLoopbackListener` does not apply there — it is
refused on a wildcard bind. The token bootstrap below is the container equivalent of the service's
own provisioning step, and it likewise runs once.

Do not put a token in `ARG`, `ENV`, `COPY`, Compose YAML, image history, or command arguments. Do not
mount the Docker socket, the host's home or Codex home, SSH agent, or provider-key files. A management
ingress bound to `127.0.0.1:10101` inside the container is reachable only by a TLS/tailnet frontend
in the same network namespace; never publish `10101` as a shortcut.

After the container is healthy, run a separate readiness promotion check:

```bash
docker compose exec hub bun -e \
  "const r=await fetch('http://127.0.0.1:10100/readyz');console.log(r.status,await r.text());if(!r.ok)process.exit(1)"

docker compose exec hub bun -e \
  "const t=(await Bun.file('/home/bun/.opencodex/service-api-token').text()).trim();const r=await fetch('http://127.0.0.1:10100/v1/catalog',{headers:{'x-opencodex-api-key':t}});console.log(r.status);if(!r.ok)process.exit(1)"
```

Then send one real authenticated routed response with a configured model. If the secret is absent or
unreadable, a non-loopback hub must not be accepted as ready. Never treat liveness alone as proof.

`docker compose down` removes the container and network but retains both named volumes. Treat
`docker compose down --volumes` as destructive: it deletes configuration, OAuth credentials, usage
history, the data-plane token, and persisted Codex state together.

Cross-platform CI builds the source image and checks startup, data-plane token admission, and
container recreation using an isolated Compose project with throwaway credentials. It verifies that
both named volumes and a synthetic catalog survive replacement. This check does not validate a
real provider account, OAuth callback, custom mount migration, or every CPU architecture; perform
the authenticated routed-response check above for your deployment.

## Rollback

Inspect existing Serve mappings before changing them. `tailscale serve reset` removes every mapping
on the node; use a narrower supported removal command when unrelated mappings exist.

```bash
tailscale serve status
tailscale serve reset
ocx config set hub.managementIngress '{"enabled":false}'
ocx service repair
```

For a container rollback, retain both named state volumes and their mappings. An older image
can still use `CODEX_HOME=/home/bun/.codex` when that directory remains mounted; do not revert
to an older Compose file that drops the Codex mount. Do not merge the homes or rerun token bootstrap.
For a service rollback, stop the branch service and repair the prior release against the same
`OPENCODEX_HOME`. Disabling management ingress or Serve does not require changing the data listener.

## Troubleshooting

- **Hub down:** `ocx connect status` still shows the saved connection. `ocx disconnect` can restore
  local state offline; it cannot revoke the remote key.
- **Stale catalog:** `ocx sync` keeps a validated last-known-good catalog only for transient hub
  failures. Authentication, schema, size, and protocol failures are hard errors and never fall back
  to local providers.
- **Rotated token or `.prev` recovery:** rerun `ocx connect rotate` with a pairing code or admin token.
  Do not edit or remove either token candidate before the recovery probe finishes.
- **Protocol mismatch:** upgrade the older side named by the `hub-too-new` or `hub-too-old` message.
  Negotiation fails before token, catalog, journal, or client-state writes.
- **Lost or burned pairing code:** run `ocx hub invite` again. Grants are one-use and repeated
  failures are rate-limited without revealing whether a code exists.
- **`ocx hub invite` says `No loopback browser origin is admitted for pairing`:** the hub admits no
  loopback browser origin, so an origin-bound grant could never match. Nothing was minted. Run the
  `ocx config set corsAllowOrigins` line the error prints, with the joining machine's proxy port.
  See [Inviting another machine](#inviting-another-machine).
- **`ocx hub invite` says the advertised data origin would be this machine's own loopback:** the
  bind is loopback-only or a wildcard and `hub.dataPublicOrigin` is unset, so there is no address
  to advertise and nothing guesses a tailnet or LAN one. Nothing was minted. Set
  `hub.dataPublicOrigin`, or pass `--data-url` for this invite only.
- **The joining machine's exchange is refused and the code is spent:** the grant was bound to an
  origin that machine does not present. Re-read the `Bound browser origin:` line from the invite —
  it names the port the other machine must be running on, or offers admitting
  `http://localhost:10100` on the hub instead.
- **`ocx hub invite` refuses a `--management-url`:** on a hub that flag confirms
  `hub.managementPublicOrigin` rather than overriding it, because the grant is bound to the
  configured value. Change the config, or drop the flag.
- **`ocx claude` on the hub launches native Codex/Claude, or the hub refuses to write its own client
  configs:** `unauthenticatedLoopbackListener` is off. The skip message names the gate. Enable the
  listener and restart the proxy (`ocx service restart` on a service install).
- **`ocx claude` on the hub gets `404` from the listener:** the proxy is still the process that
  started before the listener's wires existed, or before the port changed. Restart it with
  `ocx service restart` — see [macOS service operations](#macos-service-operations).
- **`ocx service repair` printed `nothing to do` and the process did not bounce (macOS):** expected.
  A repair of a healthy job is deliberately a no-op. When you wanted a new process, run
  `ocx service restart`, which kickstarts the loaded job in place and reports
  `service restarted (launchctl kickstart -k …)`. Only if that fails is
  `launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy` the manual fallback — the failure
  message names it.
- **`ocx service install` refuses `OPENCODEX_API_AUTH_TOKEN`:** that value is a management admin
  token. `unset OPENCODEX_API_AUTH_TOKEN` and rerun; the service provisions its own data-plane
  token. See [The data-plane token provisions itself](#the-data-plane-token-provisions-itself).
- **The hub crash-loops at boot and `ocx status` shows `admin-collision (file)`:** the
  `service-api-token` file holds the management token, so the hub fences its management API closed.
  Delete the file and run `ocx service repair` to provision a data-plane token. Unsetting the
  environment variable does not help here — the file is the source.
- **Plain HTTP refused:** pairing over non-loopback HTTP is refused outright, and there is no flag
  that opts out of it. Put the management origin behind HTTPS, or pair over loopback. Admin tokens
  are never sent over HTTP.
- **`403 origin_rejected` from `/v1/catalog` while `/readyz` returns `200`:** the data listener is
  bound to loopback behind a TLS frontend. See [Giving the data listener TLS](#giving-the-data-listener-tls).
- **Remote session ended:** sign in or pair again. Logout and expiry invalidate only the browser
  session, not a client data key.
- **Outstanding revocation after disconnect:** use the hub dashboard's **Integrations → API Keys**
  page. It is the sole post-disconnect revocation path.
