# 010 — Source findings: supervision is exit-only

Checked on `origin/dev` 7af092ca4f.

| Supervisor | Where | Liveness signal | Hung-but-listening proxy |
|---|---|---|---|
| Windows Task Scheduler wrapper | `src/service/windows-taskxml.ts` `buildWindowsServiceScript` (`:loop`, the `"%OCX_BUN%" "%OCX_CLI%" start` line, then `goto loop`) | cmd.exe returns only when the child exits; any code other than 42 (`WINDOWS_WRAPPER_STAY_OUT_EXIT_CODE`) restarts after ~5 s | Never recovered: the batch blocks on the child |
| launchd | `src/service/launchd.ts` `buildPlist`: `KeepAlive` → `SuccessfulExit=false` | Restart on non-zero exit or signal | Never recovered |
| systemd | `src/service/systemd.ts`: `Restart=on-failure`, `RestartSec=5` | Restart on failure exit or unclean signal; SIGTERM counts as clean | Never recovered |
| WinSW (native Windows service) | `src/lib/winsw.ts`: `<onfailure action="restart" delay="5 sec"/>` | Restart on a failing exit of the child | Never recovered |
| Desktop (Tauri) | `desktop/src-tauri/src/supervisor.rs` `classify`: `Probe::Inconclusive => Watch::Counting(0)`; module doc: "Timeouts and unauthorized or unreadable answers never count" | Child exit (`on_exit`) or N refused connections / a different pid answering | Never recovered: a timeout resets the streak to 0 |
| In-process memory watchdog | `src/server/memory-watchdog.ts` | Warn-only above 4 GiB, never restarts | Its timer shares the stalled event loop |

Consequence: in all four managers the only way to turn "alive but unresponsive" into a
restart is to make the process exit. Every manager already restarts after an unclean
exit (exit code 1 on Windows TerminateProcess; SIGKILL on POSIX, which systemd treats as a
failure while it treats SIGTERM as clean). So a component that terminates a verified, hung
proxy reuses all existing restart paths without changing any of them.

The desktop sidecar is a compiled standalone binary (`isStandaloneBinary()`), which cannot
run a separate TypeScript entry; it keeps its Rust watchdog. Counting timeouts there would be
a separate Rust change with the same policy and is left as a follow-up.


## Facts found during the audits

- libuv (as pinned by Bun 1.4.x) places a non-detached Windows child in a kill-on-close Job but
  ignores `ERROR_ACCESS_DENIED` from the assignment, so "the child dies with the parent" is not
  guaranteed on Windows; the sentinel holds a process handle instead.
- Bun's `process.ppid` is read live on POSIX (measured on macOS with Bun 1.4.0: it became 1 after
  the parent was SIGKILLed) but is the creating parent's id on Windows.
- `markDelegatedServiceReady()` announces bind completion, before startup reconciliation; the
  sentinel therefore starts after `reconcileClientStartupBeforeReady`.
- The ownership mutation lease (`src/service/ownership-mutation-lease.mjs`) waits with
  `Atomics.wait` and only spawns a subprocess to describe a holder on timeout; the sentinel passes
  `processImage: () => null` so it never spawns.
