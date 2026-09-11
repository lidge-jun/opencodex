# 020 — Refresh every provider quota from the Provider Overview

Work-phase `wp2`. Depends on 000. Disjoint from 010 except for the i18n files.

## Problem

The aggregate overview stacks every provider's rate-limit bars and labels each
with its age ("2분 전 확인", "1시간 전 확인"), but offers no way to re-read them.
The only refresh controls live inside a selected provider's Usage and Accounts
tabs, so refreshing five providers means five drill-downs.

## Decision

Add one refresh control to `.pws-dashboard-header`, beside the existing
`JSON 편집` ghost button — the exact row the user marked.

It reuses the existing forced-read path rather than introducing a second one,
and it reports the settled result rather than an optimistic one. The page-level
comment in `Providers.tsx` already states why that matters: a state bump only
proves React was told to re-render, so a button that resolves on the bump would
claim success while stale numbers are still on screen.

## Diff plan

### gui/src/pages/Providers.tsx

`refreshProviderQuota(provider)` exists and does two things: a per-provider
account-set read (`fetchAccountSets([provider])`, best-effort) and the
provider-level forced read (`fetchProviderQuotas(true)`), returning the settled
promise from the shell.

Add a sibling for the aggregate case:

```ts
const refreshAllProviderQuotas = useCallback((): Promise<boolean> => {
  const settled = new Promise<boolean>(resolve => { quotaRefreshWaiters.current.push(resolve); });
  void fetchProviderQuotas(true);
  return settled;
}, [fetchProviderQuotas]);
```

Deliberately NOT calling `fetchAccountSets` for every provider: that is a
per-account enrichment read used by the account panels, it is best-effort by
design, and fanning it across every configured provider turns one operator
click into N upstream calls. The overview renders provider-level bars, which is
exactly what `/api/provider-quotas?refresh=1` returns. If a later need appears
for per-account bars in the overview, that is its own unit.

Pass it down: `onRefreshAllQuotas={refreshAllProviderQuotas}` on
`ProviderWorkspaceShell`.

### gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx

Add an optional prop `onRefreshAllQuotas?: () => Promise<boolean>` to the
component signature and prop type, and forward it to
`ProviderOverviewDashboard` at the existing render site. No change to the
`/api/provider-quotas` effect — it already handles `quotaForceRefresh` and
settles the waiters.

### gui/src/components/provider-workspace/ProviderOverviewDashboard.tsx

Accept `onRefreshAllQuotas?: () => Promise<boolean>`. Mirror the local state
shape `ProviderUsage.tsx` already uses so the two controls behave identically:

```tsx
const [refreshing, setRefreshing] = useState(false);
const [refreshResult, setRefreshResult] = useState<{ ok: boolean; text: string } | null>(null);

const refreshAll = async () => {
  if (!onRefreshAllQuotas || refreshing) return;
  setRefreshing(true);
  setRefreshResult(null);          // a prior success must not sit under a later failure
  try {
    const ok = await onRefreshAllQuotas();
    setRefreshResult({ ok, text: t(ok ? "codexAuth.quotaRefreshed" : "codexAuth.quotaRefreshFailed") });
  } catch {
    setRefreshResult({ ok: false, text: t("codexAuth.quotaRefreshFailed") });
  } finally {
    setRefreshing(false);
  }
};
```

Header JSX gains the button before `JSON 편집` (refresh is the frequent action;
editing raw JSON is the rare one), plus a `role="status"` result line:

```tsx
{onRefreshAllQuotas && (
  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void refreshAll(); }} disabled={refreshing}>
    {refreshing ? t("codexAuth.refreshingQuota") : t("pws.refreshAllQuotas")}
  </button>
)}
```

Reuse of `codexAuth.refreshingQuota` / `quotaRefreshed` / `quotaRefreshFailed`
is intentional: those strings already exist in all nine locales and describe
exactly these states. Only the idle label needs a new key, because "Refresh
quotas" (per provider) and "Refresh all quotas" (aggregate) are different
promises.

### i18n

Add `pws.refreshAllQuotas` to every locale:

| locale | value |
|--------|-------|
| en | `Refresh all quotas` |
| ko | `전체 할당량 갱신` |
| ja | `すべてのクォータを更新` |
| zh | `刷新全部额度` |
| zh-TW | `重新整理所有額度` |
| de | `Alle Kontingente aktualisieren` |
| fr | `Actualiser tous les quotas` |
| ru | `Обновить все квоты` |
| tr | `Tüm kotaları yenile` |

### gui/src/styles/provider-overview-dashboard.css

`.pws-dashboard-header` currently lays out title + one button. Ensure the
action cluster tolerates two buttons and a status line without wrapping badly:
add a `.pws-dashboard-header-actions` flex row (gap + align-items: center) and
let the status line sit inside it with `--muted`/ok/warn coloring reused from
the existing `pws-status-ok` / `pws-status-warn` classes.

## Verification

- `bun run typecheck`, `bun run lint:gui`
- Focused test: the control is disabled while in flight, renders the failure
  string when the promise resolves false, and is absent when the prop is not
  supplied.
- Live: click it against the running proxy, confirm a real
  `/api/provider-quotas?refresh=1` request and an updated age label; screenshot.

## Risk

One click triggers upstream quota probes for every configured provider. That is
the point of the control, and it is operator-initiated, disabled while running,
and identical in cost to the existing per-provider button used N times. No
automatic or timed variant is introduced.
