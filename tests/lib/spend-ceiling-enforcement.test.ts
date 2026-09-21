/**
 * Operator-configurable token ceilings, and what happens when one fires (#4546).
 *
 * The ledger has had per-scope ceilings since it landed, and no configuration could set one:
 * every limit was undefined, so limitFor() answered undefined for every scope and the refusal
 * branch was unreachable in production. These pin the three things that had to become true for
 * that to change -- a policy an operator can write, a ledger that can be told about it after it
 * exists, and a refusal that says which ceiling fired -- plus the one that must NOT change: an
 * install that configures nothing behaves exactly as it did.
 */
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureSharedSpendLedger,
  createSpendReservationLedger,
  DEFAULT_SPEND_RESERVATION_POLICY,
  resetSharedSpendLedgerForTest,
  sharedSpendLedger,
  sharedSpendPolicy,
  spendCeilingsConfigured,
  spendPolicyFromConfig,
  SPEND_LEDGER_SALT_FILENAME,
  type SpendJournal,
  type SpendReservationLedger,
  type SpendReservationPolicy,
} from "../../src/lib/spend-reservation-ledger";
import {
  admitWorkflowTurn,
  chargeWorkflowSends,
  DEFAULT_WORKFLOW_BUDGET_POLICY,
  listWorkflowBudgetEvents,
  resetWorkflowBudgetsForTest,
  settleWorkflowSpend,
  WORKFLOW_LOCAL_REFUSAL_HEADER,
  workflowBudgetSnapshot,
  workflowDenialSummary,
  workflowSpendCeilingReached,
  type WorkflowBudgetPolicy,
} from "../../src/lib/workflow-budget";
import { workflowDecisionRefusalResponse, workflowRefusalResponse } from "../../src/server/workflow-refusal";
import { getConfigDir } from "../../src/config/paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireSpendLedgerOwner, type SpendLedgerOwnerLease } from "../../src/lib/spend-ledger-owner";

const memoryJournal = (): SpendJournal & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    read: () => [...lines],
    append: (line) => { lines.push(line); },
    rewrite: (next) => { lines.length = 0; lines.push(...next); },
  };
};

const policy = (maxTokens: number | undefined): SpendReservationPolicy => ({
  root: { maxTokens },
  identity: {},
  pool: {},
  retentionMs: 60_000,
});

/** A ledger that records which questions the caller asked it, and answers them for real. */
const watched = (inner: SpendReservationLedger, asked: string[]): SpendReservationLedger => ({
  reserve: (request) => { asked.push("reserve"); return inner.reserve(request); },
  markDispatched: (sendId) => inner.markDispatched(sendId),
  abandon: (sendId) => inner.abandon(sendId),
  settle: (sendId, usage) => inner.settle(sendId, usage),
  markLost: (sendId) => inner.markLost(sendId),
  snapshot: (scope, scopeId) => inner.snapshot(scope, scopeId),
  exhausted: (scope, scopeId) => { asked.push("exhausted"); return inner.exhausted(scope, scopeId); },
  prune: (at) => inner.prune(at),
  knows: (sendId) => inner.knows(sendId),
  reconfigure: (next) => inner.reconfigure(next),
  get policy() { return inner.policy; },
  get persistFailures() { return inner.persistFailures; },
  get corruptRecords() { return inner.corruptRecords; },
  get degraded() { return inner.degraded; },
});

let home = "";
let previousHome: string | undefined;
let owner: SpendLedgerOwnerLease | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-spend-ceiling-"));
  process.env.OPENCODEX_HOME = home;
  owner = acquireSpendLedgerOwner();
  resetSharedSpendLedgerForTest();
  resetWorkflowBudgetsForTest();
});

afterEach(() => {
  resetSharedSpendLedgerForTest();
  owner?.release();
  owner = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("a ledger can be told about a ceiling after it already exists", () => {
  test("reconfiguring changes what is refused and never what was spent", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: policy(100), now: () => 1_000 });
    expect(ledger.reserve({ sendId: "s1", scopes: { rootId: "r1" }, inputTokens: 60, outputCeilingTokens: 40 }).reserved)
      .toBe(true);
    expect(ledger.settle("s1", { inputTokens: 60, outputTokens: 40 })).toBe(true);

    const denied = ledger.reserve({ sendId: "s2", scopes: { rootId: "r1" }, inputTokens: 1, outputCeilingTokens: 0 });
    expect(denied.reserved).toBe(false);

    // Raising the ceiling admits again, and the 100 already settled is still counted against
    // the new number: a reconfiguration is not a forgiveness.
    ledger.reconfigure(policy(150));
    expect(ledger.policy.root.maxTokens).toBe(150);
    expect(ledger.snapshot("root", "r1")?.settled).toBe(100);
    expect(ledger.reserve({ sendId: "s3", scopes: { rootId: "r1" }, inputTokens: 50, outputCeilingTokens: 0 }).reserved)
      .toBe(true);
    expect(ledger.reserve({ sendId: "s4", scopes: { rootId: "r1" }, inputTokens: 1, outputCeilingTokens: 0 }).reserved)
      .toBe(false);

    // Clearing it returns the scope to observe-only: still accounted, no longer refused.
    ledger.reconfigure(policy(undefined));
    expect(ledger.exhausted("root", "r1")).toBe(false);
    expect(ledger.reserve({ sendId: "s5", scopes: { rootId: "r1" }, inputTokens: 10_000, outputCeilingTokens: 0 }).reserved)
      .toBe(true);
    expect(ledger.snapshot("root", "r1")?.settled).toBe(100);
  });
});

