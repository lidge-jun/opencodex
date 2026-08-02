# 260802 — GUI update leaves a launchd service that cannot serve

## Objective

A macOS machine running opencodex 2.8.0 under the launchd background service
(`com.opencodex.proxy`) clicked the dashboard update button. The npm install
succeeded (2.9.1 is on disk), but the proxy never came back. Afterwards:

- `ocx service` (install/start) registers with launchd but `http://localhost:10100`
  answers nothing.
- `ocx start` on the same machine serves 10100 immediately.

Find why the service path stays dead while the foreground path works, fix the
update logic so a dashboard update cannot land in that state, and cover the
failure with regression tests.

## Constraints

- Bun-native TypeScript on `dev`; `bun run typecheck` and `bun run test` must stay green.
- No `git push`, no PR, no release without explicit user approval.
- Security-sensitive findings go to `.tmp/`, never into this directory
  (`AGENTS.md` — Security working notes).
- The user's dirty worktree (docs-site edits, an unresolved merge path) is not ours
  to touch.

## Reproduction path (user-reported, verbatim shape)

1. macOS, opencodex 2.8.0, launchd service installed and serving on 10100.
2. Dashboard → update button → GUI update worker runs (`OCX_SERVICE=1`, stdio ignored).
3. npm install succeeds; the proxy is left dead and unreachable.
4. `ocx service` → launchd shows the job, 10100 stays silent.
5. `ocx start` → 10100 serves normally.

## Evidence index

| Doc | Contents |
|-----|----------|
| `001_update_worker_trace.md` | Line-level trace of the GUI update worker restart path |
| `002_service_vs_start_asymmetry.md` | Why the service path dies where the foreground path survives |
| `003_audit_round1_correction.md` | Audit FAIL, the refuted first hypothesis, and the measurement that replaced it |

## Revision history

- **R1 (retracted).** The first pass blamed a 450-byte Bun placeholder baked into
  the plist. An independent audit refuted it, and the refutation was confirmed by
  hand: `bundledBunPath()` ([src/lib/bun-runtime.ts:35-46](../../../src/lib/bun-runtime.ts))
  already gates every candidate through `isRealBunBinary()`, so the stub can never
  reach `ProgramArguments`. Full record in `003_audit_round1_correction.md`.
- **R2 (current).** Root cause re-derived from a live `launchctl` measurement on
  macOS 27.0. All line numbers re-verified against the working tree.

## Root-cause summary

**The launchd load path reports success for a load that failed.** Every layer
above it then reasons from that false success, and each layer independently lacks
the one check that would have caught it.

### D1 — `launchctl load -w` fails with exit code 0 (measured)

Measured on this host, macOS **27.0**, against the real installed job:

```
$ launchctl load -w ~/Library/LaunchAgents/com.opencodex.proxy.plist
Load failed: 5: Input/output error
Try running `launchctl bootstrap` as root for richer errors.
$ echo $?
0
```

The legacy `load` subcommand prints its failure to **stderr and exits 0**. This is
not a broken-plist quirk: it is what `load -w` does whenever the job is already
bootstrapped in the domain — the normal state on any machine where the service is
installed.

`startLaunchd()` is a single unguarded call:

```ts
// src/service.ts:1294
function startLaunchd(): void { sh(`launchctl load -w "${plistPath()}"`); }
```

and `sh()` ([src/service.ts:355](../../../src/service.ts)) is `execSync`, which
throws only on a **non-zero** exit. Exit 0 with `Load failed` on stderr sails
through, and `case "start"` ([src/service.ts:2092](../../../src/service.ts))
prints `✅ service started.` unconditionally.

`installLaunchd()` ([src/service.ts:1288-1292](../../../src/service.ts)) has the
same shape with one mitigation: it runs `launchctl unload` first, so a fresh
install usually does load. But that unload is `try { ... } catch { /* not loaded */ }`
with stderr sent to `/dev/null`, so an unload that fails is equally silent — and
the following `load -w` then no-ops, leaving whatever job was already bootstrapped
running its **old** `ProgramArguments`.

That is the user's report exactly: `ocx service` prints a checkmark, launchd keeps
listing the job, and the plist freshly written to disk is not the plist that runs.

