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

  test("a full root table refuses a new root instead of evicting an exhausted one", () => {
    // Fill one root to its send ceiling and let it go idle, then take the only other slot
    // with an active root. maxTrackedRoots is 2, so the table is now full and neither entry
    // may be forgotten.
    const filled = admitWorkflowTurn("full", "interactive", smallPolicy);
    chargeWorkflowSends("full", 3);
    if (filled?.admitted) filled.lease.release();
    const busy = admitWorkflowTurn("n1", "interactive", smallPolicy);
    expect(busy?.admitted).toBe(true);

    // Inserting a third root anyway is what made maxTrackedRoots a suggestion: the bound has
    // to refuse, because the only other way to honour it is to reset a ceiling that fired.
    const refused = admitWorkflowTurn("n2", "interactive", smallPolicy);
    expect(refused?.admitted).toBe(false);
    if (refused && !refused.admitted) expect(refused.reason).toBe("workflow-tracking-exhausted");
    expect(workflowBudgetSnapshot("n2")).toBeUndefined();

    // The exhausted root survived, so recreating it does not reset its allowance.
    const decision = admitWorkflowTurn("full", "interactive", smallPolicy);
    expect(decision?.admitted).toBe(false);
    if (decision && !decision.admitted) expect(decision.reason).toBe("workflow-sends-exhausted");

    // Once the active root goes idle it becomes a safe candidate and the next root fits.
    if (busy?.admitted) busy.lease.release();
    expect(admitWorkflowTurn("n2", "interactive", smallPolicy)?.admitted).toBe(true);
    expect(workflowBudgetSnapshot("n1")).toBeUndefined();
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

  test("settlement is idempotent and a dispatched release without it becomes unresolved spend", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: spendPolicy(1_000), now: () => 1_000 });
    const admitted = admitWorkflowTurn("r1", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 1_000, { sendId: "s1", inputTokens: 100, outputCeilingTokens: 50 }, ledger);
    expect(admitted?.admitted).toBe(true);
    if (admitted?.admitted) admitted.lease.markDispatched();
    expect(settleWorkflowSpend("s1", { inputTokens: 90, outputTokens: 10 }, ledger)).toBe(true);
    // Double settlement books nothing.
    expect(settleWorkflowSpend("s1", { inputTokens: 90, outputTokens: 10 }, ledger)).toBe(false);
    if (admitted?.admitted) admitted.lease.release();
    const settled = ledger.snapshot("root", "r1");
    expect(settled?.settled).toBe(100);
    expect(settled?.unresolved).toBe(0);

    // A DISPATCHED turn released without settlement keeps its cost as unresolved spend: the
    // send may have been billed even though its usage frame never arrived.
    const lost = admitWorkflowTurn("r1", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 2_000, { sendId: "s2", inputTokens: 30, outputCeilingTokens: 20 }, ledger);
    if (lost?.admitted) {
      lost.lease.markDispatched();
      lost.lease.release();
    }
    const after = ledger.snapshot("root", "r1");
    expect(after?.unresolved).toBe(50);
    // And a late settle for the lost send is correctly refused.
    expect(settleWorkflowSpend("s2", { inputTokens: 30, outputTokens: 20 }, ledger)).toBe(false);
  });

  test("a turn that never reached upstream books no spend at all", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: spendPolicy(1_000), now: () => 1_000 });
    const admitted = admitWorkflowTurn("r1", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 1_000, { sendId: "never-sent", inputTokens: 100, outputCeilingTokens: 50 }, ledger);
    expect(admitted?.admitted).toBe(true);
    // Admission is not dispatch. A local validation or routing failure between the two used
    // to be booked as unresolved spend, which invents debt the account never incurred.
    if (admitted?.admitted) admitted.lease.release();
    const snapshot = ledger.snapshot("root", "r1");
    expect(snapshot?.reserved).toBe(0);
    expect(snapshot?.unresolved).toBe(0);
    expect(snapshot?.settled).toBe(0);

    // The send id stays known, so replaying it buys no second dispatch.
    const replay = admitWorkflowTurn("r1", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 1_000, { sendId: "never-sent", inputTokens: 100, outputCeilingTokens: 50 }, ledger);
    expect(replay?.admitted).toBe(false);
    if (replay && !replay.admitted) expect(replay.reason).toBe("workflow-send-replayed");
  });

  test("a spend-exhausted idle root survives eviction pressure", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: spendPolicy(100), now: () => 1_000 });
    const exhausted = admitWorkflowTurn("full", "interactive", smallPolicy,
      undefined, 1_000, { sendId: "s1", inputTokens: 60, outputCeilingTokens: 40 }, ledger);
    // The send is dispatched and settled, then the lease is released: the root is idle and
    // its spend is exhausted.
    expect(exhausted?.admitted).toBe(true);
    if (exhausted?.admitted) {
      exhausted.lease.markDispatched();
      expect(settleWorkflowSpend("s1", { inputTokens: 60, outputTokens: 40 }, ledger)).toBe(true);
      exhausted.lease.release();
    }
    // An idle, unspent root takes the other slot, then a third root arrives under
    // maxTrackedRoots = 2. The evictable one is the unspent root, never the exhausted one.
    const spare = admitWorkflowTurn("n1", "interactive", smallPolicy, undefined, 2_000, undefined, ledger);
    if (spare?.admitted) spare.lease.release();
    expect(admitWorkflowTurn("n2", "interactive", smallPolicy, undefined, 3_000, undefined, ledger)?.admitted).toBe(true);
    expect(workflowBudgetSnapshot("n1")).toBeUndefined();
    expect(workflowBudgetSnapshot("full")).toBeDefined();
    const denied = admitWorkflowTurn("full", "interactive", smallPolicy,
      undefined, 4_000, { sendId: "s2", inputTokens: 1, outputCeilingTokens: 0 }, ledger);
    expect(denied?.admitted).toBe(false);
    if (denied && !denied.admitted) expect(denied.reason).toBe("workflow-spend-exhausted");
  });
});

