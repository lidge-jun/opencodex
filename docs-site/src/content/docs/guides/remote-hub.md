---
title: Remote Hub Deployment
description: Run an opencodex hub on Linux, macOS, or Docker with a loopback-only management ingress, Tailscale Serve, and headless OAuth.
---

An opencodex hub keeps provider credentials and usage state on one host while authenticated clients
use its data plane remotely. The browser-facing management plane is separate: an optional listener
binds only `127.0.0.1`, serves the dashboard and `/api/*`, and is intended to sit behind Tailscale
Serve or another operator-owned HTTPS frontend.

The management ingress never serves `/v1/*`, `/healthz`, or `/readyz`. Its only WebSocket exception
is the bearer-authenticated `/remote-workspace/agent` connection opened outbound by a paired OCX
Executor. Do not publish the ingress port directly, do not add a cloud-firewall rule for it, and do
not use Tailscale Funnel. Funnel is a public-internet surface and is outside this deployment model.

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
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set corsAllowOrigins '["http://localhost:10100"]'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'

# Generate/read this in a protected operator shell or secret manager.
# It is a data-admission token, not a provider credential.
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
ocx service status
```

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

## Operator-owned Docker recipe

opencodex does not publish or maintain an official container image. The following recipe is an
operator-owned starting point. Before building, resolve `oven/bun:1.4.0` to a registry digest and
replace both `REPLACE_WITH_BUN_1_4_0_DIGEST` values. A tag alone is not a production pin.

```dockerfile
# syntax=docker/dockerfile:1
FROM oven/bun:1.4.0@sha256:REPLACE_WITH_BUN_1_4_0_DIGEST AS build
WORKDIR /home/bun/app
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun gui ./gui
COPY --chown=bun:bun tsconfig.json ./
RUN cd gui && bun install --frozen-lockfile && bun run build

FROM oven/bun:1.4.0@sha256:REPLACE_WITH_BUN_1_4_0_DIGEST AS runtime
WORKDIR /home/bun/app
ENV OPENCODEX_HOME=/home/bun/.opencodex
ENV OCX_API_TOKEN_FILE=/run/secrets/ocx_api_token
COPY --from=build --chown=bun:bun /home/bun/app/package.json ./package.json
COPY --from=build --chown=bun:bun /home/bun/app/bun.lock ./bun.lock
COPY --from=build --chown=bun:bun /home/bun/app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /home/bun/app/src ./src
COPY --from=build --chown=bun:bun /home/bun/app/gui/dist ./gui/dist
USER bun
VOLUME ["/home/bun/.opencodex"]
EXPOSE 10100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:10100/healthz');if(!r.ok)process.exit(1)"]
CMD ["bun", "run", "src/cli/index.ts", "start", "--port", "10100"]
```

An example Compose definition keeps mutable state and the token outside the image:

```yaml
services:
  hub:
    build: .
    read_only: true
    ports:
      - "10100:10100"
    volumes:
      - ocx-state:/home/bun/.opencodex
    tmpfs:
      - /tmp
    secrets:
      - source: ocx_api_token
        target: ocx_api_token
        uid: "1000"
        gid: "1000"
        mode: 0440
    restart: unless-stopped

volumes:
  ocx-state:

secrets:
  ocx_api_token:
    file: ./secrets/ocx_api_token
```

Initialize the named volume before the first normal start. Container port publishing requires the
data listener to bind `0.0.0.0`; the management listener remains fixed to container loopback:

```bash
docker compose run --rm hub bun run src/cli/index.ts config set runtimeRole hub
docker compose run --rm hub bun run src/cli/index.ts config set hostname 0.0.0.0
docker compose run --rm hub bun run src/cli/index.ts config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
docker compose run --rm hub bun run src/cli/index.ts config set hub.managementIngress '{"enabled":true,"port":10101}'
docker compose run --rm hub bun run src/cli/index.ts config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
docker compose up -d
```

Do not put a token in `ARG`, `ENV`, `COPY`, Compose YAML, image history, or the command line. Do not
mount the Docker socket, host home, Codex home, SSH agent, or provider-key files. Publish only port
`10100`. A management ingress bound to `127.0.0.1:10101` inside the container is reachable only by a
TLS/tailnet frontend in the same network namespace; never publish `10101` as a shortcut.

After the container is healthy, run a separate readiness promotion check:

```bash
docker compose exec hub bun -e \
  "const r=await fetch('http://127.0.0.1:10100/readyz');console.log(r.status,await r.text());if(!r.ok)process.exit(1)"

docker compose exec hub bun -e \
  "const t=(await Bun.file('/run/secrets/ocx_api_token').text()).trim();const r=await fetch('http://127.0.0.1:10100/v1/catalog',{headers:{'x-opencodex-api-key':t}});console.log(r.status);if(!r.ok)process.exit(1)"
```

Then send one real authenticated routed response with a configured model. If the secret is absent or
unreadable, a non-loopback hub must not be accepted as ready. Never treat liveness alone as proof.

## Rollback

Inspect existing Serve mappings before changing them. `tailscale serve reset` removes every mapping
on the node; use a narrower supported removal command when unrelated mappings exist.

```bash
tailscale serve status
tailscale serve reset
ocx config set hub.managementIngress '{"enabled":false}'
ocx service repair
```

For a container rollback, remove or replace the container while retaining the named state volume.
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
- **Plain HTTP warning:** pairing over non-loopback HTTP requires the explicit
  `--allow-insecure-http` opt-in. Admin tokens are never sent over HTTP.
- **Remote session ended:** sign in or pair again. Logout and expiry invalidate only the browser
  session, not a client data key.
- **Outstanding revocation after disconnect:** use the hub dashboard's **Integrations → API Keys**
  page. It is the sole post-disconnect revocation path.
