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
  then compare the creation time with the bound value and read the token user on that handle.
  Call `TerminateProcess` on the same handle only when the token user SID equals the current
  process token user SID. The result is `terminated`, `gone`, `reused` (creation mismatch),
  `owner-unverified`, `denied` or `unavailable`;
- an exit watch: a handle opened at bind time and polled with `WaitForSingleObject(handle, 0)`;
- the Task Scheduler service host PID through `QueryServiceStatusEx` on `Schedule`, only while it runs.

The Link Child reads its live same-user creation proof in-process on one native handle, using `GetProcessTimes` and the token user SID; stop-owner argv is read through that same handle by `src/config/windows-process-command-line.ts`. It preserves the existing .NET tick identity at microsecond precision without spawning PowerShell or caching a PID proof. The process fallback compares that identity on the same handle used for termination. Unavailable native identity or handle binding refuses promptly; it does not fall back to repeated CIM subprocesses. `tests/windows/windows-stop-owner-identity.test.ts` covers handle ownership, stale identities and an actual-Windows-only repeated-read budget.

Windows ARM64, other platforms and any test that simulates a platform get no native API.
`src/service/windows-process-evidence.ts` is the facade the operations use. Its process snapshot is
one capped PowerShell snapshot that emits UTF-8 JSON and uses ISO UTC for `CreationDate`.
It reads owner SIDs for command lines carrying this home's launcher or service script as complete
tokens first, then other wrapper images, unreadable images, and command lines containing the fixed
`opencodex-service` basename prefix. Owner enrichment admits at most 32 candidates within
1.5 s including enumeration and prioritization, with a 1 s operation timeout on each owner or refresh
call. Owner reads and refreshes also stop at the snapshot timeout minus 2 s, measured from
the helper process's start. A complete framed table is emitted before optional owner enrichment, so a timeout during
enrichment retains the original rows with unknown owners. A complete enriched frame supersedes
that baseline. Owner evidence arriving at or after either cutoff is discarded.
Owner verification requires a successful `GetOwnerSid`,
valid local/domain or Entra ID SIDs, and a fresh CIM read reporting the original creation time.
Matching SIDs prove the current account. Different supported SIDs prove a foreign account.
On Windows x64, a missing CIM owner sample for a wrapper with this installation's complete
launcher or script path can be supplemented by a query-only live handle. Its process creation
time must exactly match the original CIM microsecond, and its token user must match both the
caller and the supported SID reported by the helper. This bounded probe can confirm a same-user
wrapper only. It does not override conflicting evidence. Built-in and virtual service SIDs and
unresolved lookups remain unverified. Later operations receive nullable `foreignOwner`.
All reads share the snapshot timeout and output cap. On x64 a native creation-time read
must start and finish before the snapshot deadline and agree with CIM within one millisecond.
Otherwise the row retains its ancestry with unknown creation time and owner. Elsewhere the CIM
time is used for observation. The Schedule PID falls back to a capped `sc.exe queryex Schedule`
from the trusted system directory.

## Binding rule

