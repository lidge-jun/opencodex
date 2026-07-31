# Windows/Linux/macOS Deploy Stability — Loop 3 Plan (P)

- **Date:** 2026-07-02 · **Branch:** cursor-fixes · **Class:** C3
- **Input:** Windows RCA R1/R5-lite/R8 + macOS audit M1/M2-lite/M3/M7a. Both audits converge
  on the same lifecycle cluster: liveness identity, port drift, stale baked paths,
  update-while-running.
- **Deferred to loop 4:** M4 (shim wrapper-dir redesign), M5/R7 (start lock), M6 (journal
  generations), R9 (rename retry), R10, R12/F9, R13, M7b (log rotation).

## Changes (diff level)

**L3-1 — runtime-first liveness with identity (R1/M1/R5-lite; high, both audits)**
- `src/server.ts` `/healthz` (≈:2010): add `service: "opencodex"`, `pid: process.pid`,
  `port: actualPort` to the JSON body (additive — existing consumers read `status`).
- `src/cli.ts`:
  - New `proxyIdentityAt(port, expectedPid?): Promise<{ pid?: number } | null>` — GET
    `/healthz` (existing hostname logic), require `res.ok` AND `body.service === "opencodex"`
    AND (`expectedPid` unset or `body.pid === expectedPid`). A 200 from some other app on
    the configured port no longer counts as "our proxy".
  - New `findLiveProxy(): Promise<{ pid: number; port: number } | null>` — `readPid()` →
    `readRuntimePort(pid)` → identity-probe that port with expectedPid; fall back to
    `config.port ?? 10100` identity-probe (pid from body) ONLY when no runtime state.
  - `handleEnsure` (≈:210-243): healthy check + `syncModelsToCodex(...)` use
    `findLiveProxy()` and its live port — an ensure after a fallback-port start no longer
    probes the dead configured port, spawns a duplicate, or re-syncs Codex to the wrong port.
  - `handleStart` existing-pid check (≈:131-139): replace `proxyHealthy(config.port)` with
    `findLiveProxy()`.
  - `waitForProxy` (≈:103-112): poll `findLiveProxy()`; return its live port.
  - `ocx sync` path (`syncModelsToCodex()` no-arg call ≈:430): pass
    `(await findLiveProxy())?.port` when available.
  - Keep `proxyHealthy` for any remaining internal use or fold into the new helpers.

**L3-2 — service stop leaves stale runtime-port (M7a; quick win)**
- `src/service.ts` `stopTrackedProxyIfRunning` (≈:504): also `removeRuntimePort(pid)`
  (import from `./config`) on both the stale and stopped paths, matching `ocx stop`
  (`cli.ts:256`).

**L3-4 — stale baked service paths are invisible (R2/M2-lite)**
- `src/service.ts`: extend `ServiceInstallState` with optional `bunPath`/`cliPath`
  (still `version: 1`; readers tolerate absence). `writeServiceInstallState()` records
  `cliEntry()` values at install.
- `serviceStatusSummary()`: when state records baked paths and either no longer exists,
  prefix the summary with `installed (STALE baked paths — run 'ocx service install')`.
- `src/update.ts` success path: when `isServiceInstalled()`, keep the advisory but ALSO
  surface staleness immediately by re-checking recorded paths (no auto-reinstall — service
  restart policy stays user-controlled).

**L3-5 — update replaces files under a running proxy (R8/M3)**
- `src/update.ts` `runUpdate()`: before invoking the package manager, if `readPid()` shows
  a tracked proxy, run the full `ocx stop` semantics by spawning
  `process.execPath [process.argv[1], "stop"]` (inherit stdio) — graceful drain via
  `/api/stop` (loop 1), service stop, native Codex restore. Print that the proxy was
  stopped and must be restarted (`ocx start` / `ocx service install`).
- `bin/ocx.mjs` `runNpmSelfUpdate()`: same pre-step — `spawnSync(process.execPath,
  [launcher, "stop"], { stdio: "inherit" })` before `npm install -g` (idempotent; prints
  "No running proxy found" when nothing runs).

## Tests (bun test on macOS)

- `tests/healthz-identity.test.ts` (new): startServer on an ephemeral port → `/healthz`
  body has `service === "opencodex"`, `pid === process.pid`, numeric `port` (follow
  existing server test conventions — see tests/server-auth.test.ts for how startServer is
  driven), or a source-scan if booting the server in-test is too heavy.
- `tests/cli` liveness: `findLiveProxy`/`proxyIdentityAt` live in cli.ts which executes
  argv dispatch on import — if not cleanly importable, put the pure pieces in a new
  `src/proxy-liveness.ts` (exported, imported by cli.ts) so they are unit-testable with
  injected fetch/readPid/readRuntimePort. Cover: runtime-port preferred over config.port;
  identity mismatch rejected (foreign 200 server); pid mismatch rejected; fallback only
  without runtime state.
- `tests/service.test.ts` (extend): source-scan `stopTrackedProxyIfRunning` also calls
  `removeRuntimePort(pid);`; install-state records bunPath/cliPath; status flags missing
  baked paths (unit via written state file + temp OPENCODEX_HOME).
- `tests/update-stop-first.test.ts` (new): source-scan `src/update.ts` +
  `bin/ocx.mjs` for the stop-before-update invocation ordering.

## Verification gate (C)
`bun x tsc --noEmit` + full `bun test ./tests/` (baseline 1269 pass / 0 fail).

## A verdict — PARTIAL, corrections applied

1. Liveness helpers shipped in new `src/proxy-liveness.ts` (cli.ts dispatches argv at
   module top — confirmed unimportable by tests).
2. Stale line refs noted (healthz at server.ts:2011; npm short-circuit at ocx.mjs:166-168).
3. `handleEnsure` now always syncs the live-probed port (`config.port ?? port` removed).
4. Identity-aware liveness extended to `cli-status.ts` (foreign 200 → "not an opencodex
   proxy") and `oauth/login-cli.ts` (`notifyRunningProxy` uses findLiveProxy + 127.0.0.1
   instead of localhost + config.port). `ocx gui` left as-is (already runtime-port based).
5. ocx.mjs stop-before-update resolves its own launcher path via `fileURLToPath(import.meta.url)`
   (runs before Bun is resolved).
- Compat guard added beyond the plan: `isOpencodexHealthz` accepts the legacy
  `{status, version, uptime}` body so a still-running pre-identity proxy isn't mistaken
  for a foreign server right after an update.

## Audit questions (A)
1. cli.ts is argv-dispatching at module top — confirm whether importing it in tests is
   safe today (do existing tests import cli.ts?) → decides the `src/proxy-liveness.ts`
   split.
2. `/healthz` consumers beyond cli (GUI badge? tests? docs-site?) — grep for healthz;
   confirm additive fields break nothing (e.g. exact-shape assertions).
3. `ServiceInstallState` version handling: `readServiceInstallState` requires
   `parsed.version === 1` — confirm adding optional fields keeps old state files readable
   both directions (old reader + new file, new reader + old file).
4. update.ts spawning `[process.argv[1], "stop"]`: verify process.argv[1] is cli.ts under
   the bun runtime for `ocx update` (and what it is under the Node launcher path — the
   launcher handles npm installs itself, so update.ts only runs under bun/source).
5. Does `waitForProxy`'s current caller rely on it returning `config.port` specifically
   (post-spawn port persistence interplay with `shouldPersistSelectedPort`)?