### D2 — the update worker re-bakes through that same silent path

On macOS the worker takes the `serviceInstalled` branch at
[src/update/job.ts:733](../../../src/update/job.ts) and runs
`node <pkg>/bin/ocx.mjs service install` via `spawnSync`. The `skipServiceInstall`
guard immediately above is `process.platform === "win32"` only — deliberately, per
its own comment — so macOS always re-registers, through `installLaunchd()` and its
silent load.

### D3 — `viable` cannot see any of this, and cancels the safety net

After a zero-exit reinstall the worker consults `serviceViableFn`
([src/update/job.ts:781](../../../src/update/job.ts)) and returns when true,
skipping the direct proxy start built so that "browser-dashboard updates do not
require a viable Background Service for recovery".

On darwin ([src/service.ts:1961-1971](../../../src/service.ts)):

```ts
const installed = existsSync(plistPath());
const running   = installed && Boolean(statusLaunchd());               // launchctl list | grep
const stale     = installed && bakedServicePathsDiagnostic() !== null; // existsSync only
const viable    = installed && running && !stale;
```

Every term is satisfied by a bootstrapped-but-not-serving job: `launchctl list`
reports it, and the baked paths exist. So `viable === true`, the worker returns,
and the update ends with nothing listening — which `confirmNpmExplicitRestart`
([src/update/job.ts:1248](../../../src/update/job.ts)) then correctly reports as a
**failed** job. Hence "업데이트가 완료되지 않고".

### Where the retracted D1 went

The `existsSync`-only weakness in `bakedServicePathsDiagnostic()`
([src/service.ts:1550](../../../src/service.ts)) is real but is **not** the cause:
`bundledBunPath()` rejects the placeholder one call earlier, so the stub cannot be
baked. It survives as defensive hardening (WP1), demoted from cause to gap.

## Why `ocx start` still works

`ocx start` binds the socket **in the calling process**. No supervisor, no domain
registration, nothing between the user's intent and the listening socket — so no
layer can report success without one, and every failure lands on the user's own
terminal.

The service path inserts launchd, and both signals it exposes (`load -w` exit
status, `launchctl list` membership) answer a question about *registration* while
the code reads them as answers about *service*.

A second asymmetry compounds it: the service always starts hard-pinned
(`start --port 10100`), which refuses to hop and exits, whereas a bare `ocx start`
may hop to an ephemeral port and still look healthy. See
`002_service_vs_start_asymmetry.md`.

## Work-phase map (dependency-ordered)

| Phase | Doc | Deliverable | Depends on |
|-------|-----|-------------|------------|
| WP1 | `010_launchctl_load_verification.md` | A `launchctl load` that fails with exit 0 raises instead of being ignored | — |
| WP2 | `020_service_install_verification.md` | `install`/`start` confirm a listener on the baked port before printing success | WP1 |
| WP3 | `030_update_worker_recovery.md` | Update worker stops trusting `viable` and confirms serving before returning | WP1, WP2 |
| WP4 | `040_service_status_surface.md` | `ocx service status` distinguishes registered / stale-plist / serving, and names the repair | WP1 |
| WP5 | `050_baked_runtime_hardening.md` | Optional: validate the `process.execPath` fallback before baking it | WP1 |

Each phase is one full PABCD cycle. WP1 is load-bearing — WP2, WP3, and WP4 all
build on its `runLaunchctl` / `launchdJobMatchesPlist`. WP5 is the demoted R1
finding and is explicitly optional.

## Verification standard

`src/service.ts` is imported by `cli/index.ts`, `cli/status.ts`,
`codex/autostart-health.ts`, and `server/management/system-restart.ts` among
others, so **every** phase gates on the full `bun run test`, not just its own file.

## Out of scope

GUI visual work, docs-site translation sweeps, provider/adapter changes,
Windows-only scheduler behavior beyond what these paths already share.

Migrating `launchctl load`/`unload` to `bootstrap`/`bootout` is deliberately
deferred: it changes service lifecycle semantics and needs its own unit. WP1
verifies the outcome of the legacy commands instead.
