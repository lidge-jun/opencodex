import { afterEach, expect, test } from "bun:test";
import { createPhysicalSendReporter, createRequestExecutionBudget, reportDispatchSends } from "../../src/lib/request-execution-budget";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY } from "../../src/lib/spend-reservation-ledger";
import { admitWorkflowTurn, DEFAULT_WORKFLOW_BUDGET_POLICY, resetWorkflowBudgetsForTest, workflowBudgetSnapshot } from "../../src/lib/workflow-budget";
import { bindWorkflowBudgetConfig } from "../../src/lib/workflow-budget-config";
import { fetchWithTransientRetry } from "../../src/lib/upstream-retry";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";

afterEach(() => { bindWorkflowBudgetConfig(null); resetWorkflowBudgetsForTest(); });

function root(limit: number) {
  bindWorkflowBudgetConfig({ workflowBudget: { maxPhysicalSends: limit } });
  const policy = { ...DEFAULT_WORKFLOW_BUDGET_POLICY, maxPhysicalSends: limit };
  const admission = admitWorkflowTurn("physical-root", "interactive", policy);
  if (!admission?.admitted) throw new Error("fixture admission refused");
  admission.lease.release();
  return () => workflowBudgetSnapshot("physical-root", policy)!.sends;
}

function request(enforced: boolean) {
  const lines: string[] = [];
  const ledger = createSpendReservationLedger({
    journal: { read: () => [...lines], append: line => { lines.push(line); }, rewrite: next => { lines.splice(0, lines.length, ...next); } },
    policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, root: enforced ? { maxTokens: 1_000_000 } : {} },
  });
  const tracker = createRequestSpendTracker({ provider: "fixture", spendInputEstimateTokens: 1 }, "physical-root", ledger);
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  return { tracker, budget };
}

test("a prepaid physical report cannot hide an unrelated legacy send", () => {
  const sends = root(3);
  const { tracker, budget } = request(false);
  const prepaid = budget.reserveDispatch({ sendClass: "initial", targetKey: "fixture/m", countedExternally: true });
  if (!prepaid.allowed) throw new Error("fixture reservation refused");
  const reporter = createPhysicalSendReporter(budget, () => ({ poolId: "fixture" }), prepaid.permit);
  expect(reporter.beforeSend!()).toBe(true);
  reporter(1); reporter.close!();
  expect(sends()).toBe(1);
  budget.used += 1;
  expect(sends()).toBe(2);
  expect(budget.used).toBe(2);
  tracker.settle(undefined);
});

test("legacy prepaid reports record the first physical send as well as later sends", () => {
  const sends = root(3);
  const { tracker, budget } = request(false);
  const prepaid = budget.reserveDispatch({ sendClass: "initial", targetKey: "fixture/m", countedExternally: true });
  if (!prepaid.allowed) throw new Error("fixture reservation refused");
  reportDispatchSends(budget, 1, prepaid.permit);
  expect(sends()).toBe(1);
  reportDispatchSends(budget, 1, prepaid.permit);
  expect(sends()).toBe(2);
  expect(budget.used).toBe(2);
  tracker.settle(undefined);
});

for (const enforced of [false, true]) {
  test(`the retry helper stops before a second upstream call (spend=${enforced})`, async () => {
    const sends = root(1);
    const { tracker, budget } = request(enforced);
    const reporter = createPhysicalSendReporter(budget, () => ({ poolId: "fixture" }));
    let calls = 0;
    const result = await fetchWithTransientRetry(async () => {
      calls++;
      return new Response("busy", { status: 502, headers: { "retry-after": "0" } });
    }, { attempts: 3, onSendsConsumed: reporter }).catch(error => error);
    expect(result).toBeInstanceOf(Error);
    expect(calls).toBe(1);
    expect(sends()).toBe(1);
    expect(tracker.refusals).toBe(1);
    tracker.settle(undefined);
  });

  test(`every reporter start consumes the workflow ceiling before any report (spend=${enforced})`, () => {
    const sends = root(2);
    const { tracker, budget } = request(enforced);
    const reporter = createPhysicalSendReporter(budget, () => ({ poolId: "fixture" }));
    expect(reporter.beforeSend!()).toBe(true);
    expect(reporter.beforeSend!()).toBe(true);
    expect(sends()).toBe(2);
    expect(reporter.beforeSend!()).toBe(false);
    reporter(2); reporter.close!();
    expect(sends()).toBe(2);
    expect(tracker.refusals).toBe(1);
    tracker.settle(undefined);
  });

  test(`concurrent request reporters share one root allowance (spend=${enforced})`, () => {
    const sends = root(1);
    const first = request(enforced), second = request(enforced);
    const a = createPhysicalSendReporter(first.budget, () => ({ poolId: "fixture" }));
    const b = createPhysicalSendReporter(second.budget, () => ({ poolId: "fixture" }));
    expect(a.beforeSend!()).toBe(true);
    expect(b.beforeSend!()).toBe(false);
    expect(sends()).toBe(1);
    a(1); a.close!(); b.close!();
    first.tracker.settle(undefined); second.tracker.settle(undefined);
    expect(sends()).toBe(1);
  });

  test(`unused dispatch permits cost no physical sends (spend=${enforced})`, () => {
    const sends = root(1);
    const { tracker, budget } = request(enforced);
    const abandoned = budget.reserveDispatch({ sendClass: "initial", targetKey: "fixture/m" });
    if (!abandoned.allowed) throw new Error("fixture reservation refused");
    expect(sends()).toBe(0);
    abandoned.permit.release(); abandoned.permit.release();
    const sent = budget.reserveDispatch({ sendClass: "initial", targetKey: "fixture/m" });
    if (!sent.allowed) throw new Error("fixture reservation refused");
    expect(sent.permit.use()).toBe(true);
    sent.permit.release();
    expect(sends()).toBe(1);
    tracker.settle(undefined);
  });

  test(`a prepaid reporter is counted once and cleanup cannot refund its start (spend=${enforced})`, () => {
    const sends = root(1);
    const { tracker, budget } = request(enforced);
    const prepaid = budget.reserveDispatch({ sendClass: "initial", targetKey: "fixture/m", countedExternally: true });
    if (!prepaid.allowed) throw new Error("fixture reservation refused");
    const reporter = createPhysicalSendReporter(budget, () => ({ poolId: "fixture" }), prepaid.permit);
    expect(reporter.beforeSend!()).toBe(true);
    reporter(1); reporter.close!(); prepaid.permit.release();
    expect(sends()).toBe(1);
    const next = createPhysicalSendReporter(budget, () => ({ poolId: "fixture" }));
    expect(next.beforeSend!()).toBe(false);
    next.close!(); tracker.settle(undefined);
  });
}
