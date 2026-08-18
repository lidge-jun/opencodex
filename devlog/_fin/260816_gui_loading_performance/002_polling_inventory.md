# 002 — fetch/poll inventory (research, no diffs)

Source: independent explorer audit of gui/src at origin/dev tip, verified against
live CDP measurement (001). No EventSource/WebSocket anywhere in gui/src — all
realtime behavior is interval polling.

## client-resource stores (pauseWhenHidden-capable)

| Surface | File:line | Endpoint(s) | pollMs | Notes |
|---|---|---|---|---|
| App shell | App.tsx:128 | /healthz | 30s | non-gating |
| Sidebar | sidebar-github-row.tsx:63,69 | /api/github/star, /api/update/badge | 300s/600s | |
| Dashboard | use-dashboard-data.ts:199-285 | /api/startup-health 30s; /healthz+/api/providers 5s; /api/v2 5s; /api/sidecar-settings+/api/shadow-call-settings 5s; /api/settings 5s; /api/injection-model+/api/effort-caps 5s; /api/usage?range=30d; /api/diagnostics/project-config; /api/models | 5s wave | wave-2 gated on overviewReady |
| Dashboard update job | use-dashboard-data.ts:406 | /api/update/status + /healthz | 1.5s | pauseWhenHidden:false (by design) |
| Startup | Startup.tsx:206 | /api/startup-health+/api/settings(+/api/windows-tray) | none | session cache seed |
| Providers | Providers.tsx:103,113 + ProviderWorkspaceShell.tsx:178 | /api/provider-presets; /api/usage?range=30d (shared key, 4 subscribers) | none | cache warm |
| Models catalog | Models.tsx:366 | /api/models+/api/provider-context-caps+/api/providers | 10s | session cache |
| Combos | Combos.tsx:197 | /api/combos+/api/config+/api/models | none | active-gated |
| Compatibility | CompatibilityMatrix.tsx:297 | lab matrix | 60s | |
| Subagents | Subagents.tsx:133 (loader :117) | /api/subagent-models | none | loader takes NO signal |
| Logs | Logs.tsx:490 | /api/logs?limit=2000 | 2s (auto-refresh default on) | |
| Debug | Debug.tsx:42,59 | /api/debug; /api/claude/inbound-debug | 2s | + raw 1s poll below |
| Usage | Usage.tsx:775 | /api/usage?range&surface | none | |
| Storage | Storage.tsx:1370,396 | /api/storage; /api/storage/trash | none | E3 victim |
| Integrations | ApiKeys/ClaudeCode/ClaudeDesktop/Grok/IntegrationsOverview/FileIntegrationPage | 8+ keys | none (ClaudeDesktop status 5s) | active-gated, session-seeded |

## Raw setInterval pollers (NO visibility handling today — H5)

| File:line | Endpoint | Cadence | signal | timeout | in-flight guard |
|---|---|---|---|---|---|
| MemoryObservabilityCard.tsx:277 | /api/system/memory | 5s | yes | 10s bounded | yes |
| MemoryObservabilityCard.tsx:342 | /healthz (reconnect) | 1.5s, gives up 120s | yes | 5s bounded | n/a |
| ProviderSettings.tsx:162 | /api/provider-request-pacing | 2s | NO | NO | NO |
| CodexAccountPickerSetting.tsx:42 | /api/settings | 30s | NO | NO | n/a |
| DefaultModeRequestUserInputSetting.tsx:47 | feature endpoint | 30s | NO | NO | n/a |
| useCodexAccountPool.ts:342 | account pool load | REFRESH_INTERVAL_MS | NO (:222,:250) | NO | n/a |
| CodexAuth.tsx:154 | /api/config | 30s | NO (:123) | NO | n/a |
| Models.tsx:413 | loadV2 | 10s, v2BusyRef-gated | NO (:298) | NO | busy-ref only |
| Debug.tsx:157 | pollLogs(false) | 1s | NO (:115) | NO | NO — stacks hung requests, refreshing can stick (explorer S6) |
| use-add-codex-account-oauth.ts:177 | OAuth login-status | 2s, 300s cap | yes | 10s bounded | yes |

## Timeouts today

Only 4 bounded call sites exist: MemoryObservabilityCard (2), ApiKeys mutations
(15s), stop-proxy (15s), OAuth status (10s). Every client-resource fetcher (~40
sites) and the session re-bootstrap are unbounded.

## Shared-key hazard

`usage-summary-30d:<base>:all` has 4 independent subscribers (Dashboard, Providers,
AddProviderModal, ProviderWorkspaceShell). One in-flight serves all — and one hang
wedges all (H1 applied to a shared key).

## Staleness note (S7)

Non-polled, active-gated pages (Integrations family, Combos) never revalidate on
tab re-activation: subscribe with cached data does not refetch unless
seedNeedsRevalidate (client-resource.ts:313-317). Contributes to the "stale until
F5" feel; addressed in WP4 with staleness-threshold revalidation.
