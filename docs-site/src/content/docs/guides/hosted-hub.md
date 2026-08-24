---
title: Hosted hub
description: Run the optional hubapi user login, recharge-code, credit ledger, and public API admission edge without exposing OpenCodex management routes.
---

The hosted hub is an optional public admission and accounting edge. OpenCodex remains the only
provider router. The edge authenticates a `hub_live_` user key, reserves integer credit, replaces the
public credential with a private internal admission token, and streams the request to a loopback
OpenCodex listener.

:::caution
This first hosted release is **single-node only**. It uses SQLite with an exclusive runtime lease and
does not claim multi-replica or high-availability support. Payment processors, wallets, orders, and
subscriptions are not included.
:::

## Trust boundary

- `ocx start` does not import or activate hosted-hub code.
- The public edge exposes only `/hub/*` account routes and the allowlisted `/v1/responses`,
  `/v1/chat/completions`, `/v1/messages`, and `/v1/models` data routes.
- OpenCodex `/api/*`, GUI sessions, provider credentials, and admin tokens stay on a private loopback
  listener and are never forwarded.
- Passwords use Argon2id. Browser sessions use opaque HttpOnly cookies plus same-origin CSRF evidence.
- User API keys and recharge codes are shown once; opaque session tokens are never exposed in page
  content. All three are stored only as domain-separated HMAC digests.
- Credit is an integer append-only ledger. Recharge, reservation, settlement, and release are atomic
  and idempotent.

## Required configuration

Hosted startup fails closed when any security-critical value is missing. Configure:

| Variable | Meaning |
| --- | --- |
| `HUB_DATABASE_PATH` | Private local SQLite path; do not place it on a shared/network filesystem. |
| `HUB_DIGEST_SECRET` | At least 32 random bytes for domain-separated credential digests. |
| `HUB_PUBLIC_ORIGIN` | Exact HTTPS browser origin, without a path. |
| `HUB_HOSTNAME`, `HUB_PORT` | Explicit bind and port. Use loopback only with trusted reverse-proxy mode. |
| `HUB_TRUST_LOOPBACK_PROXY` | Set to `1` only when the hub binds to loopback behind the checked reverse proxy. |
| `HUB_OPENCODEX_ORIGIN` | Private loopback OpenCodex origin, for example `http://127.0.0.1:10100`. |
| `HUB_INTERNAL_ADMISSION_TOKEN` | At least 32 random bytes; use the same value as OpenCodex `OPENCODEX_API_AUTH_TOKEN`. |
| `HUB_REQUEST_COST_UNITS` | Positive integer charged when private OpenCodex accepts the request with a 2xx response. |
| `HUB_PRICING_VERSION` | Stable identifier recorded with every reservation, such as `request-v1`. |
| `HUB_ALLOW_REGISTRATION` | Set to `1` only when public self-registration is intended. It is disabled by default. |
| `HUB_SESSION_TTL_SECONDS` | Session lifetime from 300 to 2,592,000 seconds; defaults to seven days. |
| `HUB_UPSTREAM_TIMEOUT_MS` | Private OpenCodex timeout from 1,000 to 600,000 ms; defaults to 120,000 ms. |

For loopback development only, set `HUB_DEVELOPMENT=1`, use an exact loopback HTTP
`HUB_PUBLIC_ORIGIN`, and keep `HUB_HOSTNAME` on loopback. This exception is rejected on a public bind.

## Reverse proxy and firewall

For production TLS termination, bind the hub to `127.0.0.1` and set
`HUB_TRUST_LOOPBACK_PROXY=1`. The checked-in `hub/deploy/Caddyfile.example` overwrites
`X-Hubapi-Client-IP` from the direct remote address, proxies only `/hub`, `/hub/*`, and the four
allowlisted inference routes, then returns `404` for every other path. Trusted-proxy mode rejects a
non-loopback peer, a missing header, an IP chain, or a malformed IP before route dispatch. Direct
mode ignores the forwarded header.

The service-scoped `hub/deploy/hubapi-guard.nft` accepts loopback and drops non-loopback access to
the default private OpenCodex and hub ports. It does not flush the machine's firewall or install
itself. Review custom ports, run `nft --check --file`, apply the named table in a maintenance window,
then read it back with `nft list table inet hubapi_guard`. Validate the Caddy file separately with
`caddy validate`. Cloud or VPS security-group rules should expose only the chosen administration
port and HTTPS; keep ports `10100` and `10400` private.

## First administrator

There is no default account or password. Stop the hosted service, then pass a strong password on
standard input so it does not appear in process arguments:

```bash
printf '%s' "$HUB_ADMIN_PASSWORD" | bun run hub:bootstrap-admin -- --email admin@example.com
```

The command refuses to run while the database has an active hosted-service lease and refuses to
create a second bootstrap administrator.

## Start and use

Start private OpenCodex with `OPENCODEX_API_AUTH_TOKEN` set to the internal admission token, then run:

```bash
bun run hub:start
```

