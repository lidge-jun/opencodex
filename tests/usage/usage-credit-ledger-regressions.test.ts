import { test, expect } from 'bun:test';
import { addRequestLog, clearRequestLogsForTests } from '../../src/server/request-log';
import { readUsageEntries } from '../../src/usage/log';
import { requestLogDto } from '../../src/server/management/shared';
import { refreshUserCostOverlays } from '../../src/usage/user-cost-overlays';
const config = { port: 0, defaultProvider: 'xai', providers: { xai: { adapter: 'openai', baseUrl: 'https://api.x.ai', authMode: 'apiKey', creditPriceUsd: 0.04 } } } as any;
const tierOutcome = { canonical: 'priority', wireKind: 'service-tier', wireValue: 'priority', fastOutcome: 'applied', confirmation: 'confirmed', responseServiceTier: 'priority' } as const;
const attempt = (ordinal:number, usage:any, extra:any = {}) => ({ordinal, provider:'xai', model:'grok-4.7', adapter:'openai', status:200, durationMs:900, sendCount:1, recoveryKinds:[], usageStatus:'reported', ...extra, usage});
function dto(row: Partial<Parameters<typeof addRequestLog>[0]>) {
  clearRequestLogsForTests();
  refreshUserCostOverlays(config);
  const requestId = crypto.randomUUID();
  addRequestLog({
    timestamp: Date.now(), provider: "xai", model: "grok-4.7", status: 200, durationMs: 1000,
    usageStatus: "reported", ...row, requestId,
  });
  const entry = readUsageEntries().find(candidate => candidate.requestId === requestId);
  if (!entry) throw new Error("expected test request in usage ledger");
  return JSON.parse(JSON.stringify(requestLogDto(entry)));
}
test.each([
  { label: "missing cache detail", cache: {}, provenance: undefined, parentProvenance: undefined, estimated: false, floor: undefined, total: 2.504 },
  { label: "synthesized zero", cache: { cacheReadInputTokens: 0 }, provenance: "synthesized", parentProvenance: "observed", estimated: false, floor: undefined, total: 2.504 },
  { label: "inherited synthesized zero", cache: { cacheReadInputTokens: 0 }, provenance: undefined, parentProvenance: "synthesized", estimated: false, floor: undefined, total: 2.504 },
  { label: "observed zero", cache: { cacheReadInputTokens: 0 }, provenance: "observed", parentProvenance: "synthesized", estimated: false, floor: true, total: 2.504 },
  { label: "observed hit on a legacy row", cache: { cacheReadInputTokens: 300_000 }, provenance: undefined, parentProvenance: undefined, estimated: false, floor: true, total: 1.604 },
  { label: "estimated usage with observed zero", cache: { cacheReadInputTokens: 0 }, provenance: "observed", parentProvenance: undefined, estimated: true, floor: undefined, total: 2.504 },
] as const)("mixed Combo prices a non-floor token leg with $label", ({ cache, provenance, parentProvenance, estimated, floor, total }) => {
  const result = dto({
    provider: "combo",
    usage: { inputTokens: 601_000, outputTokens: 2_010 },
    cacheProvenance: parentProvenance,
    attempts: [
      attempt(1, { inputTokens: 1_000, outputTokens: 10, providerCredits: 2 }),
      attempt(2, { inputTokens: 300_000, outputTokens: 1_000, cacheReadInputTokens: 0 }, { tierOutcome, cacheProvenance: "observed" }),
      attempt(3, { inputTokens: 300_000, outputTokens: 1_000, ...cache }, {
        cacheProvenance: provenance, usageStatus: estimated ? "estimated" : "reported",
      }),
    ],
  });
  const { estimate, estimateReasons } = result.displayMetrics.cost;
  expect(estimate.billing).toEqual({ source: "mixed" });
  expect(estimate.attempts[1].priorityLowerBound).toBe(true);
  expect(estimate.attempts[2].estimated).toBe(estimated);
  expect(estimate.attempts[2].priorityLowerBound).toBeUndefined();
  expect(estimate.cost.total).toBeCloseTo(total, 9);
  expect(estimate.priorityLowerBound).toBe(floor);
  expect(estimateReasons.includes("priority_lower_bound")).toBe(floor === true);
  expect(estimateReasons.includes("cache_detail_missing")).toBe(!("cacheReadInputTokens" in cache) || (provenance ?? parentProvenance) === "synthesized");
});
test('finite credit charges never serialize aggregate input as null',()=>{let d=dto({provider:'combo',usage:{inputTokens:1,outputTokens:1},attempts:[attempt(1,{inputTokens:1e308,outputTokens:0,providerCredits:1}),attempt(2,{inputTokens:1e308,outputTokens:0,providerCredits:1})]}); expect(d.displayMetrics.cost.kind).toBe('unavailable')});
test('synthesized zero without credit is not observed free',()=>{let d=dto({usageStatus:'estimated',usage:{inputTokens:50,outputTokens:0,estimated:true}}); expect(d.displayMetrics.cost.kind).toBe('unavailable')});
test('negative credits survive normalization as unpriceable',()=>{let d=dto({usage:{inputTokens:50,outputTokens:0,providerCredits:-1}}); expect(d.displayMetrics.cost.kind).toBe('unavailable')});
test.each([NaN, Infinity, -Infinity])("nonfinite credits %s survive normalization as unpriceable", credits => {
  const row = { inputTokens: 50, outputTokens: 10 };
  const result = dto({ usage: { ...row, providerCredits: credits } });
  expect(result.displayMetrics.cost).toEqual({ kind: "unavailable", reason: "credit_cost_unrepresentable" });
  expect(dto({ usage: row }).displayMetrics.cost).toMatchObject({ kind: "value" });
});
test('explicit measured zero credit remains free',()=>{let d=dto({usage:{inputTokens:50,outputTokens:0,providerCredits:0}}); expect(d.displayMetrics.cost.estimate.billing.providerCredits).toBe(0)});
test.each([-1, NaN, Infinity])('invalid attempt credits %s remain unavailable after ledger round trip', (credits) => {
  const result = dto({ provider: 'combo', usage: { inputTokens: 50, outputTokens: 10 }, attempts: [attempt(1, { inputTokens: 50, outputTokens: 10, providerCredits: credits })] });
  expect(result.displayMetrics.cost.kind).toBe('unavailable');
  expect(result.displayMetrics.cost.reason).toBe('credit_cost_unrepresentable');
});

test('an ineligible attempt cannot supply a credit-specific Combo failure', () => {
  const result = dto({ provider: 'combo', attempts: [
    attempt(1, { inputTokens: 50, outputTokens: 10, providerCredits: -1 }, { usageStatus: 'unreported' }),
  ] });
  expect(result.displayMetrics.cost).toEqual({ kind: 'unavailable', reason: 'combo_attempt_unavailable' });
});
