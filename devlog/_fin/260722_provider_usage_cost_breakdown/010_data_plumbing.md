# 010 — Phase 1: Data Plumbing

> Diff-level implementation contract for Provider Usage Cost Breakdown Phase 1.
> Apply every block below in order. This phase adds server-side row aggregation,
> types, formatting, fetch-state capture, and props plumbing; it must not render the
> new KPI/table yet.

## Scope and invariants

- Keep `/api/usage?range=30d` as the only usage request. Do not add a second fetch.
- Add estimatedCostUsd to existing UsageModel/UsageProvider response shapes (additive,
  non-breaking).
- `models[].provider` is used only as the grouping key and is removed from each
  provider-local `ProviderModelUsageRow`.
- Model and provider costs are computed server-side from each request's matched price.
  Combo requests attribute each physical attempt's cost to that attempt's own
  model/provider bucket; Phase 1 must not display the new values directly.
- Preserve the existing request/token totals, model-loading state, quota behavior,
  cancellation guard, and fetch failure behavior.
- No visible UI, CSS, or i18n changes belong in this phase.
- The originally named four files are not sufficient to complete the data path:
  `gui/src/pages/Providers.tsx` explicitly maps `DetailSlotData` into
  `ProviderDetails`, and `ProviderUsage.tsx` must accept the newly forwarded props
  for this phase to type-check. Their minimal non-rendering changes are therefore
  required closure changes, not Phase 2 UI work.

## Change map

| Action | File | Purpose |
| --- | --- | --- |
| MODIFY | `src/usage/summary.ts` | Add per-model and per-provider estimated-cost aggregation |
| MODIFY | `tests/usage-summary.test.ts` | Pin single-request and combo cost attribution in model/provider rows |
| MODIFY | `gui/src/components/provider-workspace/types.ts` | Add the shared model-usage contract with server-computed cost |
| MODIFY | `gui/src/provider-workspace/usage.ts` | Add the shared USD estimate formatter |
| MODIFY | `tests/provider-workspace-data.test.ts` | Pin formatter null/invalid/locale behavior |
| MODIFY | `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx` | Capture model rows, including server-computed cost, and summary cost from the existing usage fetch |
| MODIFY | `gui/src/pages/Providers.tsx` | Forward the two new detail-slot fields through the explicit prop mapper |
| MODIFY | `gui/src/components/provider-workspace/ProviderDetails.tsx` | Receive and forward the new data to `ProviderUsage` |
| MODIFY | `gui/src/components/provider-workspace/ProviderUsage.tsx` | Accept the Phase 1 props without changing rendered output |

---

## MODIFY — `/Users/jun/Developer/new/700_projects/opencodex/src/usage/summary.ts`

### Change A — extend model and provider response rows

#### Location

Add the optional field immediately after `shareRatio` in both `UsageModel` and
`UsageProvider` at current lines 53-77.

#### Before

```typescript
export interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  attemptCount: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
}

export interface UsageProvider {
  provider: string;
  requests: number;
  attemptCount: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  shareRatio: number;
}
```

#### After

```typescript
export interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  attemptCount: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
  estimatedCostUsd?: number;
}

export interface UsageProvider {
  provider: string;
  requests: number;
  attemptCount: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  shareRatio: number;
  estimatedCostUsd?: number;
}
```

### Change B — accumulate per-model cost

#### Location

In `buildModels()` at current lines 304-356, add a second pass over `entries`
immediately after the existing token/status accumulation loop and before the
`statusesByKey` finalization loop. Reuse the existing `estimateRequestCost` and
`estimateComboCost` import from `./cost` at current line 4.

#### Before

```typescript
  }
  for (const [key, model] of byKey) {
    const groups = statusesByKey.get(key) ?? new Map();
```

#### After

