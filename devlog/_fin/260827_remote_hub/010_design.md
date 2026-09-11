# 010 — Design: remote hub mode (hub / client / two-plane GUI)

Unit: 260827_remote_hub · Status: design draft (pre-audit)
Drafted by a sol-high subagent against dev @ 8b1b65b8d; every file:line claim
below re-verified by the main session on 2026-08-27.

## 0. Runtime roles

```text
standalone (default)  today's behavior, untouched — no role configured, nothing changes
hub                   full server; provider keys/OAuth/routing/usage/logs live here
client                no /v1 data plane, no provider adapters; thin loopback GUI +
                      machine integration plane; inference goes DIRECTLY to the hub
```

Client traffic never routes through the local listener — Codex/Claude talk straight to
`hub:10100/v1`. The client process is a remote control + file installer, idle otherwise.

## 1. Goals / non-goals

Goals: any machine as hub (Linux/systemd, macOS/launchd, Docker); clients keyless
(admission token only, never provider/admin credentials); single source of truth on the
hub; `ocx connect/disconnect/status`; dashboard always at localhost:10100 on clients;
remote GUI fully operable over Tailscale WITHOUT weakening the consent boundary;
injector/journal/restore reuse; in-repo (no separate repository).

Non-goals: multi-hub replication/failover; provider execution on connected clients;
public-internet exposure preset (Funnel out of scope); generic reverse proxy in the
client listener; cryptographic human-click proof (AGENTS.md already concedes a local
process can drive a browser — the enforceable contract is that admin-token alone is
never promoted to gui-session).

## 2. Architecture

```text
                              HUB (any machine)
                ┌───────────────────────────────────────┐
Codex/Claude ──▶│ /v1/* (data token: Bearer via env_key,   │
                │        or x-opencodex-api-key — #1686)   │
                │ providers · OAuth · routing · catalog  │
                │ /api/* (shared management plane)       │
                │ optional loopback mgmt ingress :10101  │◀─ tailscale serve (HTTPS)
                └──────────────────┬────────────────────┘
                                   │ tailnet
┌──────────────────────────────────┴────────────────────────────┐
│ CLIENT                                                        │
│ browser → http://localhost:10100                              │
│   ├─ shared pages  ──────────▶ hub /api/*  (direct HTTPS      │
│   │                            or fixed-target local relay)   │
│   └─ machine pages ──────────▶ localhost /api/machine/*       │
│ thin listener: GUI assets, machine API, relay; NO /v1         │
│ derived files: config.toml · opencodex-catalog.json · journal │
└───────────────────────────────────────────────────────────────┘
```

Placement: new leaf `src/client/` (connection state, catalog fetch, machine listener)
plus a narrow protocol module. Core-path rule respected: router/lifecycle/responses-core
import nothing new; hub-side activation composes in `src/server/index.ts` and must not
add an await inside the guarded synchronous window (tests/core-lab-boundary.test.ts).

## 3. Security model

### Credential classes (unchanged classes, new scoping)

