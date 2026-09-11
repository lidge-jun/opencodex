# Remote hub: roles, sessions, and disconnection

The remote hub lets one machine hold the models and credentials while other machines
and browsers use them. Four questions come up constantly, and three of them have
answers that are easy to guess wrong.

## One port, and what runs on it

A hub's data plane is one port. Remote machines dial `hostname:port` with their own
per-client key. The hub's own processes dial `127.0.0.1:<the same port>` with no
credential, through the **loopback companion listener**:

```json
{
  "runtimeRole": "hub",
  "hostname": "100.64.0.10",
  "port": 10100,
  "unauthenticatedLoopbackListener": { "enabled": true }
}
```

`port` on that listener is optional, and its absence is the whole design. Omitted means
"bind `127.0.0.1:<proxy port>`" — the address `ocx claude`, Claude Desktop, Cursor, the
`system-env` injection and the routed vision helper already write, so nothing on the hub
has to learn a new port. Setting a `port` (`{ "enabled": true, "port": 10104 }`) still
works and puts the two surfaces on separate ports; local integrations then follow the
listener's port.

The port-less form is refused on a loopback or wildcard `hostname` — `127.0.0.1`,
`localhost`, `0.0.0.0`, `::` — because the public listener already holds that loopback
address. The refusal happens at write time and again at startup, naming the collision. On
those binds the listener is unnecessary: a loopback bind already admits local callers.

The listener carries inference wires only: `POST /v1/responses` and its WebSocket
upgrade, `POST /v1/responses/compact`, `POST /v1/messages`,
`POST /v1/chat/completions`, `POST /v1/alpha/search`, `GET /v1/models`, and the realtime
voice surface. `POST /v1/messages/count_tokens`, `/api/*`, `/healthz`, `/readyz` and the
dashboard all answer `404` there. **That is why a management read never goes to it**:
local management calls use the authenticated management surface with a management
credential. Do not propose widening the listener to `/api/*` as a fix for anything.

Changing this field needs a proxy restart — the sockets bind once at startup and the
exported client files are written from the resolved port. On a background service the command
is `ocx service restart`, which always restarts (on macOS it kickstarts an unchanged,
already-loaded job in place); `ocx service repair` would correctly no-op and leave the old
process serving. `ocx restart` is the separate verb for a proxy you started yourself.

### The hub gate on the hub's own clients

A hub does **not** rewrite its own Codex/Grok/Claude configuration unless that listener is
enabled. `ocx sync`, `ocx sync-cache`, `ocx ensure` and `ocx restore back` skip the write
and say exactly this:

> This machine is a hub; it does not rewrite its own Codex/Grok/Claude configs unless
> unauthenticatedLoopbackListener is enabled.

Read that as the gate, not as the operator's `clientIntegrations` toggle — it is claimed
only when the toggle is ON and the gate is what stopped the write. A gated `ocx ensure`
leaves an existing managed Grok block in place instead of stripping it, and a gated
`ocx restore back` reports the gate instead of blaming a competing writer. The fix is to
enable the listener and restart (`ocx service restart` on a service install), or to accept
that this hub leaves its own clients native.

### The hub's data token is not yours to produce

The hub's data-admission token provisions itself. `ocx service install` on a non-loopback
bind resolves it as: `OPENCODEX_API_AUTH_TOKEN` from the installing shell, then an existing
owner-only `service-api-token` file, then 32 fresh random bytes. The result is written
`0600` and the launch wrapper reads the file at start, so the value never enters a plist, a
unit file or argv.

Three consequences for an agent:

- **Never tell an operator to export a token before installing.** There is no such step, and
  the one time it was recommended, a *management admin* token went into
  `OPENCODEX_API_AUTH_TOKEN` and crash-looped the hub. The installer refuses an admin token
  in either place it can appear — the variable, or a reused `service-api-token` file — and
  the remedy differs: unset the variable, or delete the file and run `ocx service repair`.
  Both checks run even on a loopback bind, because the wrapper reads that file into the
  variable whatever the hostname.
- **Never suggest regenerating it to fix something.** An existing file is reused on purpose;
  replacing it invalidates every per-client key already exchanged. Rotation is
  `ocx connect rotate`'s job, on the client.
- **Never copy the file to another machine.** Each client gets its own revocable key from the
  pairing exchange.

`unsafe (file)` in the status block means the file exists with permissions the installer
will not accept. Report it and let the operator fix the permissions; do not read, print, or
rewrite the file.

### `ocx status` answers most hub questions

On a hub, `ocx status` prints a `Hub:` block: the advertised data origin and whether it
came from `hub.dataPublicOrigin` or the bind address, the loopback listener's state
(`companion` / `ported` / `off`) and port, the management ingress, the management origin,
the data token's state (`present (file)`, `unsafe (file)`, `admin-collision (file)`,
`missing` — never its value), and the invite hint. Read it before asking an operator about
ports or tokens.

