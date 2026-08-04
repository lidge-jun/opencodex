# 020_page_migration — WP3 15개 표면 이관

작성 2026-07-30. WP2의 병행 문서 `010_loading_contract.md`가 landed 된 뒤 WP3 P에서 실제 export를 확인한다. 이 문서의 `WP2 adapter`, `WP2 skeleton primitive`, `WP2 status line`은 그때 실제 식별자로 치환하는 역할 표기이며 이름을 가정하지 않는다.

WP3은 새 fetch 계층을 만들지 않는다. 현재 fetcher와 session seed를 WP2 adapter의 동기 subscription 입력으로 옮긴다. `initial-loading`은 레이아웃형 WP2 skeleton, 성공 빈 응답은 기존 도메인 empty, cache 없는 실패는 WP2 status line+retry, cache가 있을 때 재검증은 기존 내용을 보존한 `aria-busy`+status line이다. sessionStorage에는 비밀을 넣지 않는다는 기존 제한은 [`session-list-cache.ts:1-4`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/session-list-cache.ts:1) 그대로다.

`App`은 현재 page만 렌더하고 `ErrorBoundary`도 `key={page}`다 ([`App.tsx:289-312`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/App.tsx:289)). 따라서 아래 subscription은 mount에서 동기 등록되어야 한다. 13개 route와 `#logs/debug`, Claude의 두 하위 표면이라는 15개 범위는 [`app-routing.ts:5-18`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/app-routing.ts:5), [`app-routing.ts:54-57`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/app-routing.ts:54)에 맞춘다.

아래 `makeResource`/`ResourceSkeleton`/`ResourceStatusLine`은 각각 WP2 adapter/primitive의 자리표시다. P에서 실제 이름으로 치환하되, `fetchX` 본문·mutation handler·cache key는 바꾸지 않는다.

## 표면별 change map

> ## P-phase 정정 (2026-07-30, WP3 진입 시)
>
> 이 문서는 WP2가 착지하기 전에 작성됐고, 어댑터·프리미티브 이름을 추상적으로 불렀다.
> WP2가 실제로 만든 것은 다음이며, 아래 각 절의 `makeResource` / `ResourceSkeleton` /
> `ResourceStatusLine` / `initialLoading` / `errorNoData` / `revalidating` 같은 가상 이름은
> 모두 이 실물로 읽는다.
>
> | 문서의 가상 이름 | WP2 실물 |
> |---|---|
> | `makeResource(...)` | `useDataSurface(key, deps, load, { isEmpty, pollMs?, enabled? })` — `gui/src/data-surface.ts` |
> | 상태 판정 | `resource.state` (`kind` + `showSkeleton` / `refreshing` / `showError`) |
> | `initialLoading` | `state.showSkeleton` (`kind === "cold"` 또는 `"retrying-cold"`) |
> | `errorNoData` | `state.showError && state.kind === "failed-cold"` |
> | `revalidating` | `state.refreshing` |
> | `ResourceSkeleton` | `<DataSurfaceSkeleton label rows />` — `gui/src/components/data-surface.tsx` |
> | `ResourceStatusLine` | `<DataSurfaceStatus live={...}>` + 기존 `Notice tone="err"` (오류는 기존 컴포넌트를 쓴다) |
> | `seed` 옵션 | WP2 어댑터에는 없다. 기존 `sessionStorage` 시드는 페이지가 `setClientResourceData(key, cached)`로 스토어에 게시하거나, 로더가 캐시를 먼저 반환하는 방식으로 보존한다. |
>
> 라이브 리전은 전환당 하나다. 스켈레톤이 있으면 상태줄을 렌더하지 않고, 오류 배너가 있으면
> 상태줄은 `live={false}`다(`010` §9.2·§10.1.1).

### 1. Dashboard (`#dashboard`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-dashboard-data.ts`, `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Dashboard.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/dashboard-contracts.test.ts`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- 현재는 0ms timer가 아니라 keyed cold subscription이다. overview와 wave-2의 실제 option은 [`use-dashboard-data.ts:188-253`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-dashboard-data.ts:188)이고 wave-2에는 `enabled: overviewReady`가 있다.

```diff
- const overviewPoll = useKeyedClientResource(...fetchDashboardOverview..., { pollMs: 5000 });
- const multiAgentPoll = useKeyedClientResource(...fetchDashboardMultiAgent..., { pollMs: 5000, enabled: overviewReady });
+ const overviewResource = makeResource("dashboard-overview", [apiBase], fetchDashboardOverview, { pollMs: 5000 });
+ const multiAgentResource = makeResource("dashboard-multi-agent", [apiBase], fetchDashboardMultiAgent, { pollMs: 5000, enabled: overviewReady });
- {selected.body}
+ {selectedNeedsColdData ? <ResourceSkeleton variant="dashboard-section" /> : selected.body}
+ {anyInitialError && <ResourceStatusLine tone="error" onRetry={refreshFailedResources} />}
```

