# 040 — Phase 2: remote GUI session issuance and management CORS

Unit: `260827_remote_hub` · Branch: `codex/remote-hub-design` · Phase: 2 · Status: diff-level plan · Work class: C4

> **SECURITY REVIEW REQUIRED.** This phase changes authentication, session issuance,
> origin binding, CSRF enforcement, CORS, and a consent-bearing principal. It must receive
> the explicit security review required by `AGENTS.md` and `MAINTAINERS.md` before merge.

## 1. Outcome and non-negotiable boundary

Remote hub dashboards can obtain an origin-bound `gui-session` through one of three
evidence paths, ordered from strongest automatic path to explicit opt-in:

1. `loopback` — current behavior, unchanged and fixed at five minutes.
2. `tailscale-identity` — trusted Tailscale Serve ingress plus exact
   `remoteGui.allowedTailscaleUsers` membership.
3. `pairing` — a short-lived, origin-bound, single-use grant printed by `ocx gui pair`,
   transmitted only over loopback or authenticated HTTPS.

**There is no fourth path.** A previous revision of this document defined
`insecure-http-pairing`: the same reusable grant over non-loopback plaintext HTTP,
gated behind `remoteGui.allowInsecureHttp === true`. That path is removed, not
merely discouraged.

Operator opt-in does not defeat a passive network observer or an on-path attacker.
A grant crossing plaintext HTTP is captured verbatim, and the session it mints is
reusable. An opt-in flag records that the operator accepted a risk they cannot
actually bound, so the flag was doing no security work.

A "bootstrap over HTTP, then upgrade to HTTPS" variant was considered and rejected:
the plaintext hop has no trust anchor, so an on-path attacker substitutes its own
valid HTTPS origin and the upgrade authenticates the attacker. An upgrade is only
admissible when the HTTPS origin is already known to the client out of band, the
scheme upgrade stays on the same host, certificate validation is ordinary, and no
authority is derived from a redirect.

Non-loopback plaintext HTTP therefore carries no grant, no session, no admin token,
and no client key. What it may carry is an unauthenticated error naming the required
scheme. Nothing else.

The admin token remains an ordinary management principal. It cannot create a pairing grant,
is never accepted by the session bootstrap/exchange endpoint, is never re-labeled as
`gui-session`, and consent routes continue to reject it. `ocx gui pair` uses an attested,
process-bound, operation-only capability to create a separate one-time credential;
consumption of that credential is the only pairing exchange.

## 2. Threat model and must-pass controls

### Assets

- Provider/OAuth credentials and hub-wide config.
- Admin token, GUI session token, CSRF token, and pairing grant.
- Consent-bearing actions guarded by `principal === "gui-session"`.
- Tailscale identity headers and the configured public management origin.

### Entrypoints and attackers

- Browser navigation/fetch to `/opencodex-session`.
- Management preflight and `/api/*` requests.
- Local `ocx gui pair` attestation and operation-capability request.
- Anonymous tailnet peer, allowlisted tailnet peer, process holding only the data key,
  process holding only the admin token, compromised browser origin, replay attacker, and a
  direct caller spoofing `Tailscale-User-*` against the public listener.

### Trust boundaries and controls

- Browser origin and server destination are separate facts; neither is inferred from the
  other.
- Tailscale headers are trusted only when the listener supplies an unforgeable
  `trustedTailscaleIngress: true` context. Direct/public-listener headers are ignored.
- An empty/missing `allowedTailscaleUsers` list authorizes nobody remotely.
- Pairing grants are stored only as SHA-256 digests, capped, expire after five minutes,
  are deleted before session minting, and are never logged or returned again. They are not
  bound to or invalidated with any data key.
- Pairing-grant creation accepts only a short-lived capability bound to the exact runtime
  PID, port, method, path, nonce, expiry, and canonical browser origin. The reusable admin
  token and every other management principal are rejected on that route.
