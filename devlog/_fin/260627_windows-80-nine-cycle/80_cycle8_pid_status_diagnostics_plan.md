# Cycle 8 - PID diagnostics in status output

## Scope
- Improve PID cleanup diagnostics by exposing the pid file path in `ocx status`.
- This helps Windows users identify stale pid-file situations without changing process-kill semantics.

## Planned diff
- `src/cli.ts`: include `getPidPath()` in the config import and print `PID file: <path>` in `handleStatus()`.
- `tests/cli-help.test.ts`: assert status output includes the temp OpenCodex home `ocx.pid` path.

## Acceptance
- `ocx status` still does not start or stop the proxy.
- Status output includes both runtime path and pid file path.
- Tests/typecheck pass.

## Verification
- `bun test tests/cli-help.test.ts`
- `bun x tsc --noEmit`

## Commit
- Atomic commit: `fix(cli): show pid path in status`
