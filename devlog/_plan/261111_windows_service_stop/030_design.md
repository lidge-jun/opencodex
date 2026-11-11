# 030 — Recommended design: one checked Windows stop (B1, with C as a later addition)

## Two parts

The proxy child is stopped by each caller AFTER the service stop, and `/api/stop` runs inside the very proxy that holds the port. A port check inside the service operation would therefore always time out. The design is split:

- Part A, `stopWindowsServiceChecked()` (async; the current `stopServiceIfInstalledDetailed` and the guarded `stopManager` slot become async on Windows): stop the manager, terminate bound wrappers, then wait until the manager is inactive and no bound wrapper is alive. Returns `stopped` / `survived` / `denied` / `unknown` for the manager and wrappers only.
- Part B, `confirmWindowsStopFreed()`, run by the caller after its graceful child stop: the port is free and stays free for the hold, and a remaining listener is classified as ours or foreign. Part B replaces `proxyStillLiveAfterStop` in `ocx service stop`, the `schedulerCanRespawn` re-poll in `ocx stop`, and the guarded path's `settle` / `managerState` observation.

## Where it sits

Part A replaces, on Windows only, the "manager stop + best-effort wrapper kill" pair in every Windows stop path:

- `stopServiceIfInstalledDetailed` (`ocx stop` without a snapshot, `ocx uninstall`, `/api/stop`) calls it instead of `stopWindowsChecked` + `killWindowsServiceWrapperProcesses`.
- `runGuardedManagerStep` calls it as its `stopManager` for a bound Task Scheduler/WinSW manager. The order stays: the operation ends the manager and the wrappers (so nothing can relaunch the child), then the existing `signalApproved` step stops the approved PID gracefully. `childNeedsSeparateStop` keeps its meaning.
- `ocx service stop` calls part A instead of `stopWindows`, stops the tracked proxy as today, then runs part B.
- `ocx service uninstall` / `remove` call part A before deleting the task (today they call `stopWindows` and kill no wrappers, so a looping wrapper can outlive its task, #764), then part B.
- `prepareServiceInstall` (service install and backend switch) calls part A instead of its manager stop + wrapper kill, then its existing tracked-proxy stop, then part B.
- `/api/stop` runs part A only. Part B belongs to the parent `ocx stop` that holds the receipt, since the route cannot observe its own post-exit window; the existing `respawnable_service` refusal for a caller without a receipt stays.
- The updater's `stopWindowsServiceWrappersBestEffort` moves to part A in the same change (Task Scheduler backend; for the native WinSW backend it keeps today's behavior of stopping WinSW without a wrapper kill, because WinSW has no `:loop` wrapper), through an authorizer-gated variant (`guardedStopWindowsServiceChecked(authorize)`) that runs the authorizer once at entry and again before each terminate, as the existing `mutationGate` does, so an update cannot race a respawned runtime either. The updater keeps its own reclaim checks.

Desktop reaches it only through the consented `ocx stop` child; the #5443 boundary is unchanged and Desktop never elevates.

## Binding rule (what may be terminated)

A process is bound, and only a bound process may be terminated, when ALL hold:

