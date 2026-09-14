import { beforeEach, describe, expect, test } from "bun:test";
import {
  createSpendReservationLedger,
  type SpendJournal,
  type SpendReservationPolicy,
} from "../../src/lib/spend-reservation-ledger";
import {
  admitWorkflowTurn,
  chargeWorkflowSends,
  DEFAULT_WORKFLOW_BUDGET_POLICY,
  resetWorkflowBudgetsForTest,
  settleWorkflowSpend,
  workflowBudgetSnapshot,
  workflowSendCeilingReached,
  type WorkflowBudgetPolicy,
} from "../../src/lib/workflow-budget";

const memoryJournal = (): SpendJournal & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, read: () => [...lines], append: (line) => { lines.push(line); } };
};

const spendPolicy = (maxTokens: number | undefined): SpendReservationPolicy => ({
  root: { maxTokens },
  identity: { maxTokens },
  pool: { maxTokens },
  retentionMs: 60_000,
});

const smallPolicy: WorkflowBudgetPolicy = {
  maxConcurrentChildren: 2,
  maxPhysicalSends: 3,
  maxDistinctChildren: 2,
  interactiveReserve: 1,
  maxTrackedRoots: 2,
};

beforeEach(() => {
  resetWorkflowBudgetsForTest();
});

describe("workflow count caps", () => {
  test("the physical-send ceiling refuses before dispatch", () => {
    admitWorkflowTurn("r1", "interactive", smallPolicy);
    chargeWorkflowSends("r1", 3);
    expect(workflowSendCeilingReached("r1", smallPolicy)).toBe(true);
    const decision = admitWorkflowTurn("r1", "interactive", smallPolicy);
    expect(decision?.admitted).toBe(false);
    if (decision && !decision.admitted) expect(decision.reason).toBe("workflow-sends-exhausted");
  });

  test("a worker lane may not take the interactive reserve", () => {
    const workerCeiling = smallPolicy.maxConcurrentChildren - smallPolicy.interactiveReserve;
    for (let i = 0; i < workerCeiling; i += 1) {
      expect(admitWorkflowTurn("r1", "worker", smallPolicy, `c${i}`)?.admitted).toBe(true);
    }
    const denied = admitWorkflowTurn("r1", "worker", smallPolicy, "c-extra");
    expect(denied?.admitted).toBe(false);
    if (denied && !denied.admitted) expect(denied.reason).toBe("workflow-concurrency-exhausted");
    // The interactive turn that owns the fan-out still gets in.
    expect(admitWorkflowTurn("r1", "interactive", smallPolicy)?.admitted).toBe(true);
  });

  test("distinct children are capped", () => {
    // Concurrency is deliberately not the binding constraint here.
    const policy: WorkflowBudgetPolicy = {
      maxConcurrentChildren: 10,
      maxPhysicalSends: 100,
      maxDistinctChildren: 2,
      interactiveReserve: 0,
      maxTrackedRoots: 10,
    };
    admitWorkflowTurn("r1", "worker", policy, "c1");
    admitWorkflowTurn("r1", "worker", policy, "c2");
    const denied = admitWorkflowTurn("r1", "worker", policy, "c3");
    expect(denied?.admitted).toBe(false);
    if (denied && !denied.admitted) expect(denied.reason).toBe("workflow-children-exhausted");
  });

  test("an exhausted-but-idle root is never evicted to make room", () => {
    // Fill the root to its send ceiling, then let it go idle: only the new
    // exhausted-but-idle rule can still protect it from eviction.
    const filled = admitWorkflowTurn("full", "interactive", smallPolicy);
    chargeWorkflowSends("full", 3);
    if (filled?.admitted) filled.lease.release();
    // Two more roots arrive, forcing eviction pressure at maxTrackedRoots = 2.
    admitWorkflowTurn("n1", "interactive", smallPolicy);
    admitWorkflowTurn("n2", "interactive", smallPolicy);
    // The exhausted root survived the prune: recreating it must not reset its allowance.
    const decision = admitWorkflowTurn("full", "interactive", smallPolicy);
    expect(decision?.admitted).toBe(false);
    if (decision && !decision.admitted) expect(decision.reason).toBe("workflow-sends-exhausted");
  });
});

