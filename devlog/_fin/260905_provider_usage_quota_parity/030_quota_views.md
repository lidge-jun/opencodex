# Current-account and all-account quota views

Depends on 010 attribution and 020 account quota API. Execute as work-phase `quota`.
Contract/resources/terminal conditions inherit 000. Class C3. No local test execution.

## Existing owners and changes

MODIFY `gui/src/provider-workspace/report.ts`: add a pure current-account projection next to `accountQuotaFromReport`. For a valid pool aggregation, use only `aggregation.currentAccount.quota`; never fall back from missing current quota to aggregate capacity. For non-pool reports, use the report's quota. Return a report-shaped view without aggregation so existing credit rendering is reusable.

```diff
+export function currentAccountQuotaReport(report?: ProviderQuotaReportView): ProviderQuotaReportView | undefined {
+  if (!report) return undefined;
+  const aggregation = capacityAggregationFromReport(report);
+  if (!aggregation) return report;
+  return { ...report, aggregation: undefined, quota: aggregation.currentAccount?.quota ?? null };
+}
```

NEW `gui/src/components/provider-workspace/ProviderCurrentQuota.tsx`: shared current-account section. Props are `report?: ProviderQuotaReportView`, `onRefreshQuota?: () => Promise<boolean>`. Render the localized current-account heading, existing `ProviderCapacityQuota` with current-only projected report, source/updated age metadata and the existing asynchronous refresh control. Missing quota uses translated unavailable text; credit-only quota must render a balance. Move the current refresh busy/result logic from ProviderUsage, preserving failure/settlement semantics and accessibility. Do not add a network client.

MODIFY `ProviderOverview.tsx`: remove the old left-side capacity block; insert `ProviderCurrentQuota` directly below the right-side usage statistics. Accept the refresh callback and forward it. Aggregate dashboard `ProviderOverviewDashboard` remains provider-wide capacity.

MODIFY `ProviderUsage.tsx`: replace its bottom rate-limit block and duplicated refresh state/handlers with the same `ProviderCurrentQuota`; preserve usage metrics/model table and source semantics. Existing report adapter is the source of truth.

MODIFY `ProviderDetails.tsx`: forward the already-scoped `onRefreshQuota` to Overview, just as Usage already receives it. Accounts receives enriched rows unchanged.

MODIFY `gui/src/hooks/useProviderAccountPools.ts` and `gui/src/components/provider-workspace/types.ts`: both OAuth and API-key row types gain `quotaMode?: "probe" | "passive" | "unsupported"`, `quota?: AccountQuota | null`, `quotaUnavailable?: boolean`; extend key rows only where currently absent. Field chain: 020 backend cheap/enriched DTO creation -> JSON -> hook read -> row props -> shared rendering. Optional mode absent keeps old-server compatibility; unknown mode must not enable a probe.

```diff
-const fetchAccountSets = useCallback(async (providers: string[]) => {
+const fetchAccountSets = useCallback(async (providers: string[], refresh = false) => {
 // keep cheap local rows and ready controls, then enrich supported modes
-void (async () => { /* quota read, swallowed outcome */ })();
+const enrichment = async (): Promise<boolean> => { /* read quota=1, append refresh=1 when requested;
+  preserve generation fence; return false for failed HTTP or quotaUnavailable rows */ };
+if (refresh) return await enrichment();
+void enrichment();
```

For `fetchKeyPools`, retain cheap list loading, add opt-in quota enrichment and generation/alive fences matching account lists. Merge refreshed provider subsets into existing state rather than replacing unrelated key pools. Return boolean settlement and preserve last-good rows on failures. Do not call OAuth APIs for key-auth providers.

For BOTH credential types, merge the cheap list with previous quota by credential ID before publishing it, removing IDs no longer listed. Mark supported probe rows `quotaPending` during enrichment; HTTP/network failure sets `quotaUnavailable: true` and clears pending behind the same generation/alive fence, preserving last-good quota. Successful enrichment replaces flags from the returned row, not a spread which would retain stale errors. Passive missing observations stay unobserved. `quotaPending?: boolean` is a GUI-only derived field, never a backend/persisted credential field. This closes HTTP failure with and without last-good data.

MODIFY `gui/src/pages/Providers.tsx`:

```diff
-void fetchAccountSets([provider]);
-void fetchProviderQuotas(true);
-return settled;
+const accountsSettled = config?.providers[provider]?.authMode === "oauth"
+  ? fetchAccountSets([provider], true)
+  : fetchKeyPools([provider], true);
+void fetchProviderQuotas(true);
+return Promise.all([settled, accountsSettled]).then(results => results.every(Boolean));
```

Codex retains its dedicated pool refresh; do not send it to the generic key/OAuth path. Reconcile current selection and clear stale refresh feedback on provider change.

Bind `quotaRefreshWaiters` to the refresh epoch rather than settling all on any forced completion. `ProviderWorkspaceShell` includes its captured epoch in `onQuotaRefreshSettled`; the page resolves only matching tickets. Superseded earlier tickets resolve false (never success from a different request); unmount resolves all false. Extend the actual page-coordinator fixture with two deferred forced reads completing in reverse order, beyond the existing shell-only settlement fixture. Update every callback prop signature and caller found by search.

MODIFY `ProviderAuthPanel.tsx`: use a small shared quota row component for both OAuth and API keys. Reuse ProviderCapacityQuota for credit balances and QuotaBars windows, not QuotaBars alone. Render read mode explicitly: probe pending uses existing bounded skeleton; passive without quota shows not-yet-observed, unsupported shows unsupported, failed read shows unavailable and optionally last-good quota with its age. Passive rows carry observedAt based on mode, not hardcoded provider name. Preserve switch/remove controls and existing key rows by nesting control row plus quota row like OAuth. Never sum all-account quotas. Add key refresh control in the same location/interaction pattern as OAuth.

