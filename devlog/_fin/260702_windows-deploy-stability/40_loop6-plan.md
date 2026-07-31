# Windows/Linux Deploy Stability — Loop 6 Plan (P)

- **Date:** 2026-07-02 · **Branch:** cursor-fixes · **Class:** C3
- **Input:** Codex whole-tree audit of ff6916a..49f9700 (10 verified findings; top 2 re-verified
  first-hand against source). Loop 6 scope = the clear, low-risk, high-value 7. Deferred to
  loop 7: F5 (OAuth dual-bind EADDRINUSE port retry), F6 (check-then-bind port race),
  F8 (Windows service asset rewrite before task stop — locking order).
- **Separate track (not this loop):** openai↔opencodex chat-history sync conflicts
  ("history vanishes except pinned after update; Windows worst") — investigation running,
  own plan folder when RCA lands.

## Findings in scope (all verified against source)

| # | Sev | OS | Defect | Evidence |
|---|-----|----|--------|----------|
| F1 | high | all | Stale/invalid `ocx.pid` is never removed: `handleStop` prints "No running proxy found" and exits, but the npm launcher's update gate re-checks raw `existsSync(ocx.pid)` after running stop → self-update aborts forever until the user hand-deletes the file. Orphan proxies (live server, missing/stale pid file) are also never stopped, so update can replace files under a running proxy. | `src/cli.ts:235-259`, `bin/ocx.mjs:110-116`, `src/config.ts:380-399` |
| F2 | high | all | `findLiveProxy` only consults `runtime-port.json` via the pid file. Pid file missing/corrupt ⇒ a live fallback-port proxy is invisible ⇒ duplicate starts, wrong-port GUI/status, update under a live proxy. | `src/proxy-liveness.ts:86-105` |
| F3 | med | non-default host | `notifyRunningProxy` always POSTs to `127.0.0.1` even when liveness found the proxy on `::1`/LAN bind — login config push silently lost. | `src/oauth/login-cli.ts:23` |
| F4 | med | IPv6 | `ocx status` builds `http://::1:10100/healthz` (unbracketed IPv6) → healthy proxy reported unreachable. | `src/cli-status.ts:58-84` |
| F7 | med | all | `ocx gui` still trusts pid file + fixed 1 s sleep instead of identity-checked liveness → opens `config.port` instead of live fallback port. | `src/cli.ts:428-451` |
| F9 | low | IPv6+corp proxy | `applyProxyEnv` appends only `localhost`,`127.0.0.1` to NO_PROXY — `::1`/`[::1]` health/management fetches can route through corporate HTTP(S)_PROXY. | `src/config.ts:329-340` |
| F10 | low | all | `ocx doctor` resolves `CODEX_HOME=~/...` literally (no `expandUserPath`), diverging from hardened runtime paths → false "missing" rows. | `src/doctor.ts:21-24` |

## Diff-level changes

**MODIFY `src/proxy-liveness.ts`** (F2, F3 support)
- `LiveProxy` gains `hostname?: string` — the raw bind hostname the probe succeeded against
  (callers compose URLs via `probeHostname`).
- `LivenessIo.readRuntimeFn` signature widens to `(pid?: number) => RuntimePortState-like | null`
  (default `readRuntimePort` already accepts optional `expectedPid`).
- `findLiveProxy`: after the pid-file path fails, read the runtime record WITHOUT pid
  expectation; if its port wasn't already probed, identity-probe it with
  `expectedPid: record.pid` and on success return
  `{ pid: identity.pid ?? record.pid, port: record.port, hostname: record.hostname }`.
  Config-port fallback unchanged (returns `hostname: config.hostname`).

**MODIFY `src/cli.ts` — `handleStop`** (F1)
- When `readPid()` is null: attempt orphan recovery — `findLiveProxy()`; if it returns a pid,
  `stopProxy(pid)` gracefully (same try/catch as the normal path).
- Always purge stale artifacts in the no-pid path: `removePid()` + `removeRuntimePort()`
  (unconditional unlink is safe here: `readPid() === null` means the file is absent, invalid,
  dead, or not ours — stale by definition; live-pid stop-failure path still preserves files).

**MODIFY `bin/ocx.mjs`** (F1)
- Update gate condition adds the runtime record: stop first when `serviceWasInstalled ||
  ocx.pid exists || runtime-port.json exists`, so orphan proxies (pid file lost, record
  present) are stopped before npm replaces files. Post-stop abort check unchanged
  (stop now guarantees stale-file purge).

**MODIFY `src/oauth/login-cli.ts`** (F3)
- `notifyRunningProxy`: `http://${probeHostname(live.hostname)}:${live.port}/api/providers`
  (import `probeHostname` from `../proxy-liveness`).

**MODIFY `src/cli-status.ts`** (F4)
- Delete local `healthHost`; `healthUrl` uses `probeHostname(hostname)` from
  `./proxy-liveness`. `dashboardUrl` stays `localhost` (browser-facing).

**MODIFY `src/cli.ts` — `gui` case** (F7)
- Replace pid-file + 1 s sleep: `let live = await findLiveProxy()`; if null, spawn `start`
  detached (unchanged) then `live = await waitForProxy(...)` (existing polling helper at
  `src/cli.ts:92-100`); `guiPort = live?.port ?? config.port`.

**MODIFY `src/config.ts` — `applyProxyEnv`** (F9)
- NO_PROXY append list becomes `["localhost", "127.0.0.1", "::1", "[::1]"]` with
  case-insensitive dedup against existing entries.

**MODIFY `src/doctor.ts`** (F10)
- `resolveCodexHomeDir` runs `expandUserPath(raw)` before `resolve()` (same helper the
  runtime paths use — verify import site in B).

**MODIFY `src/update.ts`** (F1 parity — added during B)
- The bun-install update path had the mirrored gap: gate `serviceWasInstalled || readPid()`
  misses orphaned proxies (live server, stale/missing pid file). Gate and post-stop abort
  check both add `readRuntimePort()`.

## Tests

- `tests/proxy-liveness.test.ts`: orphan adoption (no pid file, valid runtime record,
  identity probe OK → returned with record port/pid; identity mismatch → config fallback);
  `hostname` present on returned `LiveProxy`.
- `tests/cli-status.test.ts` (or nearest): `selectListenTarget` healthUrl for `::1` is
  bracketed; wildcard still 127.0.0.1.
- `tests/proxy-env.test.ts`: NO_PROXY gains `::1`,`[::1]`; no dup when preexisting
  (case-insensitive).
- `tests/uninstall.test.ts`/`tests/service.test.ts` regression: unchanged paths still pass.
- doctor: unit for `resolveCodexHomeDir` with `CODEX_HOME=~/x`.

## Verification gate (C)

`bun test ./tests/` (0 fail) + `bun x tsc --noEmit` (0 errors).
