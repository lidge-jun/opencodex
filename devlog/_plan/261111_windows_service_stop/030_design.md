# 030 — Recommended design: one checked Windows stop (B1, with C as a later addition)

## Operation

`stopWindowsServiceChecked(home)` is shared by `ocx stop` and `ocx service stop` on the Task Scheduler and WinSW backends. It returns one of:

- `stopped`: the manager is inactive (observeWindowsGuardedManagerStopped = inactive) and nothing answers on the recorded port within the deadline.
- `survived`: a bound wrapper or child is still alive, or the port still answers with this installation's identity, after the deadline.
- `denied`: a terminate or `/end` failed with access denied (for example an elevated task stopped from an unelevated shell).
- `unknown`: identity evidence was unreadable; nothing was killed on that evidence.

## Steps

1. Bind. Read the registration (`windowsTaskRegistrationIsOurs` / WinSW binary path), the running wrapper PIDs that carry this home's canonical launcher/script paths as complete tokens, and the proxy child (`readPid` identity plus ancestor chain to a bound wrapper). Record each as (pid, process start time, command-line digest). Unreadable command line for a candidate under the bound manager makes the whole operation `unknown` rather than skipping it (fixes the silent skip in the current cleanup).
2. Ask the manager first. Task Scheduler: `schtasks /end`; WinSW: the existing stop. Treat non-benign errors as evidence (`denied` on access denied), not silence.
3. Terminate bound survivors only. For each bound wrapper, then the child: revalidate (pid, start time, command-line digest) immediately before terminating; a mismatch means PID reuse and the process is left alone. Termination uses `TerminateProcess` through a trusted path (in-process FFI where available, else trusted PowerShell `Stop-Process` with the result read back), never by image name.
4. Observe. Poll `observeWindowsGuardedManagerStopped` and the port (identity-checked `proxyIdentityAt`) until `stopped` or a bounded deadline (proposal: 10 s, covering the 5 s relaunch delay twice).
5. Report. `ocx stop --json` / `ocx service stop` print the outcome and the fixed reason; a non-`stopped` outcome exits non-zero and keeps client/runtime records (no cleanup claimed). Desktop maps `denied` to an elevation hint and `survived`/`unknown` to a terminal state with the reason, never auto-elevating.

## Trigger races

Logon/session triggers or restart-on-failure can start a new instance during the stop. B1 handles that by observing a new wrapper as `survived` (honest), not by retrying without bound. B2 (disable during stop) is deferred: it changes persistent task state and needs its own interrupted-stop recovery design.

## Later: C

New wrapper scripts can check a per-installation stop token before relaunching, making step 3 unnecessary in the common case. Legacy wrappers still go through B1, so C is an optimization, not a replacement.

## Out of scope

Elevating automatically, killing anything not bound in step 1, changing the update path's `stopWindowsChecked` semantics (it can adopt the new operation later), and macOS/Linux (launchd/systemd already stop their child and are verified by the guarded-manager path).
