# 000 — Research: remote hub mode (evidence base)

Unit: 260827_remote_hub · Branch: codex/remote-hub-design · Status: research

## Motivation (user request, 2026-08-27)

Run one ocx as a central HUB (Oracle VM / Mac mini / Docker — any machine), keep every
provider key, OAuth credential, and shared config there, and let other machines connect
with only a pointer + token ("ocx connect <tailnet-dns>"). The dashboard on a client
machine must still work at localhost:10100 with a two-plane split: shared pages operate
the hub, machine pages operate local file integration. Explicit constraint from the user:
today a Tailscale-bound GUI is unusable for some operations even WITH the admin token —
the design must fix remote GUI operability without collapsing the consent boundary.

## In-repo evidence (verified 2026-08-27 on dev @ 8b1b65b8d)

- Non-loopback bind forces the data token: `isApiAuthRequired` returns true whenever the
  bind hostname is not loopback (src/server/auth-cors.ts:260-262), and startup refuses a
  public bind without a configured data credential.
- The remote-GUI limitation is a deliberate restriction, not an unreported weakness, and
  it is already visible in shipped public code: `issueGuiSession` returns null when
  `isApiAuthRequired(config)` is true and additionally requires a loopback Host
  (src/server/management-auth.ts, `issueGuiSession`). The published dashboard guide
  states the same boundary in user terms.

  The consequence is a capability gap rather than an exposure: on a remote bind the
  principal `gui-session` is unobtainable, so consent-bearing routes requiring
  `ctx.principal === "gui-session"` (src/server/management/sidebar-routes.ts:42,
  src/server/management/codex-prompt-routes.ts:298) answer 403 even to the admin token.
  That 403 is correct and stays correct — the admin token must never be able to spend the
  user's consent (AGENTS.md user-consent boundary). What is missing is any path for a
  *browser* to mint a session remotely, which is what this unit designs.

  Stated precisely: the current behavior fails closed. Nothing here describes a way to
  obtain authority one should not have, so this note is a design rationale rather than
  pre-disclosure material, and `AGENTS.md`'s scratch-space rule for unfixed defects does
  not apply to it. Anything in this unit that WOULD describe an unfixed exploitable
  weakness belongs in scratch space, not in `devlog/`.
- `managementRequestOrigin` returns null for a non-loopback Host when apiAuth is NOT
  required (src/server/auth-cors.ts:118-129); when apiAuth IS required it derives the
  origin from the request, which a TLS terminator breaks (http observed vs https public).
- The GUI attaches credentials only same-origin: `needsApiAuth` refuses absolute
  cross-origin URLs (gui/src/api.ts:53-60). A two-plane GUI therefore needs an explicit
  multi-target API layer, not a base-URL swap.
- The GUI needs a secure context in places: `crypto.subtle.digest` at
  gui/src/log-conversation-id.ts:26, `navigator.clipboard` at
  gui/src/oauth-health-display.ts:133 (with execCommand fallback).
- Injector already supports non-loopback targets: dedicated provider block with
  `env_key = "OPENCODEX_API_AUTH_TOKEN"` and `model_catalog_json` requiring a LOCAL
  absolute path (src/codex/inject.ts:186-247, 622+).
- `GET /api/catalog` and `GET /api/client-config` already exist behind management auth
  (src/server/management/model-routes.ts:334-420).
- Headless OAuth exists: `oauthOpenBrowser: false` (src/oauth/open-browser-choice.ts) and
  `POST /api/oauth/login/code` (src/server/management/oauth-account-routes.ts:208).
- Allowlist-listener precedent: the unauthenticated loopback listener enumerates exactly
  the routes it serves (src/server/index.ts, loopbackRouteAllowed) — the machine-plane
  listener should copy this failure mode (default-404).
- Token-file delivery precedent: `OCX_API_TOKEN_FILE` (src/lib/service-secrets.ts,
  src/service.ts:1571+).
- CLI already talks to the management API over HTTP with injectable baseUrl
  (src/cli/runtime-api.ts, RuntimeApiDeps.baseUrl) — client-mode remote management
  commands are a URL + credential change, not a new client.

## External evidence (Luna swarm, 3 lanes, sources opened 2026-08-27)

Peer proxies separate UI sessions from master keys:
- LiteLLM: LITELLM_MASTER_KEY for API/admin, separate UI login minting expiring
  virtual keys; per-user/per-device virtual keys with budgets, central key custody.
  https://docs.litellm.com.cn/docs/proxy/ui , virtual_keys.md / access_control.md in
  BerriAI/litellm-docs (opened 2026-08-27).
- sub2api: admin web UI uses JWT session; automation uses a separate global Admin API
  Key (x-api-key). https://github.com/Wei-Shaw/sub2api (opened 2026-08-27).
- One API broken-access-control reports (#2410, #2423) show central key custody makes
  route-level authz the main defense.

Tailscale transport facts (official docs, verified dates in page footers):
- `tailscale serve` = tailnet-only reverse proxy to a localhost backend; injects
  Tailscale-User-* identity headers; backend must bind loopback or headers are
  spoofable. https://tailscale.com/docs/features/tailscale-serve
- `tailscale cert` issues public CA certs only for the ts.net FQDN (not bare MagicDNS
  short names); names land in Certificate Transparency logs.
  https://tailscale.com/docs/how-to/set-up-https-certificates
- Funnel is public-internet exposure (ports 443/8443/10000) — out of scope here.

Browser platform facts (MDN/WHATWG/IETF, opened 2026-08-27):
- Plain-HTTP non-localhost origins are NOT secure contexts: no crypto.subtle, no
  async clipboard, Secure cookies unavailable. http://localhost IS potentially
  trustworthy. https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts
- Header-token SPAs avoid ambient-cookie CSRF but still need exact-origin allowlists
  and Origin checks on mutations (WHATWG Fetch; RFC 9700 OAuth BCP).
- RFC 8628 device flow is the reference pattern for headless-hub OAuth; ocx's
  oauthOpenBrowser:false + /api/oauth/login/code is already equivalent in shape.

## Design consequences (carried into 010)

1. Two credential worlds stay separate: data-plane admission (client machines) vs
   management (admin token / gui-session). Peers (LiteLLM, sub2api) validate this split.
2. Remote GUI needs a NEW session-issuance path, not a weakening of requireManagementAuth:
   the loopback-only refusal in issueGuiSession is the single gate to generalize.
3. HTTPS via tailscale serve against a loopback-only management ingress is the
   recommended browser path; plain-HTTP tailnet operation must exist as a documented
   opt-in because usability on a private tailnet was the user's explicit complaint.
4. localhost:10100 client GUI + direct-to-hub shared plane is cross-origin; the hub
   needs management CORS for an allowlisted client origin, or the client listener
   relays. Both appear in 010 with the relay constrained to a fixed target.
