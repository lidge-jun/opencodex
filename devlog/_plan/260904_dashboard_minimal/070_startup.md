# 070 — WP7: Startup — hero answers, details wait

Depends on: 020 (the Codex-autostart toggle removed from the dashboard is re-homed here).

## File change map

### MODIFY gui/src/pages/Startup.tsx (L318-332) and gui/src/pages/startup-sections.tsx (L236-262)

- Page head: delete the 대시보드로 돌아가기 button; keep 새로고침. Subtitle: delete the `<p>`; the
  sentence becomes a visible `.muted` line inside the hero card under `startup.safeDetail`
  (audit blocker 5: not a `title`).
- Data note: Startup reads `/api/startup-health` (L141) and already fetches `/api/settings`
  (L133); the autostart toggle was rehomed here in 020 via `useCodexAutostart`.
- Recovery section (`startup-sections.tsx:236-262` `startup-actions` panel): wrap the
  `.startup-command-list` in `<details open={data.status !== "protected"}>` (StartupRecoverySection receives `data: StartupHealthData`, startup-sections.tsx:217; confirm the discriminator field name at B — the hero switches on the same one) inside the panel; the panel head +
  hint stay as the summary.

### MODIFY gui/src/pages/startup-sections.tsx (L59-73)

- Replace `.startup-state-grid` (three `.stat`) with one line under the hero:
  `<p className="muted startup-state-line">{t(routingKey)} · {t(PROTECTION_KEYS[data.protection])} · {t(data.autostartEnabled ? "startup.enabled" : "startup.disabled")}</p>`.
- The autostart toggle row already exists here after 020 (rehomed atomically there); this phase only repositions it if the 보호 상태 상세 panel is restructured.

### MODIFY gui/src/styles.css

- DELETE `.startup-state-grid` (if unused elsewhere: `rg`); ADD `.startup-state-line`.

### MODIFY gui/src/i18n/*.ts

- `startup.backToDashboard` → orphan (090). No new keys (`dash.codexAutoStart*` reused).

### Tests

- MODIFY gui/tests/startup-*.test.ts* (`startup-install-result-reconciliation.test.tsx`
  and any asserting the 3-stat grid or back button).
- NEW gui/tests/startup-minimal.test.tsx: protected fixture → recovery details closed, state
  line present, autostart switch present and PUTs `/api/settings`; at-risk fixture → details open.

## Verifiers

`bun test ./gui/tests/startup*.test.ts*`, `cd gui && bun test tests`, `cd gui && bun run lint:i18n`, build.

## Accept criteria

- ko 1440 #startup (protected): hero + one line + 보호 상태 상세 + collapsed 복구 방법.

## Bypass fields

E2 · CI gates · `--no-verify` · none · "early warning".