```typescript
  }
  for (const entry of entries) {
    if (entry.attempts?.length) {
      const estimate = estimateComboCost(entry.attempts);
      for (const attempt of estimate?.attempts ?? []) {
        const providerKey = baseProviderLabel(attempt.provider);
        const model = byKey.get(`${providerKey}${attempt.model}`);
        if (model) model.estimatedCostUsd = (model.estimatedCostUsd ?? 0) + attempt.cost.total;
      }
      continue;
    }
    const estimate = estimateRequestCost({
      provider: entry.provider,
      model: entry.model,
      usage: entry.usage,
      usageStatus: entry.usageStatus,
    });
    if (!estimate) continue;
    const providerKey = baseProviderLabel(entry.provider);
    const model = byKey.get(`${providerKey}${entry.model}`);
    if (model) model.estimatedCostUsd = (model.estimatedCostUsd ?? 0) + estimate.cost.total;
  }
  for (const [key, model] of byKey) {
    const groups = statusesByKey.get(key) ?? new Map();
```

### Change C — accumulate per-provider cost

#### Location

In `buildProviders()` at current lines 358-402, add the equivalent second pass over
`entries` immediately after the existing token/status accumulation loop and before
the `statusesByKey` finalization loop.

#### Before

```typescript
  }
  for (const [key, provider] of byKey) {
    const groups = statusesByKey.get(key) ?? new Map();
```

#### After

```typescript
  }
  for (const entry of entries) {
    if (entry.attempts?.length) {
      const estimate = estimateComboCost(entry.attempts);
      for (const attempt of estimate?.attempts ?? []) {
        const provider = byKey.get(baseProviderLabel(attempt.provider));
        if (provider) provider.estimatedCostUsd = (provider.estimatedCostUsd ?? 0) + attempt.cost.total;
      }
      continue;
    }
    const estimate = estimateRequestCost({
      provider: entry.provider,
      model: entry.model,
      usage: entry.usage,
      usageStatus: entry.usageStatus,
    });
    if (!estimate) continue;
    const provider = byKey.get(baseProviderLabel(entry.provider));
    if (provider) provider.estimatedCostUsd = (provider.estimatedCostUsd ?? 0) + estimate.cost.total;
  }
  for (const [key, provider] of byKey) {
    const groups = statusesByKey.get(key) ?? new Map();
```

### Rationale

`addEstimatedCost` already defines the global summary's pricing behavior with
`estimateRequestCost` and `estimateComboCost`. These second passes reuse the same
estimators but accumulate priced values into existing model/provider buckets. An
unpriced row leaves `estimatedCostUsd` absent instead of presenting a false zero.
For combo requests, the returned per-attempt estimates preserve each attempt's native
model and provider, so no cost is assigned to the synthetic `combo` row.

---

## MODIFY — `/Users/jun/Developer/new/700_projects/opencodex/tests/usage-summary.test.ts`

### Change A — verify priced model/provider rows

#### Location

In `"aggregates estimated cost via model-level prices and counts unpriced rows"`
at current lines 56-92, add row-level expectations after the existing global cost
expectation.

#### Before

```typescript
    expect(all.summary.estimatedCostUsd).toBeCloseTo(expected, 9);
    // range filtering also applies to the cost sum
```

#### After

```typescript
    expect(all.summary.estimatedCostUsd).toBeCloseTo(expected, 9);
    expect(all.models.find(row => row.model === "gpt-5.5")?.estimatedCostUsd)
      .toBeCloseTo((100 * 5 + 10 * 30) / 1e6, 9);
    expect(all.providers.find(row => row.provider === "openai")?.estimatedCostUsd)
      .toBeCloseTo((100 * 5 + 10 * 30) / 1e6, 9);
    expect(all.models.find(row => row.model === "nope-model")?.estimatedCostUsd).toBeUndefined();
    expect(all.providers.find(row => row.provider === "nope")?.estimatedCostUsd).toBeUndefined();
    // range filtering also applies to the cost sum
```

### Change B — verify combo attempt attribution

#### Location