현재 page는 error 외에는 sections를 바로 그린다 ([`Dashboard.tsx:29-59`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Dashboard.tsx:29)); provider/model empty를 initial loading으로 읽지 않게 section skeleton을 둔다. `ocx.dash.controls.v1:`, `overview.v1:`, `usage30d.v1:`, `startup.v1:`, `maMode.v1:` seed는 유지한다 ([`use-dashboard-data.ts:48-104`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-dashboard-data.ts:48)). 정적 assertion `expect(hook).toContain("enabled: overviewReady")`는 [`dashboard-contracts.test.ts:90`](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/dashboard-contracts.test.ts:90)에 있으므로 option literal을 보존해 **테스트도 변경하지 않는다**. close-out: `dashboard-contracts.test.ts`, `page-loading-contract.test.tsx`, `evidence/wp3-01-dashboard-cold.png`.

### 2. Startup (`#startup`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Startup.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/startup-usage-loading-race.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- 실제 mount fetch: `const timer = window.setTimeout(() => { void refresh(controller.signal); }, 0)` ([`Startup.tsx:181-191`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Startup.tsx:181)). health 뒤 settings/tray의 병렬 규칙은 유지한다 ([`Startup.tsx:92-155`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Startup.tsx:92)).

```diff
- useEffect(() => { ...setTimeout(() => { void refresh(controller.signal); }, 0)... }, [refresh]);
+ const startupResource = makeResource("startup-page", [apiBase], refreshAsSnapshot, { seed: cached });
- {loading && !data ? <EmptyState title={t("startup.loading")} /> : failed && !data ? <EmptyState title={t("startup.error")} /> : data ? <StartupBody ... /> : null}
+ {startupResource.initialLoading ? <ResourceSkeleton variant="startup" /> : startupResource.errorNoData ? <ResourceStatusLine tone="error" onRetry={startupResource.refresh} /> : <StartupBody aria-busy={startupResource.revalidating} ... />}
```

기존 JSX 분기는 [`Startup.tsx:268-303`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Startup.tsx:268)다. `ocx.startup.page.v1:${apiBase}` seed/writer는 유지한다 ([`Startup.tsx:71-76`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Startup.tsx:71), [`Startup.tsx:150-164`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Startup.tsx:150)). close-out: race test에 stale 보존 case 추가, `evidence/wp3-02-startup-cold.png`.

### 3. Codex 인증 (`#codex-auth`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/CodexAuth.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/codex-account-pool-behaviour.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/codex-auth-provider-enable.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- config mount은 `setTimeout(() => { void loadMode(); }, 0)` ([`CodexAuth.tsx:132-136`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/CodexAuth.tsx:132)); account pool도 `enabled`면 `setTimeout(() => { void load(); }, 0)`다 ([`useCodexAccountPool.ts:218-225`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:218)).

```diff
- useEffect(() => { const timeout = window.setTimeout(() => { void loadMode(); }, 0); const iv = window.setInterval(() => { void loadMode(); }, 30_000); ... }, [loadMode]);
+ const modeResource = makeResource("codex-auth-config", [apiBase], loadModeSnapshot, { pollMs: 30_000, seed: cached });
- const timeout = window.setTimeout(() => { void load(); }, 0);
+ const accountsResource = makeResource("codex-account-pool", [apiBase, enabled], loadAccountsSnapshot, { enabled });
- return <CodexAccountPool ... />;
+ return <CodexAccountPool loadingSlot={<ResourceSkeleton variant="codex-account-pool" />} statusSlot={<ResourceStatusLine resource={accountsResource} />} ... />;
```

`ocx.codex-auth.config.v1:${apiBase}`는 유지한다 ([`CodexAuth.tsx:100-126`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/CodexAuth.tsx:100)). account seed는 이메일/ID 때문에 `lastGoodByBase` in-memory cache이고 sessionStorage key가 없다 ([`useCodexAccountPool.ts:85`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:85)); 그대로다. 마지막 pause lease release가 load를 소급 호출하지 않는 assertion은 [`codex-account-pool-behaviour.test.tsx:264-267`](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/codex-account-pool-behaviour.test.tsx:264) 그대로 유지한다. WP2 subscription은 mount/`enabled` 전이에서만 시작하고 resume은 다음 poll만 허용하므로 안전하다. close-out: 두 기존 test와 contract test, `evidence/wp3-03-codex-auth-cold.png`.