describe("an install that configures nothing is not newly refused", () => {
  test("no ceiling means no ledger is resolved and no journal is opened", () => {
    expect(spendCeilingsConfigured()).toBe(false);
    expect(sharedSpendPolicy()).toBe(DEFAULT_SPEND_RESERVATION_POLICY);
    // The gate answers without building anything: the ledger is on and journalling by default,
    // so an install that never opted in must not pay for a check it cannot fail.
    expect(workflowSpendCeilingReached("root-a")).toBeUndefined();
    expect(admitWorkflowTurn("root-a", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY)?.admitted).toBe(true);
    expect(existsSync(join(getConfigDir(), SPEND_LEDGER_SALT_FILENAME))).toBe(false);
  });

  test("an empty spend section is the same as no spend section", () => {
    for (const section of [undefined, {}, { root: {} }, { root: {}, identity: {}, pool: {} }]) {
      const resolved = spendPolicyFromConfig(section);
      expect(resolved.root.maxTokens).toBeUndefined();
      expect(resolved.identity.maxTokens).toBeUndefined();
      expect(resolved.pool.maxTokens).toBeUndefined();
      expect(resolved.retentionMs).toBe(DEFAULT_SPEND_RESERVATION_POLICY.retentionMs);
      expect(spendCeilingsConfigured(resolved)).toBe(false);
    }
  });

  test("a configured ceiling reaches the shared ledger, including one built before it", () => {
    // Ordinary startup configures before any request. This is the harder order: a ledger that
    // already exists has to be told, or a reload would leave the old ceiling in force.
    const ledger = sharedSpendLedger();
    expect(ledger.reserve({ sendId: "s1", scopes: { rootId: "root-x" }, inputTokens: 100, outputCeilingTokens: 0 }).reserved)
      .toBe(true);
    expect(workflowSpendCeilingReached("root-x")).toBeUndefined();

    configureSharedSpendLedger(spendPolicyFromConfig({ root: { maxTokens: 50 }, retentionDays: 2 }));
    expect(spendCeilingsConfigured()).toBe(true);
    expect(sharedSpendLedger().policy.root.maxTokens).toBe(50);
    expect(sharedSpendLedger().policy.retentionMs).toBe(2 * 24 * 60 * 60_000);
    expect(workflowSpendCeilingReached("root-x")).toEqual({ scope: "root", limit: 50 });
  });
});

describe("admission refuses a spent root before the body is parsed", () => {
  test("the denial names the scope and the ceiling, and so does the event", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: policy(100), now: () => 1_000 });
    expect(ledger.reserve({ sendId: "s1", scopes: { rootId: "r1" }, inputTokens: 60, outputCeilingTokens: 40 }).reserved)
      .toBe(true);

    // No spend request: the token count is not known at HTTP admission, and an already-spent
    // scope does not need one.
    const denied = admitWorkflowTurn("r1", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 2_000, undefined, ledger);
    expect(denied?.admitted).toBe(false);
    if (denied && !denied.admitted) {
      expect(denied.reason).toBe("workflow-spend-exhausted");
      expect(denied.spendScope).toBe("root");
      expect(denied.spendLimit).toBe(100);
    }
    const [event] = listWorkflowBudgetEvents(1);
    expect(event?.reason).toBe("workflow-spend-exhausted");
    expect(event?.spendScope).toBe("root");
    expect(event?.spendLimit).toBe(100);
  });

  test("a root with room is admitted exactly as before", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: policy(100), now: () => 1_000 });
    expect(admitWorkflowTurn("r2", "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 1_000, undefined, ledger)?.admitted).toBe(true);
  });
});

