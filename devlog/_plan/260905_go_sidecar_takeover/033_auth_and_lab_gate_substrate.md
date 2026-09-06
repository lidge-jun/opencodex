# 033 — Tickets #18/#19: Go management auth model + Lab activation gate/seam

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Status: implemented on `dev-go`
Tickets:
- [#18](https://github.com/waxiangzi/opencodex/issues/18) (spec #3: Go management auth/session model)
- [#19](https://github.com/waxiangzi/opencodex/issues/19) (spec #6: Lab activation gate + provider-slot in Go)
Owner decision (2026-09-05/06): implement both under the state-source gate (devlog 030); deferral decisions are made and recorded here, not re-escalated.

## What these tickets are (and are not)

Both are **substrate** tickets for later batches, not route flips. The TS front
door still admits every `/api/*` request before dispatch
(`src/server/index.ts` → `requireManagementAuth`), so a Go-owned route never
sees an unauthenticated request pre-flip, and the Go binary runs no Lab code.
The deliverables are the Go-side decision logic, the seams it registers into,
and machine proof that both answer identically to TypeScript — the write
batches (#21–#23) and the authorization gate (#26) consume #18 when they serve
writes, and #33 + the flip consume #19. Nothing here changes live behavior; a
default install is byte-identical to a build without these packages.

## #18 — Go management auth/session model

`go/internal/managementauth` reproduces the admission decision of
`src/server/management-auth.ts` + `src/lib/*-contract.ts` +
`src/server/gui-session.ts`:

- **Admin token**: credential extraction (x-opencodex-api-key /
  Authorization Bearer), timing-safe equality, env/file token resolution
  (file shape `ocx_admin_[43]`, ≤512 bytes, no creation/ACL mutation — the
  sidecar must not touch the parent's secret file).
- **Dashboard session**: `AuthorizeSession` mirroring
  `authorizeGuiSessionRequest` — expiry deletion, server-origin comparison
  through a port of `managementRequestOrigin` (loopback observed origin,
  non-loopback requires api auth, hub public-origin override, WHATWG origin
  serialisation incl. default-port dropping), browser-origin/CSRF rules for
  safe vs. unsafe methods, remote-session sliding.
- **Capability principals**: all four process-scoped HMAC contracts
  (system-restart, local-provider-reload, local-read, gui-pair) plus the
  attestation proof, with exact payload strings, base64url-256 shapes,
  allowlists, TTL windows, and the consumed-capability replay stores (256
  limit, gui-pair keyed by sha256 digest).
- **Gate**: principal ordering (capabilities → token → session) and the exact
  rejection responses — 401 `{"error":"opencodex admin token required"}` and
  503 with reason + hint — as raw JSON bodies.

State-source notes: the capability checks are pure functions of injectable
inputs; the token is env/disk state; the session table is owned by the serving
process (minted in-memory) so Go validation carries the table it is given and
mutates it the same way (expiry delete, sliding). Live enforcement lands with
the write batches / authorization gate; pre-flip this is proven substrate.

## #19 — Lab activation gate + provider-slot seam

- `go/internal/labactivation` reproduces `labActivationRequired` and
  `labAutomationEnabledOnDisk`: routing profiles non-empty in config.json, or
  automation enabled under `<configDir>/lab/automation-config.json`
  (`policy.enabled`, authority over the legacy `automation-policy.json`,
  which is consulted only when the combined file is absent or carries no
  policy object). The gate reads the same on-disk files the TS side reads.
- `go/internal/routing/compatibility` reproduces the core-owned
  `provider-slot.ts` seam: a nullable evidence-provider reference with
  set/resolve/detach-own-registration semantics. Typed opaquely until the Go
  routing port; `labactivation.Activate` reproduces the composition-root
  contract — required → register, not required → slot stays nil — proven with
  stub providers (the real Lab evidence provider arrives with #33).

## Proof

- Go unit tests: `managementauth` (capability round trips incl. cross-mint
  refusal, origin derivation, gate ordering, replay rejection, session
  outcomes, token-file loader) and `labactivation` (gate fixtures, activation
  registers only when required).
- **Differential oracle** `tests/go-auth-parity.test.ts`: the same ordered
  vector arrays through `src/server/management-auth.ts` (in-process) and the
  new `ocx-sidecar authcheck` subcommand (one Go Gate per array, so replay
  stores persist across vectors like the TS module-level maps) — decisions
  compared byte-for-byte: principal or exact status+body, plus the session
  admission reason when probed. 7 suites, every principal + rejection path.
- **Differential oracle** `tests/go-lab-gate-parity.test.ts`: ten fixture
  directories through `ocx-sidecar labcheck` and `src/lib/lab-activation.ts`
  (Go reads the pristine fixture first, because the TS loader can repair a
  config file in place) — automationEnabled/profilesNonEmpty/required equal.
- Gates: `go build/vet/test ./...` green; focused suites green.

## Wire contract additions (ocx-sidecar)

`ocx-sidecar authcheck <json>` and `ocx-sidecar labcheck <configDir>` are
differential-oracle subcommands, inert on the live path (the supervisor never
passes an argument). The authcheck JSON carries request/state/config/local per
vector; one Go process per array mirrors one serving process.

## Residuals (recorded, not hidden)

- #18's session *issuance*/pairing machinery (mint, grants, rate limits) is
  not ported — validation is the ticket's acceptance; issuance is session-route
  work at the write batch. #18's Go gate becomes live when Go serves management
  requests without the TS front door (#21–#23 differential writes, #26
  authorization gate, flip).
- #19's real Lab evidence provider registration is #33's job; until then the
  seam and gate are proven with stubs and no Go package imports Lab content.
- #26 remains the gate that makes "auth rejection paths match TypeScript" a
  whole-surface property.