### 4. Providers (`#providers`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-providers-fetch.ts`, `/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts`, `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/providers-hash-history.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- page config/OAuth는 `setTimeout(() => { void fetchConfig(); void fetchOauth(); }, 0)` ([`Providers.tsx:148-157`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:148)); account/key pools도 각 0ms timer ([`useProviderAccountPools.ts:240-254`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:240)), shell의 model/usage/quota도 0ms timer다 ([`ProviderWorkspaceShell.tsx:134-214`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:134)).

```diff
- setTimeout(() => { void fetchConfig(); void fetchOauth(); }, 0);
+ const configResource = makeResource("providers-config", [apiBase], fetchConfigSnapshot, { seed: config });
+ const oauthResource = makeResource("providers-oauth", [apiBase], fetchOauthSnapshot);
- setTimeout(() => { void fetchAccountSets(oauthCardProviders); }, 0);
+ makeResource("providers-oauth-accounts", [apiBase, oauthCardProviders], fetchAccountSetsSnapshot, { enabled: oauthCardProviders.length > 0 });
- setTimeout(() => { void fetch(`${apiBase}/api/selected-models`); }, 0);
+ makeResource("providers-selected-models", [apiBase, modelsRefreshToken], fetchSelectedModelsSnapshot);
- <div className="providers-workspace providers-workspace--boot">...rail...<span className="spin" />...</div>
+ <ResourceSkeleton variant="providers-workspace-boot" />
+ {configResource.errorNoData && <ResourceStatusLine tone="error" onRetry={configResource.refresh} />}
```

boot rail은 [`Providers.tsx:181-198`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:181)처럼 rail+main 비율을 보존하는 skeleton이어야 하며 text-only loader로 퇴행시키지 않는다. `ocx.providers.config.v1:${apiBase}`와 shell usage/quota seeds는 유지한다 ([`Providers.tsx:25-28`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:25), [`use-providers-fetch.ts:27-35`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-providers-fetch.ts:27)). close-out: hash test+contract test, `evidence/wp3-04-providers-boot-rail.png`; quota dedupe/fanout은 WP4다.

### 5. Models (`#models`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/model-visibility.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/models-empty-provider.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- catalog은 `setTimeout(() => { void load(); }, 0)`+10초 poll, shadow/v2도 독립 0ms timer다 ([`Models.tsx:236-267`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:236)).

```diff
- useEffect(() => { setTimeout(() => { void load(); }, 0); setInterval(() => { if (!busyRef.current) void load(); }, 10000); ... }, [load]);
+ const catalogResource = makeResource("models-catalog", [apiBase], loadSnapshot, { pollMs: 10_000, seed: cached, canPoll: () => !busyRef.current });
- setTimeout(() => { void loadShadowCall(); void loadV2(); }, 0);
+ const shadowResource = makeResource("models-shadow-call", [apiBase], loadShadowCallSnapshot);
+ const v2Resource = makeResource("models-v2", [apiBase], loadV2Snapshot, { pollMs: 10_000 });
- if (loading && !selectedModels) return <...spin...>; if (!selectedModels) return <Notice ...>;
+ if (catalogResource.initialLoading) return <ResourceSkeleton variant="models" />;
+ if (catalogResource.errorNoData) return <ResourceStatusLine tone="error" onRetry={catalogResource.refresh} />;
+ return <ModelsWorkspace aria-busy={catalogResource.revalidating} statusLine={<ResourceStatusLine resource={shadowResource} />} ... />;
```

기존 loader/error branch는 [`Models.tsx:622-642`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:622)다. `ocx.models.catalog.v1:${apiBase}`는 유지한다 ([`Models.tsx:55-75`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:55), [`Models.tsx:214-221`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:214)). empty provider는 성공 후 기존 EmptyProviderHint를 쓴다. close-out: 두 model test+contract test, `evidence/wp3-05-models-cold.png`.

### 6. Combos (`#combos`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Combos.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/combo-workspace-empty.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- 현재 mount fetch: `const timer = window.setTimeout(() => { void fetchAll(); }, 0)` ([`Combos.tsx:178-183`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Combos.tsx:178)).

```diff
- useEffect(() => { const timer = window.setTimeout(() => { void fetchAll(); }, 0); return () => window.clearTimeout(timer); }, [fetchAll]);
+ const combosResource = makeResource("combos-workspace", [apiBase], fetchAllSnapshot, { seed: seedCombos(cacheKey) });
- if (loading) return <div className="combos-workspace-shell">...<div role="status">{t("cws.loading")}</div></div>;
+ if (combosResource.initialLoading) return <ResourceSkeleton variant="combos-workspace" />;
+ if (combosResource.errorNoData) return <ResourceStatusLine tone="error" onRetry={combosResource.refresh} />;
+ return <ComboWorkspace aria-busy={combosResource.revalidating} ... />;
```

