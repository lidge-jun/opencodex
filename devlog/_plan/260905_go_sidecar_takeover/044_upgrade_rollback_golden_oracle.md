# 044 — Ticket #43: upgrade-in-place + rollback drill + TS golden snapshot

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-07
Ticket: [#43](https://github.com/waxiangzi/opencodex/issues/43) (spec #7 stories
11–13, acceptance: upgrade-in-place works without reconfiguration; the rollback
drill reverts with state intact; the final TS snapshot is retained as a golden
oracle). Parent spec: #7. Blocked-by #41 (flip cutover + port reclaim) and #42
(release pipeline Go build + CI switch) — both merged on `dev-go`.

## Scope discipline

Two subprocess drills and one committed oracle fixture. Nothing else moves:
this ticket deliberately adds no new CLI surface, no new HTTP route, and no new
on-disk format. Every assertion targets the *released binary's observable
behavior* — identity, upgrade, rollback, served responses — never Go internals
(spec #7 testing decisions).

The fixture driving both drills is `tests/go-upgrade-rollback-drill.test.ts`
(Bun differential harness in the same family as `tests/go-cli-parity.test.ts`):
it writes a last-TypeScript-release `OPENCODEX_HOME` by *running the real
TypeScript CLI* against it, spawns the release-shaped Go binary (`./cmd/ocx`
built with `CGO_ENABLED=0`, the artifact shape `go-release-artifacts.yml`
smokes), and shells in and out of the two runtimes under test.

## What landed

### Upgrade-in-place drill (story 11)

Simulates the operator on the last TS release upgrading to the first Go
release, with state that only the TS runtime could have written:

1. TS CLI `start` on a pinned free port in a fresh `OPENCODEX_HOME` whose
   `config.json` carries a real fixture (providers, port, default provider).
   A wait-for-healthy probe on the attested `/healthz` proves the process is
   up before any assertion runs. (The TS runtime completes its own schema
   migrations on this first start; the config as settled by the TS runtime is
   the baseline the rest of the drill must not disturb.)
2. The Go `ocx start` (same home, same config, no `--port`) then reclaims the
   port from the TS process (#41 reclaim path: liveness + command-line
   identity), takes over, and serves.
3. Assertions on the *state the TS release left behind*: the settled
   `config.json` is byte-identical after the Go takeover (no rewrite, no
   reconfiguration), the runtime records now name the Go process, and the
   Go-owned `ocx status --json` projection reads the records from the same
   home.

The upgrade path is exactly the #41 `portReclaimer` flow already exercised in
`runtime_server.go`; the drill proves the *end-to-end TS→Go process handoff*
with real spawned runtimes rather than unit mocks, and covers the
TS-runtime-released-on-SIGTERM contract (TS `syncCleanup` removes its own
pid/runtime records only after graceful drain).

### Rollback drill (story 7, exercised per story 12)

Shells *forward* to the Go runtime, then reverts to the TS CLI and asserts the
Go-written state is readable without data loss:

1. Go CLI `config set` mutates `config.json` through the Go native writer path
   (the same byte-compatible writer the parity harness diffs against the TS
   oracle); the TS-authored fields survive the write byte-compatibly.
2. Go `stop` through an async `ocx stop` (see harness constraints) releases
   the port and removes the Go runtime's own records.
3. TS CLI `status` reads the same home with no repair step, then TS `start`
   again on the same home binds the port the Go runtime released, reads the
   same config, and serves — state intact, no reconfiguration.
4. A dedicated handoff test pins the whole loop TS→Go→stop→TS against the
   TS-settled config baseline: no rewrite at any handoff boundary, so a
   rollback never triggers a second TS migration pass.

### Final TS snapshot as golden oracle (story 13)

A committed fixture that pins the *last TypeScript behavior surface* so a
post-flip parity regression is detectable even after the TS runtime is retired
from the release path:

- `go/internal/ocxcli/testdata/pid-parse-oracle.tsv` already pins the
  TS process-state parser as a matrix oracle (committed prior art, generated
  from `src/config/process-state.ts` semantics). The #43 snapshot extends the
  same pattern to the *CLI/runtime* surface that the differential harness
  still diffs TS→Go today: the parity suites
  (`tests/go-cli-parity.test.ts`, `tests/process-state-go-parity.test.ts`)
  compare Go's observable behavior against the real TypeScript CLI, and the
  committed TSV matrix remains as the oracle for what the Go binary must keep
  reproducing once TS code leaves the release path.
- The drill file itself is the retained end-to-end snapshot: it always runs
  the real TS CLI as the last-TS-release side of the handoff, so post-flip
  the same file continues to prove upgrade/rollback against whatever the
  fixture pins.

## Why the state-fixture shape stayed process-shaped

The alternative — synthesizing the TS-written state files directly — would
prove only that Go can *parse* TS-format files. The acceptance criteria are
about a *release* being upgradeable and revertible; the drill therefore runs
real TS and real Go processes against one shared home, and asserts the
observable contract (identity-attested health, served responses, state file
round-trips) rather than Go internals. TS is available in CI and in this
checkout until retirement, which is exactly the window in which a drill that
needs the real TS runtime can still run.

## Why the CI wiring stays workflow-shaped

`ci.yml`'s `go` job already runs the two differential-oracle suites in its
"go" job (`Differential oracles` step). The drill is the same family — needs
the Bun runtime and the Go toolchain, runs in minutes — so it joins that step
rather than growing a new workflow. Spec #7 story 12 wants the drill exercised
in CI, not necessarily on its own runner.

## Verification notes

Focused verification during development: the drill file standalone under
`bun test --timeout 60000` (matching the CI batch runner's per-file timeout) —
6 tests green (upgrade drill, rollback drill, byte-stable handoff, TS
snapshot-current test, Go-reproduces-snapshot test, buildable-and-named test);
`go test ./...` and `go vet ./...` under `go/`; `bun run typecheck`; sibling
differential suites (`go-cli-parity`, `process-state-go-parity`,
`go-sidecar-parity`) green. CI run: the `go` job's `Differential oracles` step
now includes the drill file, so a dev-go push exercises upgrade+rollback
against the release-shaped binary on every run. The suite-wide `test:changed`
run in this environment is ENOSPC-bound because the isolation harness gives
each worker its own Go module cache under a temp HOME; the parity suites each
pass standalone on a clean disk.

Harness findings recorded for the maintainer: `ocx stop` must be driven
asynchronously in the drill (spawnSync blocks Bun's event loop, the Go child
zombie is not reaped, and the stop ladder's bounded poll reads the zombie as
alive for its full 8s deadline); `child.exited` resolves before process death
in this environment, so liveness assertions use `kill -0`; and the drill's Go
binary must be named `ocx` because the #34 command-line identity guard
requires a standalone `ocx`/`opencodex` token.
