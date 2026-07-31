# 80.30 — Windows Service Logging and Runtime Identity PABCD

## Purpose

Make Windows failures diagnosable. Users currently report every failure as "proxy stopped" because the Task Scheduler wrapper and child process do not produce enough durable evidence.

## Source Evidence

- `devlog/80_windows-codex-path-hardening/15_final_gpt_pro_plan.md`
- GPT Pro conclusion: Patch 2 is release-blocking.

## PABCD Work Unit

This is one PABCD cycle focused on observability. It should follow 80.20 so future Windows stream failures have usable evidence.

### P — Plan

Scope:

- MODIFY `src/service.ts`
- MODIFY `src/process-control.ts` only if process identity details need reuse
- MODIFY `src/cli.ts` status output only to surface log path, not to redesign CLI
- ADD or MODIFY `tests/service.test.ts`

Non-goals:

- Do not change scheduler XML/settings in this phase.
- Do not change bundled Bun selection policy in this phase.
- Do not claim root cause is fixed only because logs exist.

### A — Audit

Ask a read-only auditor to verify:

- Wrapper script generation can write logs before child start.
- Log path is stable under `%LOCALAPPDATA%` or the existing opencodex config dir.
- The child stdout/stderr capture does not deadlock or hide output.
- `ocx service status` can show the log path without requiring admin-only commands.

### B — Build

Implementation checklist:

- Add a deterministic Windows service log path helper.
- In the generated `.cmd` or PowerShell wrapper, log:
  - wrapper start timestamp;
  - selected Bun path;
  - Bun version if cheaply available;
  - opencodex package version;
  - CLI path;
  - config dir;
  - `CODEX_HOME`;
  - child start command;
  - child exit code;
  - restart decision.
- Capture child stdout/stderr into the service log or clearly linked per-run child logs.
- Make `ocx service status` print the log path.
- Keep logs token-safe: no API keys, OAuth tokens, Authorization headers, or full config dumps.

Suggested commit:

```bash
git add src/service.ts src/cli.ts tests/service.test.ts && git commit -m "fix(windows): add service runtime diagnostics"
```

### C — Check

Required commands:

```bash
bun test tests/service.test.ts tests/cli-help.test.ts
bun x tsc --noEmit
```

Manual Windows smoke:

```powershell
ocx service install
ocx service start
ocx service status
# Confirm status prints the log path.
Get-Content <printed-log-path> -Tail 80
```

### D — Done Criteria

- Wrapper start and child exit are logged.
- Bun path/version, opencodex version, CLI path, config dir, and CODEX_HOME are logged.
- `ocx service status` points users to the log path.
- Tests assert required log/script fragments.
- No secrets appear in generated logs or tests.