현재 text loader는 [`Combos.tsx:238-253`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Combos.tsx:238)다. `ocx.combos.workspace.v1:${apiBase}` seed/writer는 유지한다 ([`Combos.tsx:53-66`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Combos.tsx:53), [`Combos.tsx:163-170`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Combos.tsx:163)). close-out: empty test에 빈 성공은 skeleton이 아니라 workspace empty인 case 추가, `evidence/wp3-06-combos-cold.png`.

### 7. Subagents (`#subagents`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Subagents.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/subagents-classic.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- 현재 mount fetch는 `setTimeout(() => { void load(); }, 0)`다 ([`Subagents.tsx:49-54`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Subagents.tsx:49)).

```diff
- useEffect(() => { const timeout = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timeout); }, [load]);
+ const subagentsResource = makeResource("subagents", [apiBase], loadSnapshot, { seed: seedSubagents(cacheKey) });
- if (loading) return <div className="muted">{t("sub.loading")}</div>;
+ if (subagentsResource.initialLoading) return <ResourceSkeleton variant="subagents" />;
+ if (subagentsResource.errorNoData) return <ResourceStatusLine tone="error" onRetry={subagentsResource.refresh} />;
+ return <SubagentsWorkspace aria-busy={subagentsResource.revalidating} ... />;
```

기존 JSX는 [`Subagents.tsx:98-114`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Subagents.tsx:98)다. `ocx.subagents.v1:${apiBase}`는 유지한다 ([`Subagents.tsx:14-25`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Subagents.tsx:14), [`Subagents.tsx:27-46`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Subagents.tsx:27)). close-out: classic test+contract test, `evidence/wp3-07-subagents-cold.png`.

### 8. Logs (`#logs`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Logs.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/logs-auto-refresh.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- 0ms timer는 없다. `tab === "logs"` effect가 mount/재진입에 `void fetchLogs({ silent: hasLogsRef.current })`하고 2초 interval을 만든다 ([`Logs.tsx:365-393`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Logs.tsx:365)).

```diff
- useEffect(() => { if (tab !== "logs") return; void fetchLogs({ silent: hasLogsRef.current }); if (!autoRefresh) return; const interval = setInterval(() => void fetchLogs({ silent: true }), 2000); return () => clearInterval(interval); }, [autoRefresh, fetchLogs, tab]);
+ const logsResource = makeResource("logs", [apiBase], fetchLogsSnapshot, { enabled: tab === "logs", pollMs: autoRefresh ? 2_000 : false, seed: cachedLogs });
- {error ? <Notice .../> : loading && logs.length === 0 ? <EmptyState title={t("common.loading")} /> : filteredLogs.length === 0 ? <EmptyState title={t("logs.noRequests")} /> : <LogsTable .../>}
+ {logsResource.errorNoData ? <ResourceStatusLine tone="error" onRetry={logsResource.refresh} /> : logsResource.initialLoading ? <ResourceSkeleton variant="logs-table" /> : filteredLogs.length === 0 ? <EmptyState title={t("logs.noRequests")} /> : <LogsTable aria-busy={logsResource.revalidating} .../>}
```

현재 JSX는 [`Logs.tsx:550-561`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Logs.tsx:550)다. `ocx.logs.v1:${apiBase}` seed는 유지하되 빈 배열도 성공 empty로 기록한다. 현재는 cached zero length를 cold로 간주한다 ([`Logs.tsx:332-345`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Logs.tsx:332)); WP2 success bit가 이를 분리한다. close-out: auto-refresh test+contract test, `evidence/wp3-08-logs-cold.png`.

### 9. Logs → Debug (`#logs/debug`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Debug.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/debug-mutation-busy.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- settings는 keyed resource poll이고 ([`Debug.tsx:38-49`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Debug.tsx:38)), debug log 최초 read는 `setTimeout(...fetchLogs..., 0)`다 ([`Debug.tsx:122-141`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Debug.tsx:122)).

```diff
- const debugPoll = useKeyedClientResource(debugSettingsKey(apiBase), [apiBase], fetchDebug, { pollMs: 2000, enabled: active });
- const debug = debugPoll.data ?? cachedSettings ?? null;
+ const debugResource = makeResource("debug-settings", [apiBase], fetchDebug, { pollMs: 2000, enabled: active, seed: cachedSettings });
+ const debug = debugResource.data;
- const timeout = window.setTimeout(() => { if (changed) setEntries([]); void fetchLogs(true, controller.signal); }, 0);
+ const logResource = makeResource(`debug-log:${stream}`, [apiBase, stream, streamEnabled], fetchLogsSnapshot, { enabled: active && streamEnabled });
- {!debug ? <div className="empty">{t("debug.loading")}</div> : <DebugSettingsPanel .../>}
+ {debugResource.initialLoading ? <ResourceSkeleton variant="debug-settings" /> : debugResource.errorNoData ? <ResourceStatusLine tone="error" onRetry={debugResource.refresh} /> : !debug ? <EmptyState title={t("debug.noSettings")} /> : <DebugSettingsPanel aria-busy={debugResource.revalidating} .../>}
```

