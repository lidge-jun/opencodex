import { beforeEach, describe, expect, test } from "bun:test";
import {
  createSpendReservationLedger,
  type SpendJournal,
  type SpendReservationPolicy,
} from "../../src/lib/spend-reservation-ledger";
import {
  admitWorkflowTurn,
  chargeWorkflowSends,
  clearWorkflowBudgetForRoot,
  DEFAULT_WORKFLOW_BUDGET_POLICY,
  listTrackedWorkflowRoots,
  listWorkflowBudgetEvents,
  resetWorkflowBudgetsForTest,
  settleWorkflowSpend,
  workflowBudgetSnapshot,
  workflowDenialSummary,
  workflowSendCeilingReached,
  WORKFLOW_EVENT_CAPACITY,
  WORKFLOW_LOCAL_REFUSAL_HEADER,
  type WorkflowDenial,
  type WorkflowBudgetPolicy,
} from "../../src/lib/workflow-budget";
import { workflowRefusalResponse } from "../../src/server/workflow-refusal";
import { repoPath } from "../helpers/repo-root";
import {
  clearRequestLogsForTests,
  getRequestLogEntries,
  type RequestLogContext,
} from "../../src/server/request-log";

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
    chargeWorkflowSends("root-a", policy.maxPhysicalSends, now);

    // Inside the window the ceiling still fires: the burst this cap was written against is
    // refused exactly as before.
    expect(admitWorkflowTurn("root-a", "worker", policy, undefined, now + 1)?.reason)
      .toBe("workflow-sends-exhausted");
    expect(workflowSendCeilingReached("root-a", policy, now + 1)).toBe(true);

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
    //
    // The root is admitted first on purpose. An earlier version of this test charged a root
    // that had never been admitted, so `chargeWorkflowSends` returned at its `!state` guard,
    // the snapshot came back undefined, and every assertion sat behind `if (snapshot)`. It
    // would have passed with the ring deleted.
    const now = 1_700_000_000_000;
    const seeded = admitWorkflowTurn("root-d", "worker", policy, undefined, now);
    expect(seeded?.admitted).toBe(true);
    seeded?.lease.release();

    let lifetime = 0;
    let refusals = 0;
    for (let i = 0; i < policy.maxPhysicalSends * 3; i += 1) {
      const at = now + i * (WINDOW / 2);
      chargeWorkflowSends("root-d", 1, at);
      lifetime += 1;
      const snapshot = workflowBudgetSnapshot("root-d", policy, at);
      expect(snapshot).toBeDefined();
      expect(snapshot?.lifetimeSends).toBe(lifetime);
      expect(snapshot?.sends).toBeLessThanOrEqual(lifetime);
      if (workflowSendCeilingReached("root-d", policy, at)) {
        refusals += 1;
        expect(lifetime).toBeGreaterThanOrEqual(policy.maxPhysicalSends);
      }
    }

    // Spread half a window apart, this traffic is a trickle and is never refused, while the
    // lifetime count passed the same ceiling three times over. That gap is the whole change.
    expect(refusals).toBe(0);
    expect(lifetime).toBeGreaterThan(policy.maxPhysicalSends);
  });

  test("the window a root was created with is the one its ceiling reads", () => {
    // Charging on one scale and reading on another is not hypothetical: the slot ids written
    // under a long window look ancient to a short one, `windowedSends` returns zero, and the
    // ceiling stops firing at all. The geometry therefore belongs to the root, not to
    // whichever policy the current caller happens to be holding.
    const now = 1_700_000_000_000;
    const seeded = admitWorkflowTurn("root-f", "worker", policy, undefined, now);
    expect(seeded?.admitted).toBe(true);
    seeded?.lease.release();
    chargeWorkflowSends("root-f", policy.maxPhysicalSends, now);

    const wider: WorkflowBudgetPolicy = { ...policy, windowMs: WINDOW * 100 };
    const narrower: WorkflowBudgetPolicy = { ...policy, windowMs: 1_000 };
    expect(workflowSendCeilingReached("root-f", wider, now + 1)).toBe(true);
    expect(workflowSendCeilingReached("root-f", narrower, now + 1)).toBe(true);
    expect(workflowBudgetSnapshot("root-f", narrower, now + 1)?.windowMs).toBe(WINDOW);
  });

  test("the snapshot separates the window from the lifetime total", () => {
    const now = 1_700_000_000_000;
    const admitted = admitWorkflowTurn("root-e", "worker", policy, undefined, now);
    admitted?.lease.release();
    chargeWorkflowSends("root-e", 3, now);
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


describe("every ceiling on this path reads the caller's clock", () => {
  test("no function reads Date.now() except as a parameter default", async () => {
    // This defect has now appeared three times in two days: codexPoolAffinityKey, then
    // chargeWorkflowSends, then workflowSendCeilingReached. Each time a caller working against
    // a fixed clock wrote into one window and read from another, and each time the symptom was
    // a ceiling that fired when it should not have. A function that decides admission must be
    // askable about a moment, so the clock is a parameter and never an ambient read.
    const source = await Bun.file(
      new URL("../../src/lib/workflow-budget.ts", import.meta.url),
    ).text();
    const ambient = source
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(entry => entry.line.includes("Date.now()"))
      .filter(entry => !entry.line.startsWith("now: number = Date.now()"))
      .filter(entry => !entry.line.startsWith("//"))
      // lastSeenMs feeds eviction ordering, not a ceiling, and its comment says so.
      .filter(entry => !entry.line.includes("lastSeenMs = Date.now()"));
    expect(ambient).toEqual([]);
  });
});

describe("a refusal an operator can read, name and clear (#4546)", () => {
  const ALL_DENIALS: WorkflowDenial[] = [
    "workflow-concurrency-exhausted",
    "workflow-sends-exhausted",
    "workflow-children-exhausted",
    "workflow-spend-exhausted",
    "workflow-tracking-exhausted",
    "workflow-send-replayed",
    "workflow-spend-undurable",
  ];

  beforeEach(() => {
    resetWorkflowBudgetsForTest();
  });

  test("each ceiling gets its own sentence rather than one shared with the others", () => {
    // The bug this replaces: all four count denials emitted one sentence about a
    // "concurrent-work limit", so an operator who had hit the SEND ceiling was told to wait for
    // turns to finish. Waiting never helped, because no turn was running.
    const messages = ALL_DENIALS.map(reason => workflowDenialSummary(reason).message);
    expect(new Set(messages).size).toBe(ALL_DENIALS.length);
    for (const message of messages) {
      // Every one of them has to say whose decision this was; that is the half an operator
      // cannot recover from the wire, since the body is shaped like a provider rate limit.
      expect(message).toContain("This proxy refused the request locally");
    }
    expect(workflowDenialSummary("workflow-sends-exhausted").message).toContain("send ceiling");
    expect(workflowDenialSummary("workflow-children-exhausted").message).toContain("child threads");
  });

  test("the response carries the machine-readable ceiling name a 429 body cannot", () => {
    const refusal = workflowRefusalResponse("workflow-children-exhausted");
    expect(refusal.status).toBe(429);
    expect(refusal.headers.get(WORKFLOW_LOCAL_REFUSAL_HEADER)).toBe("workflow_children_exhausted");
  });

  test("a refusal with a log context marks its row synthetic", () => {
    const logCtx = { model: "m", provider: "p" } as RequestLogContext;
    workflowRefusalResponse("workflow-sends-exhausted", logCtx);
    expect(logCtx.terminalSource).toBe("synthetic");
    expect(logCtx.localTerminalReason).toBe("workflow_sends_exhausted");
    // A locally assigned code wins over the 429 classification, so this is what the logs
    // column shows instead of a generic rate limit.
    expect(logCtx.errorCode).toBe("workflow_sends_exhausted");
  });

  test("a refusal before the body is parsed still leaves a row in the logs", () => {
    // The defect this closes: the HTTP admission check returns before the turn runs, so a
    // refused request left no trace at all on /api/logs. The model and provider stay
    // "unknown" because they genuinely never resolved -- the same placeholder the native
    // passthrough path already writes -- and the row says who refused and why.
    clearRequestLogsForTests();
    const before = getRequestLogEntries().length;
    const logCtx = { model: "unknown", provider: "unknown" } as RequestLogContext;
    const refusal = workflowRefusalResponse("workflow-children-exhausted", undefined, {
      requestId: "req-refusal-1",
      start: Date.now() - 5,
      logCtx,
    });
    expect(refusal.status).toBe(429);

    const written = getRequestLogEntries();
    expect(written.length).toBe(before + 1);
    const row = written.find(entry => entry.requestId === "req-refusal-1");
    expect(row?.terminalSource).toBe("synthetic");
    expect(row?.localTerminalReason).toBe("workflow_children_exhausted");
    expect(row?.errorCode).toBe("workflow_children_exhausted");
    clearRequestLogsForTests();
  });

  test("the ceiling name is readable by a browser dashboard, not only by curl", () => {
    // A header the data plane never exposes is invisible to cross-origin JavaScript, which
    // would have made this marker useful to curl and to nothing else.
    const refusal = workflowRefusalResponse("workflow-sends-exhausted");
    expect(refusal.headers.get("Access-Control-Expose-Headers"))
      .toContain(WORKFLOW_LOCAL_REFUSAL_HEADER);
  });

  test("every inbound surface that opens a log row threads its refusal into one", async () => {
    // A unit test on the helper proves the helper. It does not prove the wiring, and the
    // wiring is where this went wrong twice: the refusal originally reached no surface's log
    // at all, and the fix first reached only one of nine. Exposing the header was likewise
    // pointless until the refusal was CORS-wrapped, because without an allow-origin a browser
    // cannot read an exposed header either.
    // src/server/index.ts is a facade now. The runAdmittedHttpTurn call sites live in the
    // serve-options leaf while withCors(workflowRefusalResponse( stayed in the composition
    // root, so read both. Reading the facade alone would find no call site and the
    // "more than one surface" assertion would pass on an empty match array.
    const source = [
      await Bun.file(repoPath("src/server/index.ts")).text(),
      await Bun.file(repoPath("src/server/index/serve-options.ts")).text(),
    ].join("\n");
    const callSites = source.match(/return runAdmittedHttpTurn\(/g) ?? [];
    const threaded = source.match(/, \{ requestId, start, logCtx \}\);/g) ?? [];
    expect(callSites.length).toBeGreaterThan(1);
    // Exactly one surface has no log context to thread: /v1/messages/count_tokens opens no
    // request-log row at all. Every other one must, or a refusal there leaves no trace.
    expect(callSites.length - threaded.length).toBe(1);
    expect(source).toContain("withCors(workflowRefusalResponse(");
  });

  test("every refusal lands on the record with the counts that caused it", () => {
    const now = 1_700_000_000_000;
    const policy: WorkflowBudgetPolicy = { ...DEFAULT_WORKFLOW_BUDGET_POLICY, maxPhysicalSends: 2 };
    const seeded = admitWorkflowTurn("root-r", "worker", policy, undefined, now);
    seeded?.lease.release();
    chargeWorkflowSends("root-r", 2, now);
    const denied = admitWorkflowTurn("root-r", "worker", policy, undefined, now + 1);
    expect(denied?.admitted).toBe(false);

    const [latest] = listWorkflowBudgetEvents(4);
    expect(latest?.kind).toBe("refused");
    expect(latest?.rootId).toBe("root-r");
    expect(latest?.reason).toBe("workflow-sends-exhausted");
    expect(latest?.sends).toBe(2);
  });

  test("the event record is bounded", () => {
    const now = 1_700_000_000_000;
    const policy: WorkflowBudgetPolicy = { ...DEFAULT_WORKFLOW_BUDGET_POLICY, maxPhysicalSends: 1 };
    const seeded = admitWorkflowTurn("root-s", "worker", policy, undefined, now);
    seeded?.lease.release();
    chargeWorkflowSends("root-s", 1, now);
    for (let i = 0; i < WORKFLOW_EVENT_CAPACITY * 2; i += 1) {
      admitWorkflowTurn("root-s", "worker", policy, undefined, now + 1 + i);
    }
    expect(listWorkflowBudgetEvents(1_000).length).toBe(WORKFLOW_EVENT_CAPACITY);
  });

  test("clearing one root moves its ceilings and nothing else", () => {
    const now = 1_700_000_000_000;
    const policy: WorkflowBudgetPolicy = { ...DEFAULT_WORKFLOW_BUDGET_POLICY, maxPhysicalSends: 2 };
    const held = admitWorkflowTurn("root-t", "worker", policy, "child-1", now);
    expect(held?.admitted).toBe(true);
    chargeWorkflowSends("root-t", 2, now);
    expect(workflowSendCeilingReached("root-t", policy, now)).toBe(true);

    const before = clearWorkflowBudgetForRoot("root-t", policy, now);
    expect(before?.sends).toBe(2);
    expect(before?.children).toBe(1);

    const after = workflowBudgetSnapshot("root-t", policy, now);
    expect(after?.sends).toBe(0);
    expect(after?.children).toBe(0);
    // The turn holding a slot is still holding it: zeroing `active` would let its release drive
    // the count negative and hand out concurrency that is already taken.
    expect(after?.active).toBe(1);
    // And the lifetime total survives, so clearing a ceiling cannot launder the record of what
    // the root actually did.
    expect(after?.lifetimeSends).toBe(2);
    expect(workflowSendCeilingReached("root-t", policy, now)).toBe(false);
    held?.lease.release();

    const [latest] = listWorkflowBudgetEvents(1);
    expect(latest?.kind).toBe("cleared");
    expect(latest?.rootId).toBe("root-t");
    expect(latest?.sends).toBe(2);
  });

  test("clearing a count ceiling does not forgive spend", () => {
    // The dangerous version of this feature. A count ceiling is a rate guard an operator may
    // reasonably wave off; a token ceiling is money, and one button must not do both.
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: spendPolicy(100), now: () => 1_000 });
    const spend = (sendId: string) => ({ sendId, inputTokens: 60, outputCeilingTokens: 40 });
    expect(admitWorkflowTurn("root-u", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 1_000, spend("s1"), ledger)?.admitted).toBe(true);

    clearWorkflowBudgetForRoot("root-u", DEFAULT_WORKFLOW_BUDGET_POLICY, 1_000);

    const denied = admitWorkflowTurn("root-u", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 1_000, spend("s2"), ledger);
    expect(denied?.admitted).toBe(false);
    if (denied && !denied.admitted) expect(denied.reason).toBe("workflow-spend-exhausted");
  });

  test("clearing an untracked root reports that rather than inventing one", () => {
    expect(clearWorkflowBudgetForRoot("never-seen")).toBeUndefined();
    expect(workflowBudgetSnapshot("never-seen")).toBeUndefined();
    expect(listWorkflowBudgetEvents(1)).toEqual([]);
  });

  test("tracked roots are listed most recently active first and bounded", () => {
    const now = 1_700_000_000_000;
    // The leases are deliberately left open. `release()` stamps `lastSeenMs` from the wall
    // clock -- it feeds eviction ordering, not a ceiling -- which would collapse the injected
    // ordering this test is about into three near-identical real timestamps.
    for (const [index, root] of ["root-v", "root-w", "root-x"].entries()) {
      const admitted = admitWorkflowTurn(
        root, "worker", DEFAULT_WORKFLOW_BUDGET_POLICY, undefined, now + index,
      );
      expect(admitted?.admitted).toBe(true);
    }
    const listed = listTrackedWorkflowRoots(2, DEFAULT_WORKFLOW_BUDGET_POLICY, now + 10);
    expect(listed.length).toBe(2);
    expect(listed[0]?.rootId).toBe("root-x");
    expect(listed[1]?.rootId).toBe("root-w");
  });
});
