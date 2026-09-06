# 035 — Ticket #26: write-surface full parity + authorization gate

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Status: implemented on `dev-go` at `05f1e9632` (merge `e4d684d11` + `05f1e9632` on top of #25 config test `befb594d2`)
Ticket: [#26](https://github.com/waxiangzi/opencodex/issues/26) (spec #3 capstone: "Write-surface full parity + authorization gate")
Parent spec: [#3](https://github.com/waxiangzi/opencodex/issues/3) (increment 3: write surface)
Blocked-by (#21/#22/#23): closed on `dev-go` — `eb4292e8f` relays the three
write batches through the sidecar. Read-side mirror: [#25](https://github.com/waxiangzi/opencodex/issues/25)
(full read-surface parity gate), in flight in a sibling worktree.

Owner decision (2026-09-06): implement #26 as the **write-side parity gate**
under the state-source framework (devlog 030/032) — same shape the read
surface used. Three machine-checked deliverables:

1. Every mutating route carries an explicit ownership verdict — Go-owned,
   exempted, or deferred with a recorded reason. No silent plain route.
2. Every declared Go-owned write route has a state-reset differential oracle
   case (response AND post-state, failure modes included).
3. Auth rejection parity as a whole-surface property: every declared Go-owned
   write route is exercised without and with insufficient credentials/capability,
   rejecting byte-identically to TypeScript.

Making the Go `managementauth` gate *live* on the public write path (sidecar
answers requests without the TS front door) is deliberately **not** part of
#26: the sidecar never receives a browser session or admin token
(`go/internal/managementauth/write_relay.go`, devlog 033), and the flip (#41)
is where the Go binary becomes the serving process and owns that state. #26
proves the decision substrate now so the flip can consume it wholesale.

## Current write-surface state (HEAD `eb4292e8f`)

- **Registry** (`src/server/management/route-registry.ts`): 122 mutating
  routes total. 12 are declared Go-owned with `go: { relay: "signed",
  volatileFields: [] }`; 18 carry an `exempt` verdict (CLI-parity vocabulary,
  enforced honest by `tests/management-route-registry.test.ts`); **92 carry
  neither** — the "silent plain" set this ticket eliminates.
- **Wire shape**: the TS front door (`src/server/index.ts` →
  `requireManagementAuth`) still admits every `/api/*` request and resolves a
  principal; the Go-owned write branch (`management-api.ts` →
  `tryForwardDeclaredGoOwnedRoute`) mints a body-bound, one-use HMAC relay
  claim (nonce/principal/method/path/sha256(body)/expiry, TTL 30 s, replay 256,
  body cap 2 MiB); the sidecar public route verifies the parent request token +
  claim (`go/internal/sidecar.go` `relayPublicWrite`), then forwards to the
  private parent bridge `/__ocx_go_sidecar/write`
  (`src/server/go-sidecar-write-relay.ts`), which re-verifies and dispatches
  the **legacy TS handler** — TS remains the mutation oracle until native
  mutations land, exactly like the #24 hot-path seam.
- **`managementauth` gate** (`go/internal/managementauth/`): substrate proven
  by the `authcheck` differential oracle (`tests/go-auth-parity.test.ts`); it
  never runs live pre-flip. `relayPublicWrite` rejects an invalid/absent claim
  with a sidecar-shaped 401/404, which the front door makes unreachable from a
  public client (the front door rejects first).
- **Coverage today** (`tests/go-sidecar-parity.test.ts`): state-reset
  differential cases exist for the shadow-call write, settings write,
  sidecar-settings write, and a quota/account-pool vector — not for all 12
  declared write routes, and no under-privileged write vectors at all.

## What #26 is (and is not)

#26 is the write-side capstone of spec #3: the machine property that the
*migrated* write surface is complete (no route can become Go-owned while its
authorization is unproven — spec #3 story 4), differentially proven per route,
and guarded by an authorization gate that answers identically to TypeScript.
It does **not** migrate new routes: the batches (#21/#22/#23) own which routes
move. It does **not** make the Go gate live: the flip (#41) owns that. It
makes both future steps safe to consume — the flip can serve the write surface
knowing every route already has a verdict, a differential, and proven
rejection parity.

Acceptance criteria → deliverable map:

| Acceptance | Deliverable | Seam |
|---|---|---|
| Every write route Go-owned | A write-ownership ledger making every mutating route's verdict explicit (Go-owned / exempt / deferred-with-reason), machine-checked against `MANAGEMENT_ROUTES` so no silent plain route survives a registry edit | 1 (registry/ledger) |
| State-reset differentials green for the write surface | One state-reset oracle case per declared Go-owned write route (the 12), response + post-state + a failure-mode leg where one exists | 2 (differential oracle) |
| Auth rejection paths match TypeScript | Every declared Go-owned write route exercised without and with insufficient credentials/capability through both TS in-process and the Go decision substrate; rejections byte-identical | 3 (authorization oracle) |

## Seam 1 — the write-ownership ledger (verdict completeness)

Where the read surface recorded per-route deferrals only in devlog 032, the
write surface needs the same decision **machine-checked**, because a write
route that silently lacks a verdict is exactly how a mutation could bypass its
guard later (spec #3 story 4: "a write route must never be Go-owned before its
authorization is proven" — the ledger makes the inverse visible too: a route
with no verdict cannot be argued about).

Design: a pure-data ledger in a NEW module
(`src/server/management/write-ownership.ts`), because `route-registry.ts` is
pinned imports-nothing and a verdict ledger is data the core dispatch path
must never load. The ledger lists exactly the **deferred** mutating routes
(the set with neither a `go` marker nor an `exempt` today); go-owned and
exempt verdicts are read from the existing registry fields, never duplicated:

- `go-owned` — derived from `route.go.relay === "signed"` (12 today).
- `exempt` — derived from the registry `exempt` reason; the existing honesty
  tests already police it.
- `deferred` — one ledger row per remaining mutating route, carrying a `why`
  (≥ the same non-trivial length bar as exemption reasons) and an optional
  owner doc. Deferred is the explicit, reviewed state that replaces "silent
  plain".

A test then proves: the deferred ledger exactly covers the mutating routes
with neither marker (no extra, no missing, no plain); a route cannot gain a
`go` marker while its ledger row still exists (the existing marker-set pin
enforces the 12); adding a mutating route without a ledger row fails. The
exports stay inert data on the core path: nothing under `management-api.ts`
imports the new module.

Verdict classification for the current 92 silent-plain routes follows the
write batches' own scope (spec #3: config writes, quota/usage, account-pool)
plus the state-source gate (devlog 030) for what stays TS-process-owned. A
route in the ledger is DEFERRED because no batch has claimed it: the three
batches claimed the pure config/account-pool writes (#21 settings trio, #22
quota/usage, #23 account-pool verbs), and the deferred families are either
TS-process-owned state the flip will own (login flows and dashboard sessions,
OAuth device-code state, provider keychains, native-profile staging state
machines, storage job tables, system restart/tray/update actions, Codex Log
Guard protection) or config writes with live-catalog/registry residue the read
face already defers to the catalog/provider line (devlog 032: models,
providers, aliases, discovery). This is an ownership record, not a claim that
a relay is impossible — the relay executes the legacy TS handler, so the
honest boundary is batch scope and state ownership. The ledger row records the
family-level reason with concrete citations, mirroring 032's per-route table.

## Seam 2 — state-reset differential coverage for the write surface

Extend `tests/go-sidecar-parity.test.ts` so every one of the 12 declared
Go-owned write routes has its own state-reset oracle case: reset fixture bytes
→ apply the same mutation through Server A (in-process TS) and Server B
(sidecar attached, real Go) → compare status, headers, and body, then compare
the post-write on-disk config bytes. Where the route mutates no config (a
validation-only or account-store route under the fixture), the case proves the
response path and the no-write-on-error leg instead, and says so in the case
name.

Delivered as three vectors sets in this file, one per declared write-route
group:

- `codex-auth account-pool write vectors have a state-reset differential
  oracle` — `PUT active` (pins + writes config), `PUT`/`PATCH pool-strategy`
  (write config), `POST accounts/clear-cooldown` (no config post-state under
  the empty fixture; clears in-process routing health, so the oracle proves
  the response path and no-write leg), plus an invalid-strategy 400 leg that
  leaves bytes untouched.
- `oauth account-pool and account-store vectors match through Go` —
  `PATCH accounts/pool` (persists anthropicAccountPool), `PUT accounts/active`
  (account-store route: under the empty fixture no OAuth account exists, so it
  is the 404 no-write rejection path), `POST accounts/clear-cooldown`
  (in-process health, no config post-state), plus an invalid-strategy 400 leg.

The write legs also assert the file actually changed (`post-state ≠ initial`)
so a later byte equality is not vacuous. Under the fixture probe:
settings/shadow-call/sidecar-settings/codex-auth active/codex-auth
pool-strategy(PUT/PATCH)/oauth accounts pool(PUT/PATCH) write; the
clear-cooldown verbs return 200 `cleared:false` without writing (they clear
in-process routing health, absent under a fresh fixture); reset-credits/consume
and oauth accounts/active validate against account state and return
400/404 without writing.

## Seam 3 — authorization gate: rejection parity as a whole-surface property

The batch tests prove the happy path and the relay proof machinery
(`tests/go-sidecar-write-relay.test.ts`); #18 proves the decision substrate on
arbitrary vectors (`tests/go-auth-parity.test.ts`). Neither proves that the
*migrated write surface's own* rejection paths match TypeScript. Seam 3 adds
the write-surface authorization oracle:

- For each declared Go-owned write route (the 12 method/path pairs), build the
  under-privileged request set the front door admits or rejects on: no
  credential, wrong admin token, and a valid system-restart capability aimed
  at the write route's own method/path (proving a capability principal minted
  for another route can never cross onto the write surface). Each vector set
  also carries the admitting admin-token request so a false rejection on the
  migrated surface would surface too.
- Feed identical vectors through TS in-process
  (`src/server/management-auth.ts`, exactly as `go-auth-parity` does) and
  through the Go gate via `ocx-sidecar authcheck`; compare byte-for-byte.
  Because Go-owned write routes are forwarded only after front-door admission,
  the *public* rejection is the front door's — but the flip will serve these
  same routes with the Go gate as the front door, so the substrate decision on
  the exact write-surface method/path pairs is what must match. That is what
  this seam pins: principal-or-rejection equality on the write surface, not on
  a generic vector.
- The relay's own rejection paths (bad claim / replay / expiry / altered body)
  stay pinned by `go-sidecar-write-relay.test.ts`; seam 3 does not duplicate
  them.

The authorization oracle lives beside the existing parity tests as a new
`tests/go-write-surface-auth-parity.test.ts` (same skip-if-no-Go guard and
one-Go-process-per-array shape as `go-auth-parity.test.ts`).

## Security boundary

- Seam 1 adds an inert data module (`write-ownership.ts`) that nothing under
  `management-api.ts` imports; it never routes traffic. `route-registry.ts`
  still imports nothing at all.
- Seam 2/3 are differential oracles; they build the sidecar binary and boot
  fixture servers but touch only throwaway `OPENCODEX_HOME` fixtures. No
  credential, cookie, or browser header crosses a process boundary in the
  tested relay paths (existing write-relay contract, unchanged).
- No client credential, dashboard session, or admin token is added to what the
  sidecar receives. The Go gate stays substrate; nothing in this ticket makes
  it reachable by an unauthenticated public caller.

## Proof

- Seam 1: new `tests/write-surface-ownership.test.ts` (ledger exactly covers
  the mutating routes with neither marker; ledger rows must name real routes;
  family reasons non-trivial; owner doc is a tracked repo file).
- Seam 2: `tests/go-sidecar-parity.test.ts` gains the codex-auth and oauth
  vector sets above, completing one state-reset case per declared write route
  (12 total) — every declared write route has one; the file passes 15 tests
  (13 before this run, two fixture cases added).
- Seam 3: new `tests/go-write-surface-auth-parity.test.ts` (2 tests, 48 +
  24 vectors); TS in-process vs `ocx-sidecar authcheck` byte equality on the
  write-surface vectors, plus the 503-unavailable state for the same surface.
- Gates: `go build/vet/test ./...` green under `go/`; focused Bun suites green;
  `bun run typecheck` green.

## Delivery notes (filled in at close)

Delivered on `fix/ticket-26-write-auth-gate`, rebased onto `f8ab6d510` (dev-go: #21-23 + #24):

- **035 decision record** (this doc) written first, then the three seams TDD'd
  in order, each red-green before moving on.
- **Seam 1**: `src/server/management/write-ownership.ts` — 92 deferred verdict
  rows across 15 owning-module families (script-generated from
  `MANAGEMENT_ROUTES`, so no transcription drift), each `why` naming the real
  state-source / batch-scope reason; `tests/write-surface-ownership.test.ts`
  (4 tests) forces exact coverage: the ledger is precisely the mutating set
  with neither a `go` marker nor an `exempt`, ledger rows must resolve to real
  unclaimed mutating routes, reasons are non-trivial, and the owner doc is a
  tracked repo file. Registry untouched; ledger imports nothing but a type.
- **Seam 2**: `tests/go-sidecar-parity.test.ts` gains two fixture cases
  (codex-auth vectors: active / pool-strategy PUT+PATCH / clear-cooldown;
  oauth vectors: pool PATCH / active-404 / clear-cooldown) with write legs
  that assert the file changed so the byte equality is non-vacuous, plus
  invalid-strategy 400 no-write legs on both faces. Every declared write route
  (12) now has a state-reset differential case; the file passes 15 tests
  (13 before, two fixture cases added).
- **Seam 3**: new `tests/go-write-surface-auth-parity.test.ts` (2 tests,
  75 expect calls) — per declared write route, no-credential / wrong-token /
  cross-route capability / admin-token vectors through TS `management-auth`
  vs `ocx-sidecar authcheck`, byte-identical; plus the same surface under
  unavailable auth state (503 identical).
- Resolved mid-flight: the first ledger draft argued deferrals from a
  "cannot relay / cannot differential" frame, which the write-relay architecture
  refutes (the relay executes the legacy TS handler; `PUT /api/settings`
  itself triggers `convergeCodexCatalog`). Rewrote every family reason around
  batch scope + state ownership and updated the 035 verdict-classification
  paragraph to match.
- Gates on this branch: `bun run typecheck` clean; focused suites
  (write-surface-ownership, management-route-registry, go-ownership-plumbing,
  go-sidecar-parity, go-sidecar-write-relay, go-auth-parity,
  go-write-surface-auth-parity) green; `go vet` + `go test ./...` green under
  `go/`. A `bun run test:changed` run showed only concurrency-timeout failures
  in unrelated suites (codex-log-guard / lab / responses / abort-race), all of
  which pass when re-run alone.