- Remote sessions use a separate 12-hour sliding TTL and renew only after the complete
  destination + browser-origin + CSRF predicate succeeds. Failed requests never renew.
- Plain non-loopback HTTP is denied for all automatic issuance and for pairing unless the
  explicit opt-in is true. The opt-in does not relax origin, grant, CSRF, or replay checks.
- `requireManagementAuth` and `managementPrincipal` consume one shared admission result;
  there is no second “token exists in map” predicate that can disagree with authorization.

## 3. IN / OUT

### IN

- `GuiSessionRecord.serverOrigin` / `browserOrigin` split and full server/GUI consumer chain.
- Config validation for `hub.managementPublicOrigin`,
  and `remoteGui.allowedTailscaleUsers`.
- Automatic loopback and trusted-Tailscale issuance; pairing grant creation and exchange.
- Separate loopback/remote TTLs and sliding renewal for remote sessions.
- Exact management CORS header widening for GUI-origin and CSRF headers.
- CLI `ocx gui pair --origin <browser-origin>` grant creation through the existing
  runtime-attestation pattern; no
  grant or reusable admin credential in argv, config, disk, logs, or shell history.
- Backend and GUI regressions for every positive and negative issuance path.

### OUT

- The production loopback-only Tailscale Serve management listener and deployment recipe
  (Phase 5). Phase 2 implements and tests the trusted-ingress policy through an explicit
  request context; the public listener always passes `false` until Phase 5 supplies the
  dedicated listener.
- Client machine listener, shared/machine API target routing, fixed-target relay, pairing
  form/banner, and hub-down UI (Phase 4). Phase 2 establishes the session wire contract the
  Phase 4 UI consumes.
- Per-client data-key issuance, `serviceApiTokenFilePath` writes/deletes, connect state,
  catalog installation, and usage filtering (Phase 3/4).
- Any usage mirroring. Phase 4 reads the hub's `apiKeyId` slice while connected and the
  local `usage.jsonl` while standalone; traffic is rendered from the store that served it.
- Cookies, JWTs, persisted refresh tokens, trusted-Host-only issuance, Funnel/public
  internet exposure, or a generic reverse proxy.
- Rate-limit policy beyond bounded grant/session maps; Phase 6 adds operational rate limits.
- Any import into `src/router.ts`, `src/server/lifecycle.ts`, or
  `src/server/responses/core.ts` from the new GUI-session module.

## 4. Config contract

```ts
// src/types/config.ts
export interface OcxHubConfig {
  managementPublicOrigin?: string;
}

export interface OcxRemoteGuiConfig {
  allowedTailscaleUsers?: string[];
}

export interface OcxConfig {
  hub?: OcxHubConfig;
  remoteGui?: OcxRemoteGuiConfig;
}
```

Validation rules:

- Remote issuance requires `runtimeRole === "hub"`; config keys may round-trip before the
  role is activated, but they grant nothing in standalone/client roles.
- `hub.managementPublicOrigin` is a canonical `http:` or `https:` origin with no userinfo,
  non-root path, query, or fragment. Persist the normalized `URL.origin` spelling.
- `remoteGui.allowedTailscaleUsers` contains at most 64 unique, trimmed, non-empty strings,
  each at most 320 UTF-8 bytes and containing no ASCII control character. Matching is exact
  after trim; no substring/domain matching.
- `remoteGui.allowInsecureHttp` no longer exists. A persisted `true` from a
  pre-release tree is not honored: it is dropped with a warning naming the key, and
  remote issuance continues under the loopback/HTTPS-only rule. A config key cannot
  re-enable a transmission path this design removed.
- A malformed live candidate is rejected with its full config path. A malformed persisted
  optional block degrades to remote issuance disabled while preserving providers, accounts,
  and API keys, and emits a diagnostic that never repeats the malformed value.
- Browser origins eligible for a remote session must equal
  `hub.managementPublicOrigin` or an exact canonical entry already present in
  `corsAllowOrigins`. Pairing cannot create an origin allowlist bypass.