Immediately after `"keeps one logical combo request while attributing both physical
attempts"` at current lines 380-436, add a focused priced-combo test. Keep the existing
attribution characterization unchanged.

#### Addition

```typescript
  test("attributes combo attempt costs to each model and provider row", () => {
    const combo = entry({
      ts: FIXED_NOW - 1,
      requestId: "priced-combo",
      provider: "combo",
      model: "combo/free",
      usageStatus: "estimated",
      usage: { inputTokens: 110, outputTokens: 2, totalTokens: 112, estimated: true },
      totalTokens: 112,
      attempts: [
        {
          ordinal: 1,
          provider: "openai",
          model: "gpt-5.5",
          adapter: "openai-chat",
          status: 503,
          durationMs: 4,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "estimated",
          inputTokenEstimate: 100,
          usage: { inputTokens: 100, outputTokens: 0, estimated: true },
          totalTokens: 100,
        },
        {
          ordinal: 2,
          provider: "anthropic",
          model: "claude-fable-5",
          adapter: "openai-chat",
          status: 200,
          durationMs: 3,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
          usage: { inputTokens: 10, outputTokens: 2 },
          totalTokens: 12,
        },
      ],
    });
    const sum = summarizeUsage([combo], "30d", FIXED_NOW);
    expect(sum.models.find(row => row.provider === "openai" && row.model === "gpt-5.5")?.estimatedCostUsd)
      .toBeCloseTo((100 * 5 + 0 * 30) / 1e6, 9);
    expect(sum.models.find(row => row.provider === "anthropic" && row.model === "claude-fable-5")?.estimatedCostUsd)
      .toBeCloseTo((10 * 10 + 2 * 50) / 1e6, 9);
    expect(sum.providers.find(row => row.provider === "openai")?.estimatedCostUsd)
      .toBeCloseTo((100 * 5 + 0 * 30) / 1e6, 9);
    expect(sum.providers.find(row => row.provider === "anthropic")?.estimatedCostUsd)
      .toBeCloseTo((10 * 10 + 2 * 50) / 1e6, 9);
  });
```

### Rationale

The first test pins additive response fields for priced rows and the absent-field
contract for unpriced rows. The combo case prevents regression to assigning the full
parent cost to a synthetic combo model/provider or to only the successful attempt.

---

## MODIFY — `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/types.ts`

### Location

Immediately after the current `ProviderUsageTotals` declaration at current lines
21-25.

### Before

```typescript
/** Per-provider usage totals for the workspace overview (30d window). */
export interface ProviderUsageTotals {
  requests?: number;
  totalTokens?: number;
}

// Auth types consumed by ProviderAuthPanel (WP091).
```

### After

```typescript
/** Per-provider usage totals for the workspace overview (30d window). */
export interface ProviderUsageTotals {
  requests?: number;
  totalTokens?: number;
}

/** Per-model usage row from /api/usage, filtered by provider. */
export interface ProviderModelUsageRow {
  model: string;
  resolvedModel?: string;
  requests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
  estimatedCostUsd?: number;
}

// Auth types consumed by ProviderAuthPanel (WP091).
```

### Rationale

The shell, detail boundary, and usage panel need one shared provider-local model row
shape. The row deliberately excludes `provider` because the shell stores rows under
`Record<providerName, rows>`, while `estimatedCostUsd` preserves the server-computed
per-model estimate. No separate aggregate interface is needed because the provider KPI
can sum the selected provider's model-row estimates.

---

## MODIFY — `/Users/jun/Developer/new/700_projects/opencodex/gui/src/provider-workspace/usage.ts`

### Location

Append the helper immediately after `formatTokenCount` at the end of the file
(current lines 185-188).

### Before

```typescript
/** Same as formatRequestCount but aliased for token quantities (same rules). */
export function formatTokenCount(n: number | undefined, locale = "en"): string {
  return formatRequestCount(n, locale);
}
```

### After

