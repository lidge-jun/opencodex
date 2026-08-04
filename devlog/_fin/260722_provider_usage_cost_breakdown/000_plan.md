# Provider Usage Cost Breakdown — Plan (amended after A-gate round 3)

## Objective
Add per-model cost breakdown to the per-provider Usage tab in the workspace UI.

## Audit amendments
- B1 (ACCEPTED): Server-side per-model/provider `estimatedCostUsd` in summary.ts.
- B2 (ACCEPTED as known limitation): Provider key mismatch (chatgpt→openai normalization)
  is a pre-existing issue affecting the existing usageTotals lookup. The same
  `selectedItem.name` pattern is used for both old and new data. Documented as
  KNOWN LIMITATION: chatgpt standalone workspace rows may not match API usage data
  normalized to "openai". A canonical GUI usage-key helper is deferred to a follow-up.
- B3 (ACCEPTED): Phase 2 before blocks reference Phase 1 after state.
- B4 (ACCEPTED): ProviderCostSummary removed. File lists updated.
- B5 (ACCEPTED): formatCostUsd uses 4 decimal places.

## Known Limitations
- Provider key mismatch: `baseProviderLabel` normalizes `chatgpt` to `openai` on the
  server, but the workspace may display a standalone `chatgpt` provider. Usage data
  for such rows will show as unavailable. This is a pre-existing issue affecting the
  existing usage totals display, not a regression from this feature. A canonical GUI
  usage-key helper with regression tests is deferred to a separate work item.

## Dependency-Ordered Phase Map

### Phase 1: Backend + Data Plumbing (010)
Files:
- src/usage/summary.ts — estimatedCostUsd on UsageModel/UsageProvider + buildModels/buildProviders accumulation
- tests/usage-summary.test.ts — per-model/provider cost expectations
- gui/src/components/provider-workspace/types.ts — ProviderModelUsageRow with estimatedCostUsd
- gui/src/provider-workspace/usage.ts — formatCostUsd (4 decimal places)
- gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx — capture models/summary
- gui/src/pages/Providers.tsx — forward new DetailSlotData fields
- gui/src/components/provider-workspace/ProviderDetails.tsx — thread props
- gui/src/components/provider-workspace/ProviderUsage.tsx — accept new props (no render change)
- tests/provider-workspace-data.test.ts — formatCostUsd test expectations

### Phase 2: UI + i18n + Styles (020)
- gui/src/components/provider-workspace/ProviderUsage.tsx — 3-col KPI + 5-col model table + expandable rows
- gui/src/styles/provider-workspace-shell.css — new styles
- gui/src/i18n/ko.ts, en.ts, zh.ts, de.ts, ru.ts — new keys
- Verification: tsc + visual

## IN scope
- summary.ts per-model/provider cost aggregation
- ProviderUsage tab UI expansion with cost column
- i18n for new strings

## OUT of scope
- chatgpt/openai canonical key mapping (follow-up)
- Global Usage page changes, new API endpoints, new npm packages, git push