## 5. Session and issuance contract

### 5.1 Records and TTLs

```ts
export type GuiSessionIssuance =
  | "loopback"
  | "tailscale-identity"
  | "pairing"
  ;

export interface GuiSessionRecord {
  serverOrigin: string;
  browserOrigin: string;
  csrfToken: string;
  expiresAt: number;
  issuance: GuiSessionIssuance;
}

export interface GuiSessionBootstrap extends GuiSessionRecord {
  token: string;
}

export const LOOPBACK_GUI_SESSION_TTL_MS = 5 * 60_000;
export const REMOTE_GUI_SESSION_TTL_MS = 12 * 60 * 60_000;
export const GUI_PAIRING_GRANT_TTL_MS = 5 * 60_000;
```

`loopback` sessions retain the current fixed five-minute expiry and silent rebootstrap.
The three remote issuance values receive `now + REMOTE_GUI_SESSION_TTL_MS`; each fully
authorized management request moves expiry to `now + REMOTE_GUI_SESSION_TTL_MS`. The
session limit remains 128. Renewal does not change the token or CSRF token.

### 5.2 Origin predicate

For a session-bearing management request:

```text
destination origin from the actual request == session.serverOrigin
X-OpenCodex-GUI-Origin                 == session.browserOrigin
Origin absent only for safe same-browser reads; when present it == session.browserOrigin
mutation Origin                         == session.browserOrigin
mutation X-OpenCodex-CSRF-Token         == session.csrfToken
```

For cross-origin remote reads the browser sends `Origin`, and it must match. The legacy
Origin-absent allowance remains only for safe `GET`/`HEAD` requests carrying a session token
and claimed GUI origin; it never authorizes a mutation.

`managementRequestOrigin` uses the observed loopback origin for loopback Host values. For a
non-loopback hub request it prefers configured `hub.managementPublicOrigin`; otherwise it
keeps today's observed-origin behavior. It never reads forwarding headers.

The Phase-1 `readyProtocolMetadata(config, req)` consumer follows the same rule: configured
`hub.managementPublicOrigin` wins for hub readiness metadata, with observed request origin
used only when the setting is absent.

### 5.3 Bootstrap meta consumer chain

The compatibility meta name `opencodex-session-origin` remains and now explicitly means
`browserOrigin`. Add `opencodex-session-server-origin` for the destination binding:

```html
<meta name="opencodex-session-token" content="…">
<meta name="opencodex-session-csrf" content="…">
<meta name="opencodex-session-origin" content="https://browser.example">
<meta name="opencodex-session-server-origin" content="https://hub.example.ts.net">
```

Full consumer chain required in this phase:

- `src/server/index.ts:1608-1614`: GET/POST bootstrap routing and session candidate.
- `src/server/gui-static.ts:68-74,102-105`: escaped meta serialization.
- `gui/src/api.ts:93-110`: initial injected-session read and validation.
- `gui/src/api.ts:143-160`: `SESSION_REBOOTSTRAP_PATH` response parsing.
- `gui/src/api.ts:188-199`: attach a session only when request destination equals
  `memorySessionServerOrigin`; send `memorySessionBrowserOrigin` in the GUI header.
- `tests/native-profile-route-security.test.ts:136-160`: native mutation remains session
  + browser-origin + CSRF gated.
- `tests/server-management-auth.test.ts:790-898`: bootstrap/meta behavior and the exact
  non-loopback forged-Host regression at line 897.

The GUI accepts a bootstrap only when `browserOrigin === window.location.origin` and
`serverOrigin === new URL(bootstrapResponse.url).origin` (or the same-origin document
origin during initial injection). Failure clears all in-memory session fields. Tokens remain
memory-only and are never written to web storage.

### 5.4 Issuance routes

