# 010 — Current Windows stop paths (source at origin/dev, 2026-11-11)

## Wrapper respawn

`buildWindowsServiceScript` (src/service/windows-taskxml.ts) emits a `:loop` that relaunches Bun or `ocx.exe` about five seconds after any child exit other than the protocol exit 42 (src/service/windows-wrapper-exit.ts). The registered task also carries restart-on-failure (PT1M, 3 attempts) and logon/session-unlock triggers. Killing only the proxy child brings it back without any Task Scheduler involvement.

## Who calls which stop

| Caller | Manager stop | Wrapper cleanup | Post-stop check |
|---|---|---|---|
| `ocx stop` without a consent snapshot, `ocx uninstall`, dashboard/Desktop `/api/stop` | `stopServiceIfInstalledDetailed` (src/service/orchestration.ts): `stopWindowsChecked` when the task is present, WinSW stop, outcome `absent / stopped / stopped-respawnable / failed / state-unknown` | `killWindowsServiceWrapperProcesses` after the manager stop | `ocx stop` re-polls when the scheduler can respawn and reports `respawned`; `/api/stop` maps `state-unknown` to `service_state_unknown`, refuses a respawnable Task Scheduler service for a caller without a receipt (`respawnable_service`), and cannot observe its own post-exit window |
| `ocx stop` with a consent snapshot (Desktop's approved stop) | `runGuardedManagerStep` (src/cli/stop-approval.ts): revalidates the bound manager, stops it, signals the approved PID when the manager does not cascade (`childNeedsSeparateStop`, true for Task Scheduler and WinSW) | none of its own | `observeGuardedManagerStopped` → `inactive / active / unknown`; reports `manager-still-active` or `respawned` |
| `ocx service uninstall` / `remove` | `stopWindows` then task deletion | none | none (a looping wrapper can outlive its task) |
| Service install / backend switch (`prepareServiceInstall`) | manager stops for the recorded and requested backends | `killWindowsServiceWrapperProcesses` | its tracked-proxy stop |
| `ocx service stop` | `platformOps(...).stop` = `stopWindows` (swallows non-benign `/end` errors) | none | `stopTrackedProxyForServiceCommand` then `proxyStillLiveAfterStop` polls ~7 s and exits 1 on a survivor |
| Updater (Windows restart/reclaim) | `guardedStopWindows` / `guardedStopWinsw` (src/update/guarded-runtime-ops.ts, job-windows-restart.ts) | its own `killWindowsServiceWrapperProcesses` through `guardedKillWindowsWrappers` | its own reclaim checks |

So every path can already SEE a survivor (or at least a still-active manager); none can reliably FREE the port, because the wrapper cleanup (`killWindowsSchedulerWrappers`, src/lib/windows-service-wrappers.ts) is best effort: it matches this home's canonical launcher/script paths as complete command-line tokens, skips processes whose command line it cannot read, runs `Stop-Process -ErrorAction SilentlyContinue`, ignores the result and never re-observes.

## Existing building blocks

- `inspectWindowsGuardedManager` (src/service/windows-guarded-manager.ts) proves a manager owns an approved PID: the registered task must be a recognized OpenCodex layout (`windowsTaskRegistrationHealthy` or the exact legacy shape, via the `winRegistrationOurs` dependency), running, with an ancestor wrapper carrying this home's canonical paths; WinSW must be this installation's binary with the SCM PID as an ancestor. Unreadable evidence stays unknown. A surviving wrapper while the task reads not-running is `unknown("a surviving scheduler wrapper could not be tied to the registered task")`.
- `observeWindowsGuardedManagerStopped`: task not running, no wrapper carrying this home's paths, WinSW not started, no unreadable wrapper under the former manager.
- `readProcessCommandLine` reads one PID's command line in process on Windows x64 (#8487). Wrapper enumeration (`windowsProcessList`) still runs `Get-CimInstance Win32_Process`. `WindowsProcessEntry` carries pid, parentPid, name and commandLine, but no process start time.
