# 030 — Recommended design: one checked Windows stop (B1, with C as a later addition)

## Two parts

The proxy child is stopped by each caller AFTER the service stop, and `/api/stop` runs inside the very proxy that holds the port. A port check inside the service operation would therefore always time out. The design is split:

- Part A, `stopWindowsServiceChecked()` (async; the current `stopServiceIfInstalledDetailed` and the guarded `stopManager` slot become async on Windows): stop the manager, terminate bound wrappers, then wait until the manager is inactive and no bound wrapper is alive. Returns `absent` / `stopped` / `survived` / `denied` / `unknown` for the manager and wrappers only. `absent` means no OpenCodex task or WinSW service is registered for this home and no wrapper is bound: it maps to `ServiceStopOutcome` `absent`, prints no "Service manager stopped.", lets plain `ocx stop` send its POST, and skips part B, so a Windows install without a service keeps today's timing. With nothing registered, a process list that cannot be read is also `absent` (the wrapper sweep is skipped, as today's best-effort kill silently skips it), never `unknown`, so such a machine is never refused a stop it gets today; the residual is a stray wrapper of a deleted task that cannot be seen, which today's sweep also misses. `unknown` is reserved for evidence that cannot be read about a registered manager or a bound candidate.
- Part B, `confirmWindowsStopFreed()`, run by the caller after its graceful child stop: the port is free and stays free for the hold, and a remaining listener is classified as ours or foreign. Part B replaces `proxyStillLiveAfterStop` in `ocx service stop`, the `schedulerCanRespawn` re-poll in `ocx stop`, and the respawn-window check in `ocx uninstall` (src/cli/index.ts, uninstall-plan.ts), which today run only on `stopped-respawnable`; on Windows they run part B unconditionally after a part A `stopped`. On the guarded path part B is added after the existing `settle`, which keeps its approved-PID exit check (`waitExit`) and the probe of the approved endpoint; there "the port" is the approved endpoint.
- A part A outcome other than `stopped` aborts before anything destructive: `ocx service uninstall` / `remove` and `prepareServiceInstall` refuse with the outcome and reason before deleting or replacing the task (today uninstall only warns and continues), `ocx uninstall` keeps client configuration, and the updater aborts before replacing files.
- Plain `ocx stop` (no consent snapshot) treats a part A outcome other than `stopped` or `absent` exactly as the guarded path treats `manager-still-active`: it does not stop the child (no `/api/stop` POST), sets `stopFailed` and `ownershipBlocked`, and skips the shared teardown, so client configuration is never restored under a wrapper that can relaunch the proxy (#3008). Today this path still sends the receipt-backed POST after a failed manager stop and relies on the route re-running the service stop and answering 409; once the route skips part A for a receipt holder (below), that safety net would be gone, so the parent must not send the POST at all. The record uses existing values only: `service: failed` (or `state-unknown`), `proxy: unknown` (the child stop was not attempted), `sharedTeardown: skipped`, `outcome: failed`.

## Where it sits

Part A replaces, on Windows only, the "manager stop + best-effort wrapper kill" pair in every Windows stop path:

- `stopServiceIfInstalledDetailed` (`ocx stop` without a snapshot, `ocx uninstall`, `/api/stop`) calls it instead of `stopWindowsChecked` + `killWindowsServiceWrapperProcesses`.
- `runGuardedManagerStep` calls it as its `stopManager` for a bound Task Scheduler/WinSW manager. The order stays: the operation ends the manager and the wrappers (so nothing can relaunch the child), then the existing `signalApproved` step stops the approved PID gracefully. `childNeedsSeparateStop` keeps its meaning.
- `ocx service stop` calls part A instead of `stopWindows`, stops the tracked proxy as today, then runs part B.
- `ocx service uninstall` / `remove` call part A before deleting the task (today they call `stopWindows` and kill no wrappers, so a looping wrapper can outlive its task, #764), then part B.
- `prepareServiceInstall` (service install and backend switch) calls part A instead of its manager stop + wrapper kill, then its existing tracked-proxy stop, then part B.
- `/api/stop`: when the caller presents a valid receipt, the parent `ocx stop` has already run part A, so the route skips part A (no second enumeration, `/end` or wait inside the proxy) and only performs its graceful shutdown; part B belongs to the parent, since the route cannot observe its own post-exit window. Only `ocx stop` writes the receipt, and it sends the POST only after its own part A returned `stopped` or `absent` (see "Two parts"), so skipping is safe by construction. Without a receipt the existing `respawnable_service` refusal stays for a respawnable Task Scheduler service. Where the respawn risk is `none` (WinSW, or a deleted task with a stray wrapper) the route runs part A in process with a 4 s cap and then, before it answers, its own shared teardown (`performStopTeardown`, which a caller without a receipt still gets); the drain runs after the answer. The implementation must measure the teardown's worst case and keep part A plus teardown under the parent's 10 s POST abort, after which the parent would fall back to a forced kill; 040 carries that as a test. A part A overrun there answers `service_state_unknown` and changes nothing further.
- The updater's `stopWindowsServiceWrappersBestEffort` moves to part A in the same change (Task Scheduler backend; for the native WinSW backend it keeps today's behavior of stopping WinSW without a wrapper kill, because WinSW has no `:loop` wrapper), through an authorizer-gated variant (`guardedStopWindowsServiceChecked(authorize)`) that runs the authorizer once at entry and again before each terminate, as the existing `mutationGate` does, so an update cannot race a respawned runtime either. The updater keeps its own reclaim checks. Its three call sites in src/update/job.ts discard the result today, and one runs inside the synchronous `preparePort` callback; each gets a return path (the callback becomes async, or part A runs before it) so a non-`stopped` outcome really aborts the update before files are replaced.

Desktop reaches it through two `ocx stop` children, both ordinary CLI processes run as the user: the consented takeover at startup (`--expect-*`, under the startup sequence's deadline, which `resolve_consent` extends by the consent wait plus 60 s on a Windows approval) and the exit/restart drain (plain `ocx stop --json` under `runtime_stop::DEADLINE`, 30 s, desktop/src-tauri/src/exit.rs). The #5443 boundary is unchanged and Desktop never elevates.

## Binding rule (what may be terminated)

A process is bound, and only a bound process may be terminated, when ALL hold:

1. Image name is `wscript.exe`, `cscript.exe` or `cmd.exe` (wrapper). The proxy child is identified for observation and lineage only; it is never a terminate target of this operation.
2. Its command line contains this home's canonical launcher VBS or service script path as a complete token.
3. Lineage: it is an ancestor of the identity-checked child (`readPid()` identity), or a descendant of a BOUND wrapper, or its parent is gone (a parent PID whose creation time is later than the wrapper's counts as gone), is another bound wrapper, or is the Task Scheduler service host, proven by matching the Schedule service's process ID from the SCM (after `/end` the launcher `wscript.exe` usually still has it as parent). A wrapper that matches 1–2 but fails lineage (for example a launcher started by hand from a shell) is not terminated, and neither is its `cmd.exe` child (not a descendant of a bound wrapper); the outcome is `survived` with reason `unbound-wrapper` if either is still alive at the end of part A, and the output names the manual step. A hand-started launcher whose own shell has already exited does satisfy "parent is gone" and is bound; that is accepted, because it carries this home's paths and would otherwise keep relaunching this home's proxy. Ending a hand-started copy whose shell is still alive is left to the operator. For the stray-wrapper case (#764, task not running) this binds the launcher and, as its descendant, the `cmd.exe` running the `:loop`; ending either stops the relaunch.
4. A creation time was read for it at bind time.

This is narrower than today's cleanup, which uses the path token alone with any image name and skips unreadable command lines silently. A candidate under the bound manager whose command line or creation time is unreadable makes the outcome `unknown`; it is never skipped and never killed.

## Guarded (consent) path and the stray wrapper

Today `inspectWindowsSchedulerManager` answers `unknown` when the task is not running but a wrapper survives, and `runApprovedStop` turns that into `approval-changed` before any manager step, which is #7771's Desktop symptom. The guarded inspection adopts the same binding rule: a not-running registered OpenCodex task plus wrappers bound by the rule above (path token, wrapper image, lineage to the identity-checked approved PID, creation time) is a provable manager state `bound-stray`, which reaches part A. `runGuardedManagerStep` (which today checks `kind === "bound"`) and `sameGuardedManager` both handle the new kind, and revalidation compares the bound wrapper set (pid + creation time). Anything the rule cannot bind stays `unknown` → `approval-changed`, and Desktop shows the existing refusal with the new `unbound-wrapper` / `evidence-unreadable` reason.

## Termination primitive

New work, named explicitly (x64): the creation-time reader, the handle terminate, and reading the Schedule service's PID from the SCM (`QueryServiceStatusEx`) for the parent proof. Making part A async changes the return type of `stopServiceIfInstalledDetailed` and the `stopManager` slot on every platform, so all their callers change in the same PR.

- A Windows process creation-time reader (`GetProcessTimes`), added to `WindowsProcessEntry` as `startTime`.
- A handle-based terminate: `OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)`, read the creation time on THAT handle, compare with the bound value, then `TerminateProcess` on the same handle, then close it. No gap between check and kill for PID reuse. Implemented with Bun FFI from `resolveTrustedWindowsSystemDirectory()` (same loading rules as #8487).
- Windows ARM64 (no FFI), recommended: keep today's capability with a weaker but bounded fallback rather than regress. Bind on the CIM `CreationDate` (a reader exists at src/codex/app-server-processes.ts), then in ONE trusted PowerShell script re-read the process's `StartTime` through `Get-Process -Id`, compare, and call `.Kill()` on the same `Process` object, reading the result back. `Process.Kill()` opens its own handle by PID, so a window between the in-script check and the kill remains; the CIM `CreationDate` and `StartTime` comparison uses a 1 s tolerance in UTC. Both are accepted residuals of the fallback and documented. The alternative, reporting `unknown` and killing nothing on ARM64, is listed in 050 as a regression the owner may prefer.

## Steps

1. Bind (rule above) and record (pid, startTime, image, command-line digest).
2. Ask the manager: `schtasks /end` / WinSW stop. Access denied → `denied`, stop there.
Part A:

3. Terminate bound wrapper survivors through the handle primitive (`cmd.exe` running the loop first, then the launcher). The proxy child is NOT terminated here: it stops through the existing graceful path (`stopProxy` / `stopWithDeferral` / `signalApproved`) with its drain, the #7423 teardown-deferral receipt, and the rule that a received refusal (409, `ProxyOwnershipRefusedError`) forbids a forced stop. It is force-killed only where today's code already forces after a graceful timeout, never after a refusal. This operation gives no new kill authority over the child.
4. Wait (cap 3 s) until every bound wrapper has exited, by waiting on the process handles opened at bind time (no enumeration, no PowerShell during the wait), then read the manager state once with `schtasks /query` / `sc query` only (cap 1 s). The CIM enumeration that would find a wrapper started after bind is NOT repeated here; it runs once at the end of part B (step 5), where a late relaunch is what it has to catch. Part A therefore costs one bind enumeration (shared with the guarded `revalidateManager`, so no second CIM query on that path) + `/end` (cap 2 s) + 3 s + 1 s.

## Time budget (one deadline, checked before anything changes)

Windows only. The async `stopManager` change reaches every platform, but macOS and Linux keep today's timing and ignore the deadline.

`ocx stop` takes the deadline as an input, `--deadline-ms <n>`, measured from its own process start. Desktop passes it on both paths: the remaining startup deadline for the consented takeover, and `runtime_stop::DEADLINE` minus a 3 s spawn/parse margin for the exit drain. Without the flag (a terminal, a script, an older Desktop) the deadline is 60 s. The other callers (`ocx service stop`, `ocx uninstall`, service uninstall/remove, install/switch) are interactive and use 60 s; the updater uses its job budget.

Admission. Right before part A, after every pre-step has already run (on the consented path: `runResolve`, `describeTrackedRuntimeTarget` and the first `inspectGuardedManagerTarget` inside `runApprovedStop`, then `revalidateManager`, each with its existing CIM 5 s timeout and `schtasks`; their actual elapsed time is what counts, they are not given a cap of their own), the stop computes the worst case of everything still to come. If the remaining time cannot hold it, the stop changes NOTHING (no `/end`, no terminate, no POST) and reports `serviceStopReason: "unverified-budget"` with `manager-still-active` (guarded) or `failed` (snapshotless). This replaces "report afterwards": once part A has started, every remaining step has a cap and their sum fits by construction, so the drain is never shortened and the stop never overruns.

Worst case still to come, at admission:

| Step | Worst case | Notes |
|---|---|---|
| part A | guarded 6 s (`/end` 2 s, handle wait 3 s, manager state 1 s; the bind reuses `revalidateManager`'s enumeration); snapshotless 11 s (its own enumeration, 5 s, plus the same 6 s) | `absent` returns after the enumeration |
| POST answer | `min(10 s, remaining − the rows below)`, floor 3 s | with a receipt the route skips part A and defers the teardown, so it answers at once; the 10 s abort only matters for a hung proxy. An abort falls back to today's forced kill |
| graceful exit wait | `shutdownTimeoutMs` + 3 s (8 s by default), never shortened | runs after the POST answer, as `stopProxyGracefullyDetailed` does today |
| part B | 6 s floor, up to `min(12 s, remaining)` | `waitForStoppedPort` (today a separate 15 s wait inside `stopProxy`, also after a forced kill) is the same port-free predicate and on Windows becomes part B's first phase instead of a separate wait; `settle`'s `waitExit` and endpoint probe are its first sample; the single final CIM enumeration (`managerState` and `guardFinalStopSummary` share it) runs concurrently with the hold, capped 5 s < 6 s |
| reserve | 2 s | shared restore and the JSON summary |

Admission minimum with default settings: guarded 6 + 3 + 8 + 6 + 2 = 25 s; snapshotless 11 + 3 + 8 + 6 + 2 = 30 s.

| Caller | Deadline | Fits? |
|---|---|---|
| consented takeover (`--expect-*`) | remaining startup deadline (Windows approval adds 60 s) | yes in practice; otherwise refused before anything changes |
| Desktop exit/restart drain (plain `ocx stop --json`) | `runtime_stop::DEADLINE` − 3 s = 27 s today | NO for a registered service in the worst case (30 s needed). The same change raises Desktop's exit-drain deadline on Windows to 45 s (42 s passed as `--deadline-ms`). An older Desktop passes no flag, the CLI uses 60 s and can outlive Desktop's 30 s wait, which ends in `DrainVerdict::Failed`; today's stop can already outlive it (10 s POST + 8 s exit wait + 15 s port wait), so this is not new, and it is listed in 050 |
| terminal, scripts, other interactive callers | 60 s | yes |
| `/api/stop` route | receipt: no part A; no receipt, risk `none`: part A 4 s + teardown before the answer | parent's 10 s POST abort |
| updater | job budget | yes |

Part B (caller, after its graceful child stop):

5. The listening port is free and stays free for one relaunch period (6 s hold), within the part B window from the budget above (6–12 s, starting when the caller's child stop returns), so a loop that relaunches late is caught. The single final CIM enumeration runs during the hold and must show no wrapper-image process with this home's path token; one that appeared after bind makes the outcome `survived` even when the port is still free. A remaining listener is classified by identity as ours (`survived`) or foreign (`portHeldByForeign`). "The port" means the runtime-port record when present, else the port baked into the wrapper script (`windowsListenPort`), else the configured port.
6. Report (part A outcome combined with part B).

## Outcomes and the output contract

| Operation outcome | `ServiceStopOutcome` | `ocx-stop/1`, snapshotless path | `ocx-stop/1`, guarded (consent) path | `/api/stop` | Desktop |
|---|---|---|---|---|---|
| absent (nothing registered, nothing bound) | `absent` | today's values for no service | today's values | today's | today's |
| stopped | `stopped` | `outcome: stopped`, `service: stopped` | `outcome: stopped` | 200 | stopped |
| survived (bound wrapper or this installation's identity still on the port) | `failed` | part A survived: `outcome: failed`, `service: failed`, `proxy: unknown` (child not stopped, see "Two parts"); part B found our identity back on the port: `outcome: failed`, `proxy: respawned` (existing values) | `outcome: manager-still-active` (existing) | existing failure code | existing terminal handling |
| denied | `failed` | `outcome: failed` + additive `serviceStopReason: "access-denied"` | `outcome: manager-still-active` + additive `serviceStopReason: "access-denied"` | existing failure code + additive reason | elevation hint text |
| unknown | `state-unknown` | existing unknown handling + additive `serviceStopReason: "evidence-unreadable"` | existing unknown handling + additive reason | `service_state_unknown` (existing) | existing |
| port held by a FOREIGN identity after our processes are gone | `stopped` for the service | additive `portHeldByForeign: true` | additive `portHeldByForeign: true` | additive field | warning text |

The reason strings `access-denied`, `evidence-unreadable`, `unbound-wrapper` and `unverified-budget` all travel in the one additive field `serviceStopReason`. On Windows the Task Scheduler backend no longer returns `stopped-respawnable`: part B now runs after every Windows `stopped`, which covers the respawn re-poll it used to trigger. The value stays in `StopServiceOutcome` for macOS/Linux and for documents written by older CLIs, and the route comments, the uninstall plan and `record.service` handling are updated in the same change. No new `outcome` or `proxy` enum value is introduced: Desktop's `Outcome` enum (desktop/src-tauri/src/runtime_stop.rs) fails to parse an unknown outcome. All new fields are additive within `ocx-stop/1` and are added to Desktop's `StopSummary` as optional fields with `serde(default)`; Desktop's parser (desktop/src-tauri/src/runtime_stop.rs) has no `deny_unknown_fields`, so a newer Desktop with an older package CLI behaves exactly as today (no new field → today's text), and an older Desktop with a newer CLI sees the same outcome strings. No schema bump.

## Not persistent

The stop ends the running instance only. Logon/session-unlock triggers and restart-on-failure stay enabled, so the proxy returns at the next unlock or logon unless the service is disabled or uninstalled. That is today's service semantics and is stated in the output text; persistent disable is option B2 and out of scope.

## Later: C

New wrapper scripts can check a per-installation stop token before relaunching; legacy wrappers keep needing B1.
