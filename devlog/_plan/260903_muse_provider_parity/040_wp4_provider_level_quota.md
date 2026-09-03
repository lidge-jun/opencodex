# wp4 — provider-level Muse quota row (owner-overruled 031)

Own PR, base `dev`. Branch: `codex/meta-muse-provider-quota`.

## What changed since 031

`031_wp3_disposition_record.md` recorded the provider-level card as NOT-APPLICABLE
(option b from `030` §4): "Meta's documented limits are per team, while the observed
window is per subscription, so promoting it to provider level would relabel a different
quantity."

The owner then opened the live dashboard (v2.42.0, Usage tab → 요청 한도) and rejected
that: "지금 업데이트 된 최신 버전인데도 안돼 … 이거 해결해서 뜰때까지". The
rebuttal to (b) was already in the codebase: `fetchAnthropicQuota` and
`fetchKiroQuota` both answer the provider-level row with **the active account's**
usage (`quota.ts:1387` — "Provider-level Kiro row: the active account's usage, shown on
the Providers page"). Provider level in this dashboard has always meant "the account in
use", and per-subscription is exactly the right quantity for that.

## The change (one branch)

`src/providers/quota.ts`, in `maybeFetchProviderQuota` after the kiro branch:

```ts
// Passive providers report no probe: the row is the ACTIVE account's last observed
// subscription windows, the same shape fetchAnthropicQuota/fetchKiroQuota return.
// Cache-only — a dashboard load or ocx account refresh must never spend an inference
// turn; refresh=1 is a no-op on this path.
if (provider.authMode === "oauth" && hasPassiveAccountQuota(name)) return fetchPassiveProviderQuota(name);
```

New helper beside `fetchKiroQuota`:

```ts
async function fetchPassiveProviderQuota(provider: string): Promise<ProviderQuotaReport | null> {
  const activeId = getAccountSet(provider)?.activeAccountId;
  if (!activeId) return null;
  hydrateAccountQuotaCache();
  const entry = accountQuotaCache.get(accountCacheKey(provider, activeId));
  if (!entry?.quota) return null;
  return report(provider, `${provider}:subscription-observation`, entry.quota);
}
```

Rules:

- **Active account only.** Inactive accounts' observations never promote. Matches the
  anthropic/kiro provider-row semantics.
- **No observation → null.** The card's empty state is then correct pre-first-turn.
- **`report.updatedAt` = the observation time.** `report()` already copies
  `quota.updatedAt`, and both consumer surfaces render relative time from it:
  `ProviderUsage.tsx:151` (`pws.stats.quotaUpdated`) and
  `ProviderOverviewDashboard.tsx:166` (`pws.dashboard.checkedAgo`). **No GUI change.**
- **No new imports.** Everything stays in `quota.ts`; the lab boundary is untouched.

## Consumer audit (the one cross-cutting risk)

`fetchProviderQuotaReports` also feeds `replaceCachedProviderQuotas`
(`quota.ts:2525`), which `combos/resolve.ts:130,157` reads for
exhausted-provider skipping. That cache is safe by construction:
`getCachedProviderQuota` has a 30-minute age bound
(`quota-routing-cache.ts:21-26`) — stale passive rows are ignored by routing, and a
fresh "100%" observation correctly parks the provider for up to 30 minutes. This is the
desired behaviour, not a hazard.

## CLI consequence (kept, now reachable in both directions)

`ocx account refresh meta-muse` hits `/api/provider-quotas?refresh=1`. Before this
branch: report null → the wp3 "nothing to refresh" message. After: with an observation
cached, it prints the cached windows (still zero network calls upstream). Both outputs
are correct for their state; the wp3 test (`cli-account` 19b, no seeded cache) stays
green, and a new test pins the seeded-observation case.

## Tests

In `tests/muse-passive-quota-observation.test.ts` (extend):

- active account with a cached observation → provider report carries the windows,
  source `meta-muse:subscription-observation`, `updatedAt` equal to the observation
  time
- no observation → no report row for meta-muse
- **no network**: `fetchImpl` spy (or the absence of any fetch in the module path)
  proves a dashboard refresh issues zero upstream calls for meta-muse — pin by
  stubbing `globalThis.fetch` to throw if reached
- an inactive account holding the only observation → no provider row
- `refresh=1` returns the same cached row

In `tests/cli-account.test.ts` (extend 19-series):

- with a seeded observation, `ocx account refresh meta-muse` prints the cached
  windows rather than "nothing to refresh" (and never contacts upstream)

## Docs

`031_wp3_disposition_record.md` provider-card row amended to record the override and
point here. The `providers.md` sentence shipped in wp3 ("there is no endpoint to query
them on demand") stays true and unchanged.

## Verification

```bash
bun test tests/muse-passive-quota-observation.test.ts tests/cli-account.test.ts \
         tests/provider-quota.test.ts tests/core-lab-boundary.test.ts
bun run test:changed
bun x tsc --noEmit
bun run privacy:scan
cd gui && bun run build
```

Repository-wide local suite forbidden. Exact-head CI is the gate.

## Terminal outcome

`DONE` when `/api/provider-quotas` carries `meta-muse` once the active account has
an observation, the Usage tab 요청 한도 and the Providers overview RATE LIMITS render
it with its observation time, and the PR is green at its exact head SHA and merged.
