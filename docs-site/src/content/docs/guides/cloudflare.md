---
title: Cloudflare Deployment
description: Run an opencodex hub on Cloudflare Workers, Containers, Durable Objects, and R2, with state that survives sleep and redeploys.
---

`deploy/cloudflare/` runs the same image as [Docker Compose](/guides/remote-hub/#docker-compose)
on Cloudflare, with no server of your own. A Worker receives every request and forwards it to one
[Cloudflare Container](https://developers.cloudflare.com/containers/) running `ocx`. The container
disk is wiped whenever the container sleeps or a new version rolls out, so the hub's state lives in
an R2 bucket between runs.

```text
client ──HTTPS──▶ Worker ──▶ OpencodexHub (Durable Object) ──▶ container: supervisor ─▶ ocx :10100
                                   │ lease                              │ snapshots
                                   └──────────────── R2 bucket ◀────────┘
```

:::note[Status]
This is the first stage of Cloudflare support. `ocx` still runs as a Linux process inside a
container; it is not yet a Workers-native runtime. The deployment is a data-plane hub: clients call
`/v1/*` with a key, and the dashboard and management API are not available remotely. It has been
exercised with `wrangler dev` and on a production Cloudflare account, without routing a request to
a real model provider.
:::

## Requirements

- A Cloudflare account on the Workers Paid plan, which Containers require.
- Docker running on the machine you deploy from. `wrangler deploy` builds the root `Dockerfile`
  there and pushes the image to Cloudflare's registry.
- Bun, to install the Wrangler package.

## Deploy

```bash
cd deploy/cloudflare
bun install
npx wrangler login
npx wrangler r2 bucket create opencodex-state

# The data-plane token clients will send. History records the command, not the value.
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$OPENCODEX_API_AUTH_TOKEN" | npx wrangler secret put OPENCODEX_API_AUTH_TOKEN

npx wrangler deploy
```

Save the value of `$OPENCODEX_API_AUTH_TOKEN` in your password manager now; Cloudflare will not show
it again, and the steps below use it. Until the
`OPENCODEX_API_AUTH_TOKEN` secret exists, the Worker answers every request with `503` and names the
missing secret.

Check the deployment with the token in a header:

```bash
curl -H "x-opencodex-api-key: $OPENCODEX_API_AUTH_TOKEN" \
  https://opencodex.<your-subdomain>.workers.dev/healthz
```

The Worker answers `401` to any request that does not carry the data token, without starting the
container, so scanners and wrong keys cannot keep it running. It reads the token from the same places
`ocx` does: `x-opencodex-api-key`, `Authorization: Bearer`, `x-api-key`, or, for the audio WebSocket,
the key subprotocol. The comparison takes the same time whatever the key. `ocx` still checks every
key it receives.

The Worker only knows the data token. If you issue further client keys through `apiKeys` in the
hub's configuration, the Worker would refuse them, so store `OCX_EDGE_KEY_CHECK=presence` as a secret
to go back to checking only that some key is present. That costs money: any request with any
non-empty key then starts the container and keeps it awake, and only `ocx` rejects the wrong ones.

`OPTIONS` requests are answered by the Worker without CORS headers, so cross-origin browser requests
that need an authentication header fail. The audio WebSocket still works from a browser, because it
carries its key as a subprotocol. Because `/healthz` needs a key too, an uptime monitor must be given
the data token, or, with `OCX_EDGE_KEY_CHECK=presence`, a dedicated client key.

The first request starts the container, which takes a few seconds. Requests that arrive while it is
restoring or saving state get `503` with `Retry-After: 10`.

## Configure providers

On first boot, with no saved state, the hub uses the image's default configuration. To start from
your own `config.json` instead, store it as a secret before the first request:

```bash
npx wrangler secret put OCX_BOOTSTRAP_CONFIG_JSON < config.json
```

The hub must listen on `0.0.0.0:10100`, the only address the Worker reaches. Leave `hostname` and
`port` out of the file and they are filled in; any other value stops the first boot with an error,
before an unreachable configuration can be saved. Worker secrets have a size limit, so keep the file
small. The secret is read only when no saved state exists. After that, the saved configuration wins;
see [Change configuration later](#change-configuration-later).

Keep provider API keys and `apiKeys` entries out of the file, because the configuration is saved to
R2. Reference provider keys as `${NAME}` in the provider's `apiKey`, as in
[Providers](/guides/providers/), store each as a secret, and list the names in
`OCX_PASSTHROUGH_SECRETS`:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
printf 'ANTHROPIC_API_KEY' | npx wrangler secret put OCX_PASSTHROUGH_SECRETS
```

Only names listed there reach the container.

## Change configuration later

Once a snapshot exists, a new `OCX_BOOTSTRAP_CONFIG_JSON` is ignored. There are two ways to change
the configuration after that:

- **Keep the saved state.** Open the management API for the change, as described under
  [Security](#security), and use it like any other hub. Close it again afterwards.
- **Start over from the bootstrap secret.** Store the new `OCX_BOOTSTRAP_CONFIG_JSON`, then set
  `OCX_DISCARD_SAVED_STATE` to a value it has never had; a random one is safest. This discards the saved state:
  OAuth logins, client keys, and usage history go with it.

  ```bash
  npx wrangler secret put OCX_BOOTSTRAP_CONFIG_JSON < config.json
  openssl rand -hex 8 | npx wrangler secret put OCX_DISCARD_SAVED_STATE
  ```

## Connect Codex

Point Codex at the hub with the data token in an environment variable. In `~/.codex/config.toml`:

```toml
model_provider = "opencodex"

[model_providers.opencodex]
name = "opencodex"
base_url = "https://opencodex.<your-subdomain>.workers.dev/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENCODEX_API_AUTH_TOKEN"
```

This is the table `ocx` itself writes for a remote hub. Export `OPENCODEX_API_AUTH_TOKEN` in the
shell that starts Codex.

## How state is kept

The container's entrypoint is `docker/cloudflare-supervisor.ts`. It:

1. Takes a lease from the Durable Object, so only one container writes state at a time.
2. Restores `~/.opencodex` and `~/.codex` from the latest snapshot in R2. If that fails, it stops
   rather than start `ocx` with an empty home.
3. Starts `ocx`, renews the lease every 30 seconds, and uploads a snapshot every 30 seconds if
   anything changed.
4. On `SIGTERM` (sleep or a new rollout), stops `ocx`, uploads a final snapshot with retries, and
   releases the lease. Cloudflare allows up to 15 minutes between `SIGTERM` and `SIGKILL`, and
   stops the old container before starting the new one.

SQLite databases are copied with `VACUUM INTO`, so a snapshot never holds a half-written database.
Lock databases and the generated management token are left out. Other files are copied as they
are; the final snapshot is taken after `ocx` has exited, so it cannot catch a file mid-write.

If a container dies without `SIGTERM`, changes since its last snapshot are lost, and the next
container waits up to two minutes for the dead one's lease to expire. A container that loses its
lease, or cannot renew it for two minutes because the state endpoint is unreachable, stops
without uploading, and its late uploads are discarded, so it cannot overwrite newer state.

Two settings tune this. Neither is secret, but store them with `npx wrangler secret put` like the
others, so that deploying the repository's `wrangler.jsonc` does not reset them:

| Setting | Default | Effect |
|---|---|---|
| `OCX_SNAPSHOT_INTERVAL_SECONDS` | `30` | Upload interval, clamped to 5–60 seconds |
| `OCX_SLEEP_AFTER` | `30m` | How long the container stays up without requests, for example `2h` |

Changing any value the container receives (`OCX_SNAPSHOT_INTERVAL_SECONDS`, `OCX_BOOTSTRAP_CONFIG_JSON`,
the tokens, or a passthrough secret) restarts the container on the next request, as described
under [Operate](#operate).

## Recover a hub that will not start

If the hub answers `503` indefinitely, the saved state may be unusable: for example, the snapshot
object was deleted from R2 while the Durable Object still points at it. The supervisor refuses to
start `ocx` on an empty home in that case, so it cannot overwrite what was saved. To start over
from `OCX_BOOTSTRAP_CONFIG_JSON`, set `OCX_DISCARD_SAVED_STATE` to a new value as shown in
[Change configuration later](#change-configuration-later). Each distinct value is honored once, so
leaving it set does not wipe later boots.

## Security

- The R2 bucket holds `config.json`, OAuth credentials, client API keys, and usage history. Treat
  access to the bucket, and to the Cloudflare account, as access to those credentials.
- The data token and any client keys are the only thing between the internet and your provider
  accounts. Use long random values.
- The Worker keeps `/api/*` closed. To expose the management API anyway, set your own
  `OPENCODEX_ADMIN_AUTH_TOKEN` (different from the data token) and `OCX_EXPOSE_MANAGEMENT_API=1`.
  Anyone with that token can then administer the hub from the internet, so leave it closed unless
  you need it.
- Do not put tokens in `wrangler.jsonc`; `vars` there are stored in plain text.
- The Worker always sends requests to port `10100`; a client cannot reach any other port in the
  container.
- `wrangler.jsonc` keeps Workers Logs on for `console` output but turns invocation logs off, because
  they record request metadata that can include a client's key header. If you turn them back on, treat
  the logs as holding credentials.
- `OCX_PASSTHROUGH_SECRETS` refuses names that control the process rather than carry a secret, such
  as `HOME`, `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, and the proxy variables. The Worker log names each
  refused entry.
- Remote Workspace pairing limits failed attempts per client IP address. Every request reaches `ocx`
  from the Worker, so on this deployment the limit is shared: one client's failed attempts can lock
  everyone out of pairing until the window passes.
- Snapshot objects are stored under the Durable Object's id in the bucket, and the cleanup at boot
  deletes only inside that prefix, so a bucket shared by mistake does not lose another deployment's
  state. Give each deployment its own bucket anyway.

## Operate

| Task | Command |
|---|---|
| Follow Worker logs | `npx wrangler tail` |
| Update to a new release | `git pull`, then `npx wrangler deploy` |
| Rotate the data token | Repeat the two token lines from [Deploy](#deploy), save the new value, and update your clients |

A running container keeps the secrets it started with. When any secret it receives changes, the
next request stops the container, which saves its state, and starts a new one with the new values;
requests in between get `503` with `Retry-After`. After a rotation, confirm that a request with the
old token gets `401`.

Rotating `OPENCODEX_API_AUTH_TOKEN` revokes only that token. Client keys stored in `apiKeys`,
including a key's `pendingRotation` value, are part of the saved state in R2 and keep working until
you remove them through the management API or discard the saved state.

For local testing with `npx wrangler dev`, stopping it with Ctrl-C kills the local container without
a final snapshot. The next start waits up to two minutes for the old lease to expire, then restores
the last periodic snapshot. Deployed containers are not affected: Cloudflare sends `SIGTERM` first.

## Limits

- One container serves every request (`max_instances: 1`), because the hub's stores assume a
  single writer.
- Each deployment needs its own Worker `name` and R2 `bucket_name` in `wrangler.jsonc`; two
  deployments with the same names in one account overwrite each other.
- The Worker and container are billed separately from the $5 Workers Paid base; see
  [Containers pricing](https://developers.cloudflare.com/containers/pricing/).
- Cloudflare's Deploy to Cloudflare button does not document support for Containers, so deploy with
  Wrangler as above.