- `GET /opencodex-session`
  - loopback request: current auto-issuance.
  - trusted Tailscale ingress: read `Tailscale-User-Login`; require HTTPS public origin,
    exact allowlist membership, and an allowed browser origin; issue
    `tailscale-identity`.
  - public listener with spoofed Tailscale headers: no session.
- `POST /api/gui/pairing-grants`
  - exact operation-capability endpoint used by local `ocx gui pair`; it does not accept
    admin-token, gui-session, local-read, provider-reload, restart, or data-key authority.
  - bodyless. The canonical browser origin is carried in a dedicated header and is included
    in the HMAC capability payload, so a body/header substitution cannot retarget the grant.
  - returns `{grant, browserOrigin, serverOrigin, expiresAt}` once; response has
    `Cache-Control: no-store` and no grant digest.
- `POST /opencodex-session`
  - strict body `{ "grant": "…" }`, 4 KiB maximum, unknown fields rejected.
  - requires an `Origin` matching the grant's `browserOrigin`; the grant is the only
    credential accepted. Admin/data/session credentials in headers do not substitute.
  - Loopback and authenticated HTTPS issue `pairing`. A non-loopback plaintext HTTP
    request is refused **before** the grant is read, so a captured request cannot even
    consume the grant as a denial-of-service. The grant is consumed before minting;
    all replays fail.
  - Phase 4's fixed-target relay path allowlist admits this exact POST exchange in addition
    to GET bootstrap and forwards the browser's `Origin` header verbatim; no other
    non-`/api/*` method/path is widened.

`ocx gui pair --origin <browser-origin> [--json]` requires an explicit `--origin`; there is
no config-derived or localhost default. It resolves the identity-checked
runtime, verifies the `/healthz` challenge proof, rechecks PID/port, derives the one-operation
capability from the protected runtime attestation secret, and POSTs once. It prints the grant
exactly once to stdout and never accepts a grant/token argument. JSON output is intended for
an immediately consuming operator tool and carries the same no-persistence warning. CLI
error paths redact response bodies containing a grant.

## 6. Management CORS contract

`managementCorsHeaders` currently calls `corsHeaders()` without the request
(`src/server/auth-cors.ts:199-206`), so it can echo an allowed origin but cannot include the
two GUI session headers in preflight. Keep the existing management header set and append
exactly:

```text
X-OpenCodex-GUI-Origin, X-OpenCodex-CSRF-Token
```

Do not route management preflight through data-plane dynamic vendor-header echo. An allowed
origin receives exact-origin ACAO and the fixed header set; a rejected origin remains 403.
No `Access-Control-Allow-Credentials` is added because authentication is an explicit header,
not a cookie.

## 7. Diff-level file-change map

All paths below exist in the current tree except files marked **NEW**.

