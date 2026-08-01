# 040 — PR #306: feat(windows): tray controls and restart-safety diagnostics

- Author: himomohi (Appcaster) · base `dev` · +3610/−49, 45 files, 8 commits.
- **CI: only CodeRabbit has run** — statusCheckRollup shows a single check. Cross-platform
  CI (ubuntu/windows/macos + npm-global) has NOT executed on the current head.
- **GUI-TOUCHING**: `gui/src/App.tsx`, `gui/src/pages/Dashboard.tsx`, new
  `gui/src/pages/Startup.tsx` (~360 lines), `gui/src/startup-health-ui.ts`, all 6 i18n files,
  `styles.css`. Per standing policy this alone blocks merge without explicit owner approval.

## What it does

- Windows-only notification-area tray (`src/tray/windows-tray.ps1`, 272-line PowerShell WinForms
  app) with Start/Stop/Restart/Open dashboard/Open logs/Exit; singleton via named mutex keyed
  on sha256(home path); heartbeat JSON + action log.
- `ocx tray install|start|stop|status|uninstall` CLI + `HKCU\...\Run` login registration,
  preserved across package updates (`src/update/tray-update-plan.mjs`).
- Restart-safety diagnostics: `src/codex/autostart-health.ts` classifies OCX-owned routing vs
  custom/remote gateways vs stale/disabled/conflicting lifecycle state; fail-closed injection.
- Management API startup/tray health endpoint (secret-free) + localized Startup dashboard page.

## Review findings

- PowerShell arg handling: `ConvertTo-NativeArgument` rejects quotes/CR/LF then wraps in
  quotes — reasonable, though trailing-backslash quoting (`C:\path\` → `"C:\path\"`) is a
  classic Win32 quoting pitfall left unhandled. Paths come from our own install layout, so
  exposure is low, but worth a comment or trailing-backslash guard.
- Registry writes are per-user HKCU Run — no elevation, acceptable surface. Uninstall removes
  only the owned entry.
- Scope is very large for one PR (tray + update-handoff + health cache + GUI page + docs x5).
  Tests are extensive (9 test files), which helps, but nothing has been proven on real
  Windows CI yet on this head.

## Verdict: **HOLD — needs cross-platform CI run + explicit GUI approval**

Not mergeable in this pass: (1) GUI-touching → owner sign-off required; (2) cross-platform CI
has not run on current head — Windows behavior is the whole point of the PR; (3) `bin/ocx.mjs`,
`src/service.ts`, `src/update/*` touch the service lifecycle path that release policy treats as
security-review scope. Recommend: trigger CI, then a dedicated review session for the
service/update/tray triangle before any merge decision.