1. Image name is `wscript.exe`, `cscript.exe` or `cmd.exe` (wrapper). The proxy child is identified for observation and lineage only; it is never a terminate target of this operation.
2. Its command line contains this home's canonical launcher VBS or service script path as a complete token.
3. Lineage: it is an ancestor of the identity-checked child (`readPid()` identity), or a descendant of a wrapper that satisfies 1–2, or its parent is gone (a parent PID whose creation time is later than the wrapper's counts as gone), is another bound wrapper, or is the Task Scheduler service host, proven by matching the Schedule service's process ID from the SCM (after `/end` the launcher `wscript.exe` usually still has it as parent). A wrapper that matches 1–2 but fails lineage (for example a launcher started by hand) is not terminated and makes the outcome `survived` with reason `unbound-wrapper` if it is still alive at the end of part A. For the stray-wrapper case (#764, task not running) this binds the launcher and, as its descendant, the `cmd.exe` running the `:loop`; ending either stops the relaunch.
4. A creation time was read for it at bind time.

This is narrower than today's cleanup, which uses the path token alone with any image name and skips unreadable command lines silently. A candidate under the bound manager whose command line or creation time is unreadable makes the outcome `unknown`; it is never skipped and never killed.

## Termination primitive

New work, named explicitly (x64):

- A Windows process creation-time reader (`GetProcessTimes`), added to `WindowsProcessEntry` as `startTime`.
- A handle-based terminate: `OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)`, read the creation time on THAT handle, compare with the bound value, then `TerminateProcess` on the same handle, then close it. No gap between check and kill for PID reuse. Implemented with Bun FFI from `resolveTrustedWindowsSystemDirectory()` (same loading rules as #8487).
- Windows ARM64 (no FFI), recommended: keep today's capability with a weaker but bounded fallback rather than regress. Bind on the CIM `CreationDate` (a reader exists at src/codex/app-server-processes.ts), then in ONE trusted PowerShell script re-read the process's `StartTime` through `Get-Process -Id`, compare, and call `.Kill()` on the same `Process` object, reading the result back. The window between the CIM read and the check is closed; the remaining window between the in-script check and `Kill()` is accepted and documented. The alternative, reporting `unknown` and killing nothing on ARM64, is listed in 050 as a regression the owner may prefer.

## Steps

1. Bind (rule above) and record (pid, startTime, image, command-line digest).
2. Ask the manager: `schtasks /end` / WinSW stop. Access denied → `denied`, stop there.
Part A:

3. Terminate bound wrapper survivors through the handle primitive (`cmd.exe` running the loop first, then the launcher). The proxy child is NOT terminated here: it stops through the existing graceful path (`stopProxy` / `stopWithDeferral` / `signalApproved`) with its drain, the #7423 teardown-deferral receipt, and the rule that a received refusal (409, `ProxyOwnershipRefusedError`) forbids a forced stop. It is force-killed only where today's code already forces after a graceful timeout, never after a refusal. This operation gives no new kill authority over the child.
4. Wait until `observeWindowsGuardedManagerStopped` = inactive and no bound wrapper is alive (part A deadline: 5 s, starting after the manager stop returns).

Part B (caller, after its graceful child stop):

5. The listening port is free and stays free for one relaunch period (6 s hold), within a 12 s budget that starts when the caller's child stop returns, so a loop that relaunches late is caught. A remaining listener is classified by identity as ours (`survived`) or foreign (`portHeldByForeign`). "The port" means the runtime-port record when present, else the port baked into the wrapper script (`windowsListenPort`), else the configured port.
6. Report (part A outcome combined with part B).

## Outcomes and the output contract

| Operation outcome | `ServiceStopOutcome` | `ocx-stop/1`, snapshotless path | `ocx-stop/1`, guarded (consent) path | `/api/stop` | Desktop |
|---|---|---|---|---|---|
| stopped | `stopped` | `outcome: stopped`, `service: stopped` | `outcome: stopped` | 200 | stopped |
| survived (bound wrapper or this installation's identity still on the port) | `failed` | `outcome: failed`, `proxy: respawned` (existing values) | `outcome: manager-still-active` (existing) | existing failure code | existing terminal handling |
| denied | `failed` | `outcome: failed` + additive `serviceStopReason: "access-denied"` | `outcome: manager-still-active` + additive `serviceStopReason: "access-denied"` | existing failure code + additive reason | elevation hint text |
| unknown | `state-unknown` | existing unknown handling + additive `serviceStopReason: "evidence-unreadable"` | existing unknown handling + additive reason | `service_state_unknown` (existing) | existing |
| port held by a FOREIGN identity after our processes are gone | `stopped` for the service | additive `portHeldByForeign: true` | additive `portHeldByForeign: true` | additive field | warning text |

No new `outcome` or `proxy` enum value is introduced: Desktop's `Outcome` enum (desktop/src-tauri/src/runtime_stop.rs) fails to parse an unknown outcome. All new fields are additive within `ocx-stop/1` and are added to Desktop's `StopSummary` as optional fields with `serde(default)`; Desktop's parser (desktop/src-tauri/src/runtime_stop.rs) has no `deny_unknown_fields`, so a newer Desktop with an older package CLI behaves exactly as today (no new field → today's text), and an older Desktop with a newer CLI sees the same outcome strings. No schema bump.

## Not persistent

The stop ends the running instance only. Logon/session-unlock triggers and restart-on-failure stay enabled, so the proxy returns at the next unlock or logon unless the service is disabled or uninstalled. That is today's service semantics and is stated in the output text; persistent disable is option B2 and out of scope.

## Later: C

New wrapper scripts can check a per-installation stop token before relaunching; legacy wrappers keep needing B1.