| Action | Exact path | Diff-level change |
|---|---|---|
| MODIFY | `src/types/config.ts` | Add `OcxHubConfig`, `OcxRemoteGuiConfig`, and optional `hub`/`remoteGui` fields. Extend the Phase-1 role type only by reference, not by new values. |
| MODIFY | `src/config.ts` | Add strict nested schemas, canonical-origin/user-list validation, cross-field diagnostics, and persisted malformed-block degradation that preserves unrelated config. |
| MODIFY | `src/remote/protocol.ts` | Consume `hub.managementPublicOrigin` in `readyProtocolMetadata(config, req)` so configured origin wins and observed request origin is the fallback. Preserve the Phase-1 wire shape and parser. |
| NEW | `src/lib/gui-pair-capability.ts` | Own v1 method/path/header constants and HMAC create/verify functions bound to nonce, expiry, canonical browser origin, PID, and port. It accepts only the existing local-attestation secret shape. |
| NEW | `src/server/gui-session.ts` | Own session/grant records, constants, bounded maps, digest-only grant storage, issuance policy, grant consumption, shared request admission predicate, and sliding renewal. No provider/router/Lab imports. |
| MODIFY | `src/server/management-auth.ts` | Replace private `origin` records and duplicate authorization/principal checks with the shared GUI-session module. Preserve exported `issueGuiSession` as the loopback-compatible facade. Add pairing-grant state and exact `gui-pair-capability` principal/replay handling without changing admin-token initialization. |
| MODIFY | `src/server/auth-cors.ts` | Prefer configured hub public origin only for non-loopback management requests; add exact fixed management preflight headers and exact-origin ACAO. Do not change data-plane CORS or credential admission. |
| MODIFY | `src/server/index.ts` | Pass `(config, req)` to the `/readyz` protocol metadata builder so `hub.managementPublicOrigin` reaches the response; advertise GUI-pair capability v1 in `/healthz`; mount exact pairing-grant creation after capability admission, mount GET/POST bootstrap before GUI fallback, pass `trustedTailscaleIngress: false` on the public/ordinary loopback listeners, and preserve the line-1604 unknown-`/v1` guard. Do not make `startServer` async or add an await in its synchronous activation window. |
| MODIFY | `src/server/proxy-liveness.ts` | Add optional `guiPairCapability` to the existing health identity projection so the local client can fail closed against an old/foreign listener without changing required liveness identity fields. |
| MODIFY | `src/server/gui-static.ts` | Serialize escaped browser/server origin meta tags; keep `opencodex-session-origin` as browser-origin compatibility metadata. |
| NEW | `src/cli/gui.ts` | Own `runGuiCommand(args, deps)`: existing no-subcommand open behavior plus `pair`; require exactly one explicit `--origin`, parse `--json` strictly, and emit the one-time grant. |
| NEW | `src/cli/gui-pair-client.ts` | Mirror the existing bound restart/provider-reload client pattern: read runtime identity, challenge `/healthz`, verify proof/capability version, recheck the target, derive the browser-origin-bound capability, POST once, and return a redacted typed result. |
| MODIFY | `src/cli/dispatch.ts` | Delegate the current inline `gui` runner to `runGuiCommand`, passing existing open/start dependencies; do not duplicate live-proxy discovery. |
| MODIFY | `src/cli/registry.ts` | Change usage to `ocx gui [pair --origin <browser-origin> [--json]]` and document that pairing output is secret and single-use. |
| MODIFY | `src/cli/help.ts` | Update the curated GUI command line so registry/help parity remains green. |
| MODIFY | `gui/src/api.ts` | Split memory browser/server origins, validate both meta sources, scope token attachment to the server origin, keep browser origin in the GUI header, and clear all four session values atomically. No web-storage persistence. |
| MODIFY | `tests/config.test.ts` | Extend sibling config tests for valid HTTPS, explicit HTTP opt-in, invalid origin components, duplicate/empty/oversize Tailscale users, malformed persisted block preservation, and non-hub inertness. |
| MODIFY | `tests/server-management-auth.test.ts` | Extend the primary auth suite for every issuance/expiry/replay/origin/CSRF/admin negative; preserve the line-897 forged-Host test unchanged in meaning. |
| MODIFY | `tests/native-profile-route-security.test.ts` | Update session fixture fields and prove native consent mutations still reject admin, wrong browser origin, wrong server destination, absent CSRF, and accept only the full remote-session predicate. |
| MODIFY | `tests/server-auth.test.ts` | Extend management preflight tests for exactly the two added headers, allowed/rejected origins, and no data-plane header-policy drift. |
| MODIFY | `tests/server-live.test.ts` | Extend `/readyz` coverage so configured `hub.managementPublicOrigin` wins over the observed origin and absence falls back to the observed origin; extend `/healthz` capability metadata coverage for GUI-pair v1 while keeping readiness/session secrets absent. |
| MODIFY | `tests/proxy-liveness.test.ts` | Extend health identity fixtures for optional GUI-pair capability detection and prove a foreign/malformed body cannot become an attested target. |
| NEW | `tests/gui-pair-capability.test.ts` | Characterize payload binding, wrong method/path/origin/PID/port, malformed nonce/expiry, constant-time mismatch, and expiration for the operation capability, following `tests/local-management-capability.test.ts` and `tests/system-restart-contract-security.test.ts`. |
| NEW | `tests/gui-pair-client.test.ts` | Characterize attestation, PID/port recheck, capability-version refusal, bodyless POST headers, one-attempt behavior, and redacted transport failures, following `tests/system-restart-client.test.ts` and `tests/local-provider-reload-client.test.ts`. |
| MODIFY | `tests/cli-dispatch.test.ts` | Extend the existing GUI runner coverage for default open vs `pair`, remote API failure, and exit codes. |
| MODIFY | `tests/cli-registry.test.ts` | Keep registry/dispatch/help parity and assert the GUI usage shape from registry values. |
| MODIFY | `tests/cli-help.test.ts` | Extend real CLI help coverage for `ocx gui pair`; do not spawn a live pairing request. |
| MODIFY | `gui/tests/api-auth-memory.test.ts` | Extend in-memory auth sibling tests for two-origin meta validation, destination-scoped attachment, remote CSRF headers, rejection/clear, and silent renewal. |
| MODIFY | `gui/tests/api-auth-deadline.test.ts` | Update bootstrap fixtures to both origins and prove timeout/watchdog behavior still settles without credential prompts or stale-session reuse. |

