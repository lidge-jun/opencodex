# 030 — Frontier closes #8–#14 and the read-surface state-source gate

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Status: recorded on `dev-go`; issues #8–#14 closed as delivered
Tickets: closes [#8](https://github.com/waxiangzi/opencodex/issues/8) (1.1) →
[#10](https://github.com/waxiangzi/opencodex/issues/10) (1.2) /
[#11](https://github.com/waxiangzi/opencodex/issues/11) (1.3) →
[#12](https://github.com/waxiangzi/opencodex/issues/12) (1.4) →
[#13](https://github.com/waxiangzi/opencodex/issues/13) (1.5) →
[#14](https://github.com/waxiangzi/opencodex/issues/14) (2.1), plus
[#9](https://github.com/waxiangzi/opencodex/issues/9) (6.1) — in dependency order
Parent specs: [#1](https://github.com/waxiangzi/opencodex/issues/1) (increment 1),
[#2](https://github.com/waxiangzi/opencodex/issues/2) (increment 2 — see the gate below)

## What this run delivered

The first seven tickets were code-complete on `dev-go` (commits `4b8715a30` …
`148a51c6d`, recorded in `000_plan.md`, `010_lab_migrate_vs_cut_decision.md`, and
`020_ownership_plumbing.md`) but had never been **resolved** in the issue
tracker, so the frontier query kept returning them as available work. This run
re-ran every machine gate that backs them — `go build ./...` / `go vet ./...` /
`go test ./...` under `go/`, the six-target `CGO_ENABLED=0` cross-compile matrix,
the differential oracle, the ownership-plumbing suite, the route-registry
reconciliation, and `bun run typecheck` — and closed issues #8–#14 in dependency
order, each with a comment citing the tree evidence and this doc.

Closing them exposes the true frontier: #15, #16, #17, #18, and #19 are now all
unblocked (each lists only #14 and/or #9 as a blocker). Auditing those tickets
against the actual handlers found a gate the batch texts do not state:

> **A management route can be Go-served byte-identically only when its body is a
> pure function of state the sidecar process can see** — the environment it was
> spawned with, on-disk files, the OS, or its own process. Routes whose bodies
> report the *TypeScript process's* live state (in-memory maps and caches,
> `bun:jsc` introspection, module-level counters, memoized discovery) cannot be
> reproduced by a separate sidecar process before the flip, no matter how
> faithfully their handlers are ported.

The health route migrated in #14 precisely because it sits at the portable end
of that spectrum (env + the sidecar's own process, two declared volatile
fields). Several routes in the next batches sit at the opposite end.

## State-source classification

Each candidate read route should be classified by where its body comes from
before batch work starts:

- **env/on-disk (portable today)** — config-file content merged with the
  version the supervisor passed at spawn. Both processes can read it; this is
  the class the ownership marker was built for.
- **OS-level (portable with care)** — process enumeration, platform probes. Go
  can reproduce these, but the matching semantics must be proven byte-exact
  against the live TS oracle.
- **TS-process live state (NOT portable pre-flip)** — in-memory session and
  replay tables, runtime introspection, module counters, memoized discovery,
  drain/lifecycle state. A sidecar physically cannot return these values.

### Ticket #15 (system reads) — per-route verdicts

| route | handler | source | Go-servable pre-flip? |
|---|---|---|---|
| `GET /api/system/health` | `system-routes.ts` (Go-owned since #14) | env + own process | yes — the #14 precedent |
| `GET /api/system/memory` | `system-routes.ts` | TS-process live: `process.memoryUsage`, `bun:jsc` heapStats, `responseStateMetrics`, memory-watchdog snapshot, relay inspection counters, active-turn/drain counters | no |
| `GET /api/system/windows-replace-retries` | `src/lib/windows-atomic-replace.ts` (`counters` module map) | TS-process live | no |
| `GET /api/system/codex-app-server` | `src/codex/app-server-restart-service.ts` `readCodexAppServerState` | OS process catalog | yes in principle; catalog-matching parity must be proven |

So #15 as written — "system read routes are Go-owned and byte-identical" —
cannot be closed while the TS server owns the process state: two of its three
unmigrated routes report TS-process introspection with no on-disk counterpart.
Only `codex-app-server` is plausibly portable, and one route does not close a
three-route ticket.

### Ticket #16 (config reads) — mixed, and the pure core is the prize

The config-core read bodies are disk-derived, but the GET handlers mix in live
process work:

- `GET /api/settings` returns a disk-derived core (`port`, `hostname`,
  `streamMode`, memory budget, toggles) **plus** `codexRuntime`, resolved by
  `resolveCodexRuntime()` — memoized in-process discovery that locates and
  versions the installed Codex binaries (`config-routes.ts`) — **plus** cached
  `startupHealth` and the serving process's browser `timeZone`.
- `GET /api/startup-health` serves a cache invalidated by install actions.
- `GET /api/diagnostics/project-config` serves `getCachedProjectConfigDiagnostics`
  — a scan cache populated by process work.
- `GET /api/update/check` / `GET /api/update/status` consult the update job
  module (`src/update/job.ts`), which is process state.
- `GET /api/sidecar-settings` mixes config with candidate-row/model resolution.

The valuable and genuinely portable artifact here is the **disk-derived core** —
one shared Go config-parsing implementation that turns the same on-disk config
into the same DTO bytes (#16's second acceptance criterion, and the dependency
#20/#21/#24/#35 all list). Route-level parity for the live fields needs a
per-field owner decision in the style of health's `volatileFields`: declare the
field volatile, forward a parent snapshot, or defer the whole route to the flip.

### Ticket #18 (auth/session) — the session half is not portable

- **Admin token**: file/env → portable; Go can read the same
  `OPENCODEX_HOME/admin-api-token` or `OPENCODEX_ADMIN_AUTH_TOKEN`.
- **Dashboard session**: `ManagementAuthState.sessions` is an **in-memory
  `Map`** in the TS process (`src/server/management-auth.ts`,
  `src/server/gui-session.ts`). Sessions are opaque tokens into that map — there
  is no stateless signed cookie a second process could verify.
- **Local capability principals**: HMACs over the process pid/port/attestation
  secret, plus **in-process replay tables** (`consumedLocalReadCapabilities`,
  the `admitted*Requests` weak sets) that live and die with the TS process.

So #18's "Go validates the dashboard session; under-privileged requests are
rejected identically" cannot be proven while the session table and replay caches
exist only in the TS process. What is missing is a **principal-relay contract**:
the front door already admits the request; for Go to re-validate rather than
trust the hop blindly (spec #3), the front door must hand the sidecar an
assertion of the admitted principal that Go can verify against a shared secret.
That contract has no ticket yet and no consumer until a mutating route actually
migrates — it should be specified as part of the write-surface work, not before.

### Ticket #19 (Lab gate) — premature

The Go codebase contains no Lab subsystem yet, so a Go activation gate would
gate nothing until the Lab routes port (#33). #9's migrate-vs-cut decision is
recorded as **migrate** (`010_lab_migrate_vs_cut_decision.md`); the natural
reading is that the Go gate + provider-slot seam are built *as part of* the Lab
increment so the seam has something to activate. #19's acceptance wording ("an
opt-in activation gate exists in Go") is satisfiable only vacuously today.

## Consequence and recommended order

The next batch implementer should not take "every read route Go-owned and
byte-identical" as a literal instruction: several routes report process state
that a sidecar cannot know. Concretely:

1. **Port #16's pure config-core first.** A shared Go config-parsing package is
   the load-bearing artifact the rest of the program lists as a dependency.
   Prove it byte-identical on the disk-derived subset of config read bodies and
   resolve each live field (`codexRuntime`, `startupHealth`, updater state) by
   one of the three per-field options above, recorded where the health route's
   `volatileFields` live.
2. **Before #15, get an owner decision on the process-derived system routes.**
   `memory` and `windows-replace-retries` cannot be Go-served pre-flip; the
   registry's `exempt` mechanism already models a documented deferral, and a
   defer-to-flip exemption is more honest than a sidecar inventing values.
3. **Specify the principal-relay contract before #18.** It becomes real work
   only when a mutating route is being ported.
4. **Fold #19 into the Lab increment (#33)** so the gate has something to gate.

## Verification

- `go build ./...`, `go vet ./...`, `go test ./...` green under `go/`.
- Six-target cross-compile matrix (`linux/darwin/windows` × `amd64/arm64`,
  `CGO_ENABLED=0`) produces all six binaries (#8 acceptance).
- `bun test tests/go-sidecar-parity.test.ts`: 4 pass — byte parity with the
  declared normalisation, missing-binary no-op, crash fallback (#10/#11/#13).
- `bun test tests/go-ownership-plumbing.test.ts tests/management-route-registry.test.ts
  tests/ci-workflows.test.ts tests/repo-hygiene.test.ts`: 170 pass (#12/#13/#14).
- `bun run typecheck` green.