describe("root ceilings bound a rate, not a lifetime (#4546)", () => {
  const WINDOW = 60_000;
  const policy: WorkflowBudgetPolicy = {
    ...DEFAULT_WORKFLOW_BUDGET_POLICY,
    maxPhysicalSends: 4,
    maxDistinctChildren: 2,
    windowMs: WINDOW,
  };

  beforeEach(() => {
    resetWorkflowBudgetsForTest();
  });

  test("a root at the send ceiling is admitted again once its window rolls", () => {
    const now = 1_700_000_000_000;
    const first = admitWorkflowTurn("root-a", "worker", policy, undefined, now);
    expect(first?.admitted).toBe(true);
    first?.lease.release();
    chargeWorkflowSends("root-a", policy.maxPhysicalSends, policy, now);

    // Inside the window the ceiling still fires: the burst this cap was written against is
    // refused exactly as before.
    expect(admitWorkflowTurn("root-a", "worker", policy, undefined, now + 1)?.reason)
      .toBe("workflow-sends-exhausted");
    expect(workflowSendCeilingReached("root-a", policy)).toBe(true);

    // Past the window the same root is served, with no restart. This is the case that made a
    // long-lived session unusable: work it finished hours ago kept refusing it.
    const rolled = admitWorkflowTurn("root-a", "worker", policy, undefined, now + WINDOW + 1);
    expect(rolled?.admitted).toBe(true);
    rolled?.lease.release();
  });

  test("distinct children age out of the count the same way sends do", () => {
    const now = 1_700_000_000_000;
    for (const child of ["c1", "c2"]) {
      const admitted = admitWorkflowTurn("root-b", "worker", policy, child, now);
      expect(admitted?.admitted).toBe(true);
      admitted?.lease.release();
    }
    // A third distinct child inside the window is refused at the configured ceiling.
    expect(admitWorkflowTurn("root-b", "worker", policy, "c3", now + 1)?.reason)
      .toBe("workflow-children-exhausted");

    // Once c1 and c2 have aged out, c3 is a new child under an empty count rather than the
    // third member of a set the root can never shrink.
    const later = admitWorkflowTurn("root-b", "worker", policy, "c3", now + WINDOW + 1);
    expect(later?.admitted).toBe(true);
    later?.lease.release();
  });

  test("a child that keeps working holds its slot; one that stops does not", () => {
    const now = 1_700_000_000_000;
    for (const at of [now, now + WINDOW / 2, now + WINDOW]) {
      const busy = admitWorkflowTurn("root-c", "worker", policy, "busy", at);
      expect(busy?.admitted).toBe(true);
      busy?.lease.release();
    }
    const quiet = admitWorkflowTurn("root-c", "worker", policy, "quiet", now);
    expect(quiet?.admitted).toBe(true);
    quiet?.lease.release();

    // "busy" was seen inside the window and still counts; "quiet" was not and does not, so
    // there is room for exactly one more distinct child rather than none.
    const snapshot = workflowBudgetSnapshot("root-c", policy, now + WINDOW + 1);
    expect(snapshot?.children).toBe(1);
  });

  test("windowing never refuses traffic the lifetime count would have admitted", () => {
    // The safety argument stated as a test rather than trusted as prose: a count inside a
    // window is bounded by the same count over a lifetime, so for identical traffic the
    // windowed ceiling fires no earlier than the lifetime one did.
    const now = 1_700_000_000_000;
    let lifetime = 0;
    for (let i = 0; i < policy.maxPhysicalSends * 3; i += 1) {
      const at = now + i * (WINDOW / 2);
      chargeWorkflowSends("root-d", 1, policy, at);
      lifetime += 1;
      const snapshot = workflowBudgetSnapshot("root-d", policy, at);
      if (snapshot) expect(snapshot.sends).toBeLessThanOrEqual(lifetime);
    }
  });

  test("the snapshot separates the window from the lifetime total", () => {
    const now = 1_700_000_000_000;
    const admitted = admitWorkflowTurn("root-e", "worker", policy, undefined, now);
    admitted?.lease.release();
    chargeWorkflowSends("root-e", 3, policy, now);
    const inside = workflowBudgetSnapshot("root-e", policy, now);
    expect(inside?.sends).toBe(3);
    expect(inside?.lifetimeSends).toBe(3);
    expect(inside?.windowMs).toBe(WINDOW);

    const after = workflowBudgetSnapshot("root-e", policy, now + WINDOW * 2);
    // The ceiling reads the window and sees nothing; the lifetime total is still reported, so
    // an operator can tell an idle root from one that never worked.
    expect(after?.sends).toBe(0);
    expect(after?.lifetimeSends).toBe(3);
  });
});