The token state is always about the **file**, because the launch wrapper overwrites the
environment from it before exec. A separate sub-line reports `OPENCODEX_API_AUTH_TOKEN`
being set in the invoking shell, which decides only what a foreground `ocx start` in that
shell would admit. `admin-collision (file)` is the incident shape: that file holds the
management token, the hub fences its management API closed at boot, and the fix is to
delete the file and run `ocx service repair` — **not** to unset anything.

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

Minimum hub config for a browser-reachable hub:

```json
{
  "runtimeRole": "hub",
  "hub": { "managementPublicOrigin": "https://host.ts.net" }
}
```

A hub that also serves its own local clients adds the loopback listener above. A hub that
hands out invites also needs `hub.dataPublicOrigin` unless `http://<bind>:<port>` is
genuinely reachable from the joining machine.

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
| `ocx hub invite [--json]` | Hub-side: mint a code and print the whole `ocx connect` line for one more machine |

Connect flags: `--clients codex,claude` (which client configs to point at the hub),
`--management-url <url>` (when management lives at a different address),
`--management-transport direct|relay` (`relay` tunnels management over the data
connection when no management port can be opened), `--no-sync` (connect without pulling
the catalog), and `--catalog-timeout <seconds>` (1–120 seconds of catalog-transfer
inactivity before failing; arriving bytes reset the deadline).

`ocx gui pair` refuses an origin that is not in `hub.managementPublicOrigin` or
`corsAllowOrigins`. Grants are single-use, expire in five minutes, are origin-bound,
stored as digests, and rate-capped at 8/min. They are secrets: do not persist one.

## Inviting a machine (`ocx hub invite`)

Run on the **hub**. It prints the command for the other machine:

```bash
ocx hub invite
```

```text
# Run on the other machine:
echo '<code>' | ocx connect https://host.ts.net:8443 --management-url https://host.ts.net --pairing-code-stdin
```

Origins: data from `--data-url`, then `hub.dataPublicOrigin`, then the bind address;
management from `hub.managementPublicOrigin`. **`--management-url` is a confirmation, not an
override** — the grant records the configured management origin as its own server origin and
the exchange compares against it, so a differing value is refused with both origins named
rather than printed. `--data-url` really is an override, because nothing is bound to it.

The bind-address fallback only works when the bind is an address another machine can dial. On
a loopback or wildcard bind it would resolve to `http://localhost:<port>`, which tells the
other machine to dial itself and spends the code for nothing, so `invite` refuses and prints
the `hub.dataPublicOrigin` fix. An explicit override is never second-guessed: a loopback data
origin is legitimate over an SSH tunnel.

Every successful invite prints a `Bound browser origin:` line on stderr. A grant is bound to
one origin and a remote `ocx connect` presents `Origin: http://localhost:<its own configured
port>`, so when the bound origin is not the default the other machine must already be running
on that port. Relay that line; it is the difference between a working exchange and a spent
code.

`invite` needs no admin token and nothing exported into the shell: it drives the same
attested local route `ocx gui pair` uses, authorized by the running proxy's own attestation
secret. It requires a running hub.

It refuses **before** minting anything when the setup cannot work: `runtimeRole` is not
`hub`, `hub.managementPublicOrigin` is missing, the management origin is non-loopback
plaintext, `--data-url` is malformed, there is no running attested proxy, or — the
non-obvious one — the hub admits no loopback browser origin.

Two of those are the refusals you will actually hit. The data-origin one names which shape
the hub has (wildcard, or loopback-only) and prints both the persistent and the per-invite
fix. The browser-origin one looks like this:

```text
No loopback browser origin is admitted for pairing. Add the connecting machine's local origin:
ocx config set corsAllowOrigins '["http://localhost:10100"]'
```

`ocx connect` sends `Origin: http://localhost:<its own proxy port>` when it exchanges the
grant, and grants are origin-bound, so only `hub.managementPublicOrigin` itself or a
loopback entry of `corsAllowOrigins` can ever match. Run the command it prints rather than a
hand-written one: a whole-array set replaces the array, so the printed line carries the hub's
existing entries plus the new origin. Nothing was minted, so there is no burned code to clean
up.

`--json` emits `{ code, expiresAt, dataUrl, managementUrl, command }` with `expiresAt` as
ISO 8601; `--clients codex,claude` chooses which client configs the printed command points
at the hub. The code goes to stdout and the "secret, single-use" warning to stderr, matching
`ocx gui pair`. Treat it as a secret: five-minute TTL, one use, rate-capped. Do not persist
it, and do not echo it back into a transcript you are keeping.

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

Raw access-key creation and rotation-start return plaintext and belong outside the agent
session; follow [recipe 5](03_recipes.md#5-prepare-an-access-key-rotation-without-exposing-the-new-key)
for the human handoff and separate revocation approval. The managed `ocx connect rotate`
flow returns non-secret status and is a distinct command, not permission to invoke the raw
secret-returning endpoint from an agent tool.

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

To return the hub itself to a normal install, set `runtimeRole` to `standalone` and restart
with `ocx service restart` (or `ocx restart` for a proxy you run yourself). Leftover `hub` and
`remoteGui` blocks are inert outside the hub role.

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
