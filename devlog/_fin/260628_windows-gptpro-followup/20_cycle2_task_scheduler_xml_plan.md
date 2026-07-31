# Cycle 2 - P1 Windows Task Scheduler XML settings

## Problem
GPT Pro found that `schtasks /create /sc onlogon /du 9999:59` does not implement the planned service-like Task Scheduler settings. `/du` is not the right mechanism for ONLOGON tasks and does not set an indefinite execution limit.

## Plan

### MODIFY src/service.ts
1. Add XML escaping helper for Task Scheduler XML values.
2. Add `windowsTaskXmlPath()` beside `windowsServiceScriptPath()` under OPENCODEX_HOME.
3. Export `buildWindowsTaskXml(script = windowsServiceScriptPath()): string` that includes:
   - Task Scheduler v1.4 XML root namespace;
   - LogonTrigger enabled;
   - `MultipleInstancesPolicy` explicit value;
   - battery settings: do not stop on battery and allow start on battery;
   - `ExecutionTimeLimit` = `PT0S`;
   - `RestartOnFailure` with `Interval` and `Count`;
   - `Exec` command pointing at the generated `.cmd` script;
   - principal run level limited/least privilege.
4. Change `buildWindowsSchtasksCreateArgs()` to return `/create /tn <TASK> /xml <xmlPath> /f` instead of `/tr`, `/sc`, `/du` flags.
5. In `installWindows()`, write both `opencodex-service.cmd` and the XML before `schtasks(...)`.
6. In `uninstallWindows()`, remove the XML file along with the cmd script.

### MODIFY tests/service.test.ts
1. Update schtasks arg test to expect `/xml` and no `/du`/`/tr`/`/sc` flag-only task body.
2. Add XML static test for PT0S execution limit, restart interval/count, battery settings, multiple instance policy, limited run level, and escaped script path.
3. Add uninstall/static source assertion that XML path is removed.

## Acceptance criteria
- Windows task creation uses XML settings, not `/du` as runtime hardening.
- XML contains service-like reliability settings requested by GPT Pro.
- Existing Windows service wrapper script tests remain green.
- Focused service tests and typecheck pass.

## Verification
- `bun test tests/service.test.ts`
- `bun x tsc --noEmit`

## Commit
- `fix(windows): install scheduler task from xml`

## Known debt
`src/service.ts` already exceeds the 500-line guideline. This patch keeps changes local; splitting service manager backends is a separate refactor.
