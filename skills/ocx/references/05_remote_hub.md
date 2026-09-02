# Remote hub: roles, sessions, and disconnection

The remote hub lets one machine hold the models and credentials while other machines
and browsers use them. Three questions come up constantly, and two of them have
answers that are easy to guess wrong.

## Which parts need pairing (the common misconception)

**Pairing is not how you configure a hub.** It is how a *remote browser* gets a session
when it cannot be trusted by position or identity. Configuring the hub itself — providers,
accounts, routing, keys — never requires a pairing code.

`GET /opencodex-session` mints a session on its own in two cases (`src/server/gui-session.ts`):

| Situation | What happens |
|---|---|
| API auth not required, request is loopback, origin allowed | Session minted, source `loopback`. This is the ordinary local dashboard. |
| Role is `hub`, request arrived through the trusted Tailscale ingress over HTTPS, the login is in `remoteGui.allowedTailscaleUsers`, and the browser origin is allowed | Session minted, source `tailscale-identity`. No pairing code involved. |
| Anything else | `null` — the browser gets 401 and must exchange a pairing grant at `POST /opencodex-session`. |

So a pairing code is the fallback for the third row only. If the operator is sitting at
the hub, or their Tailscale identity is on the allow-list, there is nothing to pair.

The management API has its own admission ladder, independent of the browser session
(`src/server/management-auth.ts` `resolveManagementAdmission`). In order: process-scoped
local capabilities, then the GUI-pair capability, then the admin token, then a GUI session.
An agent driving the hub over the management API uses the admin token and never touches
pairing at all.

**Answer the question directly when a human asks it:** no, the hub dashboard does not need
pairing to be set up. Pairing exists so a browser on *another* machine can get in when
neither loopback position nor Tailscale identity vouches for it.

## Roles

`runtimeRole` is one config key with three values, and it decides whether remote code runs at all.

| Role | Meaning |
|---|---|
| `standalone` (default) | No hub UI renders and no machine-plane request is issued. The feature is absent, not merely disabled — `gui/tests/api-targets.test.ts` pins zero requests at boot. |
| `hub` | Holds models and credentials. Other machines connect to it. |
| `client` | Connected to a hub. `ocx connect` puts a machine in this role. |

Minimum hub config:

```json
{
  "runtimeRole": "hub",
  "hub": { "managementPublicOrigin": "https://host.ts.net" }
}
```

`managementPublicOrigin` is the origin a browser actually reaches, which is the outside
address when a TLS terminator or reverse proxy sits in front. `/readyz` advertises it as
`managementUrl`.

Optional management-only listener:

```json
"hub": {
  "managementPublicOrigin": "https://host.ts.net",
  "managementIngress": { "enabled": true, "port": 10120 }
}
```

The socket is always bound to `127.0.0.1` — the hostname is deliberately not configurable.
Only GUI, session bootstrap, and management API routes are admitted; the data plane is not.

## Commands

Credentials are accepted **only** through stdin. The CLI says so itself: "argv and
environment credential forms are not supported." Do not construct a command that puts a
secret in argv; there is no flag for it and adding one would defeat the design.

| Command | Purpose |
|---|---|
| `ocx connect <url> --pairing-code-stdin` | Join a hub with a one-time pairing code |
| `ocx connect <url> --admin-token-stdin` | Join a hub with the hub admin token (automation) |
| `ocx connect status [--json]` | Inspect the connection |
| `ocx connect rotate --pairing-code-stdin` | Rotate this client's data key |
| `ocx connect revoke --admin-token-stdin` | Kill this client's key at the hub — works only while connected |
| `ocx disconnect [--keep-catalog]` | Restore local state and clear the connection |
| `ocx gui` | Open the dashboard |
| `ocx gui pair --origin <browser-origin>` | Issue a pairing grant for a remote browser |

Connect flags: `--clients codex,claude` (which client configs to point at the hub),
`--management-url <url>` (when management lives at a different address),
`--management-transport direct|relay` (`relay` tunnels management over the data
connection when no management port can be opened), `--no-sync` (connect without pulling
the catalog), and `--catalog-timeout <seconds>` (1–120 seconds of catalog-transfer
inactivity before failing; arriving bytes reset the deadline).

`ocx gui pair` refuses an origin that is not in `hub.managementPublicOrigin` or
`corsAllowOrigins`. Grants are single-use, expire in five minutes, are origin-bound,
stored as digests, and rate-capped at 8/min. They are secrets: do not persist one.

## Reading `ocx connect status`

Disconnected is a single line. Connected prints hub, management URL and transport,
protocol version, API key id, selected clients, and three health fields worth checking:

| Field | What a non-nominal value means |
|---|---|
| `Token file` | `owned` is nominal. `changed` means another process overwrote the token, and `disconnect` will refuse until that is resolved. |
| `Key rotation` | `recovery-required` means a rotation was interrupted. Re-run `connect rotate` to commit or abort it. |
| `Catalog` | `unsafe` means the catalog bytes are not the ones this connection wrote. |

## Key rotation is a two-step commit

Starting a rotation issues the new key while **the old key stays valid**. The dashboard
says so and offers exactly two exits: commit, or abort.

The ordering is not ceremony. If the old key died at issuance, a client that had not yet
received the new key would be disconnected — and a disconnected client cannot be given a
new key. So the contract is: apply the new key, verify the connection, then commit.

The token backup (`<tokenfile>.prev`) is not deleted while a rotation is in flight, and
commits only once both sides are confirmed to have accepted.

## Disconnection happens in two places

This is the part that is most often done halfway.

`ocx disconnect` is **local only**. It restores the pre-connect Codex config from the
journal, removes the service token, and clears the hub catalog (`--keep-catalog` keeps
it). It then tells you plainly that the hub key is still valid and must be revoked from
Integrations → API Keys.

Revocation is the other half:

- **Device still connected:** `ocx connect revoke --admin-token-stdin`, then `ocx disconnect`.
  `revoke` only works while connected, so it comes first.
- **Device lost, already disconnected, or unreachable:** delete the key in the hub
  dashboard under Integrations → API Keys.

To return the hub itself to a normal install, set `runtimeRole` to `standalone` and
restart. Leftover `hub` and `remoteGui` blocks are inert outside the hub role.

A remote browser logging itself out (`/api/session/logout`) is a third, separate action.
It ends a browser session; it does not disconnect a client or revoke a key.

### When `disconnect` refuses, that is the safety property

Do not work around these. Each one means unwinding would damage state that
`disconnect` cannot prove is safe to touch.

| Refusal | Cause |
|---|---|
| `service token ownership changed` | Another process owns the token file. Disconnecting now would unwind someone else's state. |
| `Codex routing is injected but no journal records the original state` | There is no recorded baseline, so restoring would be a guess. |
| `Codex journal ownership conflicts with the connected key` | A different client key owns the journal; that client must disconnect. |
| `Codex journal restore was partial` | A half-restore is not reported as success. |

## What to tell a human who asks

- *"Do I need to pair to set up the hub?"* No. Pairing is only for a remote browser that
  is neither on loopback nor covered by `remoteGui.allowedTailscaleUsers`.
- *"I ran `ocx disconnect`, am I done?"* Not yet — the hub key is still valid. Revoke it
  at the hub, or delete it from Integrations → API Keys.
- *"Why does rotation need two steps?"* Because the old key must outlive the moment the
  new one is issued, or a client that has not yet been updated is stranded.
- *"Why is there no remote UI on my machine?"* Expected — `runtimeRole` is not `hub`.
- *"Can I pass the pairing code as an argument?"* No. Credentials are stdin-only by design.
