# Windows Checked Service Stop

The checked Windows service stop (#7771) is a library of primitives and two operations that
stop a Task Scheduler or WinSW manager, end the wrappers that would relaunch the proxy, and
then confirm the port is free. Every Windows stop path that also restores shared client state
uses it: `ocx stop` with and without a consent snapshot, `ocx uninstall`, `/api/stop`,
`ocx service stop` / `uninstall` / `remove`, service install and backend switch, and the updater.
The best-effort path-token sweep in `src/lib/windows-service-wrappers.ts` is no longer called by
any stop path. `ocx service repair` is the one remaining exception: it still stops the manager
through `stopWindows()` (`src/service/repair.ts:259`) because it does not restore shared client
state, so the #3008 relaunch window this stop exists to close does not apply to it. Wiring repair
is its own follow-up slice (`devlog/_plan/261111_windows_service_stop/060_implementation.md`,
"Follow-up slices"). macOS and Linux keep their manager stops and timing; only the signatures
turned async. The design and its slices live in `devlog/_plan/261111_windows_service_stop/`.

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
running, it reads the Schedule host PID (2 s). A WinSW-only registration also binds against a
process enumeration, including when WinSW is stopped, so ancestry and stray-wrapper evidence
are checked before a stop can be confirmed. Admission then compares the time left on the
caller's deadline, which already excludes these first steps, with the worst case still to come,
and returns `unverified-budget` without changing anything when it does not fit. It binds, ends
the task (`schtasks /end`, 2 s) or stops WinSW (a
2 s stop command and an SCM poll capped at `<stoptimeout>` + 2 s), terminates bound survivors
deepest first, waits on the bind-time watches (terminates and wait share 3 s), and reads the
manager state once (1 s). Denied stops every further step. A cap overrun is `unknown`. A wrapper or
manager still running is `survived` (`unbound-wrapper` when the survivor was never bound). WinSW
is `survived` while the proxy is still alive after the service reports stopped. The authorizer
variant `guardedStopWindowsServiceChecked` runs its authorizer at entry, before each manager stop (/end, the WinSW stop) and before each terminate and
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
and 50.5 s for WinSW. Each includes the 0.5 s closing port sample that Part B can take past its
window.

## Callers

`src/service/windows-checked-stop-live.ts` is the production side of every seam: capped
asynchronous `schtasks` and `sc.exe` calls through `execFile` (a deadline-derived timeout is
floored to whole milliseconds and one that floors to 0 spawns nothing, because `execFile` reads 0
as no timeout), the evidence snapshot `windowsProcessSnapshot` for every bind, the checked
terminate, the exit watch, the Part B port sampler and the listener identity. The task's running
state is read from `schtasks /query /fo CSV`, falling back to `Get-ScheduledTask` inside the same
1 s cap when the status word is localized. A running WinSW service is only this home's manager
when `sc qc` shows a `BINARY_PATH_NAME` naming this installation's WinSW executable, the same
proof the guarded manager path uses: the service ID is fixed, so a successful `sc query` alone
would let Part A stop another installation's service. An unreadable registration is `unknown`
(`evidence-unreadable`, nothing changed); a foreign executable is reported as `nonexistent`, so
Part A stops nothing and answers `absent`.

The port sampler is `sampleWindowsStopPort(port, timeoutMs)`, async and bounded by the caller's
timeout: it runs `netstat.exe` from the trusted System32 directory through `execFile` with that
timeout and `SIGKILL`, and a scan that misses the timeout, or cannot be read, samples `unknown`.
A synchronous scan would ignore the cap and could stall the stop for the helper's own 5 s. A row
whose owner has exited is cleared like `reclaimListenPort` does, but only the rows that exited
PID owns: `dropWindowsTcpRowsForLocalPort` takes an owner filter, so a program that took the port
between scans keeps its connections. The listener identity is
tri-state over `inspectOcxStartProcessIdentity`: only a positive `mismatch` is `foreign`, and an
`unverifiable` probe (another account's or an elevated process's command line) stays `unknown`.
`verifyPidIdentity`'s null collapses those two, which would report a listener we merely could not
read as another program holding the port.

`src/service/windows-service-stop.ts` is what callers call: `runWindowsServiceStopPartA` (optional
admission, a reused bind snapshot, the updater's authorizer, a hard cap for the route),
`confirmWindowsServiceStop` (Part B), the mapping onto `ServiceStopOutcome` (absent, stopped;
survived, denied and unverified-budget are failed; unknown is state-unknown), the additive
`serviceStopReason` and the receipt record. The deadline lives in
`src/service/windows-stop-deadline.ts`, and its origin depends on who is stopping. `ocx stop`
takes `--deadline-ms <n>`, else `OCX_STOP_DEADLINE_MS` (empty or invalid counts as absent), else
60 s, measured from the command's own start: that is the operator's budget, and
`performance.now()` counting from `performance.timeOrigin` makes it an absolute value on the Part
A clock. Every other caller starts the default 60 s when its stop phase begins, because it
reaches the stop after work it cannot charge to the stop — the scheduler registration and the UAC
prompt — and a budget measured from process start could already be spent, which made admission
refuse `unverified-budget` a stop that had its whole budget left. The first deadline read in a
stop phase arms it and later reads inside that phase keep it, so one deadline governs the whole
stop instead of sliding forward.

- `stopServiceIfInstalledReport` / `stopServiceIfInstalledDetailed` (`src/service/orchestration.ts`)
  are async and run Part A on Windows. On Windows Task Scheduler never yields `stopped-respawnable`.
- Plain `ocx stop` (`src/cli/stop-windows-checked.ts`) admits against the deadline with orphan
  discovery and the inherited receipts counted. A Part A other than stopped or absent holds the
  child: no `/api/stop` POST, the shared teardown skipped, `service` failed or state-unknown,
  `proxy` unknown. A thrown Part A also holds the child and reports a service error. After a stopped Part A, the POST skips `stopProxy`'s legacy 15 s
  `waitForStoppedPort`, orphan discovery is capped at 3 s, and Part B replaces the respawn re-poll:
  our identity back on the port is `proxy: respawned`, an unconfirmed port is
  `evidence-unreadable`, and another program on the port sets `portHeldByForeign` without failing
  the stop. The port wait is skipped on BOTH Windows paths, guarded included, through
  `windowsPartBOwnsPortWait`; `windowsPartBDue` stays snapshotless-only because it also gates the
  legacy respawn re-poll. A failed owner receipt claim refuses the child stop and shared teardown
  on both paths. `ocx uninstall`'s two `stopProxy` calls pass the same predicate.
- The guarded path reads the evidence snapshot and the Schedule host PID once per inspection;
  `stopManager` binds on the revalidation's snapshot (so its admission does not count a second
  enumeration), Part B runs after `settle` on the approved endpoint, and the manager-state checks
  reuse Part B's final enumeration.
- A registered task whose state is `not-running` promotes its surviving wrappers to `bound-stray`
  only after `winTaskXml` and `winRegistrationOurs` pass (`src/service/windows-guarded-manager.ts`).
  The state word says the task is inert, not that it is ours; promoting on the word alone let a
  same-named foreign task make this home's hand-started wrappers terminable. Nothing surviving
  keeps the `absent` verdict without the read; an unreadable definition is `evidence-unreadable`
  and a definition that is not this installation's is `unknown`, both leaving the previous
  verdict.
- The teardown receipt carries the Part A record (`partA` stopped or absent, the registered
  managers, the ended wrappers as pid + creation time): written at the claim, or added by the owner
  for a receipt claimed before Part A. `/api/stop` (`src/server/stop-service-route.ts`) skips its
  own Part A only for a record whose managers are still the registered ones; a receipt without it
  runs Part A capped at 6 s; without a receipt a registered WinSW keeps its in-process stop and
  anything else gets the stray sweep capped at 4 s. A cap overrun is `service_state_unknown`, and
  the manager commands and terminates are gated off once the cap has passed.
- `ocx service stop` (`src/service/cli-windows-stop.ts`) refuses on a Part A other than stopped or
  absent, claims a teardown receipt before the deferred tracked-proxy stop when this home owns the
  shared teardown (a failed claim sends no child stop), runs Part B, and clears the receipt only
  after the restore. With Part A absent it requires every candidate endpoint to be definitively
  dead; live or unknown keeps the receipt and blocks restoration. `ocx service uninstall` / `remove` refuse before deleting the task unless
  Part A stopped (or found nothing) and Part B did not find our identity or an unreadable port.
  Removal claims the same receipt, carrying Part A's record, before its child stop: Part A leaves
  the scheduler task registered, so a receipt-less POST answers `respawnable_service` (409) and
  the removal refuses with the proxy left running. The receipt is discharged only after the
  shared restore, and a failed claim sends no child stop. Part A `absent` says no manager is
  registered, not that nothing serves, so removal then proves every candidate endpoint
  (`endpointsToProve(readRuntimePort(), loadConfig())`, the set `ocx uninstall` proves) tri-state:
  only a definitive dead on all of them permits deleting the task, while live or unknown refuses
  and keeps the receipt. The receipt endpoint alone is not enough — a stale runtime record naming
  a closed port must not stand in for the configured port where a live listener can sit.
- Every tracked-proxy stop takes its orphan-discovery cap from the caller
  (`TrackedProxyStopIo.orphanDiscoveryCapMs`). The checked Windows callers pass the admitted 3 s
  (`WINDOWS_STOP_CAPS.orphanDiscovery`), which is what admission priced; the omitted default stays
  the legacy 7 s so macOS and Linux timing is unchanged.
- Windows service stop, removal and install resolve one tracked or discovered proxy target before
  claiming its receipt. The receipt and POST use that target's exact endpoint; Part B checks its
  port. No target means no receipt or POST. An owning caller refuses a target without an endpoint.
- `ocx uninstall` (`src/cli/uninstall-stop.ts`) resolves its stop target before it claims
  anything: the tracked pid with its own runtime endpoint, or the discovered live proxy with the
  endpoint discovery found it on. The receipt and `stopProxy` then name the same endpoint, so a
  stale runtime record cannot produce a receipt for a port the stop never contacted, and no target
  means no receipt at all (a guessed obligation recovery cannot resolve is worse than none). The
  tracked record is removed only for a stop that was proven, and the step reports a change only
  when state changed. When Part A did not end stopped or absent the graceful POST still goes out
  with `allowForcedFallback: false`, and that unconfirmed wait is observational: it samples the
  port without `reclaimListenPort`'s kill eligibility, so a forbidden fallback cannot kill through
  the reclaim path either. An unconfirmed stop is not proof the proxy is down: `stopProxy` answers
  false without contacting the endpoint when the tracked pid is already dead, so the step then
  requires the tri-state `endpointProvenDown()` over every candidate before it reports
  `provenDown`, exactly as the discovery path does. A different proxy on the configured port
  would otherwise be missed and shared config restored under it (#3008).
- `ocx uninstall` removes the Windows manager only after a Part A that ended stopped or absent
  (`serviceRemovalAllowed` in `src/cli/uninstall-plan.ts`); otherwise the step records `failed` and
  leaves the registration, as `ocx service uninstall` refuses. `uninstallServiceDetailed`
  (`src/service/orchestration.ts`) reads the scheduler probe, the native status and `sc qc`
  `BINARY_PATH_NAME` before the first destructive step: a registration naming another
  installation's WinSW executable is left untouched, and an unreadable status or ownership
  refuses and keeps install state. The task used to be deleted first, so an unreadable `sc qc`
  left a half-removed install with no task to retry from. Non-Windows removal is unchanged.
- `prepareServiceInstall` refuses before replacing anything on a Part A other than stopped or
  absent and stops install and switch on any Part B result other than a free port, naming the
  owner. `ocx uninstall` runs Part B as its respawn window after a stopped Part A.
- Install and backend switch claim a teardown receipt before their tracked stop when Part A
  ended `stopped`: the task is still registered, so a receipt-less POST answers 409
  `respawnable_service` and the install aborted while the old proxy kept serving. The receipt
  carries Part A's record and its nonce travels on the POST. An install replaces the proxy, so
  shared config stays pointed at OpenCodex and the receipt is cleared only after the new service
  is installed and started; an install that fails after the stop keeps it for the next
  `ocx stop`. A failed claim sends no child stop.
- With Part A `absent`, install preparation skips Part B, and the tracked stop can return
  `"none"` after its orphan-discovery cap while an unresponsive proxy still holds the port. The
  candidate set is resolved before cleanup and every endpoint must be definitively dead before
  the install callback runs; live or unknown throws like a Part B failure.
- The updater (`src/update/job-windows-restart.ts`) uses `guardedStopWindowsChecked` for both
  backends, with the service mutation gate as the authorizer. Each of the
  three call sites in `src/update/job.ts` aborts the restart unless the outcome is stopped or absent.

## Who may run Part A

The binding rule excludes the stopping process but not its ancestors. A stop that runs beneath a
wrapper carrying this home's launcher or service-script path would end its own supervision chain,
so `runWindowsServiceStopPartA` refuses such a stop with nothing changed (`unknown`, "runs under
this home's service wrapper") by checking the bind snapshot's ancestry of the current PID. Two
callers opt out on purpose: `/api/stop` runs inside the wrapped proxy, and the updater's worker
descends from the service-run proxy; both exist to end that wrapper, and ending an ancestor never
ends the stopper. Every interactive caller (`ocx stop`, `ocx uninstall`, `ocx service`
commands, install and switch) refuses.

## ARM64

No ARM64 device run exists, so ARM64 ships the strict variant (050).
`terminateWindowsProcessBound` falls back to the PowerShell script whenever the native API is
missing, so the strict gate sits in the caller's adapter: `windowsStopTerminate` answers
`unavailable` whenever `windowsProcessNative()` is null (ARM64, or an x64 whose DLL load failed)
and never reaches the fallback, which leaves Part A `unknown` / `evidence-unreadable` wherever a
terminate would be needed. `WINDOWS_ARM64_BOUNDED_TERMINATE_ENABLED` turns the fallback on once
the 040 ARM64 device case has run.

## Tests

`tests/windows/windows-stop-binding.test.ts`, `tests/windows/windows-checked-stop.test.ts`,
`tests/windows/windows-stop-confirm.test.ts` and `tests/windows/windows-process-evidence.test.ts` are
hermetic: injected deps, a virtual clock and simulated platforms, and no real `schtasks`,
PowerShell or FFI call. The FFI primitive itself is exercised only by the cases gated on real
Windows x64.

The callers are covered by `tests/windows/windows-checked-stop-live.test.ts` (adapters, ARM64
strict, whole-millisecond timeouts, the ancestry check, the bounded port sampler and the tri-state
listener identity), `tests/windows/windows-service-stop-wiring.test.ts`
(the real Part A through the wiring: the own-wrapper refusal, the cap, admission, the deadline's
two origins and the receipt record), `tests/windows/windows-stop-callers.test.ts` (the route, the
service commands, the guarded order, `bound-stray`, the orphan-discovery cap and the bind on the
evidence snapshot), `tests/windows/windows-guarded-manager.test.ts` (the not-running promotion
behind its registration proof) and `tests/windows/windows-stop-ocx-stop.test.ts` (plain `ocx stop`
through the real CLI with the platform simulated). None of them reaches `schtasks`, PowerShell or
FFI.