현재 `debugPoll.data ?? cachedSettings ?? null`과 `!debug` branch는 [`Debug.tsx:38-50`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Debug.tsx:38), [`Debug.tsx:207-218`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Debug.tsx:207)다. 그래서 failed settings read와 loading이 합쳐진다. 위 순서로 `error-no-data`를 먼저 분기한다. `ocx.debug.settings.v1:${apiBase}`는 유지한다 ([`Debug.tsx:22-45`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Debug.tsx:22)). close-out: mutation test+contract test, `evidence/wp3-09-debug-settings-error.png`.

### 10. Usage (`#usage`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Usage.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/usage-layout.test.ts`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- mount/filter fetch는 `setTimeout(() => { void fetchUsage(range, surface, controller.signal); }, 0)`다 ([`Usage.tsx:808-820`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Usage.tsx:808)).

```diff
- useEffect(() => { ...setTimeout(() => { void fetchUsage(range, surface, controller.signal); }, 0)... }, [fetchUsage, range, surface]);
+ const usageResource = makeResource("usage", [apiBase, range, surface], fetchUsageSnapshot, { seed: readHeldUsage(apiBase, range, surface) });
- {error ? <Notice tone="err">...retry...</Notice> : <UsageWorkspaceBody data={data} loading={loading} .../>}
+ {usageResource.initialLoading ? <ResourceSkeleton variant="usage-workspace" /> : usageResource.errorNoData ? <ResourceStatusLine tone="error" onRetry={usageResource.refresh} /> : <UsageWorkspaceBody data={data} loading={false} aria-busy={usageResource.revalidating} .../>}
```

현재 JSX는 [`Usage.tsx:850-879`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Usage.tsx:850)다. `ocx.usage.v1:${apiBase}:${range}:${surface}` memory+session seed는 유지한다 ([`Usage.tsx:743-759`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Usage.tsx:743)). close-out: usage layout+contract test, `evidence/wp3-10-usage-cold.png`.

### 11. Storage (`#storage`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Storage.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/storage-loading-race.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- report mount은 `setTimeout(() => { void fetchStorage(controller.signal); }, 0)`이고 ([`Storage.tsx:1390-1400`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Storage.tsx:1390)), policy/trash도 별도 0ms load다 ([`Storage.tsx:415-425`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Storage.tsx:415), [`Storage.tsx:701-711`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Storage.tsx:701)).

```diff
- setLoading(true); useEffect(() => { ...setTimeout(() => { void fetchStorage(controller.signal); }, 0)... }, [fetchStorage]);
+ const reportResource = makeResource("storage-report", [apiBase], fetchStorageSnapshot, { seed: cachedReport });
+ const policyResource = makeResource("storage-cleanup-policy", [apiBase], loadPolicySnapshot, { seed: cachedPolicy });
+ const trashResource = makeResource("storage-trash", [apiBase, reloadToken], loadTrashSnapshot);
- <button disabled={loading} onClick={() => void refreshAll()} />
- {showBody && <StorageReport .../>}
+ <button disabled={reportResource.initialLoading || reportResource.revalidating} onClick={() => void reportResource.refresh()} />
+ {reportResource.initialLoading ? <ResourceSkeleton variant="storage-report" /> : reportResource.errorNoData ? <ResourceStatusLine tone="error" onRetry={reportResource.refresh} /> : <StorageReport aria-busy={reportResource.revalidating} statusLine={<ResourceStatusLine resource={reportResource} />} .../>}
```

cached report에도 `fetchStorage`가 `setLoading(true)`를 호출한다 ([`Storage.tsx:1368-1387`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Storage.tsx:1368)); `showBody`는 data만 보면 true라 stale content는 남지만 visible loader가 없다 ([`Storage.tsx:1419-1425`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Storage.tsx:1419)). WP3은 내용을 지우지 않고 header status line+`aria-busy`로 보인다. `ocx.storage.report.v1:${apiBase}`와 `ocx.storage.cleanup-policy.v1:${apiBase}`는 유지한다 ([`Storage.tsx:633-665`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Storage.tsx:633), [`Storage.tsx:1355-1379`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Storage.tsx:1355)); trash에는 cache key가 없다. close-out: storage race+contract test, `evidence/wp3-11-storage-stale-revalidate.png`.

