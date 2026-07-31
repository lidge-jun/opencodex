# 80.40 — Windows Task Scheduler Hardening PABCD

## Purpose

Harden the Windows service contract. GPT Pro judged Task Scheduler unlikely to be the minute-scale root cause, but its default behavior is still too weak for a Windows hotfix because recovery and stop semantics are ambiguous.

## Source Evidence

- `devlog/80_windows-codex-path-hardening/15_final_gpt_pro_plan.md`
- GPT Pro conclusion: Patch 3 is release-blocking for the hotfix but probably not the initiating failure.

## PABCD Work Unit

This is one PABCD cycle after 80.30. Do not start it until service logging exists, because scheduler hardening needs logs to prove restart/stop semantics.

### P — Plan

Scope:

- MODIFY `src/service.ts`
- MODIFY `tests/service.test.ts`
- ADD helper tests if XML generation is split into a new module

Non-goals:

- Do not make Windows service stop auto-restart the proxy.
- Do not rely on Task Scheduler restart to replace wrapper-level child restart.
- Do not require users to manually edit Task Scheduler.

### A — Audit

Ask a read-only auditor to verify:

- XML/PowerShell task definition is compatible with current Windows Task Scheduler semantics.
- `ExecutionTimeLimit` is disabled with `PT0S`.
- Stop/uninstall still stop wrapper first, then tracked child, before deleting task or restoring Codex.
- Multiple-instance policy does not spawn duplicate proxies.

### B — Build

Implementation checklist:

- Replace bare `schtasks /create /sc onlogon /rl highest /f` with XML or PowerShell task definition.
- Set `ExecutionTimeLimit` to `PT0S`.
- Set restart interval and restart count explicitly.
- Set battery behavior explicitly.
- Set multiple-instance policy explicitly.
- Preserve intentional stop semantics: `ocx service stop` must not immediately resurrect the service.
- Ensure uninstall still stops and kills tracked child before task deletion.

Suggested commit:

```bash
git add src/service.ts tests/service.test.ts && git commit -m "fix(windows): harden scheduled task settings"
```

### C — Check

Required commands:

```bash
bun test tests/service.test.ts tests/uninstall.test.ts
bun x tsc --noEmit
```

Manual Windows smoke:

```powershell
ocx service install
schtasks /query /tn OpenCodex /xml
# Verify ExecutionTimeLimit PT0S, restart settings, battery policy, multiple instance policy.
ocx service stop
# Verify no opencodex/Bun child remains and it does not respawn.
```

### D — Done Criteria

- Scheduled task definition contains explicit lifetime, restart, battery, and instance policy.
- Stop and uninstall semantics remain stop-before-delete and stop-before-restore.
- Tests assert generated settings.
- Windows manual smoke evidence is recorded in devlog.
