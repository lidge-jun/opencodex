# hubapi hosted edge

`hub/` is an independently started Bun/TypeScript admission and accounting edge. It is not imported by the ordinary OpenCodex runtime and it does not contain a second provider router.

## Boundaries

- Public data-plane routes are allowlisted to `/v1/responses`, `/v1/chat/completions`, `/v1/messages`, and `/v1/models`.
- `/api/*` and every OpenCodex management route stay private.
- Browser sessions, public API keys, recharge codes, and the internal admission credential are separate credential classes.
- Credits use integer units and append-only ledger entries.
- SQLite is single-node only; a second process fails closed on the instance lock.
- Payments, wallets, orders, and subscriptions are intentionally absent.

## Required configuration

Hosted startup has no usable secret or database defaults. Configure every required value explicitly:

```text
HUB_DATABASE_PATH
HUB_DIGEST_SECRET
HUB_PUBLIC_ORIGIN
HUB_HOSTNAME
HUB_OPENCODEX_ORIGIN
HUB_INTERNAL_ADMISSION_TOKEN
HUB_REQUEST_COST_UNITS
HUB_PRICING_VERSION
```

Optional policy settings include `HUB_ALLOW_REGISTRATION=1`, `HUB_SESSION_TTL_SECONDS`, `HUB_PORT`, and `HUB_UPSTREAM_TIMEOUT_MS`. Plain HTTP is accepted only with `HUB_DEVELOPMENT=1` on loopback.

## Network firewall

For an HTTPS reverse-proxy deployment, set `HUB_HOSTNAME=127.0.0.1` and `HUB_TRUST_LOOPBACK_PROXY=1`. In this mode the server fails closed unless the direct socket peer is loopback and Caddy supplies one valid `X-Hubapi-Client-IP`; direct mode ignores that header. Use [`deploy/Caddyfile.example`](./deploy/Caddyfile.example) as the route-default-deny TLS gateway.

[`deploy/hubapi-guard.nft`](./deploy/hubapi-guard.nft) is a service-scoped nftables guard. It accepts loopback first, then drops non-loopback access to the default private OpenCodex and hub ports without flushing or replacing the host's existing firewall. Review any custom ports, validate, apply, and read back the exact table on the Linux host:

```bash
sudo nft --check --file hub/deploy/hubapi-guard.nft
sudo nft --file hub/deploy/hubapi-guard.nft
sudo nft list table inet hubapi_guard
caddy validate --config hub/deploy/Caddyfile.example --adapter caddyfile
```

Do not apply the example blindly over an existing table; delete or replace only the named `inet hubapi_guard` table during a controlled maintenance window. Host firewall activation is intentionally not automatic from the application.

Bootstrap the first administrator offline by passing the password over stdin, then start the independent listener:

```bash
bun run bootstrap-admin -- --email ADMIN_EMAIL
bun run start
```

Replace `ADMIN_EMAIL` with the administrator address before running the offline bootstrap command.

The account and admin portal is served from `/hub/`. The admin dashboard is available at `/hub/#admin`; `/hub/#proxy` is a proxy workbench with the exact allowlisted endpoints, the current browser-visible Base URL, an authenticated and bounded view of the private `/v1/models` catalog, and copyable OpenAI SDK, Codex CLI, and Claude Code setup recipes. Recipes contain only a key placeholder: create the real one-time key on `/hub/#keys` and keep it out of browser storage. Administrators can set batch expiry, inspect only masked user-key/card inventory and user ledgers, revoke active user keys, and never recover a complete secret.