No pairing form/component, locale file, docs-site page, or generated GUI output is touched in
this phase. If usable pairing requires visible UI before Phase 4, that is a scope expansion
and must be approved/amended before adding component or i18n paths.

## 8. New and changed signatures

```ts
// src/lib/gui-pair-capability.ts
export const GUI_PAIR_METHOD = "POST";
export const GUI_PAIR_PATH = "/api/gui/pairing-grants";
export const GUI_PAIR_CAPABILITY_VERSION = "v1";

export function createGuiPairCapability(
  secret: string,
  nonce: string,
  method: string,
  path: string,
  browserOrigin: string,
  pid: number,
  port: number,
  expiresAt: number,
): string | null;

export function verifyGuiPairCapability(
  secret: string,
  nonce: string | null,
  method: string,
  path: string,
  browserOrigin: string | null,
  pid: number,
  port: number,
  expiresAt: number,
  capability: string | null,
  now?: number,
): boolean;

// src/server/gui-session.ts
export interface GuiSessionState {
  sessions: Map<string, GuiSessionRecord>;
  pairingGrants: Map<string, GuiPairingGrantRecord>; // key is SHA-256 digest
}

export interface GuiSessionRequestContext {
  trustedTailscaleIngress: boolean;
  now?: number;
}

export type GuiSessionAdmission =
  | { ok: true; principal: "gui-session"; session: GuiSessionRecord }
  | { ok: false; reason: "missing" | "expired" | "server-origin" | "browser-origin" | "csrf" };

export function issueGuiSession(
  req: Request,
  config: OcxConfig,
  state: GuiSessionState,
  context?: GuiSessionRequestContext,
): GuiSessionBootstrap | null;

export function createGuiPairingGrant(
  browserOrigin: string,
  config: OcxConfig,
  state: GuiSessionState,
  now?: number,
): { grant: string; browserOrigin: string; serverOrigin: string; expiresAt: number };

export function consumeGuiPairingGrant(
  req: Request,
  body: unknown,
  config: OcxConfig,
  state: GuiSessionState,
  now?: number,
): GuiSessionBootstrap | null;

export function authorizeGuiSessionRequest(
  req: Request,
  config: OcxConfig,
  state: GuiSessionState,
  now?: number,
): GuiSessionAdmission;

// src/server/management-auth.ts — public facade stays source-compatible
export type ManagementPrincipal =
  | "admin-token"
  | "gui-session"
  | "gui-pair-capability"
  | "local-read-capability"
  | "local-provider-reload-capability"
  | "system-restart-capability";

export function issueGuiSession(
  req: Request,
  config: OcxConfig,
  state: ManagementAuthState,
  context?: GuiSessionRequestContext,
): GuiSessionBootstrap | null;

// src/cli/gui.ts
export interface GuiCommandDeps extends RuntimeApiDeps {
  openDefaultGui: () => Promise<number>;
  loadConfig: () => OcxConfig;
}
export function runGuiCommand(args: string[], deps: GuiCommandDeps): Promise<number>;

// src/cli/gui-pair-client.ts
export type GuiPairRequestResult =
  | { kind: "created"; grant: string; browserOrigin: string; serverOrigin: string; expiresAt: number }
  | { kind: "unavailable"; reason: "unattested-target" | "runtime-mismatch" | "attestation" | "capability" | "transport" | "rejected" };

export function requestBoundGuiPairingGrant(
  target: LiveProxy,
  browserOrigin: string,
  deps?: GuiPairClientDeps,
): Promise<GuiPairRequestResult>;
```