describe("counts and tokens are an intersection, in a stated order", () => {
  const smallPolicy: WorkflowBudgetPolicy = {
    maxConcurrentChildren: 2,
    maxPhysicalSends: 3,
    maxDistinctChildren: 2,
    interactiveReserve: 1,
    maxTrackedRoots: 4,
  };

  test("a count denial asks the ledger nothing, so it books no tokens", () => {
    const asked: string[] = [];
    const ledger = watched(
      createSpendReservationLedger({ journal: memoryJournal(), policy: policy(10_000), now: () => 1_000 }),
      asked,
    );
    admitWorkflowTurn("r3", "interactive", smallPolicy, undefined, 1_000, undefined, ledger);
    asked.length = 0;
    chargeWorkflowSends("r3", 3, 1_000);

    const denied = admitWorkflowTurn("r3", "interactive", smallPolicy, undefined, 1_000,
      { sendId: "s9", inputTokens: 10, outputCeilingTokens: 0 }, ledger);
    expect(denied?.admitted).toBe(false);
    if (denied && !denied.admitted) expect(denied.reason).toBe("workflow-sends-exhausted");
    // The cheap bound refused first, so the expensive one was never consulted -- and no
    // reservation is left holding tokens against a request that never happened.
    expect(asked).toEqual([]);
    expect(ledger.snapshot("root", "r3")?.reserved ?? 0).toBe(0);
  });

  test("a token denial leaves the count state untouched", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: policy(100), now: () => 1_000 });
    const admitted = admitWorkflowTurn("r4", "worker", smallPolicy, "child-1", 1_000,
      { sendId: "s1", inputTokens: 100, outputCeilingTokens: 0 }, ledger);
    expect(admitted?.admitted).toBe(true);
    // Dispatched and settled before the lease is released: an UNDISPATCHED release hands the
    // reservation back, which would leave the scope with room and test nothing.
    if (admitted?.admitted) {
      admitted.lease.markDispatched();
      expect(settleWorkflowSpend("s1", { inputTokens: 100, outputTokens: 0 }, ledger)).toBe(true);
      admitted.lease.release();
    }

    const denied = admitWorkflowTurn("r4", "worker", smallPolicy, "child-2", 1_000,
      { sendId: "s2", inputTokens: 1, outputCeilingTokens: 0 }, ledger);
    expect(denied?.admitted).toBe(false);
    if (denied && !denied.admitted) expect(denied.reason).toBe("workflow-spend-exhausted");
    const snapshot = workflowBudgetSnapshot("r4", smallPolicy, 1_000);
    expect(snapshot?.active).toBe(0);
    // The refused child was never counted as one: a token refusal must not spend a count.
    expect(snapshot?.children).toBe(1);
  });
});

describe("a token refusal is legible on the wire", () => {
  test("the sentence names the scope, the ceiling and what the send would have taken it to", () => {
    const summary = workflowDenialSummary("workflow-spend-exhausted", {
      scope: "identity",
      limit: 100_000,
      projected: 112_500,
    });
    expect(summary.code).toBe("workflow_spend_exhausted");
    expect(summary.message).toContain("account token ceiling of 100,000");
    expect(summary.message).toContain("112,500");
    expect(summary.message).toContain("spend.identity.maxTokens");
    expect(summary.message).toContain("no provider was contacted");
  });

  test("without a denial in hand the sentence is the one it always was", () => {
    expect(workflowDenialSummary("workflow-spend-exhausted").message)
      .toBe("This proxy refused the request locally: the task reached a configured token"
        + " ceiling, so no provider was contacted.");
  });

  test("the response carries the ceiling and never the scope id", async () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: policy(100), now: () => 1_000 });
    const rootId = "thread_2f9c4b1e_private";
    ledger.reserve({ sendId: "s1", scopes: { rootId }, inputTokens: 100, outputCeilingTokens: 0 });
    const denied = admitWorkflowTurn(rootId, "interactive", DEFAULT_WORKFLOW_BUDGET_POLICY,
      undefined, 2_000, undefined, ledger);
    expect(denied?.admitted).toBe(false);
    if (!denied || denied.admitted) throw new Error("unreachable");

    const response = workflowDecisionRefusalResponse(denied);
    expect(response.status).toBe(429);
    expect(response.headers.get(WORKFLOW_LOCAL_REFUSAL_HEADER)).toBe("workflow_spend_exhausted");
    const body = await response.text();
    expect(body).toContain("task token ceiling of 100");
    // Root ids are client thread headers and identity ids are credentials. The ledger writes
    // salted aliases for exactly that reason, and a refusal body is no safer a place for one.
    expect(body).not.toContain(rootId);
  });

  test("a refusal decided outside admission still names its ceiling once", () => {
    const response = workflowRefusalResponse("workflow-spend-exhausted", undefined, undefined, "root-z", {
      scope: "pool",
      limit: 250_000,
    });
    expect(response.headers.get(WORKFLOW_LOCAL_REFUSAL_HEADER)).toBe("workflow_spend_exhausted");
    const [event] = listWorkflowBudgetEvents(1);
    expect(event?.spendScope).toBe("pool");
    expect(event?.spendLimit).toBe(250_000);
    expect(listWorkflowBudgetEvents(10).filter((entry) => entry.rootId === "root-z")).toHaveLength(1);
  });
});