```typescript
/** Same as formatRequestCount but aliased for token quantities (same rules). */
export function formatTokenCount(n: number | undefined, locale = "en"): string {
  return formatRequestCount(n, locale);
}

/** Format a USD cost estimate for display. Returns "—" when null. */
export function formatCostUsd(value: number | null | undefined, locale = "en"): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return "\u2014";
  return `~$${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value)}`;
}
```

### Rationale

The formatter centralizes the feature's estimate marker, fixed four-decimal display
matching the existing Usage page formatter, locale-aware separators, and
unavailable-value behavior. It remains a pure helper and does not introduce UI copy or
a dependency.

---

## MODIFY — `/Users/jun/Developer/new/700_projects/opencodex/tests/provider-workspace-data.test.ts`

### Change A — import `formatCostUsd`

#### Location

In the existing import from `../gui/src/provider-workspace/usage` at current lines
16-26.

#### Before

```typescript
  countAvailableModels,
  formatRelativeTime,
  formatRequestCount,
  formatTokenCount,
```

#### After

```typescript
  countAvailableModels,
  formatCostUsd,
  formatRelativeTime,
  formatRequestCount,
  formatTokenCount,
```

### Change B — add formatter coverage

#### Location

Inside `describe("usage: count formatting", ...)`, immediately after the existing
`"en formatting tiers"` test at current lines 407-414.

#### Before

```typescript
  test("en formatting tiers", () => {
    expect(formatRequestCount(undefined)).toBe("\u2014");
    expect(formatRequestCount(999)).toBe("999");
    expect(formatRequestCount(1_500)).toBe("1.5k");
    expect(formatRequestCount(2_500_000)).toBe("2.5M");
    expect(formatRequestCount(3_000_000_000)).toBe("3B");
    expect(formatTokenCount(1_500)).toBe("1.5k");
  });

  test("characterization: threshold edges and trailing-zero behavior", () => {
```

#### After

```typescript
  test("en formatting tiers", () => {
    expect(formatRequestCount(undefined)).toBe("\u2014");
    expect(formatRequestCount(999)).toBe("999");
    expect(formatRequestCount(1_500)).toBe("1.5k");
    expect(formatRequestCount(2_500_000)).toBe("2.5M");
    expect(formatRequestCount(3_000_000_000)).toBe("3B");
    expect(formatTokenCount(1_500)).toBe("1.5k");
  });

  test("USD estimates use fixed four-decimal localized formatting and reject invalid values", () => {
    expect(formatCostUsd(undefined)).toBe("\u2014");
    expect(formatCostUsd(null)).toBe("\u2014");
    expect(formatCostUsd(Number.NaN)).toBe("\u2014");
    expect(formatCostUsd(-0.01)).toBe("\u2014");
    expect(formatCostUsd(0)).toBe("~$0.0000");
    expect(formatCostUsd(1_234.5, "en")).toBe("~$1,234.5000");
    expect(formatCostUsd(1_234.5, "de")).toBe("~$1.234,5000");
  });

  test("characterization: threshold edges and trailing-zero behavior", () => {
```

### Rationale

The test locks the exact contract requested for nullish, non-finite, negative, zero,
English, and German values. It catches accidental removal of the estimate prefix or
loss of locale-aware separators before Phase 2 consumes the helper.

---

## MODIFY — `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx`

### Change A — import `ProviderModelUsageRow`

#### Location

Replace the type-only import from `./types` at current line 26.

#### Before

```typescript
import type { PricingFilter, ProviderUsageTotals, StatusFilter, TypeFilter } from "./types";
```

#### After

```typescript
import type { PricingFilter, ProviderModelUsageRow, ProviderUsageTotals, StatusFilter, TypeFilter } from "./types";
```

### Change B — extend `DetailSlotData`

#### Location

In `DetailSlotData` at current lines 33-41, add the two fields after
`quotaReport` and use the already imported `ProviderUsageTotals` type.

#### Before

