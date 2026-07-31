# Windows/Linux Deploy Stability — Loop 8: close-out audit (D)

- **Date:** 2026-07-03 · **Branch:** dev · **Class:** C3
- **Goal:** audit every prior-loop fix against current code (HEAD 69c56e3) and close the item.
- **Method:** 5 parallel Opus subagents, one per subsystem, read-only, verifying each finding is
  present + correct in current source (file:line). Main session spot-checked the two open findings.

## Audit verdict per cluster

| Cluster | Findings | Verdict |
|---|---|---|
| Windows shim/service encoding + install lifecycle | F2 (chcp/BOM/env-indirect), F5-l1 (ping vs timeout), F8-l7 (stop-before-write + retry, utf16le XML) | ALL CONFIRMED-FIXED (`service.ts:295/320/416-428`, `codex-shim.ts:237`, `win-paths.ts`; tests incl. `한글사용자` fixtures) |
| Self-update / npm-spawn | F1, F1 audit-9, F7 | CONFIRMED-FIXED (`bin/ocx.mjs:99-149`, `src/update.ts:56-137`) + **1 NEW open (fixed below)** |
| Graceful stop / lifecycle | F3 | CONFIRMED-FIXED (`process-control.ts:56-96`, `cli.ts:143-279`, `server.ts:2051-2061`); 2 accepted residuals |
| Networking (loopback/oauth/port) | F4-l1, F5-l7, F6-l7 | CONFIRMED-FIXED (`codex-inject.ts:33-42`, `callback-server.ts:148-169`, `ports.ts:8-14`, `cli.ts:117-128`) + F4 symmetry note (fixed below) |
| Linux (openUrl/systemd) | F6-l1, F9 | F6 CONFIRMED-FIXED (`open-url.ts:23`); **F9 was STILL-OPEN (fixed below)** |

## Fixes applied this loop (to make it closeable)

1. **ocx.cmd shell-less restart → EINVAL (Windows, bun/source GUI restart).** `update-job.ts`
   `restartCommand()` non-npm branch spawned `ocx.cmd` shell-less (`spawn`/`spawnSync` at `:250/267`)
   → EINVAL on Node/Bun ≥18.20/20.12 (same CVE-2024-27980 class F1/F7 fixed). Now restarts via
   `process.execPath` + the package launcher (both real `.exe`, no shell). `ocxBin()` removed.
2. **F9 systemd no-DBUS SSH false negative.** `service.ts` `isSystemd()` hard-failed on
   `systemctl --user show-environment`, which errors in an SSH session without a user D-Bus even
   when systemd is present → first-time `ocx service install` wrongly refused. Added
   `userRuntimeDir()` + `ensureUserBusEnv()`: point `XDG_RUNTIME_DIR` at `/run/user/<uid>` when
   unset, fall back to its existence as the systemd-present signal, and ensure the bus env before
   `installSystemd` runs the `--user` commands.
3. **F4 explicit-localhost bind symmetry (D's note).** `server.ts` bind now canonicalizes a literal
   `hostname: "localhost"` to `127.0.0.1` (matching the injected base_url), while leaving wildcards
   (`0.0.0.0`/`::`) and specific hosts untouched so intentional exposure is preserved.

Regression guards: `tests/windows-deploy-close-regressions.test.ts` (5 source-contract cases).

## Accepted residuals (documented, not blocking — narrow Windows signal-model limits)

- **Windows service-managed stop skips the `/api/stop` drain.** `schtasks /end` hard-terminates the
  task tree before `stopProxy` runs; in-flight turns are cut. The F3 objective (no stale
  pid/runtime-port, config restored) is still met because those run in the CLI stop process after.
  Non-service (manually started) proxies get the full graceful drain.
- **Windows Ctrl+Break (SIGBREAK) unhandled.** The proxy registers SIGINT/SIGTERM/SIGHUP only;
  Ctrl+Break falls to Node's default terminate and bypasses `process.on("exit")` cleanup. Console
  window-close (SIGHUP emulation) is handled; the launcher already flags Windows signal forwarding
  as best-effort.

## Verification

`npx tsc --noEmit` → 0 · `bun test ./tests/` → 1370 pass / 0 fail (incl. new regression file).
Cross-platform CI (ubuntu/windows/macos) is the standing safety net; the release cut this day
(2.6.19) passed it.

## Status: CLOSED — moved to `_fin`. All 9 original findings + loop-7 findings resolved; 2 narrow
Windows signal-model residuals accepted and documented above.