`src/service/windows-stop-binding.ts` decides, as a pure function over a snapshot, which processes
may be terminated. A process is bound only when its image is `wscript.exe`, `cscript.exe` or
`cmd.exe`; its command line carries this home's launcher VBS or service script path as a complete
token; it is an ancestor of the identity-checked child, a descendant of a bound wrapper, a child
of the Schedule host (SCM PID), or, only while this home's task is registered, an orphan (a parent
that is missing or was created after it); its creation time was read; and its owner SID
was verified as the current user's SID. The proxy child is never a candidate. A wrapper that matches image and path but fails lineage is reported unbound and
left alone. A proven foreign owner is excluded from both bound and unbound candidates, while its
row remains available for ancestry so a live parent cannot be mistaken for an orphan.
Unverified ownership on an otherwise eligible wrapper ends Part A with `evidence-unreadable`
before mutation. The output directs the operator to the owning session and Task Manager.
A matching wrapper without a creation time or image name, or a wrapper image with no readable
command line under a bound wrapper or above the child while a manager is registered, also
leaves evidence unreadable. Bound wrappers are ordered
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
the task's verified running instances (2 s for proof and stop together) or stops WinSW (a
2 s stop command and an SCM poll capped at `<stoptimeout>` + 2 s), terminates bound survivors
deepest first, waits on the bind-time watches (terminates and wait share 3 s), and reads the
manager state once (1 s). Denied stops every further step. A cap overrun is `unknown`. A wrapper or
manager still running is `survived` (`unbound-wrapper` when the survivor was never bound). WinSW
is `survived` while the proxy is still alive after the service reports stopped. The authorizer
variant `guardedStopWindowsServiceChecked` runs its authorizer at entry, before each manager stop and before each terminate and
reports a refusal as `WindowsCheckedStopRefusedError` with what had already happened. For Task
Scheduler it reauthorizes after validating the helper proof, before sending `stop-before` on stdin.
With native identity support, each captured running instance carries its GUID, engine PID and
creation time through that exchange. The native handle must prove the matching process and
token user for every engine. The helper rechecks the registration and the captured instances
before calling their COM stop methods. The bounded CIM owner check remains the fallback when
native identity support is unavailable. The
helper and outer deadlines must still be open after authorization. The helper starts its
monotonic clock before sending proof. The parent measures from proof receipt and sends the
earlier deadline as a cutoff on that clock. Time spent delivering approval and refreshing
instances counts toward the cutoff, which the helper checks before each `Stop()`. The outer cap also aborts
the owned helper, including while its registration or instance refresh is pending.
Task-stop verdicts carry separate mutation evidence: a known failure before dispatch leaves
`changed` false even if proof was approved, an attempted stop keeps it true, and a lost answer after dispatch is conservative.
Dispatching approval marks a pending possible mutation until a completed helper verdict proves
otherwise; a timer between dispatch and the first stdout marker must not report `changed: false`.
The helper's `stop-attempted` marker confirms mutation as it arrives. Part A publishes detached
progress at these boundaries, so an outer timer can return pending dispatch and confirmed stop attempts,
bound wrappers and terminations without awaiting unfinished verification. Returned arrays and
records do not change when a late dependency completes.
An authorizer refusal before the outer cap throws with its partial result; after cap expiry it returns the detached cap snapshot with completed mutation evidence.

For the Korean Scheduler status, `사용 안 함` (disabled) proves inactivity and `대기`
(queued) remains active because that instance can still start.