```typescript
export interface DetailSlotData {
  usageTotals?: import("./types").ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  availableModels: string[];
  selectedModels: string[];
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
  onRetryModels?: () => void;
}
```

#### After

```typescript
export interface DetailSlotData {
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  modelUsage?: ProviderModelUsageRow[];
  usageSummaryEstimatedCost?: number;
  availableModels: string[];
  selectedModels: string[];
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
  onRetryModels?: () => void;
}
```

### Change C — add usage model and summary state

#### Location

In the state declarations at current lines 88-95, immediately after
`usageTotals`.

#### Before

```typescript
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  const [usageTotals, setUsageTotals] = useState<Record<string, ProviderUsageTotals>>({});
  const [quotaReports, setQuotaReports] = useState<Record<string, ProviderQuotaReportView>>({});
  const [modelsLoadEpoch, setModelsLoadEpoch] = useState(0);
```

#### After

```typescript
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  const [usageTotals, setUsageTotals] = useState<Record<string, ProviderUsageTotals>>({});
  const [usageModels, setUsageModels] = useState<Record<string, ProviderModelUsageRow[]>>({});
  const [usageSummary, setUsageSummary] = useState<{ estimatedCostUsd?: number }>({});
  const [quotaReports, setQuotaReports] = useState<Record<string, ProviderQuotaReportView>>({});
  const [modelsLoadEpoch, setModelsLoadEpoch] = useState(0);
```

### Change D — capture `models` and `summary` in the existing usage fetch

#### Location

Replace the full `/api/usage?range=30d` effect at current lines 135-147.

#### Before

```typescript
  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/usage?range=30d`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { providers?: Array<{ provider: string; requests: number; totalTokens?: number }> } | null) => {
        if (cancelled || !data) return;
        const byProvider: Record<string, ProviderUsageTotals> = {};
        for (const p of data.providers ?? []) byProvider[p.provider] = { requests: p.requests, totalTokens: p.totalTokens };
        setUsageTotals(byProvider);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [apiBase]);
```

#### After

```typescript
  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/usage?range=30d`)
      .then(r => r.ok ? r.json() : null)
      .then((data: {
        providers?: Array<{ provider: string; requests: number; totalTokens?: number }>;
        models?: Array<ProviderModelUsageRow & { provider: string }>;
        summary?: { estimatedCostUsd?: number };
      } | null) => {
        if (cancelled || !data) return;
        const byProvider: Record<string, ProviderUsageTotals> = {};
        for (const p of data.providers ?? []) byProvider[p.provider] = { requests: p.requests, totalTokens: p.totalTokens };

        const modelsByProvider: Record<string, ProviderModelUsageRow[]> = {};
        for (const row of data.models ?? []) {
          const { provider, estimatedCostUsd, ...model } = row;
          (modelsByProvider[provider] ??= []).push({ ...model, estimatedCostUsd });
        }

        setUsageTotals(byProvider);
        setUsageModels(modelsByProvider);
        setUsageSummary({ estimatedCostUsd: data.summary?.estimatedCostUsd });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [apiBase]);
```

### Change E — expose selected-provider rows and summary through the detail slot

#### Location

In the `detail?.(selectedItem, { ... })` object at current lines 422-430, insert
the fields after `quotaReport`.

#### Before

```typescript
          detail?.(selectedItem, {
            usageTotals: usageTotals[selectedItem.name],
            quotaReport: quotaReports[selectedItem.name],
            availableModels: availableModels[selectedItem.name] ?? [],
            selectedModels: selectedModels[selectedItem.name] ?? [],
            modelsLoading,
            modelsLoadFailed,
            onRetryModels: retryModels,
          }) ?? (
```

#### After

```typescript
          detail?.(selectedItem, {
            usageTotals: usageTotals[selectedItem.name],
            quotaReport: quotaReports[selectedItem.name],
            modelUsage: usageModels[selectedItem.name],
            usageSummaryEstimatedCost: usageSummary.estimatedCostUsd,
            availableModels: availableModels[selectedItem.name] ?? [],
            selectedModels: selectedModels[selectedItem.name] ?? [],
            modelsLoading,
            modelsLoadFailed,
            onRetryModels: retryModels,
          }) ?? (
```

