# 010 — PR #152 absorb: keep configured port after update restart

## 1. Scope and locked inputs

Absorb community PR #152 from immutable source head
`e91da0817361af872247b0b46e7904b4a0b9ee71` (`codex/source-pr152-e91da081`,
4 commits) onto local `dev`, then land maintainer repairs for the Sol FAIL
findings. No push. Attribution per `000_plan.md`.

Source delta (10 files, +180/−22):

- `src/server/ports.ts` — NEW `waitForPortAvailable`, `findAvailablePort` gains
  `preferRetryMs`/`preferRetryIntervalMs`.
- `src/cli/index.ts` — `chooseListenPort` uses 750ms prefer-retry; update-worker
  dispatch awaited.
- `src/config.ts` — NEW `readAlivePid` (cheap liveness pid), WMIC-first Windows
  cmdline probe with PowerShell fallback + `windowsHide`, per-process cmdline memo.
- `src/lib/process-control.ts` — `windowsHide` on taskkill.
- `src/server/proxy-liveness.ts` — `findLiveProxy` defaults to `readAlivePid`.
- `src/update/job.ts` — `restartCommand` pins `--port`, `restartAfterUpdate`
  waits up to 2s for port free after kill, worker async.
- Tests: ports/update-job/usage-debug/windows-deploy-close-regressions.

`git merge-tree --write-tree dev codex/source-pr152-e91da081` → clean
(`1e01a3c8b370`).

## 2. Sol review verdict (2026-07-19, lane A)

`VERDICT PR#152: FAIL` — absorb proceeds only WITH the maintainer repairs below
landed in the same work-phase (A-gate for the implementation cycle re-audits the
repaired plan).

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | P1 | `readAlivePid` default in `findLiveProxy` lets a pidless legacy health response return a reused/unverified PID which `handleStop` will kill (proxy-liveness.ts:91-101, config.ts:846, cli/index.ts:292-295); breaks existing invariant tested at proxy-liveness.test.ts:111-121 | FOLD — DECIDED (round-3 amendment): `LivenessIo` gains `verifyPidFn: (candidatePid: number) => number \| null` (default wraps `readPid`-style cmdline identity check OF THE PASSED candidate) alongside `readPidFn` (default `readAlivePid`, cheap discovery only). In the pidless-legacy branch `findLiveProxy` calls `verifyPidFn(candidatePid)` and returns a killable pid ONLY when the verified pid `=== candidatePid`; any mismatch or null → result `pid: null`. This closes the TOCTOU window where the pidfile changes between discovery and verification |
| 2 | P1 | The 2s `waitForPortAvailable` never runs in the real GUI-update sequence: stop-first update clears pid state before `restartAfterUpdate`, so `if (pid)` is false; only the 750ms prefer-retry remains — 751-2000ms drain still hops ports | FOLD — DECIDED: in `runGuiUpdateWorker`, capture `const rt = readRuntimePort(); const capturedPort = rt?.port ?? config.port ?? 10100; const capturedHostname = rt?.hostname ?? config.hostname ?? "127.0.0.1"` BEFORE invoking the stop-first update command; pass both into `restartAfterUpdate`, which calls `waitForPortAvailable(capturedPort, capturedHostname, {timeoutMs: 2000, intervalMs: 25})` unconditionally (drop the `if (pid)` gating for the wait) before `spawnDetachedStart` |
| 3 | P2 | Tests don't activate either integration path (restartCommand arg-shape only; stale-PID regression injects readPidFn) | FOLD — add behavior tests: worker→stop→restart sequence with a fake port occupier; findLiveProxy default-path test proving pidless-legacy no longer yields a kill target |
| 4 | P3 | usage-debug test shrink unrelated to port fix | FOLD — land as its own commit (test maintenance), matching source commit `8865dc2c` boundary |

## 3. Landing plan (commit map)

1. Wibias-author pick of `ec1eace1` + `94adfd1f` (port pinning + console hide +
   test contract) — source-faithful.
2. Wibias-author pick of `8865dc2c` (usage-debug shrink) — separate commit per P3.
3. Maintainer repair commit (+Co-authored-by): P1#1 pid-identity guard,
   P1#2 unconditional captured-port wait, P2 behavior tests.

(`e91da081` is a no-op marker commit "leave ACL for separate PR" — skip.)

## 4. Verification

- `bun run typecheck` exit 0.
- `bun test tests/ports.test.ts tests/update-job.test.ts tests/proxy-liveness.test.ts tests/usage-debug.test.ts tests/windows-deploy-close-regressions.test.ts` pass.
- C-ACTIVATION mechanics:
  - pidless-legacy: extend `tests/proxy-liveness.test.ts` using the existing
    `LivenessIo` seam — inject `readPidFn` returning a live-but-foreign pid,
    `verifyPidFn` returning null (identity failed), and a fetch stub returning
    a pidless healthz body; assert result `pid` is null. A second case injects
    `verifyPidFn` echoing the candidate (identity ok) and asserts it is
    returned. A third case (TOCTOU regression) injects `verifyPidFn` returning
    a DIFFERENT pid than the candidate and asserts result `pid` is null.
  - captured-port wait: `tests/update-job.test.ts` — bind a real socket on an
    ephemeral port, invoke the restart path with injected config/port, release
    the socket at T+300ms, assert the spawned start args pin `--port <captured>`.
    DECIDED seam: `restartAfterUpdate` gains an injectable io object
    `{ waitForPort?: typeof waitForPortAvailable; spawnStart?: ... }` (test
    injects a recording spawnStart; wait result observed via the recorded args
    plus a wait spy in the same io object).
