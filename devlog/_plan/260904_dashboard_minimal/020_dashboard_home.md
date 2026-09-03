# 020 — WP2: dashboard becomes health + sync + startup risk

Depends on: nothing at code level (010 is independent). Order after 010 for stack hygiene.

## Goal

Dashboard shows: stat row (status, providers, tokens 30d), reboot-protection bar, model sync
card, one collapsed "사이드카" disclosure, memory pressure bar with details collapsed. Everything
else moves to its owning page or is removed as a duplicate.

## File change map

### DELETE gui/src/pages/dashboard-providers-section.tsx, gui/src/pages/dashboard-models-section.tsx

### MODIFY gui/src/pages/Dashboard.tsx

- Remove imports of the two sections, `DashboardSection`, `dashboardHashForSection`,
  `selectDashboardTab`, `onTabKeyDown`, the `sections` array, the `page-tabs` tablist and
  the `role="tabpanel"` wrapper. Render:
```tsx
<div className="dashboard-workspace-shell">
  <div className="page-head"><h2>{t("nav.dashboard")}</h2></div>
  <DashboardOverviewSection {...d} />
  {updateDialog}
</div>
```
- Delete `<p className="page-sub">{t("dash.subtitle")}</p>`.

### MODIFY gui/src/pages/dashboard-shared.ts

- `DashboardSection` → keep type as `"overview"` only or delete with its readers;
  `readDashboardSectionFromHash` / `dashboardHashForSection` → DELETE.
- `DASHBOARD_UPDATE_HASH` and `hashRequestsUpdateDialog` stay.

### MODIFY gui/src/pages/use-dashboard-data.ts

- L90, L173: remove `selectedSection` state + hash listener; remove `models`, `modelsLoading`,
  `modelQuery`, `filteredGroups`, `expandedProviders` ONLY if no remaining overview consumer
  (`sidecarModels`/`visionModels` derive from `models` — keep `models`).
- Remove `maMode`, `maBusy`, `switchMaMode`, `maError`, `maHelp*`, `maModePoll`,
  `MA_MODE_CACHE_PREFIX` and the dialog in dashboard-dialogs.tsx (`multi-agent-help-dialog`).
- Remove `shadowCall*` state, refs, `saveShadowCall`, help dialog — Models owns it
  (Models.tsx:345 has its own state).
- Remove `toggleCodexAutoStart` + `settings`/`settingsSaving` if only the autostart card used
  them (check `DashboardMaintenancePanel` first; the model-sync card uses other fields).

### MODIFY gui/src/app-routing.ts

- L62 `DASHBOARD_TAB_HASHES` → DELETE; L111 hashBelongsToPage dashboard clause → only
  `DASHBOARD_UPDATE_HASH`.
- `resolveAppHashChange`: add
```ts
if (rawHash === "dashboard/providers") return { page: "providers", replaceTo: "providers" };
if (rawHash === "dashboard/models") return { page: "models", replaceTo: "models" };
```
  (passive replace, same pattern as the legacy `debug` and `api` rewrites at L133/L153).

### MODIFY gui/src/pages/dashboard-overview-head.tsx (L34-90)

- Delete the multi-agent stat (first `.stat`, L34-64) and its props.
- Delete the 버전 stat (L79) and the 가동 시간 stat (L80); put uptime + version into the
  status stat's `title`: `title={`v${health?.version ?? "—"} · ${formatUptime(...)}`}`.
- Keep status, providers, tokens(30d)+coverage. `.stat-row` now has 3 cards.

### MODIFY gui/src/pages/dashboard-overview-panels.tsx

```tsx
<DashboardEffortCapPanel …/>            // keep (verify it is the model-sync/effort card; if it is the injection prompt panel, keep too)
<div className="dash-overview-tools">
  <DashboardInjectionPanel …/>          // keep? — it is "서브에이전트 위임"? verify: if so DELETE
  <DashboardMaintenancePanel …/>        // keep (모델 동기화 + update dialog owner)
</div>
<details className="panel dash-sidecars"><summary>{t("dash.sidecars")}</summary><DashboardSidecarPanels d={props}/></details>
<MemoryObservabilityCard …/>
```
Resolve at B by reading each panel's JSX: the names above are guesses from the file; the
decision table (002 #3-#6) is the authority: 서브에이전트 위임 → remove; Codex 실행 시 시작 →
remove (moves to 070); shadow-call → remove; sidecars → collapse.

### MODIFY gui/src/pages/dashboard-overview-sections.tsx

- `DashboardSidecarPanels`: delete the autostart `.panel` (L485-505) and the shadow-call
  `.panel` (L626-668) and their destructured props; keep web-search + vision panels.
- Delete the 서브에이전트 위임 card (L127-160 region) and `DashboardInjectionPanel` if that is
  what it renders.

### MODIFY gui/src/components/MemoryObservabilityCard.tsx (L451-467)

- Move the `<div className="stat-row mem-stats">…` block inside the existing `<details>`
  (after `dash.mem.hint`). Above the details only `<MemoryPressure/>` + in-flight/restart row
  remain.

### MODIFY gui/src/i18n/*.ts (9)

- ADD `dash.sidecars` ("Sidecars" / "사이드카").
- DELETE (after `rg` proves no consumer): `dash.subtitle`, `dash.activeProviders`,
  `dash.availableModels`, `dash.workspace.overview`, `dash.workspace.sections`, `dash.version`,
  `dash.uptime`, `dash.multiAgent*`, `dash.shadowCall*`, `dash.codexAutoStart*` (autostart keys
  are REUSED by 070 — keep them), `dash.delegation*`.
  Deletion is deferred to 090 if it touches more than ~20 keys; this phase only ADDS.

### Tests

- DELETE gui/tests/dashboard-tabs.test.ts (contract removed) → REPLACE with
  gui/tests/dashboard-legacy-hashes.test.ts: `resolveAppHashChange("dashboard/providers")`
  → `{page:"providers", replaceTo:"providers"}`, same for models; `dashboard/update` still
  belongs to dashboard.
- MODIFY gui/tests/dashboard-contracts.test.ts, dashboard-model-grouping.test.ts,
  dashboard-sync-feedback.test.tsx, vision-sidecar-dashboard.test.tsx: run them at B; those
  that import the deleted sections are rewritten or deleted (grouping helper may move with
  Models if still used there).
- NEW gui/tests/dashboard-minimal.test.tsx (happy-dom): mount Dashboard with a stub
  `/api/*`; assert no `role="tablist"`, no text "reasoning_effort", stat-row has 3 `.stat`,
  `details.dash-sidecars` is closed by default and opens on click revealing the web-search
  Select.

## Verifiers

- `bun test ./gui/tests/dashboard-*.test.ts* ./gui/tests/vision-sidecar-dashboard.test.tsx ./gui/tests/app-routing*.test.ts` (list actual files at P).
- `cd gui && bun test tests` (whole GUI dir, seconds).
- `cd gui && bun run lint:i18n`, `cd gui && bun run build`.

## Accept criteria

- `#dashboard/providers` in the address bar lands on Providers with hash `#providers`.
- ko 1440 screenshot: dashboard first viewport = stat row (3) + health bar + sync card +
  collapsed 사이드카 + memory pressure; interactive count on #dashboard drops from 34 to ≤ 14.
- No dashboard control writes `multiAgentMode` or `shadowCall` (grep).

## Bypass fields

E2 · CI gates · `--no-verify` local · residual: redirect only covers the two known hashes · "early warning".