### 12. API / ApiKeys (`#api`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ApiKeys.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/apikeys-refresh-preserve.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- keys/models mount은 한 0ms callback에서 독립 호출한다 ([`ApiKeys.tsx:158-165`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ApiKeys.tsx:158)). keys는 finally에서 항상 loading을 끝내고 ([`ApiKeys.tsx:82-115`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ApiKeys.tsx:82)), models만 cache 없을 때 loading을 세운다 ([`ApiKeys.tsx:118-155`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ApiKeys.tsx:118)). workspace는 keys loading을 rail의 plain loading text로도 사용하고 ([`ApiKeysWorkspace.tsx:120-140`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx:120)) keys/model panel에 별도 flags를 전달한다 ([`ApiKeysWorkspace.tsx:225-254`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx:225)); 이 세 갈래를 WP2 primitive family로 합친다.

```diff
- useEffect(() => { const timeout = window.setTimeout(() => { void fetchKeys(); void fetchModels(); }, 0); return () => window.clearTimeout(timeout); }, [fetchKeys, fetchModels]);
+ const keysResource = makeResource("api-keys", [apiBase], fetchKeysSnapshot, { seed: cachedKeys });
+ const modelsResource = makeResource("api-models", [apiBase], fetchModelsSnapshot, { seed: cachedModels });
- <ApiKeysWorkspace keysLoading={keysLoading} modelsLoading={modelsLoading} ... />
+ <ApiKeysWorkspace keysSlot={keysResource.initialLoading ? <ResourceSkeleton variant="api-keys-list" /> : undefined} modelsSlot={modelsResource.initialLoading ? <ResourceSkeleton variant="api-model-catalog" /> : undefined} railStatus={<ResourceStatusLine resource={keysResource} />} aria-busy={keysResource.revalidating || modelsResource.revalidating} ... />
```

현재 상위 전달은 [`ApiKeys.tsx:308-335`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ApiKeys.tsx:308)다. `ocx.apikeys.list.v1:${apiBase}`, `ocx.apikeys.models.v1:${apiBase}`는 유지한다 ([`ApiKeys.tsx:54-72`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ApiKeys.tsx:54), [`ApiKeys.tsx:105-109`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ApiKeys.tsx:105), [`ApiKeys.tsx:147-149`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ApiKeys.tsx:147)). 각 panel의 error/retry는 독립이다. close-out: apikey refresh+contract test, `evidence/wp3-12-api-keys-cold.png`.

### 13. Claude → Code (`#claude`, Code tab)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Claude.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeCode.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/claudecode-fetch-errors.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- 현재 mount fetch: `setTimeout(() => { void load(); }, 0)` ([`ClaudeCode.tsx:81-86`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeCode.tsx:81)).

```diff
- <ClaudeCode key={apiBase} apiBase={apiBase} />
+ <ClaudeCode key={apiBase} apiBase={apiBase} active={tab === "code"} />
- useEffect(() => { const timeout = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timeout); }, [load]);
+ const codeResource = makeResource("claude-code", [apiBase], loadSnapshot, { enabled: active, seed: seedClaudeCode(cacheKey) });
- if (loading) return <div className="muted">{t("claude.loading")}</div>; if (!state) return <Notice tone="err">...</Notice>;
+ if (codeResource.initialLoading) return <ResourceSkeleton variant="claude-code" />; if (codeResource.errorNoData) return <ResourceStatusLine tone="error" onRetry={codeResource.refresh} />;
```

기존 JSX는 [`ClaudeCode.tsx:141-142`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeCode.tsx:141)다. `ocx.claude-code.v1:${apiBase}` seed는 유지한다 ([`ClaudeCode.tsx:21-38`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeCode.tsx:21), [`ClaudeCode.tsx:66-70`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeCode.tsx:66)). close-out: fetch error+contract test, `evidence/wp3-13-claude-code-cold.png`.

### 14. Claude → Desktop (`#claude`, Desktop tab)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Claude.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeDesktop.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/claude-desktop-vertical.test.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- Desktop mount은 `setTimeout(() => { void load(); }, 0)`이고 ([`ClaudeDesktop.tsx:210-213`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeDesktop.tsx:210)), status poll만 `active`에 따라 멈춘다 ([`ClaudeDesktop.tsx:237-269`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeDesktop.tsx:237)).

```diff
- useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
+ const desktopResource = makeResource("claude-desktop", [apiBase], loadSnapshot, { enabled: active, seed: seedDesktop(cacheKey) });
- if (loading) return <div className="claude-desktop-loading" role="status">...</div>; if (loadError || !data || !profile) return <div className="claude-desktop-error">...</div>;
+ if (desktopResource.initialLoading) return <ResourceSkeleton variant="claude-desktop" />; if (desktopResource.errorNoData) return <ResourceStatusLine tone="error" onRetry={desktopResource.refresh} />;
```

