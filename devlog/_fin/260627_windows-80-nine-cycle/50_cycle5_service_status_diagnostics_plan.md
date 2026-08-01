# Cycle 5 - Windows service status diagnostics

## Scope
- Expose the durable service log path in service status summaries so Windows users can find Task Scheduler wrapper/child exit diagnostics after the Cycle 4 logging patch.
- Keep the change CLI-visible through existing `ocx status` and `ocx service status` flows without changing service lifecycle semantics.

## Planned diff
- `src/service.ts`: add a small diagnostic suffix/helper for service log location and include it in `serviceStatusSummary()` and direct `ocx service status` output.
- `tests/service.test.ts`: assert summaries/status command source expose `serviceLogPath()`.
- `tests/cli-help.test.ts`: assert `ocx status` includes the service log path.

## Verification
- `bun test tests/service.test.ts tests/cli-help.test.ts`
- `bun x tsc --noEmit`

## Commit
- Atomic commit: `fix(windows): expose service diagnostics`
