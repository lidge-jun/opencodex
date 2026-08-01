# 260627 Cycle 4 — Windows Service Wrapper Start Log Plan

## Purpose

Make the generated Windows Task Scheduler wrapper leave durable startup evidence before launching Bun. This is the first service-observability patch and is intentionally limited to wrapper start identity, not scheduler XML or child exit policy.

## Planned Diff

### MODIFY `src/service.ts`

- Export `serviceLogPath()` or keep `logPath()` internal but reuse it in Windows wrapper generation.
- In `buildWindowsServiceScript(...)`, add `OCX_SERVICE_LOG` variable and append token-safe startup lines:
  - timestamp;
  - Bun path;
  - CLI path;
  - OPENCODEX_HOME;
  - CODEX_HOME;
  - config dir/log path by variable.
- Redirect child stdout/stderr to the same log file for this cycle if it can be done safely with batch redirection.
- Do not print API token contents; only token file path is allowed.

### MODIFY `tests/service.test.ts`

Add assertions that `buildWindowsServiceScript(...)` contains:

- `OCX_SERVICE_LOG` assignment;
- startup log marker;
- Bun/CLI/CODEX_HOME/OPENCODEX_HOME labels;
- child command appends to the log;
- no raw `OPENCODEX_API_AUTH_TOKEN` value.

## Verification

```bash
bun test tests/service.test.ts
bun x tsc --noEmit
```

## Acceptance Criteria

- Windows wrapper writes start identity before launching child.
- Startup evidence is token-safe.
- Existing shell escaping tests still pass.
- Focused tests and typecheck pass.