### Rationale

This extends the existing single fetch rather than introducing a parallel API path.
Grouping once at the shell boundary gives the selected detail panel only its provider's
rows and explicitly preserves each row's server-computed `estimatedCostUsd`, while the
global summary value remains explicitly named as a summary estimate. The existing
cancellation and silent-failure semantics remain unchanged.

---

## MODIFY — `/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx`

### Location

In the `detail={(item, data) => ...}` render prop, add the two explicit mappings
after `quotaReport` at current lines 913-915.

### Before

```tsx
              usageTotals={data.usageTotals}
              quotaReport={data.quotaReport}
              availableModels={data.availableModels}
```

### After

```tsx
              usageTotals={data.usageTotals}
              quotaReport={data.quotaReport}
              modelUsage={data.modelUsage}
              usageSummaryEstimatedCost={data.usageSummaryEstimatedCost}
              availableModels={data.availableModels}
```

### Rationale

`Providers.tsx` does not spread `DetailSlotData`; it maps each field explicitly. Without
this change the shell would capture the new data but silently drop it before
`ProviderDetails`, so this is a required Phase 1 data-plumbing seam.

---

## MODIFY — `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderDetails.tsx`

### Change A — import `ProviderModelUsageRow`

#### Location

Replace the `./types` import at current line 22.

#### Before

```typescript
import type { AccountLoadState, ProviderUsageTotals, OAuthAccountRow, ApiKeyRow, LoginHint, ProviderAuthHandlers, ProviderUpdatePatch } from "./types";
```

#### After

```typescript
import type { AccountLoadState, ProviderModelUsageRow, ProviderUsageTotals, OAuthAccountRow, ApiKeyRow, LoginHint, ProviderAuthHandlers, ProviderUpdatePatch } from "./types";
```

### Change B — receive the new props

#### Location

Add the destructured names after `quotaReport` at current lines 27-30, and add
their types after `quotaReport` at current lines 52-55.

#### Before

```tsx
export default function ProviderDetails({
  item,
  usageTotals,
  quotaReport,
  availableModels,
```

```typescript
}: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  availableModels: string[];
```

#### After

```tsx
export default function ProviderDetails({
  item,
  usageTotals,
  quotaReport,
  modelUsage,
  usageSummaryEstimatedCost,
  availableModels,
```

```typescript
}: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  modelUsage?: ProviderModelUsageRow[];
  usageSummaryEstimatedCost?: number;
  availableModels: string[];
```

### Change C — forward the props to `ProviderUsage`

#### Location

Replace the usage-tab render at current lines 241-243.

#### Before

```tsx
        {tab === "usage" && (
          <ProviderUsage item={item} usageTotals={usageTotals} quotaReport={quotaReport} />
        )}
```

#### After

```tsx
        {tab === "usage" && (
          <ProviderUsage
            item={item}
            usageTotals={usageTotals}
            quotaReport={quotaReport}
            modelUsage={modelUsage}
            usageSummaryEstimatedCost={usageSummaryEstimatedCost}
          />
        )}
```

### Rationale

`ProviderDetails` remains a props-only composition boundary. It owns no usage-derived
state and performs no cost calculation; Phase 2's `ProviderUsage` implementation will
own the selected-provider presentation calculation.

---

## MODIFY — `/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderUsage.tsx`

This is a required compile-closure change. It changes only the component's prop
contract and explicitly consumes the values with `void`; rendered JSX remains byte-for-
byte unchanged. Phase 2 removes the two `void` statements when it renders the KPI/table.

### Change A — import the model row type

#### Location

Replace the type-only import at current line 10.

#### Before

```typescript
import type { ProviderUsageTotals } from "./types";
```

#### After

