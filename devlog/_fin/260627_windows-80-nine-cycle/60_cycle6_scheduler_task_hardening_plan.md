# Cycle 6 - Windows Task Scheduler run-condition hardening

## Scope
- Harden the Windows Task Scheduler service registration so the proxy is less likely to stop under common desktop/laptop conditions.
- Keep privilege level LIMITED and avoid destructive service behavior changes.

## Planned diff
- `src/service.ts`: extend `buildWindowsSchtasksCreateArgs()` with stable Task Scheduler flags that remove the default time limit and avoid battery-only stop behavior where schtasks supports it.
- `tests/service.test.ts`: assert generated args include the added scheduler hardening flags and still keep LIMITED privilege.

## Acceptance
- Windows scheduled task create args remain shell-safe and quote the generated `.cmd` path.
- The task has no finite `/du` runtime limit and does not request elevated privileges.
- Tests/typecheck pass.

## Verification
- `bun test tests/service.test.ts`
- `bun x tsc --noEmit`

## Commit
- Atomic commit: `fix(windows): harden scheduler task args`
