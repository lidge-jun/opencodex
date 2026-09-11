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
- AUTOSTART IS REHOMED IN THIS PHASE (audit blocker 2, PHASE-SPLIT-01). Extract `settings`,
  `settingsSaving`, `toggleCodexAutoStart` from use-dashboard-data.ts into NEW
  `gui/src/pages/use-codex-autostart.ts` (`useCodexAutostart(apiBase)` → `{ enabled, saving, toggle }`,
  GET/PUT `/api/settings` exactly as today). Startup.tsx already fetches `/api/settings`
  (L133-138); call the hook there and render the toggle row inside the 보호 상태 상세 panel
  (startup-sections.tsx after the shim row): label `dash.codexAutoStart`, hint
  `dash.codexAutoStartHint`, same `.switch` button. 070 then only restyles.

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
- Delete the 버전 stat (L79) and the 가동 시간 stat (L80). Uptime + version stay VISIBLE (audit
  blocker 5: no title-only info): render as the status card's sub-line in the same
  `.muted.text-label` slot the tokens card uses for coverage (L84-88):
  `<div className="muted text-label">v{health?.version ?? "—"} · {formatUptime(...)}</div>`.
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
RESOLVED (audit blocker 3) from dashboard-overview-sections.tsx:
- `DashboardEffortCapPanel` (L37): effort-cap card (GET/PUT `/api/effort-caps`, L65-114), rendered
  only when maMode !== v1. It is REHOMED IN THIS PHASE, not deferred (round-2 blocker 2: Models'
  v2 row is `/api/v2`, not an equivalent). Extract the card body + its fetch/save into NEW
  `gui/src/components/subagents-workspace/EffortCapSection.tsx` (props: apiBase; owns the
  `/api/effort-caps` state that use-dashboard-data.ts holds today: effortCap, subagentEffortCap,
  effortCapSaving, setters) and mount it in Subagents.tsx below SubagentDelegationSection,
  gated by `ultraMode.multiAgentMode !== "v1"`. Contract change IN THIS PHASE (round-3 blocker 2):
  `gui/src/pages/use-subagent-delegation.ts:23-27` `UltraModeState` gains
  `multiAgentMode: "v1" | "default" | "v2"`; `Subagents.tsx:53-60` `loadUltraMode` sets it from
  `data.multiAgentMode ?? "default"`; the initial state literal at `Subagents.tsx:28` and the
  fixture at `gui/tests/multi-agent-guidance.test.tsx:68` both gain `multiAgentMode: "default"`
  (round-4 blocker 2: required field, so every constructor site is listed). (`UltraModePatch` is widened in 030 when the switch arrives.)
- `DashboardInjectionPanel` (L120, `.dash-delegation-summary`, `dash.injectionLabel`) = the
  서브에이전트 위임 card → DELETE (Subagents owns 먼저 부를 모델).
- `DashboardMaintenancePanel` (L162) = 모델 동기화 + update dialog → KEEP.
- `DashboardSidecarPanels` (L437) = autostart + web-search + vision + shadow-call → delete the
  autostart card and shadow-call panel here; wrap web-search + vision in details.
Final panels.tsx body:
```tsx
<DashboardMaintenancePanel d={props} />
<details className="panel dash-sidecars"><summary className="font-semibold">{t("dash.sidecars")}</summary><DashboardSidecarPanels d={props} /></details>
<MemoryObservabilityCard apiBase={props.apiBase} />
```

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
- NEW gui/tests/startup-autostart-rehome.test.tsx (happy-dom, fetch stub): Startup renders the
  autostart switch from `/api/settings.codexAutoStart`; clicking PUTs `/api/settings` with the
  flipped value; Dashboard no longer renders `dash.codexAutoStart`.
- NEW gui/tests/subagents-effort-cap-rehome.test.tsx: Subagents with `/api/v2` → multiAgentMode
  "default" renders EffortCapSection reading `/api/effort-caps`; changing a cap PUTs
  `/api/effort-caps`; with multiAgentMode "v1" the section is absent; Dashboard renders no
  `dash.effortCapLabel`.
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