| Credential | Lives | Grants | Consent authority |
|---|---|---|---|
| Provider keys / OAuth | hub only | upstream calls | — |
| Data admission token (env OPENCODEX_API_AUTH_TOKEN; per-client via config.apiKeys) | hub + that client | /v1/* only | none |
| Admin token | hub only | /api/*管理 | NEVER consent routes |
| gui-session | hub memory + browser | /api/* incl. consent routes | yes (origin+CSRF bound) |

Per-client keys ride the existing `config.apiKeys` mechanism, still exported to Codex
as `OPENCODEX_API_AUTH_TOKEN` (env_key contract unchanged) → independent rotation and
per-machine attribution. This is the LiteLLM virtual-key / sub2api admin-key split,
which the research doc grounds.

### The remote-GUI fix (the load-bearing change)

Defect: `issueGuiSession` refuses when `isApiAuthRequired(config)` and demands a
loopback Host, so a remote bind can never mint the `gui-session` principal; consent
routes 403 even with the admin token. That refusal was correct when "remote" implied
"unprotected"; hub mode makes remote-with-credentials a first-class state.

Change shape — generalize the session record, not the auth gate:

```ts
interface GuiSessionRecord {
  serverOrigin: string;    // canonical hub management origin
  browserOrigin: string;   // page that owns the session (may be http://localhost:10100)
  csrfToken: string;
  expiresAt: number;
  issuance: "loopback" | "tailscale-identity" | "pairing" | "trusted-tailnet";
}
```

Validation keeps every current predicate (destination = serverOrigin, claimed GUI
origin = browserOrigin, mutations need browser Origin + per-session CSRF), just split
across two origins instead of assuming they are equal. `requireManagementAuth` and
`managementPrincipal` keep sharing one predicate. Admin token is NEVER an exchange
credential for a session — entering it still unlocks ordinary management, and consent
routes stay 403 until a real session exists. Boundary preserved.

Issuance ladder (config-selected, strictest first):
1. loopback — today's path, unchanged.
2. tailscale-identity (recommended) — a loopback-only management ingress (:10101,
   GUI + /api only, allowlist style like loopbackRouteAllowed) fronted by
   `tailscale serve`; trust Tailscale-User-* headers ONLY on that ingress (Tailscale
   strips inbound spoofs and requires a loopback backend — official docs). Browser gets
   real HTTPS (ts.net cert), so secure-context features work. Identity is necessary
   but NOT sufficient: the header proves who, an operator-configured
   `remoteGui.allowedTailscaleUsers` allowlist decides whether that who may mint a
   session. On a shared tailnet, an empty allowlist means nobody mints remotely.
3. pairing — `ocx gui pair` on the hub prints a single-use, short-TTL, origin-bound
   grant that can only mint a session. For generic HTTPS terminators.
4. ~~insecure-http pairing~~ — REMOVED. An earlier revision let the rung-3 grant travel
   over a plain-HTTP tailnet origin behind `remoteGui.allowInsecureHttp`, as the
   "don't over-harden" valve for a private tailnet with a sole operator. A reusable
   grant on plaintext HTTP is captured verbatim by anything with tailnet reach, and an
   opt-in flag records a risk the operator cannot actually bound, so the flag was doing
   no security work. A private tailnet is not a private wire.

   The valve the user asked for is served by rung 3 over `tailscale serve`, which
   terminates HTTPS for exactly this deployment and needs no plaintext hop. Non-loopback
   plaintext HTTP now carries no grant, session, admin token, or client key — only an
   unauthenticated error naming the required scheme.

   Audit note (blocker 1, folded): the earlier "trusted-tailnet" variant that minted
   sessions from Host/Origin alone is DROPPED — headers are forgeable by anything with
   TCP reach, so it would have granted consent routes with zero credential, strictly
   weaker than the admin token. Issuance always consumes a real credential; only the
   transport hardening is relaxable, and the relaxation is loudly warned.

Supporting changes: operator-configured `hub.managementPublicOrigin` (never derive the
public origin from forwarding headers — fixes today's TLS-terminator mismatch);
management CORS must allow x-opencodex-api-key / x-opencodex-gui-origin /
x-opencodex-csrf-token for allowlisted origins with exact-origin ACAO (currently
managementCorsHeaders calls corsHeaders() without the request, so the echo path never
engages — verified src/server/auth-cors.ts:199-206. x-opencodex-api-key is already in
STATIC_ALLOWED_REQUEST_HEADERS; the two headers genuinely missing from preflight are
x-opencodex-gui-origin and x-opencodex-csrf-token, read at management-auth.ts:469/475).

Secure-context reality (research doc): plain-HTTP remote origins lose crypto.subtle
(used in gui/src/log-conversation-id.ts:26) and async clipboard. Two-plane helps here:
the PAGE stays on http://localhost:10100 (a secure context), so local-plane features
keep working even when the hub side is plain HTTP via the relay.

### Threat summary

Compromised client → its own admission token + local files; NOT provider keys, admin
token, or other clients' keys. Compromised hub → everything (accepted: that's what
"hub" means; same posture as LiteLLM/sub2api). Tailnet membership ≠ admin identity:
data plane still needs the token, management still needs admin-token/session.

## 4. ocx connect (client mode)

```text
ocx connect <url> [--management-url <url>] [--pairing-code-stdin | --admin-token-stdin]
                  [--clients codex,claude] [--management-transport direct|relay] [--no-sync]
ocx disconnect [--keep-catalog]      ocx connect status [--json]
```

No `--token <value>` flag (argv/history leak). Local state = dumb pointer:
`{ serverUrl, managementUrl?, tokenEnv, selectedClients, managementTransport,
connectedAt, protocolVersion }`. Existing local provider config stays dormant →
disconnect is fully reversible offline (restore from injector journal, no hub needed).

Connect is a transaction: validate URL → GET /readyz (version + protocol + advertised
managementUrl) → validate data credential → download catalog → injector preflight →
atomic catalog write → inject → persist state. Any failure before the end leaves the
machine untouched.

Catalog: add data-authenticated `GET /v1/catalog` (same serializer as /api/catalog,
ETag/If-None-Match, bounded body) — a client must not hold the management token just to
sync models. Injector: generalize input to
`{ baseUrl, requiresAdmissionToken, tokenEnv }` — the loopback/non-loopback split in
inject.ts already carries 90% of this. `ocx sync` becomes mode-aware and NEVER falls
back to local provider discovery in client mode. Management CLI (`ocx models` 등) rides
RuntimeApiDeps.baseUrl toward the hub. Claude: launcher-scoped ANTHROPIC_BASE_URL +
ANTHROPIC_AUTH_TOKEN first; persistent settings.json mutation stays a machine-plane
opt-in with ownership records.

## 5. Machine-plane listener (client, loopback-only)

Explicit allowlist, default-404 (same failure mode as loopbackRouteAllowed):
/healthz · /readyz · GET /api/machine/status · GET /api/machine/clients ·
POST /api/machine/sync · GET/POST /api/machine/shim · POST /api/machine/disconnect ·
POST /api/machine/hub-relay/* (opt-in only).
Mutations need local gui-session + CSRF (auto-minted on loopback, today's flow).

Relay constraints (it is NOT a proxy): fixed destination = client.managementUrl;
path allowlist (/api/* + session bootstrap); no caller-supplied host/scheme; redirects
rejected; hop-by-hop headers stripped; management size caps; nothing logged.

GUI: replace the single same-origin `apiBase` assumption (gui/src/api.ts needsApiAuth
refuses cross-origin credentials today) with explicit shared/machine targets; pages map
to planes; hub-down leaves the shell + machine pages alive with one stable offline state.

## 6. Deployment recipes

- Oracle/systemd & Mac/launchd: existing `ocx service install` path; hostname =
  tailscale IP; data token via env or OCX_API_TOKEN_FILE (existing mechanism,
  src/lib/service-secrets.ts); management ingress loopback + tailscale serve; never
  open :10100 on the cloud firewall.
- Docker: non-root; persistent ~/.opencodex volume; token as runtime secret via
  OCX_API_TOKEN_FILE; tailscale sidecar or host TLS; /healthz + /readyz probes.
- Headless OAuth: oauthOpenBrowser:false → dashboard shows the auth URL → user finishes
  in any browser → POST /api/oauth/login/code (both halves already exist; RFC 8628-shaped).

## 7. Failure modes (contract)

Hub down → clear CLI errors, machine GUI alive, NO local-provider fallback · catalog
refresh failure → keep last-known-good + stale age · token rotation → 401 with named
cause, token never printed · protocol major mismatch → refuse before any local write ·
disconnect-while-hub-down → journal-based offline restore · plain-HTTP → relay + banner.

## 8. Roadmap → 020_roadmap.md (6 dependency-ordered phases, one PABCD cycle each)

### Phase-2 consumer chain (audit blocker 3, folded)

GuiSessionRecord.origin is not private state. The serverOrigin/browserOrigin split must
enumerate and update, in doc 040 before Phase 2's P:
- src/server/index.ts:1609-1614 serveSessionBootstrap + the opencodex-session-origin
  meta-tag contract in gui-static serving;
- gui/src/api.ts:94-96 and 154-156 (memorySessionOrigin validation,
  SESSION_REBOOTSTRAP_PATH reader);
- tests/native-profile-route-security.test.ts:136;
- tests/server-management-auth.test.ts:897 ("non-loopback binding never issues a GUI
  session from a forged loopback Host") must stay green: every new issuance mode is
  strictly config-opt-in, defaults byte-identical to today.

### /v1/catalog admission contract (audit blocker 4, folded)

/v1/catalog uses the data-plane admission matrix as-is: x-opencodex-api-key OR a
Bearer that is one of our admission secrets (AUTH_MATRIX, auth-cors.ts:397-406 — the
#1686 substitution rule; the injector's env_key emits Bearer, inject.ts:231-237).
No Direct-passthrough route exists on this path, so no reservation conflict; the only
integration concern is route ordering ahead of the unknown-/v1 JSON-404 guard
(index.ts:1604).

## 9. Open questions for the maintainer

1. First release: require tailscale-identity/pairing for remote sessions, trustTailnet
   as advanced opt-in — or ship trustTailnet as the blessed tailnet default?
2. Per-client config.apiKeys mandatory at connect, or recommended-only?
3. One public URL for /v1+/api, or separate managementUrl acceptable?
4. /v1/catalog as the data-authenticated contract vs a scoped /api/catalog exception?
5. Hub mode: disable local Codex/Claude integration by default ("hub is also a client"
   as explicit switch)?
6. Session TTL: keep 5-minute GUI sessions or add renewable browser grants for remote?
7. Plain-HTTP relay in the first stack, or hardening phase after HTTPS-direct is proven?

## Riskiest three decisions

Remote session issuance without weakening the consent principal; browser/server origin
split across direct+relay transports; injector generalization without regressing
journal/restore ownership.
