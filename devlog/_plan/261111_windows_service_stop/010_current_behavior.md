# 010 — Current Windows stop paths (source at origin/dev, 2026-11-11)

## Wrapper respawn

`buildWindowsServiceScript` (src/service/windows-taskxml.ts) emits a `:loop` that relaunches Bun or `ocx.exe` about five seconds after any child exit other than the protocol exit 42 (src/service/windows-wrapper-exit.ts). The task XML also requests restart-on-failure and logon/session triggers. Killing only the proxy child therefore brings it back without any Task Scheduler involvement.

## `ocx service stop`

`platformOps("scheduler").stop` is `stopWindows` (src/service/windows-ops.ts): it runs `schtasks /end /tn opencodex-proxy` and swallows every non-benign error. `stopWindowsChecked` exists for the updater and reports only whether `/end` was accepted. Neither observes the wrapper or the child afterwards. The service stop path does not call the wrapper cleanup at all.

## `ocx stop`

Plain `ocx stop` stops the tracked proxy (identity-checked `readPid` / `findLiveProxy`, src/service/orchestration.ts) and attempts wrapper cleanup through `killWindowsSchedulerWrappers` (src/lib/windows-service-wrappers.ts). That cleanup is best effort by design: it matches this installation's canonical launcher and script paths as complete command-line tokens, but skips processes whose command line it cannot read, runs `Stop-Process -ErrorAction SilentlyContinue`, ignores the PowerShell exit status, and never re-observes.

## Existing building blocks

- `inspectWindowsGuardedManager` (src/service/windows-guarded-manager.ts) proves a Task Scheduler or WinSW manager owns an approved PID: the registered task must be a recognized OpenCodex layout, running, and an ancestor wrapper must carry this home's canonical paths; WinSW must be this installation's binary with the SCM PID as an ancestor. Unreadable evidence stays unknown.
- `observeWindowsGuardedManagerStopped` answers `inactive` / `active` / `unknown` after a stop: task not running, no wrapper carrying this home's paths, WinSW not started, and no unreadable wrapper under the former manager.
- `readProcessCommandLine` now reads command lines in process on Windows x64 (#8487), so wrapper and child identities are readable without CIM in the common case.
- `confirmServiceServing` with `replacing` (#8487) is the analogous "prove the replacement" check on the restart side.
