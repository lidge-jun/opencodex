# wp1 — passive quota survives the client freshness bound

Goal: the `meta-muse` report reaches `ProviderDetails` so the Usage tab renders its
bars and the Overview renders its rate-limit section, without weakening the staleness
guarantee that protects probed providers.

## Design

Add one boolean to the wire report, set only by the passive path, and have the client
skip the age check for reports carrying it. This keeps the decision where the fact
lives: the server knows a provider is passive, the client currently has to guess.

`reverseEngineered?: boolean` is the existing precedent for a per-report advisory
flag on `ProviderQuotaReport`, so `observed?: boolean` follows the same shape and
needs no schema ceremony.

Rejected alternatives:

- **Raise `QUOTA_REPORT_MAX_AGE_MS`.** Any finite bound still deletes an older
  observation, and raising it weakens the probed-provider case it exists for.
- **Special-case the literal `"meta-muse"` in the GUI.** The provider list is data;
  the next passive provider would silently regress. `hasPassiveAccountQuota` is
  already the server-side predicate, so derive from it.
- **Infer from `source.endsWith(":subscription-observation")`.** String sniffing a
  label that exists for humans; the flag is one field and cannot drift.

## Diff-level plan

### `src/providers/quota.ts`

`ProviderQuotaReport` gains a field beside `reverseEngineered`:

```ts
export interface ProviderQuotaReport {
  provider: string;
  label: string;
  source: string;
  quota: ProviderQuota;
  updatedAt: number;
  reverseEngineered?: boolean;
  /** Observed in-band on a streaming turn; no probe exists and age is expected. */
  observed?: boolean;
  aggregation?: CodexCapacityAggregation;
}
```

`fetchPassiveProviderQuota` is the only writer. Its final line becomes:

```ts
  const built = report(provider, \`\${provider}:subscription-observation\`, entry.quota);
  return built ? { ...built, observed: true } : null;
```

`report()` is left untouched — it is shared by every probed path and must not learn
about passivity.

### `gui/src/provider-workspace/report.ts`

`ProviderQuotaReportView` gains `observed?: boolean`.

### `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx`

`freshQuotaReport(value, now)`:

```ts
  const observed = row.observed === true;
  if (!observed && now - row.updatedAt >= QUOTA_REPORT_MAX_AGE_MS) return null;
```

and the returned view carries `...(observed ? { observed: true } : {})` so the flag
survives the session cache round-trip (the cache is re-validated through the same
function, so without this a reload would drop the row again).

A non-boolean `observed` is treated as absent rather than rejected: the field is
advisory, and a strict reject would turn an unknown future value into a vanished row.

### `gui/src/components/provider-workspace/ProviderUsage.tsx`

The rate-limit block passes the age through, matching what the Accounts tab already
does per account:

```tsx
  <QuotaBars quota={quota} plan={null} threshold={80} t={t} layout="stacked"
    {...(quotaReport?.observed && quotaReport.updatedAt !== undefined
      ? { observedAt: quotaReport.updatedAt } : {})} />
```

`quota.observedAgo` and `quota.observedHint` already exist in all nine locales, so
no new copy is required for this phase.

### `gui/src/components/provider-workspace/ProviderCapacityQuota.tsx`

Same treatment for the Overview surface, so the two places that render a
provider-level quota agree on how an observation is labelled.

## Tests

- `tests/provider-quota-observed-flag.test.ts` — `fetchProviderQuotas` emits
  `observed: true` on the meta-muse row and no `observed` field on a probed row.
- `gui/tests/provider-quota-observed-freshness.test.ts` — an observed report older
  than 30 minutes survives `freshQuotaReportsFromResponse`; an unflagged report of the
  same age is dropped; the flag round-trips through the cache validator.

Both are new files, so no existing focused file needs re-running beyond
`gui/tests/provider-capacity-shell.test.tsx`, which exercises the same shell effect.

## Verification

`bun test tests/provider-quota-observed-flag.test.ts`,
`bun test gui/tests/provider-quota-observed-freshness.test.ts`,
`bun test gui/tests/provider-capacity-shell.test.tsx`, `bun x tsc --noEmit`.
Live: restart the proxy, load `#providers` → meta-muse → Usage, expect bars plus
"N시간 전에 확인한 값".
