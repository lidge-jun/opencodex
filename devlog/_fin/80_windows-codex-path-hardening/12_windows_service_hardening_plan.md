# 80.12 — Windows Service Hardening Plan

## Problem

macOS uses launchd service semantics. Windows currently uses a generated `.cmd` wrapper plus a minimal Task Scheduler task.

Current Windows service shape:

- generated script: `~/.opencodex/opencodex-service.cmd`
- sets `OCX_SERVICE`, `PATH`, optional `CODEX_HOME`
- loops only when the child exits non-zero
- Task Scheduler registration uses bare `/create /tn /tr /sc onlogon /rl highest /f`

This is not a strong always-on service contract. It lacks explicit:

- indefinite execution time limit;
- restart-on-failure count/interval;
- start-when-available;
- battery behavior;
- multiple-instance behavior;
- timestamped logs for child start/exit/restart decisions.

## Patch intent

Make Windows service behavior closer to macOS/Linux service mode and make failures diagnosable.

## Proposed implementation

### 1. Generate a real task definition

Replace or supplement bare `schtasks /create` args with XML or PowerShell ScheduledTasks registration.

The generated definition should include:

- logon trigger;
- highest run level;
- `ExecutionTimeLimit` set to indefinite (`PT0S`) or equivalent;
- restart-on-failure count and interval;
- start when available;
- do not stop because of battery mode;
- predictable multiple-instance policy.

Use structured generation functions so tests can assert fields without running Windows.

### 2. Add Windows service logging

Update the `.cmd` wrapper to write to opencodex `service.log`:

- timestamp when wrapper starts;
- Bun executable path;
- Bun version when obtainable;
- CLI path;
- `CODEX_HOME` and opencodex config dir;
- each child start;
- each child exit code;
- restart delay/decision;
- wrapper stop if reachable.

### 3. Preserve intentional stop semantics

Be careful with restart-on-failure and `.cmd` loop changes.

Existing intentional stop flows:

- `ocx stop` calls `stopServiceIfInstalled()` before killing the proxy.
- dashboard `/api/stop` calls `stopServiceIfInstalled()`, restores native Codex, drains, then exits.
- `ocx service stop` now stops the task wrapper and kills the tracked proxy.

A new restart loop must not resurrect the child after intentional stop. Prefer stopping the wrapper task first, then child kill, and avoid unconditional restart on clean intentional exits.

## Tests

- Static test for generated Windows task XML/settings:
  - indefinite execution;
  - restart policy;
  - start-when-available;
  - battery behavior;
  - highest run level.
- Static test for wrapper log lines:
  - child start;
  - child exit code;
  - Bun path/version;
  - config/CODEX_HOME.
- Existing lifecycle tests remain green:
  - `tests/service.test.ts`
  - `tests/uninstall.test.ts`

## Manual Windows smoke checklist

On a real Windows host:

1. Install service.
2. Inspect Task Scheduler settings.
3. Confirm `service.log` appears and records Bun path/version.
4. Kill only the child proxy process.
5. Verify restart and log entry.
6. Run `ocx service stop` and verify no child remains.
7. Run `ocx service uninstall` and verify task/script removed and native Codex restored.