Each step that asks the machine runs under a cap that races a timer and rechecks the elapsed time
on the injected clock. The Scheduler proof-time authorization shares the 2 s task-end cap.
Opening bind-time watches and the other authorization calls have no individual cap. Authorization
before terminating a wrapper spends time from the shared 3 s terminate-and-wait window. Part A has no
overall cap either, so a caller with a tighter bound than the sum of the caps (the `/api/stop`
route's 4 s sweep and 6 s Part A in 030) needs an outer race or smaller caps.

`src/service/windows-stop-confirm.ts` is Part B, `confirmWindowsStopFreed(deps)`, run after the caller's
graceful child stop. The port must stay free for a 6 s hold, measured between sample starts,
inside a window of `min(12 s, remaining - 0.5 s - 5 s - reserve)` with a 6 s floor. A final
enumeration (5 s, sharing its cap with the listener identification) must show no wrapper image
with this home's path token after excluding proven foreign owners. The same exclusion applies
to the unreadable-image check and the guarded manager's candidate checks. Its inspection-only
`windowsProcessList` shares the owner snapshot and parser but does not expose creation times or
gain terminate authority. An unreadable table is not success. A listener is ours
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
terminate, the exit watch, the Part B port sampler and the listener identity.
For Scheduler registration, Part A queries the exact root task with `schtasks /query /tn` and
`/hresult`. On Windows x64 it prepares native exit-code capture during executable lookup,
then reads the full exit code from the spawned process handle. Only
`0x80070002` establishes absence. Bun's truncated process status cannot prove that result.
Where a full exit code is unavailable, the local Scheduler COM API can still confirm the task
or report `ERROR_FILE_NOT_FOUND` from `GetTask` within the remainder of the same 2 s budget.
Denied access, incomplete evidence, and late answers keep the registration unknown.
`src/service/windows-task-instance-stop.ts` keeps the root registration and its running instances
in one Task Scheduler COM session. It passes the registered XML and the helper's current account as
base64 UTF-8 to preserve Unicode through the console. The live adapter checks the recognized task
shape, the exact launcher, and the single run-as principal through `src/service/windows-taskxml.ts`.
The logon scope and every recovery-trigger scope must match the expected account. Only the
recognized legacy shape without recovery triggers may omit the logon scope. The stop proof accepts a disabled task with the same
ownership evidence. Installation health still requires an enabled task.
Each `EnginePID` requires the native identity proof described above when available.
The CIM fallback re-reads process creation time after checking the owner SID. After approval the
helper re-reads the registration XML and refreshes every captured instance to verify that its GUID,
engine PID and running state still agree.
It stops each captured `IRunningTask` by instance GUID. An empty collection counts as idle only if
the final task state shows ready or disabled before the stop deadline. Failed proof returns
`evidence-unreadable` with instructions to verify the task in Task Scheduler and repair an owned
registration or contact its owner or administrator. Ending a running instance alone does not repair
an unverifiable registration.

The Scheduler exposes current registration XML separately from instance identity. An instance
already running under the same account from an earlier definition can still be visible under that
path. Changing the registered definition requires task write access, normally held by the task
owner, Administrators and SYSTEM. Those principals can already stop tasks they own or administer.
A replacement launched after capture has a separate GUID and cannot be stopped by the captured
objects. The final manager-state probe treats both running and queued tasks as active.
[Task Scheduler permissions](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)
[Instance stop protocol](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tsch/b3572584-8727-441f-83e6-9b02101ea7f4)

The task's running state is read from `schtasks /query /fo CSV`. The status words observed from shipped
zh-CN, ko-KR, and ja-JP resources are recognized there, because a cold `Get-ScheduledTask` takes
1.6 s to 4.9 s (#8863) and cannot finish inside the 1 s cap. Any other localized word (French `Prêt`, for example) falls back to the numeric `TASK_STATE` read through the `Schedule.Service` COM object, which needs no module import (about 0.3 s including PowerShell startup on the reporting host): 2 and 4 (queued, running) are active, 1 and 3 (disabled, ready) are stopped, and a failed, timed-out or other value stays unknown.
The instance stop maps an access-denied HRESULT to `denied`. A running WinSW service is only this home's manager
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
  discovery and the inherited receipts counted as the probes their recovery runs: one per
  distinct exact endpoint (`inheritedTeardownProbeCount`, `src/cli/stop-restore.ts`), since an
  invalid, unscannable or guessed-endpoint receipt blocks without probing and the recovery pass
  asks each endpoint once (`abandonedTeardownProbeOncePerEndpoint`). Counting receipts let
  repeated failed stops against one proxy raise the budget past any deadline (#8960). A Part A
  other than stopped or absent holds the child: no `/api/stop` POST, the shared teardown
  skipped, `service` failed or state-unknown, `proxy` unknown. When that held Part A changed
  nothing (`windowsPartAHeldUnchanged`: no manager stop, no terminate), the receipt this run
  claimed before it (an update handover claims first) is removed: it describes a stop that never
  happened, and kept it would be inherited by the next stop's admission. A thrown Part A also holds the child and reports a service error. After a stopped Part A, the POST skips `stopProxy`'s legacy 15 s
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
  the manager commands and terminates are gated off once the cap has passed, including after
  asynchronous authorization. A completed late result retains known mutation and termination
  records while reporting the cap refusal instead of success.
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

The terminate primitive requires a native process handle. On ARM64, or if the native API
cannot load on x64, `terminateWindowsProcessBound` returns `unavailable` without spawning a
helper. If the manager stop leaves a wrapper running or its exit cannot be confirmed, Part A
returns `unknown` / `evidence-unreadable`. The operator can check the wrapper from its owning
session in Task Manager, stop it if it is still running, then retry.

## Tests

`tests/windows/windows-stop-binding.test.ts`, `tests/windows/windows-checked-stop.test.ts`,
`tests/windows/windows-stop-confirm.test.ts` and `tests/windows/windows-process-evidence.test.ts`
use injected deps, a virtual clock and simulated platforms. The owner-budget and Scheduler stop
script tests run PowerShell against stubbed CIM and COM objects. Live CIM and FFI tests require
Windows and the FFI cases require x64.

The callers are covered by `tests/windows/windows-checked-stop-live.test.ts` (adapters, ARM64
strict, whole-millisecond timeouts, the ancestry check, the bounded port sampler and the tri-state
listener identity), `tests/windows/windows-service-stop-wiring.test.ts`
(the real Part A through the wiring: the own-wrapper refusal, the cap, admission, the deadline's
two origins and the receipt record), `tests/windows/windows-stop-callers.test.ts` (the route, the
service commands, the guarded order, `bound-stray`, the orphan-discovery cap and the bind on the
evidence snapshot), `tests/windows/windows-guarded-manager.test.ts` (the not-running promotion
behind its registration proof) and `tests/windows/windows-stop-ocx-stop.test.ts` (plain `ocx stop`
through the real CLI with the platform simulated).
`tests/windows/windows-stop-boundary.test.ts` covers trigger ownership, cap authorization,
mutation evidence and complete process-table retention across interrupted enrichment.