describe("workflow spend reservation", () => {
  test("the token cap intersects the count caps", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: spendPolicy(100), now: () => 1_000 });
    const spend = (sendId: string) => ({
      sendId, inputTokens: 60, outputCeilingTokens: 40,
    });
    expect(admitWorkflowTurn("r1", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 1_000, spend("s1"), ledger)?.admitted).toBe(true);
    const denied = admitWorkflowTurn("r1", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 1_000, spend("s2"), ledger);
    expect(denied?.admitted).toBe(false);
    if (denied && !denied.admitted) {
      expect(denied.reason).toBe("workflow-spend-exhausted");
      expect(denied.spendScope).toBe("root");
    }
  });

  test("identity and pool scopes hold spend across fresh root ids", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: spendPolicy(100), now: () => 1_000 });
    const spend = (sendId: string) => ({
      sendId, identityId: "user-1", poolId: "pool-1", inputTokens: 60, outputCeilingTokens: 40,
    });
    expect(admitWorkflowTurn("root-a", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 1_000, spend("s1"), ledger)?.admitted).toBe(true);
    const denied = admitWorkflowTurn("root-b", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 1_000, spend("s2"), ledger);
    expect(denied?.admitted).toBe(false);
    if (denied && !denied.admitted) expect(denied.spendScope).toBe("identity");
  });

  test("settlement is idempotent and a release without it becomes unresolved spend", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: spendPolicy(1_000), now: () => 1_000 });
    const admitted = admitWorkflowTurn("r1", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 1_000, { sendId: "s1", inputTokens: 100, outputCeilingTokens: 50 }, ledger);
    expect(admitted?.admitted).toBe(true);
    expect(settleWorkflowSpend("s1", { inputTokens: 90, outputTokens: 10 }, ledger)).toBe(true);
    // Double settlement books nothing.
    expect(settleWorkflowSpend("s1", { inputTokens: 90, outputTokens: 10 }, ledger)).toBe(false);
    if (admitted?.admitted) admitted.lease.release();
    const settled = ledger.snapshot("root", "r1");
    expect(settled?.settled).toBe(100);
    expect(settled?.unresolved).toBe(0);

    // A turn released without settlement keeps its cost as unresolved spend.
    const lost = admitWorkflowTurn("r1", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 2_000, { sendId: "s2", inputTokens: 30, outputCeilingTokens: 20 }, ledger);
    if (lost?.admitted) lost.lease.release();
    const after = ledger.snapshot("root", "r1");
    expect(after?.unresolved).toBe(50);
    // And a late settle for the lost send is correctly refused.
    expect(settleWorkflowSpend("s2", { inputTokens: 30, outputTokens: 20 }, ledger)).toBe(false);
  });

  test("a spend-exhausted idle root survives eviction pressure", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: spendPolicy(100), now: () => 1_000 });
    const exhausted = admitWorkflowTurn("full", "interactive", smallPolicy,
      undefined, 1_000, { sendId: "s1", inputTokens: 60, outputCeilingTokens: 40 }, ledger);
    // The lease is released so the root is idle, but its spend is exhausted.
    if (exhausted?.admitted) exhausted.lease.release();
    admitWorkflowTurn("n1", "interactive", smallPolicy, undefined, 2_000, undefined, ledger);
    admitWorkflowTurn("n2", "interactive", smallPolicy, undefined, 3_000, undefined, ledger);
    const snap = workflowBudgetSnapshot("full");
    expect(snap).toBeDefined();
    const denied = admitWorkflowTurn("full", "interactive", smallPolicy,
      undefined, 4_000, { sendId: "s2", inputTokens: 1, outputCeilingTokens: 0 }, ledger);
    expect(denied?.admitted).toBe(false);
    if (denied && !denied.admitted) expect(denied.reason).toBe("workflow-spend-exhausted");
  });
});