```typescript
import type { ProviderModelUsageRow, ProviderUsageTotals } from "./types";
```

### Change B — accept the new props without rendering them

#### Location

Replace the component signature and the existing `void item` block at current lines
12-22.

#### Before

```tsx
export default function ProviderUsage({ item, usageTotals, quotaReport }: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
}) {
  const t = useT();
  const { locale } = useI18n();
  const timeLabels = relativeTimeLabelsFromT(t);
  const hasUsage = usageTotals?.requests !== undefined;
  const quota = accountQuotaFromReport(quotaReport);
  void item;
  return (
```

#### After

```tsx
export default function ProviderUsage({
  item,
  usageTotals,
  quotaReport,
  modelUsage,
  usageSummaryEstimatedCost,
}: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  modelUsage?: ProviderModelUsageRow[];
  usageSummaryEstimatedCost?: number;
}) {
  const t = useT();
  const { locale } = useI18n();
  const timeLabels = relativeTimeLabelsFromT(t);
  const hasUsage = usageTotals?.requests !== undefined;
  const quota = accountQuotaFromReport(quotaReport);
  void item;
  void modelUsage;
  void usageSummaryEstimatedCost;
  return (
```

### Rationale

TypeScript rejects undeclared JSX props. Accepting the two values here closes the Phase
1 data path and preserves a clean intermediate build without prematurely implementing
the Phase 2 visual surface.

---

## Acceptance checks

After applying all blocks, verify these source-level invariants:

1. `UsageModel` and `UsageProvider` expose additive optional `estimatedCostUsd`
   fields, and `ProviderModelUsageRow` exposes the same model-row field without adding
   a duplicate cost-summary type.
2. A priced non-combo request contributes the same estimate to the global summary,
   its model row, and its provider row; an unpriced-only row leaves the optional field
   absent.
3. Every priced combo attempt contributes only its own cost to its own model/provider
   buckets; no estimate is assigned to the synthetic `combo` identity.
4. The shell still performs exactly one `/api/usage?range=30d` request.
5. Every `data.models` entry is stored under its `provider` key, the stored row no
   longer contains `provider`, and its `estimatedCostUsd` value is preserved including
   numeric zero.
6. Selecting a provider with no model rows yields `modelUsage === undefined`; no fake
   empty usage record is created. Phase 2 decides its empty-state presentation.
7. `summary.estimatedCostUsd === 0` is preserved as `0`, not treated as unavailable.
8. A failed/non-OK usage request leaves the initial usage states untouched, matching
   current behavior.
9. The rendered `ProviderUsage` JSX is unchanged in Phase 1.

## Verification commands

Run from `/Users/jun/Developer/new/700_projects/opencodex` after implementation:

```bash
bun test --isolate tests/usage-summary.test.ts
```

Expected: exit code `0`; usage summary tests pass, including per-model,
per-provider, unpriced-row, and combo-attempt cost attribution.

```bash
bun test --isolate tests/provider-workspace-data.test.ts
```

Expected: exit code `0`; all provider-workspace data tests pass, including the new USD
formatter case.

```bash
cd gui && bun x tsc --noEmit
```

Expected: exit code `0`; the complete
`ProviderWorkspaceShell -> Providers -> ProviderDetails -> ProviderUsage` prop chain
type-checks.

```bash
git diff --check -- \
  src/usage/summary.ts \
  tests/usage-summary.test.ts \
  gui/src/components/provider-workspace/types.ts \
  gui/src/provider-workspace/usage.ts \
  tests/provider-workspace-data.test.ts \
  gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx \
  gui/src/pages/Providers.tsx \
  gui/src/components/provider-workspace/ProviderDetails.tsx \
  gui/src/components/provider-workspace/ProviderUsage.tsx
```

Expected: exit code `0` and no output.

No browser/visual check is required for Phase 1 because the rendered JSX and styles are
unchanged. Browser QA becomes mandatory in Phase 2 when the cost KPI and model table are
rendered.
