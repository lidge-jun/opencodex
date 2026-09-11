---
title: Remote Hub Deployment
description: Run an opencodex hub on Linux, macOS, or Docker with a loopback-only management ingress, Tailscale Serve, and headless OAuth.
---

An opencodex hub keeps provider credentials and usage state on one host while authenticated clients
use its data plane remotely. The browser-facing management plane is separate: an optional listener
binds only `127.0.0.1`, serves the dashboard and `/api/*`, and is intended to sit behind Tailscale
Serve or another operator-owned HTTPS frontend.

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

## Linux systemd or macOS launchd

Choose the hub's Tailscale address for the data listener and the exact browser-visible HTTPS origin
for management. The values below are examples:

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
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'

# Generate/read this in a protected operator shell or secret manager.
# It is a data-admission token, not a provider credential.
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
ocx service status
```

On a genuinely empty configuration you can set each object in one call instead:

```bash
ocx config set hub '{"managementPublicOrigin":"https://hub-name.tailnet-name.ts.net","managementIngress":{"enabled":true,"port":10101}}'
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
effect. `managementPublicOrigin` must be a bare origin with no path, query or fragment.

`ocx service install` copies the token into the existing owner-only `service-api-token` path. The
launchd plist and systemd user unit read that protected file when the process starts; neither embeds
the literal token. Do not paste the value into `ocx config show`, unit/plist output, screenshots, or
support bundles.

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
# Any loopback TCP forwarder works; socat is one. The data listener is bound to the tailnet
# address, so 127.0.0.1:10100 is free for the forwarder to take.
socat TCP-LISTEN:10100,bind=127.0.0.1,fork,reuseaddr TCP:100.64.0.10:10100 &

tailscale serve --bg --https=8443 http://127.0.0.1:10100
tailscale serve status   # expect both mappings: 443 -> 10101, 8443 -> 10100
```

Serve accepts a limited set of HTTPS ports; confirm the mapping was actually created with
`tailscale serve status` rather than assuming the port was allowed.

Give the forwarder the same lifetime as the hub. A backgrounded shell job dies on reboot while the
service comes back up, which leaves a hub that is running and unreachable over TLS; run it from
launchd or systemd alongside `ocx service install`.

Then connect with the two origins stated separately. The positional URL is the **data** origin —
it is where `/readyz` and `/v1/catalog` are fetched — and `--management-url` is the dashboard
origin used for pairing and key issuance. They do not have to share a port:

```bash
ocx connect https://hub-name.tailnet-name.ts.net:8443 \
  --management-url https://hub-name.tailnet-name.ts.net \
  --admin-token-stdin
```

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

Binding `0.0.0.0` also works and removes the need for a forwarder, since the listener is then
reachable on loopback as well. It publishes the data port on every interface, so prefer it only
where the host has no other network you care about.

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
- **Lost or burned pairing code:** create a new short-lived code. Grants are one-use and repeated
  failures are rate-limited without revealing whether a code exists.
- **Plain HTTP refused:** pairing over non-loopback HTTP is refused outright, and there is no flag
  that opts out of it. Put the management origin behind HTTPS, or pair over loopback. Admin tokens
  are never sent over HTTP.
- **`403 origin_rejected` from `/v1/catalog` while `/readyz` returns `200`:** the data listener is
  bound to loopback behind a TLS frontend. See [Giving the data listener TLS](#giving-the-data-listener-tls).
- **Remote session ended:** sign in or pair again. Logout and expiry invalidate only the browser
  session, not a client data key.
- **Outstanding revocation after disconnect:** use the hub dashboard's **Integrations → API Keys**
  page. It is the sole post-disconnect revocation path.
