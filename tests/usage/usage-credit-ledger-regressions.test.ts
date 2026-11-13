import { test, expect } from 'bun:test';
import { addRequestLog, clearRequestLogsForTests } from '../../src/server/request-log';
import { readUsageEntries } from '../../src/usage/log';
import { requestLogDto } from '../../src/server/management/shared';
import { refreshUserCostOverlays } from '../../src/usage/user-cost-overlays';
const config = { port: 0, defaultProvider: 'xai', providers: { xai: { adapter: 'openai', baseUrl: 'https://api.x.ai', authMode: 'apiKey', creditPriceUsd: 0.04 } } } as any;
const tierOutcome = { canonical: 'priority', wireKind: 'service-tier', wireValue: 'priority', fastOutcome: 'applied', confirmation: 'confirmed', responseServiceTier: 'priority' } as const;
const attempt = (ordinal:number, usage:any, extra:any = {}) => ({ordinal, provider:'xai', model:'grok-4.7', adapter:'openai', status:200, durationMs:900, sendCount:1, recoveryKinds:[], usageStatus:'reported', ...extra, usage});
function dto(row:any) { clearRequestLogsForTests(); refreshUserCostOverlays(config); addRequestLog({requestId:crypto.randomUUID(),timestamp:Date.now(),provider:'xai',model:'grok-4.7',status:200,durationMs:1000,usageStatus:'reported',...row}); const entry=readUsageEntries().at(-1)!; return JSON.parse(JSON.stringify(requestLogDto(entry as any))); }
test('mixed credit plus lower bound and exact token leg retains bound',()=>{let d=dto({provider:'combo',usage:{inputTokens:400000,outputTokens:2000},attempts:[attempt(1,{inputTokens:1000,outputTokens:10,providerCredits:2}),attempt(2,{inputTokens:300000,outputTokens:1000},{tierOutcome}),attempt(3,{inputTokens:1000,outputTokens:10})]}); expect(d.displayMetrics.cost.estimate.priorityLowerBound).toBe(true)});
test('finite credit charges never serialize aggregate input as null',()=>{let d=dto({provider:'combo',usage:{inputTokens:1,outputTokens:1},attempts:[attempt(1,{inputTokens:1e308,outputTokens:0,providerCredits:1}),attempt(2,{inputTokens:1e308,outputTokens:0,providerCredits:1})]}); expect(d.displayMetrics.cost.kind).toBe('unavailable')});
test('synthesized zero without credit is not observed free',()=>{let d=dto({usageStatus:'estimated',usage:{inputTokens:50,outputTokens:0,estimated:true}}); expect(d.displayMetrics.cost.kind).toBe('unavailable')});
test('negative credits survive normalization as unpriceable',()=>{let d=dto({usage:{inputTokens:50,outputTokens:0,providerCredits:-1}}); expect(d.displayMetrics.cost.kind).toBe('unavailable')});
test.each([NaN, Infinity, -Infinity])('nonfinite credits %s survive normalization as unpriceable',(credits)=>{let d=dto({usage:{inputTokens:50,outputTokens:0,providerCredits:credits}}); expect(d.displayMetrics.cost.kind).toBe('unavailable')});
test('explicit measured zero credit remains free',()=>{let d=dto({usage:{inputTokens:50,outputTokens:0,providerCredits:0}}); expect(d.displayMetrics.cost.estimate.billing.providerCredits).toBe(0)});
test.each([-1, NaN, Infinity])('invalid attempt credits %s remain unavailable after ledger round trip', (credits) => {
  const result = dto({ provider: 'combo', usage: { inputTokens: 50, outputTokens: 10 }, attempts: [attempt(1, { inputTokens: 50, outputTokens: 10, providerCredits: credits })] });
  expect(result.displayMetrics.cost.kind).toBe('unavailable');
  expect(result.displayMetrics.cost.reason).toBe('credit_cost_unrepresentable');
});
