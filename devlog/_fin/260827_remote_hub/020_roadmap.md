# 020 — Roadmap: remote hub phases (dependency-ordered, PHASE-SPLIT-01)

Each phase = one PABCD cycle = one reviewable PR (stack against dev; children retarget
after parents land). Decade docs 030+ get diff-level detail when their cycle's P begins
(the P re-verifies against the then-current tree before executing).

## Phase 1 — Foundations: protocol + catalog read path (doc 030)
Runtime role types (standalone/hub/client) in config; /readyz protocol metadata
{protocol, minimumClientProtocol, managementUrl}; data-authenticated GET /v1/catalog
sharing the /api/catalog serializer, ETag, bounded body. No GUI, no local writes.
Prove: /readyz secret-free; /v1/catalog auth matrix; byte-identical serialization vs
/api/catalog; core-lab-boundary green.

## Phase 2 — Core security: remote gui-session + management CORS (doc 040)
serverOrigin/browserOrigin session records; hub.managementPublicOrigin; issuance modes
(loopback / tailscale-identity / pairing / trusted-tailnet); cross-origin bootstrap;
management preflight header allowlist; shared validation predicate; NO admin→session
exchange. Prove: remote HTTPS page mints session; consent routes 403 to admin-token but
200 to remote session; wrong origin/CSRF/expired/replay rejected; plain HTTP refused
unless opted in. Security-review-required phase (auth surface).

## Phase 3 — Client core: connect/disconnect/sync + injector target (doc 050)
Connect transaction; client state; catalog download/atomic placement; CodexRoutingTarget
generalization; mode-aware sync (no silent fallback); Claude launcher target; offline
journal restore. Prove: no local write before checks pass; injected config byte-shape;
disconnect restores pre-connect state hub-down; standalone output byte-compatible.

## Phase 4 — Integration: machine listener + two-plane GUI (doc 060)
Loopback allowlist listener; /api/machine/*; shared/machine API targets in GUI;
fixed-target relay; plane-aware offline/permission states. Prove: no /v1 on the
listener; mutations need session+CSRF; hub credentials only reach the hub origin;
hub-down UI renders; GUI build/lint/i18n + browser smoke on both transports.

## Phase 5 — Deployment integration (doc 070)
Loopback management ingress on the hub; systemd/launchd via existing service installer;
Docker recipe (volume + OCX_API_TOKEN_FILE secret); tailscale serve docs; headless OAuth
walkthrough. Prove: all three targets pass health/ready/auth'd catalog/routed response/
remote session smoke; identity headers unspoofable past the loopback backend.

## Phase 6 — Hardening + release gate (doc 080)
Rotation UX; skew matrix; multi-client attribution; session invalidation/rate limits;
catalog adversarial tests; relay SSRF negatives; docs-site sync (5 locales); full
typecheck/test/privacy:scan/build:gui/lint:gui; MAINTAINERS security review.