`requireManagementAuth` and `managementPrincipal` keep their public signatures. Internally
they call one `resolveManagementAdmission(req, ...)` result; a WeakMap keyed by the exact
`Request` may carry that result from the gate to principal projection so successful remote
sessions renew at most once per request.

## 9. Acceptance criteria with activation grounding

| ID | Constructible activation scenario | Required result / oracle |
|---|---|---|
| P2-A01 | Existing loopback config, GET page/bootstrap with loopback Host. | Session issues with equal server/browser origins, `issuance: loopback`, and exactly five-minute fixed expiry; current silent rebootstrap stays green. |
| P2-A02 | Current `remoteConfig()` and forged loopback Host on the public non-loopback bind (`tests/server-management-auth.test.ts:891-898`). | `issueGuiSession(...) === null`; this row remains green without adding config or trusted context. |
| P2-A03 | Hub config + allowed Tailscale login + HTTPS public origin, but direct/public listener context and spoofed `Tailscale-User-Login`. | No session. Header presence alone never activates identity issuance. |
| P2-A04 | Same request through `trustedTailscaleIngress: true`, exact allowlisted login, and allowed browser origin. | `tailscale-identity` session with separate origins where applicable and 12-hour expiry. |
| P2-A05 | Trusted ingress with empty list, nonmember, whitespace variant, HTTP public origin, standalone role, or client role. | No remote session for every branch; loopback behavior remains independent. |
| P2-A06 | Local CLI resolves the live runtime, verifies its challenge proof/capability version, rechecks PID/port, and POSTs a valid origin-bound capability. | One grant returned with 5-minute expiry/no-store; state stores only its digest; no session exists yet. |
| P2-A07 | Call grant creation with admin token, GUI session, data key, wrong/replayed/expired capability, changed PID/port/origin, or an origin outside public origin/`corsAllowOrigins`. | 403/401 as appropriate; no grant/session state change. Admin authority cannot reach grant creation. |
| P2-A08 | HTTPS POST bootstrap with fresh grant and exact `Origin`. | Grant is deleted and one `pairing` session is returned with both origin meta values. |
| P2-A09 | Replay consumed grant; use expired grant, wrong Origin, wrong server destination, data key, admin token, or session token in place of grant. | No session for every case; replay and alternate credentials cannot enter the exchange branch. |
| P2-A10 | Non-loopback HTTP pairing exchange, with and without a legacy persisted `remoteGui.allowInsecureHttp: true`. | Refused in both cases, before the grant is read, so the grant survives for a later HTTPS exchange. The legacy key is dropped with a warning and grants nothing. Automatic Tailscale issuance remains refused on HTTP. |
| P2-A11 | Authorized remote safe read immediately before expiry. | Full origin predicate passes and expiry slides to `now + 12h`; token/CSRF unchanged. |
| P2-A12 | Wrong destination, wrong claimed browser origin, wrong browser `Origin`, absent/wrong CSRF mutation, and an expired session. | 401 and expiry remains unchanged/deleted as applicable; principal is never projected as `gui-session`. |
| P2-A13 | Admin token calls ordinary management, pairing-grant creation, bootstrap exchange, and then a consent route; valid remote GUI session calls ordinary/consent routes with correct CSRF. | Admin remains ordinary management-capable but the other three are refused; remote session reaches consent route. No admin-to-grant or admin-to-session exchange exists. |
| P2-A14 | Serve initial GUI HTML and dedicated bootstrap for same-origin and two-origin fixtures. | Escaped meta contains compatibility browser origin plus new server origin; no raw attribute injection. |
| P2-A15 | GUI loads valid two-origin meta, then calls the bound server and an evil third origin. | Session headers attach only to bound server; evil origin receives no token/CSRF and triggers no admin prompt. |
| P2-A16 | GUI receives mismatched browser origin, mismatched response/server origin, missing meta, or a failed renewal. | All in-memory session fields clear atomically; no web-storage write and no stale header reuse. |
| P2-A17 | Allowed management OPTIONS requests GUI-origin + CSRF headers; repeat from rejected origin and request an unrelated custom header. | Allowed response lists the two exact additions and exact ACAO; rejected origin is 403; unrelated header is not dynamically echoed by management CORS. |
| P2-A18 | Run `ocx gui pair --origin <browser-origin>` with an explicit allowed origin, then missing `--origin`, malformed/disallowed origin, `--json`, extra args, stale target, failed attestation, and capability/API failure. | Valid cases create one grant and print once; every absent/invalid origin fails with no default and without falling back to admin auth or echoing secrets; no grant appears in argv/config/disk/log fixtures. |
| P2-A19 | Run native-profile mutation suite with admin, malformed remote session, and valid remote session. | Existing consent boundary remains: only the valid session + correct origin + CSRF dispatches the mutation. |
| P2-A20 | Run import-graph and synchronous-window guard. | No protected core import reaches GUI-session code; `startServer` remains synchronous and activation ordering is unchanged. |
| P2-A21 | Plaintext HTTP request for the session bootstrap on a non-loopback bind. | Response carries no grant, session, admin token, or client key — only an unauthenticated error naming the required scheme. |

