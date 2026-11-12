# Windows Checked Service Stop

The checked Windows service stop (#7771) is a library of primitives and two operations that
stop a Task Scheduler or WinSW manager, end the wrappers that would relaunch the proxy, and
then confirm the port is free. **No stop path calls it yet.** `ocx stop`, `ocx service stop`,
`ocx uninstall`, service uninstall and install, `/api/stop` and the updater still use the
best-effort sweep in `src/lib/windows-service-wrappers.ts` and the guarded inspection in
`src/service/windows-guarded-manager.ts`, unchanged. The plan for wiring the callers lives in
`devlog/_plan/261111_windows_service_stop/`.

## Process evidence

`src/service/windows-process-native.ts` holds the in-process primitives for Windows x64. It loads
`kernel32.dll` and `advapi32.dll` from `resolveTrustedWindowsSystemDirectory()`, requires `bun:ffi`
lazily, caches a failed load as unavailable, and closes every handle in a `finally`:

- creation time through `GetProcessTimes`, as epoch milliseconds truncated from the FILETIME;
- a checked terminate: `OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)`,
  the creation time read on that handle and compared with the bound value, `TerminateProcess` on
  the same handle. The result is `terminated`, `gone`, `reused` (identity mismatch, untouched),
  `denied` or `unavailable`;
- an exit watch: a handle opened at bind time and polled with `WaitForSingleObject(handle, 0)`;
- the Task Scheduler service host PID through `QueryServiceStatusEx` on `Schedule`, only while it runs.

Windows ARM64, other platforms and any test that simulates a platform get no native API.
`src/service/windows-process-evidence.ts` is the facade the operations use. Its process snapshot is
one capped `Get-CimInstance Win32_Process` query that emits `CreationDate` as an ISO UTC string. On
x64 each creation time is re-read natively and kept only when it agrees with CIM to the
millisecond; a disagreement (a PID reused between the two reads) is unreadable. Elsewhere the
CIM time is the bound value. The Schedule PID falls back to `sc.exe queryex Schedule` from the
trusted system directory with a cap. The ARM64 terminate is one trusted PowerShell script that
re-reads `Get-Process -Id` StartTime, compares it with the bound time within 1 s (UTC), calls
`Kill()` on the same `Process` object and reads the exit back. `Kill()` opens its own handle by PID, so
a window between the in-script check and the kill remains; that window and the 1 s tolerance are
the accepted residuals of the fallback. Only integers reach a script: a fractional timeout is
floored to whole milliseconds, and one that floors to 0 spawns nothing.

With no ARM64 device run, 050 ships ARM64 with the strict variant (kill nothing, report `unknown`).
`terminateWindowsProcessBound` does not enforce that: on win32 without the native API it runs the
fallback script. The caller's terminate adapter gates strict itself; see
`devlog/_plan/261111_windows_service_stop/060_implementation.md`.

## Binding rule

`src/service/windows-stop-binding.ts` decides, as a pure function over a snapshot, which processes
may be terminated. A process is bound only when its image is `wscript.exe`, `cscript.exe` or
`cmd.exe`; its command line carries this home's launcher VBS or service script path as a complete
token; it is an ancestor of the identity-checked child, a descendant of a bound wrapper, a child
of the Schedule host (SCM PID), or, only while this home's task is registered, an orphan (a parent
that is missing or was created after it); and its creation time was read. The proxy child is
never a candidate. A wrapper that matches image and path but fails lineage is reported unbound and
left alone. Unreadable evidence about a candidate is reported unreadable: a matching wrapper
without a creation time or image name, and a wrapper image with no readable command line under a
bound wrapper or, while a manager is registered, above the child. Bound wrappers are ordered
deepest first and carry pid, creation time, image and a SHA-256 digest of the command line.

## Part A and Part B

`src/service/windows-checked-stop.ts` is Part A, `stopWindowsServiceChecked(deps, options)`. Every
external effect is injected. It probes registration (2 s each). An unreadable answer is `unknown`
with nothing changed. With nothing registered it enumerates once for a stray wrapper of a deleted
task; an unreadable table or no wrapper is `absent`. With a task registered or a stray sweep
running, it reads the Schedule host PID (2 s). Admission then compares the time left on the
caller's deadline, which already excludes these first steps, with the worst case still to come,
and returns `unverified-budget` without changing anything when it does not fit. It binds, ends
the task (`schtasks /end`, 2 s) or stops WinSW (a
2 s stop command and an SCM poll capped at `<stoptimeout>` + 2 s), terminates bound survivors
deepest first, waits on the bind-time watches (terminates and wait share 3 s), and reads the
manager state once (1 s). Denied stops every further step. A cap overrun is `unknown`. A wrapper or
manager still running is `survived` (`unbound-wrapper` when the survivor was never bound). WinSW
is `survived` while the proxy is still alive after the service reports stopped. The authorizer
variant `guardedStopWindowsServiceChecked` runs its authorizer at entry and before each terminate and
reports a refusal as `WindowsCheckedStopRefusedError` with what had already happened.

Each step that asks the machine runs under a cap that races a timer and rechecks the elapsed time
on the injected clock. Opening the bind-time watches and the authorizer are not capped. The
authorizer runs inside the shared 3 s terminate-and-wait window, so its time comes out of that
window, and an authorizer that never returns hangs Part A; its caller bounds it. Part A has no
overall cap either, so a caller with a tighter bound than the sum of the caps (the `/api/stop`
route's 4 s sweep and 6 s Part A in 030) needs an outer race or smaller caps.

`src/service/windows-stop-confirm.ts` is Part B, `confirmWindowsStopFreed(deps)`, run after the caller's
graceful child stop. The port must stay free for a 6 s hold, measured between sample starts,
inside a window of `min(12 s, remaining - 0.5 s - 5 s - reserve)` with a 6 s floor. A final
enumeration (5 s, sharing its cap with the listener identification) must show no wrapper image
with this home's path token. An unreadable table is not success. A listener is ours
(`survived`), foreign (`portHeldByForeign`) or left by an exited owner, which is not foreign.
`resolveWindowsStopPort` picks the runtime-port record, then the wrapper's baked port, then the
configured port.

`src/service/windows-stop-budget.ts` holds the caps and the admission arithmetic. With default
settings the minimum is 48.5 s for a guarded Task Scheduler stop, 56.5 s for a snapshotless one
and 42.5 s for WinSW. Each includes the 0.5 s closing port sample that Part B can take past its
window.

## Tests

`tests/windows/windows-stop-binding.test.ts`, `tests/windows/windows-checked-stop.test.ts`,
`tests/windows/windows-stop-confirm.test.ts` and `tests/windows/windows-process-evidence.test.ts` are
hermetic: injected deps, a virtual clock and simulated platforms, and no real `schtasks`,
PowerShell or FFI call. The FFI primitive itself is exercised only by the cases gated on real
Windows x64.