NEW `ProviderAccountQuota.tsx`: pure shared row props `quota`, `quotaMode`, `quotaUnavailable`, `pending`; output a credits/window report through ProviderCapacityQuota plus translated state. Add only the required unsupported/not-yet-observed/current-account usage copy in every locale (`en,de,fr,ko,zh,zh-TW,ru,ja,tr`). Existing unknown data is never presented as 0%.

## Verification activation matrix

- Existing `gui/tests/provider-capacity-credits.test.tsx`: current quota credit-only with and without expiry renders on both Overview and Usage; invalid date remains safe.
- Existing `gui/tests/provider-capacity-shell.test.tsx`: pool aggregate 20%, current 70% -> detail current section shows 70%, overview dashboard retains aggregate 20%; missing current is unknown, not 20%.
- Existing `gui/tests/provider-quota-refresh-controls.test.tsx`: pending -> success/failure, passive unobserved, unsupported no loading/probe, current provider change resets feedback.
- Existing `gui/tests/provider-quota-refresh-settle.test.tsx`: explicit refresh awaits enriched per-account response, sends refresh=1, rejects one account failure; key-auth never calls OAuth endpoint; stale response cannot replace another request/provider state.
- Add API-key quota row cases beside the existing account rendering tests; verify two distinct keys and credit-only quotas.
- Remote CI executes tests. Local `node node_modules/typescript/bin/tsc --noEmit`, `cd gui && node node_modules/typescript/bin/tsc -b && node node_modules/vite/bin/vite.js build`, GUI lint and privacy scan. Do not turn local manual QA into a test suite.
- Isolated dev server with synthetic API responses: Kimi/Anthropic/Codex pool/API-key/passive/unsupported; browser screenshots for Overview, Usage, Accounts and narrow Korean layout. No calls to live provider endpoints, no user credentials in screenshots.

## Documentation

MODIFY `structure/05_gui-and-management-api.md` usage/quota paragraphs and `docs-site/src/content/docs/guides/web-dashboard.md`: current account below usage, all supported credentials in Accounts, API cost != subscription quota, observed/unsupported/error meanings. Keep translated `*/guides/web-dashboard.md` pages non-contradictory.

## Bypass/residual

UI state is presentation, not credential authorization. Backend fixed-destination account/key readers are the actual boundary. Existing account mutation permissions are unchanged; no new enforcement claim.

## P stale-check and locked refinements at 768e5a004

The backend now emits the row-level mode/availability fields, including Kimi's omitted-key-auth
default. 000's no-local-validation directive supersedes all local command examples above.

1. Main owns a shared `AccountQuotaMode` and `AccountQuotaReading` in existing view types:
   `quotaMode?: "probe"|"passive"|"unsupported"`, `quota?: AccountQuota|null`,
   `quotaUnavailable?: boolean`, `quotaPending?: boolean`. OAuth/key rows and hook interfaces
   reuse it. Pending is GUI-only. Worker reads this contract, does not edit types.ts.
2. Main owns NEW `ProviderAccountQuota.tsx`, shared by all three tabs. Props exactly match
   AccountQuotaReading. Unsupported ignores retained data; passive without observation has an
   honest unobserved message; only explicit probe pending can show a skeleton. Failed reads
   retain last-good numbers with a warning and their actual age. Reuse ProviderCapacityQuota
   for windows AND credits-only balances. No summation of different accounts/keys.
3. NEW ProviderCurrentQuota accepts `report`, optional `reading: AccountQuotaReading`, and
   optional refresh callback. ProviderDetails supplies the active OAuth/key row only. A present
   row with a known quotaMode (including passive with no observation), pending/unavailable,
   or an explicit quota overrides the provider report;
   never substitute the previous active account's quota. Codex uses report aggregation's current
   account. Use the actual quota.updatedAt for current metadata, not aggregate refresh time.
4. `currentAccountQuotaReport` treats present malformed aggregation as unknown, not as a
   non-pool current quota. Valid aggregate missing current likewise stays unknown. Tests pin
   aggregate20/current70, absent current, malformed aggregation and distinct measurement age.
5. Preserve callback argument order: shell reports `onQuotaRefreshSettled(ok, epoch)` with
   captured epoch second. Page resolves matching ticket only; superseded/unmounted tickets
   resolve false. Existing one-argument callback consumers still receive a boolean.
6. The account loader merges last-good quota only by surviving credential id, publishes explicit
   pending for probe rows, awaits forced enrichment, handles HTTP failure behind generation
   fences, and uses a bounded fetch deadline rather than a never-ending spinner. Passive and
   unsupported rows never get absence-driven loading. Key subset refresh merges other providers.
7. Refresh outcome text says the quota check completed, not that every upstream value is freshly
   measured; passive reloads and a provider-report last-good fallback cannot prove freshness.

New localized keys owned by main: `pws.currentAccountUsage`, `pws.quotaUnsupported`,
`pws.quotaUnobserved`, `pws.quotaCheckCompleted`. Existing error/refresh labels are reused.
Worker's AuthPanel imports ProviderAccountQuota and uses the above keys; no locale edits there.

Source delta verification is remote CI plus existing in-app browser on synthetic data only.

A repair: Kant identified a passive account switch while the old provider report remains cached.
Accepted. Any active passive row is authoritative even with no quota: render unobserved and never
reuse the old report. The direct current-section regression must provide an old report75% plus a
new active passive row lacking quota and assert that75% is absent. Unknown-mode legacy rows may
only use a provider report when no row-specific state/data exists; absence is never confirmation.
