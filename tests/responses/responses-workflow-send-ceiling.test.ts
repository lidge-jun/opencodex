import { afterEach, expect, test } from "bun:test";
import { createPhysicalSendReporter, createRequestExecutionBudget, createBoundedSameTargetRecovery, reportDispatchSends } from "../../src/lib/request-execution-budget";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY } from "../../src/lib/spend-reservation-ledger";
import { admitWorkflowTurn, DEFAULT_WORKFLOW_BUDGET_POLICY, resetWorkflowBudgetsForTest, workflowBudgetSnapshot } from "../../src/lib/workflow-budget";
import { bindWorkflowBudgetConfig } from "../../src/lib/workflow-budget-config";
import { fetchWithTransientRetry, SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { bindResponsesSpendTarget } from "../../src/server/responses/request-spend-target";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

afterEach(() => { bindWorkflowBudgetConfig(null); resetWorkflowBudgetsForTest(); });

function root(limit: number) {
  bindWorkflowBudgetConfig({ workflowBudget: { maxPhysicalSends: limit } });
  const policy = { ...DEFAULT_WORKFLOW_BUDGET_POLICY, maxPhysicalSends: limit };
  // This unit uses in-memory ledgers; a prior server fixture's policy is not its owner.
  const admission = admitWorkflowTurn("physical-root", "interactive", policy, undefined, Date.now(), undefined, createSpendReservationLedger());
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
  const logCtx: Parameters<typeof createRequestSpendTracker>[0] = { provider: "fixture", spendInputEstimateTokens: 1 };
  const tracker = createRequestSpendTracker(logCtx, "physical-root", ledger);
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  return { tracker, budget, logCtx, ledger, lines };
}

for (const path of ["reporter", "continuation", "permit"] as const) {
  test(`a refused ${path} releases its unstarted token seed before settlement`, () => {
    const sends = root(1);
    const f = request(true);
    const continuation = path === "continuation" ? auxiliaryOwner(f.budget, f.logCtx).continuationSendReporter({ body: {}, text: "x" }) : undefined;
    const other = request(false);
    const sent = createPhysicalSendReporter(other.budget, () => ({ poolId: "fixture" }));
    expect(sent.beforeSend!()).toBe(true);
    sent(1); sent.close!(); other.tracker.settle(undefined);
    const reserved = () => f.ledger.snapshot("root", "physical-root")?.reserved ?? 0;
    expect(reserved()).toBe(0);
    try {
      if (path === "permit") {
        const decision = f.budget.reserveDispatch({ sendClass: "initial", targetKey: "refused" });
        if (!decision.allowed) throw new Error("fixture booking refused before physical admission");
        try {
          expect(reserved()).toBeGreaterThan(0);
          expect(decision.permit.use()).toBe(false);
          expect(reserved()).toBe(0);
        } finally { decision.permit.release(); }
      } else {
        const reporter = continuation ?? createPhysicalSendReporter(f.budget, () => ({ poolId: "fixture" }));
        try {
          expect(reporter.beforeSend!()).toBe(false);
          expect(f.lines.some(line => JSON.parse(line).kind === "reserve")).toBe(true);
          expect(reserved()).toBe(0);
        } finally { reporter.close!(); }
      }
      expect(sends()).toBe(1);
    } finally { f.tracker.settle(undefined); }
  });
}

test("a refused helper gives back only its seed and preserves a pending parent booking", () => {
  root(1);
  const f = request(true);
  const parent = f.budget.reserveDispatch({ sendClass: "initial", targetKey: "parent", countedExternally: true });
  if (!parent.allowed) throw new Error("parent booking refused");
  const parentHold = f.ledger.snapshot("root", "physical-root")!.reserved;
  const priorHelperPoolHold = f.ledger.snapshot("pool", "anthropic")?.reserved ?? 0;
  const other = request(false);
  const sent = createPhysicalSendReporter(other.budget, () => ({ poolId: "fixture" }));
  expect(sent.beforeSend!()).toBe(true); sent(1); sent.close!(); other.tracker.settle(undefined);
  const helper = f.budget.reserveDispatch({ sendClass: "auxiliary", targetKey: "helper",
    spendScopes: { poolId: "anthropic", identityId: "" }, spendEstimate: { inputTokens: 2, outputCeilingTokens: 3 } });
  if (!helper.allowed) throw new Error("helper booking refused before physical admission");
  try {
    expect(f.ledger.snapshot("root", "physical-root")!.reserved).toBeGreaterThan(parentHold);
    expect(helper.permit.use()).toBe(false);
    expect(f.ledger.snapshot("root", "physical-root")!.reserved).toBe(parentHold);
    expect(f.ledger.snapshot("pool", "anthropic")!.reserved).toBe(priorHelperPoolHold);
    expect(f.ledger.snapshot("pool", "fixture")!.reserved).toBe(parentHold);
  } finally { helper.permit.release(); parent.permit.release(); f.tracker.settle(undefined); }
});

test("a refused reporter cannot abandon a seed that already started", () => {
  root(1);
  const f = request(true);
  const first = createPhysicalSendReporter(f.budget, () => ({ poolId: "fixture" }));
  const refused = createPhysicalSendReporter(f.budget, () => ({ poolId: "fixture" }));
  try {
    expect(first.beforeSend!()).toBe(true);
    const hold = f.ledger.snapshot("pool", "fixture")!.reserved;
    expect(refused.beforeSend!()).toBe(false);
    expect(f.ledger.snapshot("pool", "fixture")!.reserved).toBe(hold);
    first(1);
  } finally { first.close!(); refused.close!(); f.tracker.settle(undefined); }
});

const auxiliaryTarget = { poolId: "anthropic", identityId: "", targetKey: "search:q",
  estimate: { inputTokens: 1, outputCeilingTokens: 1 } };
function auxiliaryOwner(budget: ReturnType<typeof createRequestExecutionBudget>,
  logCtx: Parameters<typeof createRequestSpendTracker>[0] = { provider: "fixture" }) {
  const state = createResponsesSendBudget({ options: { sendBudget: budget }, logCtx,
    req: new Request("http://fixture/v1/responses", { headers: { "x-codex-parent-thread-id": "physical-root" } }) });
  if (state instanceof Response) throw new Error("fixture owner refused");
  return state;
}

test("auxiliary factory budgets without observers still spend and enforce the root ceiling", async () => {
  const sends = root(1), budget = createRequestExecutionBudget();
  const state = auxiliaryOwner(budget);
  let calls = 0;
  await state.dispatchSidecarSend(auxiliaryTarget, async () => { calls++; });
  expect(sends()).toBe(1);
  await expect(state.dispatchSidecarSend(auxiliaryTarget, async () => { calls++; })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
  expect(calls).toBe(1); expect(sends()).toBe(1); expect(budget.used).toBe(1);
});

test("auxiliary root refusal refunds the unused booking on an inherited budget", async () => {
  const sends = root(1), budget = createRequestExecutionBudget(), state = auxiliaryOwner(budget);
  const observed = request(false);
  const first = observed.budget.reserveDispatch({ sendClass: "initial", targetKey: "parent" });
  if (!first.allowed) throw new Error("initial refused");
  expect(first.permit.use()).toBe(true);
  let calls = 0;
  await expect(state.dispatchSidecarSend(auxiliaryTarget, async () => { calls++; })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
  expect(calls).toBe(0); expect(sends()).toBe(1); expect(budget.used).toBe(0);
  observed.tracker.settle(undefined);
});

test("concurrent auxiliary factory sends cannot share the last root slot", async () => {
  const sends = root(1), budget = createRequestExecutionBudget(), state = auxiliaryOwner(budget);
  let calls = 0;
  const results = await Promise.allSettled(["a", "b"].map(targetKey =>
    state.dispatchSidecarSend({ ...auxiliaryTarget, targetKey }, async () => { calls++; })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(calls).toBe(1); expect(sends()).toBe(1); expect(budget.used).toBe(1);
});

test("auxiliary charge-only observers still use fallback root admission", async () => {
  const sends = root(1);
  let charges = 0, refunds = 0, calls = 0;
  const budget = createRequestExecutionBudget(undefined, undefined, {
    charge: () => { charges++; return true; }, refund: () => { refunds++; },
  });
  const state = auxiliaryOwner(budget);
  await state.dispatchSidecarSend(auxiliaryTarget, async () => { calls++; });
  await expect(state.dispatchSidecarSend(auxiliaryTarget, async () => { calls++; })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
  expect(calls).toBe(1); expect(sends()).toBe(1); expect(budget.used).toBe(1);
  expect(charges - refunds).toBe(1);
});

test("auxiliary factory sends without a workflow root retain request accounting", async () => {
  const budget = createRequestExecutionBudget();
  const state = createResponsesSendBudget({ options: { sendBudget: budget }, logCtx: { provider: "fixture" },
    req: new Request("http://fixture/v1/responses") });
  if (state instanceof Response) throw new Error("fixture owner refused");
  let calls = 0;
  await state.dispatchSidecarSend(auxiliaryTarget, async () => { calls++; });
  await state.dispatchSidecarSend(auxiliaryTarget, async () => { calls++; });
  expect(calls).toBe(2); expect(budget.used).toBe(2);
});

test("auxiliary use refusal consumes neither root capacity nor the unused booking", async () => {
  const sends = root(1), budget = createRequestExecutionBudget();
  const reserve = budget.reserveDispatch.bind(budget);
  budget.reserveDispatch = intent => {
    const decision = reserve(intent);
    return decision.allowed ? { allowed: true, permit: { ...decision.permit, use: () => false } } : decision;
  };
  const state = auxiliaryOwner(budget);
  await expect(state.dispatchSidecarSend(auxiliaryTarget, async () => { throw new Error("unexpected dispatch"); })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
  expect(sends()).toBe(0); expect(budget.used).toBe(0);
});

for (const enforced of [false, true]) test(`auxiliary root refusal is nonterminal until the routed send is refused (spend=${enforced})`, async () => {
  const sends = root(1), { tracker, budget, logCtx } = request(enforced);
  const state = auxiliaryOwner(budget, logCtx);
  const initial = budget.reserveDispatch({ sendClass: "initial", targetKey: "parent" });
  if (!initial.allowed) throw new Error("initial refused");
  expect(initial.permit.use()).toBe(true);
  await expect(state.dispatchSidecarSend(auxiliaryTarget, async () => "unexpected")).rejects.toBeInstanceOf(SendBudgetExhaustedError);
  expect(tracker.refusals).toBe(1); expect(tracker.lastRefusal?.reason).toBe("workflow-sends-exhausted");
  expect(logCtx.localTerminalReason).toBeUndefined(); expect(logCtx.errorCode).toBeUndefined();
  const terminal = budget.reserveDispatch({ sendClass: "transient", targetKey: "parent" });
  if (!terminal.allowed) throw new Error("expected admission to reach root guard");
  expect(terminal.permit.use()).toBe(false); terminal.permit.release();
  expect(logCtx.localTerminalReason).toBe("workflow_sends_exhausted");
  expect(sends()).toBe(1); tracker.settle(undefined);
});

test("native successors reserve fresh token capacity before each physical start", () => {
  const release = acquireOwnedSpendHome();
  const sends = root(10);
  const logCtx = { model: "m", provider: "fixture", spendInputEstimateTokens: 1 };
  const ledger = createSpendReservationLedger({ policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, root: { maxTokens: 2 } } });
  const tracker = createRequestSpendTracker(logCtx, "physical-root", ledger);
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  try {
    const state = createResponsesSendBudget({ options: { sendBudget: budget }, logCtx,
      req: new Request("http://fixture/v1/responses", { headers: { "x-codex-parent-thread-id": "physical-root" } }) });
    if (state instanceof Response) throw new Error("fixture admission refused");
    for (const reporter of [state.transientSendReporter(), state.continuationSendReporter({ body: {}, text: "x" })]) {
      try { expect(reporter.beforeSend!()).toBe(true); reporter(1); } finally { reporter.close?.(); }
    }
    const denied = state.continuationSendReporter({ body: {}, text: "x" });
    try { expect(denied.beforeSend!()).toBe(false); } finally { denied.close?.(); }
    expect(sends()).toBe(2); expect(budget.used).toBe(2); expect(budget.physicalStarted).toBe(2);
    expect(tracker.refusals).toBe(1);
  } finally { tracker.settle(undefined); release(); }
});

test("routed spend identity survives continuation estimates", () => {
  const sends = root(10);
  const f = request(true);
  const targets: Array<Parameters<typeof f.tracker.ensureSeed>[0]> = [];
  const budget = createRequestExecutionBudget(undefined, undefined, { ...f.tracker,
    ensureSeed: (target, proof) => { targets.push(target); return f.tracker.ensureSeed(target, proof); },
  });
  bindResponsesSpendTarget(f.logCtx, () => ({ poolId: "candidate-pool", identityId: "candidate-account" }));
  try {
    const state = auxiliaryOwner(budget, f.logCtx);
    for (const reporter of [state.transientSendReporter(),
      state.continuationSendReporter({ body: { max_output_tokens: 8 }, text: "saved result ".repeat(40) })]) {
      try { expect(reporter.beforeSend!()).toBe(true); reporter(1); } finally { reporter.close?.(); }
    }
    expect(sends()).toBe(2);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ poolId: "candidate-pool", identityId: "candidate-account" });
    expect(targets[1]).toMatchObject({ poolId: "candidate-pool", identityId: "candidate-account",
      explicitEstimate: true, estimate: { outputCeilingTokens: 8 } });
    expect(targets[1].estimate!.inputTokens).toBeGreaterThan(1);
  } finally { bindResponsesSpendTarget(f.logCtx); f.tracker.settle(undefined); }
});

test("explicit native starts do not replenish ordinary or bounded recovery grants", () => {
  const release = acquireOwnedSpendHome();
  const sends = root(30), { tracker, budget } = request(true);
  const logCtx = { model: "m", provider: "fixture" };
  try {
    const state = createResponsesSendBudget({ options: { sendBudget: budget }, logCtx,
      req: new Request("http://fixture/v1/responses", { headers: { "x-codex-parent-thread-id": "physical-root" } }) });
    if (state instanceof Response) throw new Error("fixture admission refused");
    for (let i = 0; i < 6; i++) {
      const reporter = state.continuationSendReporter({ body: {}, text: "x" });
      try { expect(reporter.beforeSend!()).toBe(true); reporter(1); } finally { reporter.close?.(); }
    }
    expect(budget.used).toBe(6); expect(budget.physicalStarted).toBe(6);
    expect(budget.remainingBaseSends(3)).toBe(0);
    expect(budget.reserveDispatch({ sendClass: "transient", targetKey: "fixture/m" }).allowed).toBe(false);
    const recovery = createBoundedSameTargetRecovery(budget, "fixture/m", 2);
    for (let i = 0; i < 2; i++) {
      const decision = recovery.reserve();
      if (!decision.allowed) throw new Error("bounded fixture grant refused");
      expect(decision.permit.use()).toBe(true);
    }
    expect(recovery.reserve().allowed).toBe(false);
    expect(sends()).toBe(8); expect(budget.used).toBe(8); expect(budget.physicalStarted).toBe(8);
  } finally { tracker.settle(undefined); release(); }
});

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
