# 80.50 — Bun Runtime Override and PID Cleanup PABCD

## Purpose

Give Windows users a mitigation path if bundled Bun is the crash source, while making explicit stop/uninstall robust when PID identity checks are inconclusive.

## Source Evidence

- `devlog/80_windows-codex-path-hardening/15_final_gpt_pro_plan.md`
- GPT Pro conclusion: Patch 4 and Patch 5 are strongly recommended.

## PABCD Work Unit

This can be one PABCD cycle or two smaller cycles if implementation grows. Keep Bun override and PID cleanup together only if the diff remains small and tests are focused.

### P — Plan

Scope:

- MODIFY `bin/ocx.mjs` for npm launcher Bun selection
- MODIFY `src/service.ts` if service wrapper embeds selected Bun path
- MODIFY `src/process-control.ts` for safe PID cleanup behavior
- MODIFY `src/config.ts` or add a config helper only if persistent config is chosen over env-only override
- ADD or MODIFY launcher/service/process tests

Non-goals:

- Do not auto-switch all users from bundled Bun to canary/stable without Windows smoke validation.
- Do not kill arbitrary PIDs without identity checks except as an explicit logged best-effort stop/uninstall path.
- Do not expose tokens in runtime diagnostics.

### A — Audit

Ask a read-only auditor to verify:

- `OPENCODEX_BUN_PATH` or the chosen equivalent is validated before use.
- Invalid override paths fail loudly.
- Service wrapper uses the same selected Bun path as the CLI launcher.
- PID cleanup cannot kill unrelated user processes silently.

### B — Build

Implementation checklist:

- Add `OPENCODEX_BUN_PATH` support or an equivalent config field.
- Validate override path exists and is executable enough for the current platform.
- Log whether bundled Bun or override Bun is used.
- Ensure `ocx service install` embeds or resolves the selected Bun consistently.
- For explicit stop/uninstall, if PID file exists but Windows command-line inspection fails, attempt safe best-effort cleanup and log uncertainty.
- Keep strict PID identity checks for status/reporting.

Suggested commits:

```bash
git add bin/ocx.mjs src/service.ts tests && git commit -m "fix(windows): allow validated bun override"
git add src/process-control.ts tests && git commit -m "fix(windows): make explicit pid cleanup resilient"
```

### C — Check

Required commands:

```bash
bun test tests/service.test.ts tests/uninstall.test.ts tests/config.test.ts
bun x tsc --noEmit
```

Manual Windows smoke:

```powershell
$env:OPENCODEX_BUN_PATH = "C:\\path\\to\\bun.exe"
ocx -v
ocx service install
ocx service start
ocx service status
# Confirm selected Bun path appears in diagnostics/logs.
```

### D — Done Criteria

- Default bundled Bun path still works.
- Valid override path is used by CLI and service.
- Invalid override path fails with a clear message.
- PID inspection failure during explicit stop/uninstall still attempts logged cleanup.
- Tests cover default, valid override, invalid override, and PID uncertainty.
