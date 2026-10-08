import { expect, test } from "bun:test";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY } from "../../src/lib/spend-reservation-ledger";
import { createRequestExecutionBudget, deriveRequestExecutionBudget, CODEX_TEXT_GUARDED_BUDGET_POLICY, createPhysicalSendReporter } from "../../src/lib/request-execution-budget";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { fetchWithResetRetry, fetchWithTransientRetry } from "../../src/lib/upstream-retry";

function fixture(enforced = true, capacity = 8) {
  const lines: string[] = [];
  const ledger = createSpendReservationLedger({ salt: "anchor-fixture", policy: {
    ...DEFAULT_SPEND_RESERVATION_POLICY, maxTrackedSends: capacity,
    ...(enforced ? { pool: { maxTokens: 10000 } } : {}),
  }, journal: { read: () => [], append: line => { lines.push(line); } } });
  const ctx = { provider: "P", spendPoolId: "P", accountLogLabel: "A", spendInputEstimateTokens: 10, spendOutputCeilingTokens: 20 };
  const tracker = createRequestSpendTracker(ctx, undefined, ledger);
  const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY }, undefined, tracker);
  const reporter = () => createPhysicalSendReporter(budget, () => ({ poolId: ctx.spendPoolId, identityId: ctx.accountLogLabel }));
  return { lines, ledger, ctx, tracker, budget, reporter };
}

test("ordinary rootless passthrough seeds before its first fetch", async () => {
  const f = fixture(true, 1);
  f.ledger.reserve({ sendId: "busy", scopes: { poolId: "P" }, inputTokens: 1, outputCeilingTokens: 0 });
  let wires = 0;
  await expect(fetchWithTransientRetry(async () => { wires++; return new Response(); }, { attempts: 1, onSendsConsumed: f.reporter() })).rejects.toThrow();
  expect(wires).toBe(0);
  expect(f.tracker.refusals).toBe(1);
});

test("generic adapter initial send adopts one normal seed", async () => {
  const f = fixture();
  const decision = f.budget.reserveDispatch({ sendClass: "initial", targetKey: "P/A", countedExternally: true });
  expect(decision.allowed).toBe(true);
  if (!decision.allowed) throw new Error("dispatch refused");
  await fetchWithResetRetry(async () => { expect(decision.permit.use()).toBe(true); return new Response(); }, {
    attempts: 1, onSendsConsumed: createPhysicalSendReporter(f.budget, () => ({ poolId: "P", identityId: "A", targetKey: "P/A" }), decision.permit),
  });
  expect(f.lines.filter(line => JSON.parse(line).kind === "reserve")).toHaveLength(1);
  f.tracker.settle({ inputTokens: 2, outputTokens: 3 });
  expect(f.ledger.snapshot("pool", "P")?.settled).toBe(5);
});

test("stable reset transient and continuation retries never create new scope entries", async () => {
  const f = fixture(true, 1);
  for (const helper of [fetchWithResetRetry, fetchWithTransientRetry, fetchWithResetRetry]) {
    await helper(async () => new Response(), { attempts: 1, onSendsConsumed: f.reporter() });
  }
  f.tracker.settle({ inputTokens: 4 });
  expect(f.ledger.snapshot("pool", "P")?.unresolved).toBe(60);
  expect(f.ledger.snapshot("pool", "P")?.settled).toBe(4);
  expect(f.budget.physicalStarted).toBe(3);
});

test("delayed key A batch remains on A after key B reselection", () => {
  const f = fixture();
  const a = f.reporter();
  expect(a.beforeSend?.()).toBe(true);
  f.ctx.accountLogLabel = "B";
  const b = f.reporter();
  expect(b.beforeSend?.()).toBe(true);
  b(1); b.close?.();
  a(1); a.close?.();
  f.tracker.settle({ inputTokens: 7 });
  expect(f.ledger.snapshot("identity", "A")?.unresolved).toBe(30);
  expect(f.ledger.snapshot("identity", "B")?.settled).toBe(7);
});

test("combo B adopts B seed on a shared parent observer", () => {
  const f = fixture();
  const child = deriveRequestExecutionBudget(f.budget, CODEX_TEXT_GUARDED_BUDGET_POLICY);
  const report = createPhysicalSendReporter(child, () => ({ poolId: "B", identityId: "account-B" }));
  expect(report.beforeSend?.()).toBe(true); report(1); report.close?.();
  expect(f.budget.physicalStarted).toBe(1);
  f.tracker.settle({ inputTokens: 11 });
  expect(f.ledger.snapshot("pool", "B")?.settled).toBe(11);
  const reserve = f.lines.map(line => JSON.parse(line)).find(record => record.kind === "reserve");
  expect(reserve.targets.filter((target: { scope: string }) => target.scope === "pool")).toHaveLength(1);
  expect(f.ledger.snapshot("identity", "account-B")?.settled).toBe(11);
});

test("all helper native adapter WS and compact executors enforce frozen L", async () => {
  const f = fixture();
  let wires = 0;
  for (let i = 0; i < 4; i++) await fetchWithResetRetry(async () => { wires++; return new Response(); }, { attempts: 1, onSendsConsumed: f.reporter() });
  Object.assign(f.budget.policy, { maxTotalModelSends: 100 });
  await expect(fetchWithResetRetry(async () => { wires++; return new Response(); }, { attempts: 1, onSendsConsumed: f.reporter() })).rejects.toThrow();
  expect(wires).toBe(4);
  expect(f.budget.physicalLimit).toBe(4);
});

test("native Messages without a budget shares the finite enforced ingress limit", () => {
  const f = fixture();
  const report = f.reporter();
  for (let i = 0; i < 4; i++) expect(report.beforeSend?.()).toBe(true);
  expect(report.beforeSend?.()).toBe(false);
  report(4); report.close?.();
  expect(f.budget.physicalStarted).toBe(4);
});

test("async terminal cancel and shutdown drain reporters before forgetting", async () => {
  const f = fixture();
  const report = f.reporter();
  expect(report.beforeSend?.()).toBe(true);
  f.tracker.settle(undefined);
  let drained = false;
  const drain = f.ledger.waitForReporterDrain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(f.ledger.snapshot("pool", "P")?.reserved).toBe(30);
  report(1); report.close?.();
  await drain;
  expect(f.ledger.snapshot("pool", "P")?.unresolved).toBe(30);
});

test("recovery telemetry cannot mint unclaimed sends", () => {
  const f = fixture();
  const report = f.reporter();
  report(70); report.close?.();
  f.budget.used += 70;
  expect(f.budget.physicalStarted).toBe(0);
  expect(f.lines.filter(line => JSON.parse(line).kind === "reserve")).toHaveLength(0);
});

test("unconfigured helper keeps shipped no-refusal behavior", async () => {
  const f = fixture(false, 1);
  f.ledger.reserve({ sendId: "busy", scopes: { poolId: "P" }, inputTokens: 1, outputCeilingTokens: 0 });
  let wires = 0;
  await fetchWithResetRetry(async () => { wires++; return new Response(); }, { attempts: 1, onSendsConsumed: f.reporter() });
  expect(wires).toBe(1);
  expect(f.tracker.refusals).toBe(0);
});