기존 branch는 [`ClaudeDesktop.tsx:367-375`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeDesktop.tsx:367)다. `ocx.claude-desktop.v1:${apiBase}`는 유지한다 ([`ClaudeDesktop.tsx:124-153`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeDesktop.tsx:124), [`ClaudeDesktop.tsx:187-192`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeDesktop.tsx:187)).

**결정:** child를 unmount하지 않는다. 현재도 draft/UI state 보존을 위해 둘 다 mount하고 Desktop poll만 hidden 때 중지한다 ([`Claude.tsx:65-80`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Claude.tsx:65)). 대신 Code와 Desktop adapter에 `enabled: active`를 준다. Desktop 선택 중 Code fetch는 0이고 반대도 같다. tradeoff는 inactive 설정을 미리 warm하지 않는 것이지만 draft DOM 수명은 보존하며, 이는 WP4 dedupe가 아니라 보이지 않는 child의 activation correctness다. close-out: desktop vertical+contract test, `evidence/wp3-14-claude-desktop-cold.png`.

### 15. Grok (`#grok`)

- 파일: `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Grok.tsx`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/grok-page.test.ts`, `/Users/jun/Developer/new/700_projects/opencodex/gui/tests/page-loading-contract.test.tsx`.
- 실제 mount fetch는 `const timer = window.setTimeout(() => { void load(); }, 0)`다 ([`Grok.tsx:97-102`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Grok.tsx:97)).

```diff
- useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
+ const grokResource = makeResource("grok-status", [apiBase], loadSnapshot, { seed: cached });
- if (loading) return <section className="grok-page"><p>{t("grok.loading")}</p></section>; if (error) return <section ...>...</section>;
+ if (grokResource.initialLoading) return <ResourceSkeleton variant="grok" />; if (grokResource.errorNoData) return <ResourceStatusLine tone="error" onRetry={grokResource.refresh} />;
+ return <GrokWorkspace aria-busy={grokResource.revalidating} .../>;
```

기존 loader/error는 [`Grok.tsx:187-196`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Grok.tsx:187)이다. `ocx.grok.status.v1:${apiBase}` seed는 유지한다 ([`Grok.tsx:56-70`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Grok.tsx:56), [`Grok.tsx:81-87`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Grok.tsx:81)). 성공했지만 `present === false`는 정상 not-configured empty로 유지한다 ([`Grok.tsx:222-229`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Grok.tsx:222)). close-out: grok page+contract test, `evidence/wp3-15-grok-cold.png`.

## 활성화 시나리오 표

| 분기 | 발화 | 관측 증거 |
|---|---|---|
| 0ms timer 폐기 | resource mount 직후 다른 hash로 이동 | mock fetch는 subscription 시점에 1회 호출되고 timer cleanup에 의해 사라지지 않음 |
| cold first load | 해당 `ocx.*` session key 삭제 뒤 mount | 각 `wp3-XX-*-cold.png`에 WP2 skeleton, `role=status`/`aria-busy` |
| stale revalidate | 유효 seed 뒤 응답 지연 | 기존 rows/cards 유지, skeleton 없음, status line만 보임 |
| empty success | `[]` 또는 빈 domain payload 200 | 기존 EmptyState, loading/error 아님 |
| first failure | 첫 GET 500/network reject | `error-no-data` status line + retry; Debug는 loading으로 합류하지 않음 |
| Dashboard wave-2 | overview promise hold 후 resolve | resolve 전 wave-2 request 0, 후 1; `enabled: overviewReady` 유지 |
| Codex pause lease | 두 lease 획득 뒤 마지막 release | [`codex-account-pool-behaviour.test.tsx:264-267`](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/codex-account-pool-behaviour.test.tsx:264)의 call count 불변 |
| Storage stale | report seed+delayed refresh | report는 유지, header status line과 `aria-busy=true` |
| Claude inactive child | Desktop 선택 상태에서 Code fetch 감시, 반대 반복 | inactive fetch 0, tab activation 1, child DOM/draft는 unmount되지 않음 |

## 커밋 분할

safest-first로 간다. 먼저 고립된 single-resource pages로 WP2의 landed call shape를 고정하고,
shared controller와 다중 subresource는 뒤에 둔다. surface마다 한 commit이며, 각 commit은
focused test 뒤 `cd gui && bun test tests && bun run lint && bun run build`를 실행한다. 마지막
두 명령은 구현 단계 검증 명령이지 이 문서 작성 단계에서 실행한 결과가 아니다.

| 순서 / commit | 표면 | focused verification |
|---|---|---|
| 1 `gui: migrate Grok loading contract` | Grok | `cd gui && bun test tests/grok-page.test.ts tests/page-loading-contract.test.tsx` |
| 2 `gui: migrate Subagents loading contract` | Subagents | `cd gui && bun test tests/subagents-classic.test.tsx tests/page-loading-contract.test.tsx` |
| 3 `gui: migrate Combos loading contract` | Combos | `cd gui && bun test tests/combo-workspace-empty.test.tsx tests/page-loading-contract.test.tsx` |
| 4 `gui: migrate Usage loading contract` | Usage | `cd gui && bun test tests/usage-layout.test.ts tests/page-loading-contract.test.tsx` |
| 5 `gui: migrate Startup loading contract` | Startup | `cd gui && bun test tests/startup-usage-loading-race.test.tsx tests/page-loading-contract.test.tsx` |
| 6 `gui: migrate Storage loading contract` | Storage | `cd gui && bun test tests/storage-loading-race.test.tsx tests/page-loading-contract.test.tsx` |
| 7 `gui: migrate Logs loading contract` | Logs | `cd gui && bun test tests/logs-auto-refresh.test.tsx tests/page-loading-contract.test.tsx` |
| 8 `gui: migrate Debug loading contract` | Logs → Debug | `cd gui && bun test tests/debug-mutation-busy.test.tsx tests/page-loading-contract.test.tsx` |
| 9 `gui: migrate Models loading contract` | Models | `cd gui && bun test tests/model-visibility.test.tsx tests/models-empty-provider.test.tsx tests/page-loading-contract.test.tsx` |
| 10 `gui: migrate API keys loading contract` | API | `cd gui && bun test tests/apikeys-refresh-preserve.test.tsx tests/page-loading-contract.test.tsx` |
| 11 `gui: migrate Claude Code loading contract` | Claude → Code | `cd gui && bun test tests/claudecode-fetch-errors.test.tsx tests/page-loading-contract.test.tsx` |
| 12 `gui: migrate Claude Desktop loading contract` | Claude → Desktop | `cd gui && bun test tests/claude-desktop-vertical.test.tsx tests/page-loading-contract.test.tsx` |
| 13 `gui: migrate Codex auth loading contract` | Codex 인증 | `cd gui && bun test tests/codex-account-pool-behaviour.test.tsx tests/codex-auth-provider-enable.test.tsx tests/page-loading-contract.test.tsx` |
| 14 `gui: migrate Dashboard loading contract` | Dashboard | `cd gui && bun test tests/dashboard-contracts.test.ts tests/dashboard-tabs.test.ts tests/page-loading-contract.test.tsx` |
| 15 `gui: migrate Providers loading contract` | Providers | `cd gui && bun test tests/providers-hash-history.test.tsx tests/page-loading-contract.test.tsx` |
| 16 `gui: capture WP3 surface evidence` | 15 screenshots | `bun run build:gui` 후 재기동 service에서 CDP capture 15장 |

WP3 최종 gate는 `bun run typecheck`와 `bun run test`다. 새 `page-loading-contract.test.tsx`는 commit 1에서 만들고 각 뒤 commit이 자기 surface case만 추가한다.

## 회귀 위험

위 순서는 safest-first다. Providers는 config/OAuth/account pool/selected-model/usage/quota가 여러 owner에 나뉘어 있고 ([`Providers.tsx:84-157`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:84), [`ProviderWorkspaceShell.tsx:134-214`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:134)), 가장 마지막이다. Codex 인증은 pause lease와 credential-bearing in-memory boundary를 함께 건드린다 ([`useCodexAccountPool.ts:85`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:85), [`codex-account-pool-behaviour.test.tsx:249-271`](/Users/jun/Developer/new/700_projects/opencodex/gui/tests/codex-account-pool-behaviour.test.tsx:249)). Dashboard는 overview readiness가 wave-2 start order를 통제한다 ([`use-dashboard-data.ts:188-253`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-dashboard-data.ts:188)). Storage는 report/policy/trash와 draft 보존이 같이 있다 ([`Storage.tsx:677-711`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Storage.tsx:677)). Claude는 permanent mount와 inactive subscription을 동시에 보존해야 한다 ([`Claude.tsx:65-80`](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Claude.tsx:65)).

## 범위 경계

**IN**: 15개 표면의 mount subscription, loading/empty/error/stale JSX 통일, 기존 cache seed 보존,
surface별 test와 cold screenshot.

**OUT**: request count·dedupe·single-flight·fanout 최적화는 WP4, settings card restyle은 WP6,
control 제거와 CLI/API 이관은 WP7이다. Providers quota fanout과 model selection request 축소도 이 WP에서 하지 않는다.