## 10. Verification — remote only on `lidge-ai`

Do not run Bun tests, GUI tests, typecheck, full suite, or privacy scan on the local Mac.
Run as the ordinary `lidgeai` user in the remote checkout.

Focused backend/CLI gate:

```bash
ssh lidge-ai 'cd ~/Developer/opencodex && bun run typecheck && bun test tests/config.test.ts tests/server-management-auth.test.ts tests/native-profile-route-security.test.ts tests/server-auth.test.ts tests/server-live.test.ts tests/proxy-liveness.test.ts tests/gui-pair-capability.test.ts tests/gui-pair-client.test.ts tests/cli-dispatch.test.ts tests/cli-registry.test.ts tests/cli-help.test.ts tests/core-lab-boundary.test.ts'
```

Focused GUI auth gate:

```bash
ssh lidge-ai 'cd ~/Developer/opencodex/gui && bun test tests/api-auth-memory.test.ts tests/api-auth-deadline.test.ts'
```

Review-ready security/shared-server gate:

```bash
ssh lidge-ai 'cd ~/Developer/opencodex && bun run test && bun run privacy:scan'
```

Record remote commit, Bun version, command, exit code, pass/fail counts, and the security
review decision. Do not mark the phase review-ready from focused tests alone.

## 11. Completion boundary

Phase 2 is complete only when all four issuance values have a reachable positive or explicit
refusal scenario, every failure path leaves consent authority closed, and the existing
line-897 forged-Host regression remains green. A healthy endpoint alone is insufficient:
evidence must show an ordinary management request and one consent-bearing request with the
correct principal distinction. Production Tailscale listener wiring and visible pairing UX
remain later-phase work and must not be implied complete here.