Open `HUB_PUBLIC_ORIGIN/hub/`. An administrator can generate a recharge-code batch; complete codes
are returned only in that response. A user redeems one code, creates a `hub_live_` API key, and uses
the public origin as the OpenAI/Anthropic-compatible Base URL.

### Task-routed models

hubapi does not add a second model router. Configure task contracts such as `coding`, `vision`,
`fast`, or `private` as aliases in the private routing core, then send that alias in the client's
`model` field. The hosted edge records and forwards the alias unchanged. It does not inspect, persist,
or classify prompt text to guess a task. The private routing core remains responsible for capability
gates, evidence-based candidate scoring, failover, and the final provider/model decision.

The proxy page reads the authenticated private `/v1/models` data-plane endpoint with the internal
admission credential. It validates and bounds the response, exposes only model IDs, the observed time,
and the upstream HTTP status, and renders an explicit empty or unavailable state. It never reads the
management API and never turns sample aliases into configured claims.

The independently served portal uses a compact 2D pixel console. Its hash routes remain inside the
hosted listener: `/hub/#dashboard` shows only the signed-in user's route, model alias, upstream status,
charge state, and non-secret terminal reason. `/hub/#proxy` shows the exact public endpoint allowlist, pricing version, honest
edge/upstream status, and copyable setup recipes for OpenAI-compatible clients, Codex CLI, and Claude
Code. The recipes use a placeholder instead of reading or retaining a real API key. `/hub/#admin` is
visible only to administrators and provides user state, aggregate integer-credit metrics, redacted
request activity, batch expiry, masked user-key and recharge-code inventory, per-user ledger readback,
key revocation, proxy-safety, and audit views. Complete keys and recharge codes are never returned by
these support views. `/hub/#security` shows the read-only account profile and lists active sessions without exposing session tokens, changes the
password only after verifying the current password, and can revoke every browser session. Operator lists use non-email display
references, and fixed management-action URLs keep reusable user identifiers out of browser URLs.

The initial pricing contract is a fixed integer amount once the private routing core accepts a request with a
2xx response. A failure before that acceptance releases the reservation. Cancellation, stream failure,
or process recovery after acceptance is conservatively charged because upstream work may already have
been consumed. An optional `Idempotency-Key` prevents a retry from forwarding or settling twice; an
accepted response is not replayed, so that retry receives `409`.

Login, registration, and recharge redemption have persistent, keyed account/network rate limits; sensitive administrator
mutations have a separate per-admin limit and audit denied attempts. A clean restart releases any
reservation that was never accepted upstream and conservatively settles an accepted pending request
before taking traffic. Request bodies must be uncompressed JSON and are held only in bounded, ephemeral
memory for fingerprinting and forwarding; they are never logged or persisted. Responses remain streamed
without whole-response buffering, and private upstream calls have a configured timeout.

## Operator runbook

### Backup and restore

Stop `hub:start` before copying the SQLite database. Verify that no active lease remains, copy the
database to owner-only storage, record a checksum, and test restoring that copy to a separate path.
To restore, keep the service stopped, preserve the failed database for investigation, place the
verified backup at `HUB_DATABASE_PATH` with owner-only permissions, then start the service and check
`/hub/health`, login, balance, and ledger readback. Never restore only a `-wal` or `-shm` sidecar.

### Secret rotation

- Rotate `HUB_INTERNAL_ADMISSION_TOKEN` together with the private OpenCodex
  `OPENCODEX_API_AUTH_TOKEN`, during a stopped maintenance window, and verify one public request.
- `HUB_DIGEST_SECRET` protects all session, public-key, recharge-code, and rate-limit digests. This
  schema has no dual-key migration. Changing it intentionally invalidates outstanding sessions,
  public API keys, and unused recharge codes. Export required accounting evidence, notify users,
  rotate while stopped, then issue replacement credentials and codes. Do not reuse the internal
  admission token as the digest secret.

### Audit retention and incident evidence

Audit events and ledger entries are append-only and are not automatically purged. Define retention,
encrypted backup, and access rules outside the application before public deployment. Preserve the
database and reverse-proxy request metadata for an incident, but never enable prompt/body, email,
full-key, session, or recharge-code logging. There is currently no supported in-app audit deletion or
multi-node archive exporter.

## Threat model and remaining limits

The edge is designed for credential theft, CSRF, session fixation, brute-force login, cross-user
object access, duplicate redemption/settlement, oversized bodies, upstream stalls, and accidental
management-route exposure. It does not make a compromised host, database plus digest secret, TLS
terminator, or private OpenCodex process trustworthy. Single-node SQLite, fixed per-upstream-accepted-request
pricing, manual backups, and manual secret rotation remain explicit phase-one limits.

## Security review status

The SimpleCard repository informed the user/card workflow under its MIT license, but its Next.js and
Spring Boot application and dependency tree are not vendored. The hubapi implementation is a
Bun-native reimplementation with separate trust boundaries. Before public deployment, run the hub
focused tests, strict typecheck, full repository tests, privacy scan, and high-severity dependency
audit, and complete TLS/reverse-proxy hardening plus a tested backup/restore exercise.
