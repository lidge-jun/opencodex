# wp2 — operator-driven quota refresh on both named surfaces

Goal: an operator can force a fresh quota read for any provider, from the Accounts
surface and from the Usage surface, with a visible busy state and a success/failure
report.

## Where the force path already exists

`Providers.tsx` owns `invalidateProviderQuotas(force)` → `quotaRefresh {epoch, force}`
→ `ProviderWorkspaceShell` effect → `GET /api/provider-quotas?refresh=1`. Every
caller today is a mutation. `useProvidersFetch` already exposes it as
`fetchProviderQuotas(refresh?: boolean)`, and `useProviderAccountPools` already holds
it. So the work is plumbing a handler down to the two panels, not new fetch logic.

The per-account rows are filled by a SEPARATE read —
`/api/oauth/accounts?provider=X&quota=1` inside `fetchAccountSets` — so the Accounts
surface must trigger both, or the bars beside each account keep their old numbers
while the provider-level report updates.

## Diff-level plan

### `gui/src/hooks/useProviderAccountPools.ts`

New exported callback:

```ts
  const refreshProviderQuota = useCallback(async (provider: string): Promise<boolean> => {
    const [accountsOk] = await Promise.all([
      fetchAccountSets([provider]),
      fetchProviderQuotas(true),
    ]);
    return accountsOk;
  }, [fetchAccountSets, fetchProviderQuotas]);
```

Returned from the hook and destructured in `Providers.tsx`.

`fetchAccountSets` already carries a per-provider generation guard, so a second
refresh while one is in flight cannot commit an older response.

### `gui/src/components/provider-workspace/types.ts`

`ProviderAuthHandlers` gains `onRefreshQuota?: (provider: string) => Promise<boolean>`.
Optional, so the Codex-accounts surface (which has its own button) and any caller that
does not pass it keep compiling.

### `gui/src/components/provider-workspace/ProviderAuthPanel.tsx`

In the OAuth-accounts branch, beside the existing "Add account" control, a button
gated on `authHandlers.onRefreshQuota` and on there being at least one account:

```tsx
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [quotaRefreshMsg, setQuotaRefreshMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refreshQuota = async () => {
    if (!authHandlers.onRefreshQuota || refreshingQuota) return;
    setRefreshingQuota(true);
    setQuotaRefreshMsg(null);
    try {
      const ok = await authHandlers.onRefreshQuota(item.name);
      setQuotaRefreshMsg({ ok, text: t(ok ? "codexAuth.quotaRefreshed" : "codexAuth.quotaRefreshFailed") });
    } catch {
      setQuotaRefreshMsg({ ok: false, text: t("codexAuth.quotaRefreshFailed") });
    } finally {
      setRefreshingQuota(false);
    }
  };
```

Rendered with `IconRefresh`, `disabled={refreshingQuota || busy || Boolean(switchingAccountId)}`,
label `refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")`,
and the outcome in a `role="status"` span. The message is cleared on the next click so
a stale "refreshed" cannot sit under a later failure.

A passive provider gets the same button. The refresh is honest there too: it re-reads
the cached observation, it does not and must not spend an inference turn — the server
path (`fetchPassiveProviderQuota`) is cache-only by construction and ignores
`forceRefresh`, so no client guard is needed and none is added.

### `gui/src/components/provider-workspace/ProviderUsage.tsx`

The `pws.rateLimits` block gains a header row with the same control. `ProviderUsage`
is presentational today, so it takes two new optional props rather than reaching for a
hook:

```tsx
  onRefreshQuota?: () => Promise<boolean>;
```

with local busy/message state identical in shape to the Accounts one. The section
header becomes a flex row: `<h3>` on the left, the button on the right. The button is
shown whenever the handler exists — including when `quota` is null, since "no quota
shown" is precisely when an operator wants to retry.

### `gui/src/components/provider-workspace/ProviderDetails.tsx`

Threads `onRefreshQuota` from its props into `ProviderUsage`, and passes the shared
handler into `ProviderAuthPanel` through `authHandlers`.

### `gui/src/pages/Providers.tsx`

Adds `onRefreshQuota: refreshProviderQuota` to the `authHandlers` object and
`onRefreshQuota={() => refreshProviderQuota(item.name)}` to `ProviderDetails`.

### i18n

`codexAuth.refreshQuota`, `codexAuth.refreshingQuota`, `codexAuth.quotaRefreshed`
and `codexAuth.quotaRefreshFailed` exist in all nine locale files
(en, ko, ja, zh, zh-TW, de, fr, ru, tr) — verified, four hits each. No new keys are
introduced, so no locale can fall out of sync in this phase.

### CSS

One new rule in `gui/src/styles/provider-quota.css` (or the nearest workspace
stylesheet) for the section-header flex row and the status text. No new colour tokens.

## Tests

- `gui/tests/provider-quota-refresh-usage.test.tsx` — the Usage tab renders the
  button, clicking it calls the handler once, the label swaps to the busy copy while
  the promise is pending, and a rejected handler reports the failure copy.
- `gui/tests/provider-quota-refresh-accounts.test.tsx` — the Accounts panel renders
  the button for an OAuth provider, disables it while in flight, and omits it when no
  handler is supplied.

## Verification

The two new focused files, plus `bun x tsc --noEmit` and `bun run lint:gui`.
