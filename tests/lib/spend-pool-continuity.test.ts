import { executeComboResponses } from "../../src/server/responses/core-combo";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { OcxConfig } from "../../src/types";
import { createLegacySpendLedger } from "../helpers/legacy-spend-ledger";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createSpendReservationLedger, configureSharedSpendLedger, DEFAULT_SPEND_RESERVATION_POLICY, parseSpendJournalRecord,
  sharedSpendLedger, type SpendJournal, type SpendReservationPolicy,
} from "../../src/lib/spend-reservation-ledger";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { admitHttpWorkflowTurn, workflowDecisionRefusalResponse } from "../../src/server/workflow-refusal";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { claimDispatchSpendProof, createRequestExecutionBudget, deriveRequestExecutionBudget, reportDispatchSends } from "../../src/lib/request-execution-budget";
import { createPoolContinuity } from "../../src/lib/spend-pool-continuity";
import { listWorkflowBudgetEvents, resetWorkflowBudgetsForTest, workflowSpendCeilingReached } from "../../src/lib/workflow-budget";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import type { RequestLogContext } from "../../src/server/request-log";

const salt = "5".repeat(64);
const alias = (kind: string, id: string) => createHash("sha256").update(salt).update("\0").update(kind).update("\0").update(id).digest("hex").slice(0, 32);
const pool = (id: string) => alias("pool", id);
const policy = (poolAliases?: unknown, overrides: Partial<SpendReservationPolicy> = {}): SpendReservationPolicy => ({
  ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: 100 }, poolAliases, ...overrides,
});
const journal = (records: unknown[] = []): SpendJournal & { lines: string[] } => {
  const lines = records.map(record => JSON.stringify(record));
  return { lines, read: () => [...lines], append: line => { lines.push(line); },
    rewrite: next => { lines.splice(0, lines.length, ...next); } };
};
const checkpoint = (entries: Array<[string, number, number]>) => ({
  v: 1, kind: "checkpoint", at: 1,
  scopes: entries.map(([id, settled, unresolved]) => ({ scope: "pool", alias: pool(id), settled, unresolved, seenAt: 1 })), sends: [],
});
const reserve = (ledger: ReturnType<typeof createSpendReservationLedger>, sendId: string, poolId = "provider", tokens = 1, alreadySent = false) =>
  ledger.reserve({ sendId, scopes: { poolId }, inputTokens: tokens, outputCeilingTokens: 0, alreadySent });

describe("historical pool identity continuity", () => {
  test("verified group merges are atomic and independent of salted key order", () => {
    const low = "1".repeat(32), high = "2".repeat(32), target = "3".repeat(32);
    for (const [a, b] of [[low, high], [high, low]]) {
      const continuity = createPoolContinuity();
      expect(continuity.restore({ v: 1, kind: "pool-continuity", at: 1,
        bindings: [{ alias: a!, canonical: b! }] })).toBe(true);
      const record = continuity.prepare({ [a!]: target, [b!]: target }, undefined, new Set(), id => id, 2, 100);
      expect(record).not.toBe(false);
      if (!record) throw new Error("merge was refused");
      expect(continuity.resolve(a!)).toBe(b!); // prepare does not publish evidence
      expect(continuity.restore(record)).toBe(true);
      expect(continuity.resolve(a!)).toBe(target);
      expect(continuity.resolve(b!)).toBe(target);
      const before = continuity.record(3);
      expect(continuity.prepare({ [a!]: "4".repeat(32) }, undefined, new Set(), id => id, 3, 100)).toBe(false);
      expect(continuity.record(3)).toEqual(before);
      expect(continuity.restore({ v: 1, kind: "pool-continuity", at: 3,
        bindings: [{ alias: a!, canonical: "4".repeat(32) }] })).toBe(false);
      expect(continuity.record(3)).toEqual(before);
      expect(continuity.prepare({ [target]: a!, [a!]: target }, undefined, new Set(), id => id, 3, 100)).toBe(false);
      expect(continuity.record(3)).toEqual(before);
    }
  });

  test("unmapped historical debt fails closed across labels, providers, pruning and restart", () => {
    const disk = journal([checkpoint([["provider-old-label", 100, 0]])]);
    for (let restart = 0; restart < 2; restart += 1) {
      const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 100_000 });
      ledger.prune();
      for (const id of ["provider", "provider-old-label", "unrelated-provider"]) {
        expect(reserve(ledger, `${restart}-${id}`, id)).toMatchObject({ reserved: false, denial: { reason: "pool-history-unresolved" } });
      }
      expect(ledger.snapshot("pool", "provider-old-label")?.settled).toBe(100);
    }
  });

  test("explicit aliases aggregate each original balance once, including canonical history", () => {
    const disk = journal([checkpoint([["label-a", 40, 0], ["label-b", 0, 30], ["provider", 20, 0]])]);
    const aliases = { [pool("label-a")]: "provider", [pool("label-b")]: "provider", [pool("provider")]: "provider" };
    let ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(aliases, { compactAfterRecords: 1 }), now: () => 2 });
    expect(ledger.checkPoolContinuity()).toBeUndefined();
    expect(ledger.snapshot("pool", "provider")).toEqual({ settled: 60, unresolved: 30, reserved: 0, exhausted: false });
    expect(reserve(ledger, "new", "provider", 10).reserved).toBe(true);
    expect(ledger.settle("new", { inputTokens: 10, outputTokens: 0 })).toBe(true);
    expect(ledger.settle("new", { inputTokens: 10, outputTokens: 0 })).toBe(false);
    // Clearing config never removes durable evidence. Repeated replay/compaction never adds
    // a migrated copy of a balance or charges a canonical self-alias twice.
    for (let restart = 0; restart < 3; restart += 1) {
      ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(undefined, { compactAfterRecords: 1 }), now: () => 3 });
      expect(ledger.checkPoolContinuity()).toBeUndefined();
      expect(ledger.snapshot("pool", "provider")).toEqual({ settled: 70, unresolved: 30, reserved: 0, exhausted: true });
      expect(reserve(ledger, `denied-${restart}`)).toMatchObject({ reserved: false, denial: { reason: "spend-limit-exceeded", projected: 101 } });
    }
    expect(disk.lines.join("\n")).not.toContain("label-a");
    expect(disk.lines.join("\n")).not.toContain("provider");
  });

  test("old open/dispatched sends become unresolved exactly once; duplicate send IDs remain refused", () => {
    const old = ["a", "b"].flatMap(id => [
      { v: 1, kind: "reserve", send: alias("send", id), targets: [{ scope: "pool", alias: pool(`label-${id}`) }], tokens: 30, at: 1 },
      ...(id === "b" ? [{ v: 1, kind: "dispatch", send: alias("send", id), at: 1 }] : []),
    ]);
    const disk = journal(old);
    const aliases = { [pool("label-a")]: "provider", [pool("label-b")]: "provider" };
    for (let count = 0; count < 2; count += 1) {
      const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(aliases), now: () => 2 });
      expect(ledger.checkPoolContinuity()).toBeUndefined();
      expect(ledger.snapshot("pool", "provider")?.unresolved).toBe(60);
      expect(reserve(ledger, "a")).toMatchObject({ reserved: false, denial: { reason: "duplicate-send-id" } });
    }
  });

  test("a live original reservation settles/refunds once after explicit linking", () => {
    const ledger = createSpendReservationLedger({ salt, policy: policy(), now: () => 2 });
    expect(reserve(ledger, "pending", "label", 40).reserved).toBe(true);
    expect(reserve(ledger, "refund", "label", 10).reserved).toBe(true);
    ledger.reconfigure(policy({ [pool("label")]: "provider" }));
    expect(ledger.checkPoolContinuity()).toBeUndefined();
    expect(ledger.abandon("refund")).toBe(true);
    expect(ledger.settle("pending", { inputTokens: 30, outputTokens: 0 })).toBe(true);
    expect(ledger.snapshot("pool", "provider")).toEqual({ settled: 30, reserved: 0, unresolved: 0, exhausted: false });
  });

  test("zero/abandoned-only historical scopes do not create debt", () => {
    const ledger = createSpendReservationLedger({ journal: journal([checkpoint([["empty-old", 0, 0]])]), salt, policy: policy(), now: () => 2 });
    expect(reserve(ledger, "new").reserved).toBe(true);
  });

  test("unknown history and aggregate exhaustion survive retention and capacity pressure", () => {
    const disk = journal([checkpoint([["label-a", 60, 0], ["label-b", 40, 0]])]);
    const ledger = createSpendReservationLedger({ journal: disk, salt,
      policy: policy({ [pool("label-a")]: "provider", [pool("label-b")]: "provider" }, { retentionMs: 1, maxTrackedScopes: 2 }), now: () => 100 });
    expect(ledger.checkPoolContinuity()).toBeUndefined();
    ledger.prune();
    expect(ledger.snapshot("pool", "provider")?.settled).toBe(100);
    expect(reserve(ledger, "new").reserved).toBe(false);
    expect(ledger.snapshot("pool", "provider")?.settled).toBe(100);
  });

  test("under-limit historical components remain while their canonical group is active", () => {
    const disk = journal([checkpoint([["label", 40, 0]])]);
    let now = 2;
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy({ [pool("label")]: "provider" }, { retentionMs: 5 }), now: () => now });
    expect(reserve(ledger, "pending", "provider", 10).reserved).toBe(true);
    now = 100;
    ledger.prune();
    expect(ledger.snapshot("pool", "provider")).toMatchObject({ settled: 40, reserved: 10 });
  });

  test("retention uses the newest pool member and journals every dormant member removal", () => {
    const record = checkpoint([["older", 10, 0], ["newer", 0, 20]]);
    record.scopes[1]!.seenAt = 95;
    const disk = journal([record]);
    const aliases = { [pool("older")]: "provider", [pool("newer")]: "provider" };
    const config = policy(aliases, { retentionMs: 5 });
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: config, now: () => 100 });
    expect(ledger.checkPoolContinuity()).toBeUndefined();
    ledger.prune(100); // The newest member is exactly at the retention cutoff.
    expect(ledger.snapshot("pool", "provider")).toMatchObject({ settled: 10, unresolved: 20 });
    expect(disk.lines.map(line => JSON.parse(line)).filter(record => record.kind === "drop")).toEqual([]);
    ledger.prune(101);
    expect(ledger.snapshot("pool", "provider")).toBeUndefined();
    expect(disk.lines.map(line => JSON.parse(line)).filter(record => record.kind === "drop")).toEqual([
      { v: 1, kind: "drop", scope: "pool", alias: pool("older"), at: 101 },
      { v: 1, kind: "drop", scope: "pool", alias: pool("newer"), at: 101 },
    ]);
    const restarted = createSpendReservationLedger({ journal: disk, salt, policy: config, now: () => 101 });
    expect(restarted.snapshot("pool", "provider")).toBeUndefined();
    expect(restarted.checkPoolContinuity()).toBeUndefined();
  });

  test("capacity eviction chooses the oldest individual member and drops only one scope", () => {
    const record = checkpoint([["oldest", 10, 0], ["recent", 20, 0], ["other", 0, 0]]);
    record.scopes[1]!.seenAt = 40;
    record.scopes[2]!.seenAt = 2;
    const disk = journal([record]);
    const config = policy({ [pool("oldest")]: "provider", [pool("recent")]: "provider" },
      { retentionMs: 100, maxTrackedScopes: 3 });
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: config, now: () => 50 });
    expect(ledger.checkPoolContinuity()).toBeUndefined();
    expect(ledger.reserve({ sendId: "new-root", scopes: { rootId: "new-root" }, inputTokens: 1, outputCeilingTokens: 0 }).reserved).toBe(true);
    expect(disk.lines.map(line => JSON.parse(line)).filter(record => record.kind === "drop")).toEqual([
      { v: 1, kind: "drop", scope: "pool", alias: pool("oldest"), at: 50 },
    ]);
    expect(ledger.snapshot("pool", "provider")?.settled).toBe(20);
    expect(ledger.snapshot("pool", "other")?.settled).toBe(0);
    expect(ledger.snapshot("root", "new-root")?.reserved).toBe(1);
    const restarted = createSpendReservationLedger({ journal: disk, salt, policy: config, now: () => 50 });
    expect(restarted.snapshot("pool", "provider")?.settled).toBe(20);
    expect(restarted.snapshot("pool", "other")?.settled).toBe(0);
    expect(restarted.snapshot("root", "new-root")?.unresolved).toBe(1);
  });

  test("observe-only records already-sent requests while ambiguity still blocks new dispatches", () => {
    const disk = journal([checkpoint([["unknown-label", 40, 0]])]);
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 2 });
    const context: RequestLogContext = { model: "fixture", provider: "provider-display", spendPoolId: "provider", usageLogInputTokens: 10 };
    const tracker = createRequestSpendTracker(context, undefined, ledger);
    expect(tracker.charge()).toBe(false);
    expect(tracker.refusals).toBe(1);
    expect(context.errorCode).toBe("workflow_pool_history_unresolved");
    expect(tracker.charge({ alreadySent: true })).toBe(true);
    tracker.settle({ inputTokens: 8, outputTokens: 0 });
    expect(ledger.snapshot("pool", "provider")?.settled).toBe(8);
    expect(ledger.snapshot("pool", "unknown-label")?.settled).toBe(40);
    expect(reserve(ledger, "new").reserved).toBe(false);
  });

  test("malformed or conflicting maps fail closed without clearing ceilings or saved links", () => {
    const disk = journal([checkpoint([["label", 40, 0]])]);
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy({ [pool("label")]: "provider" }), now: () => 2 });
    expect(ledger.checkPoolContinuity()).toBeUndefined();
    for (const aliases of [null, [], { label: "provider" }, { [pool("label")]: "different-provider" }]) {
      ledger.reconfigure(policy(aliases));
      expect(ledger.policy.pool.maxTokens).toBe(100);
      expect(ledger.checkPoolContinuity()?.reason).toBe("pool-history-unresolved");
      expect(reserve(ledger, "new").reserved).toBe(false);
      expect(ledger.snapshot("pool", "provider")?.settled).toBe(40);
    }
    ledger.reconfigure(policy());
    expect(ledger.checkPoolContinuity()).toBeUndefined();
  });

  test("evidence write failure cannot publish a mapping or erase historical balances", () => {
    const disk = journal([checkpoint([["label", 40, 0]])]);
    disk.append = () => { throw new Error("synthetic write failure"); };
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy({ [pool("label")]: "provider" }), now: () => 2 });
    expect(reserve(ledger, "new")).toMatchObject({ reserved: false, denial: { reason: "reserve-not-durable" } });
    expect(ledger.snapshot("pool", "provider")).toBeUndefined();
    expect(ledger.snapshot("pool", "label")?.settled).toBe(40);
    expect(disk.lines).toHaveLength(1);
  });

  test("complete invalid metadata at the final line fails closed and survives attempted compaction", () => {
    const invalid = { ...checkpoint([["label", 40, 0]]), poolContinuity: { v: 1, kind: "pool-continuity", at: 1, bindings: [{ alias: "bad", canonical: pool("provider") }] } };
    const disk = journal([invalid]);
    let ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 2 });
    expect(ledger.corruptRecords).toBe(1);
    expect(ledger.checkPoolContinuity()?.reason).toBe("journal-corrupt");
    ledger.reconfigure(policy(undefined, { pool: {}, compactAfterRecords: 1 }));
    reserve(ledger, "observed", "provider", 1, true);
    ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 3 });
    expect(ledger.corruptRecords).toBe(1);
  });

  test("a v1 checkpoint remains parseable when compatibility metadata is omitted by an old reader", () => {
    const disk = journal();
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(undefined, { compactAfterRecords: 1 }), now: () => 2 });
    reserve(ledger, "new", "provider", 30);
    ledger.settle("new", { inputTokens: 25, outputTokens: 0 });
    expect(disk.lines.every(line => parseSpendJournalRecord(line) !== undefined)).toBe(true);
    const oldView = JSON.parse(disk.lines[0]!);
    delete oldView.poolContinuity;
    // Unmodified old readers retain raw v1 counters, but cannot prove canonical continuity.
    expect(parseSpendJournalRecord(JSON.stringify(oldView))).toBeDefined();
    const restart = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 3 });
    expect(restart.checkPoolContinuity()).toBeUndefined();
    expect(restart.snapshot("pool", "provider")?.settled).toBe(25);
  });
});


test("rootless HTTP and passthrough preflight refuse before any synthetic fetch", () => {
  const previous = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-pool-history-"));
  process.env.OPENCODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  try {
    writeFileSync(join(home, "spend-ledger.salt"), salt + "\n", { mode: 0o600 });
    writeFileSync(join(home, "spend-ledger.jsonl"), JSON.stringify(checkpoint([["old-label", 100, 0]])) + "\n", { mode: 0o600 });
    configureSharedSpendLedger(policy());
    resetWorkflowBudgetsForTest();
    const rooted = admitHttpWorkflowTurn(new Headers({ "x-codex-parent-thread-id": "synthetic-root" }));
    expect(rooted).toMatchObject({ admitted: false, reason: "workflow-pool-history-unresolved" });
    expect(listWorkflowBudgetEvents()).toMatchObject([{ rootId: "synthetic-root", reason: "workflow-pool-history-unresolved" }]);
    if (rooted && !rooted.admitted) workflowDecisionRefusalResponse(rooted);
    expect(listWorkflowBudgetEvents()).toHaveLength(1);
    let syntheticFetches = 0;
    const decision = admitHttpWorkflowTurn(new Headers());
    expect(decision).toMatchObject({ admitted: false, reason: "workflow-pool-history-unresolved" });
    if (!decision || decision.admitted) syntheticFetches += 1;
    else {
      const response = workflowDecisionRefusalResponse(decision);
      expect(response.status).toBe(429);
      expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_pool_history_unresolved");
    }
    const budget = createResponsesSendBudget({ req: new Request("https://fixture.example.test/v1/responses"), options: {}, logCtx: { model: "fixture", provider: "provider" } });
    expect(budget).toBeInstanceOf(Response);
    if (!(budget instanceof Response)) syntheticFetches += 1;
    expect(syntheticFetches).toBe(0);
    expect(listWorkflowBudgetEvents()).toHaveLength(1); // rootless refusals add no event
    configureSharedSpendLedger(policy({ [pool("old-label")]: "provider" }));
    expect(admitHttpWorkflowTurn(new Headers())).toBeUndefined();
    const mappedBudget = createResponsesSendBudget({ req: new Request("https://fixture.example.test/v1/responses"), options: {}, logCtx: { model: "fixture", provider: "provider-display", spendPoolId: "provider" } });
    expect(mappedBudget).toBeInstanceOf(Response);
    if (mappedBudget instanceof Response) {
      expect(mappedBudget.status).toBe(429);
      expect(mappedBudget.headers.get("x-opencodex-local-refusal")).toBe("workflow_spend_exhausted");
    } else syntheticFetches += 1;
    expect(syntheticFetches).toBe(0);
    const otherPool = createResponsesSendBudget({ req: new Request("https://fixture.example.test/v1/responses"), options: {}, logCtx: { model: "fixture", provider: "provider", spendPoolId: "unspent-provider" } });
    expect(otherPool).not.toBeInstanceOf(Response);
  } finally {
    resetWorkflowBudgetsForTest();
    release();
    if (previous === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(home);
  }
});

test("actual old-reader compaction preserves raw spend; compatible rollback resolves every alias exactly once", () => {
  const disk = journal([checkpoint([["old-label", 40, 0]])]);
  const modern = createSpendReservationLedger({ journal: disk, salt,
    policy: policy({ [pool("old-label")]: "provider" }, { compactAfterRecords: 1 }), now: () => 2 });
  expect(reserve(modern, "modern", "provider", 8).reserved).toBe(true);
  modern.settle("modern", { inputTokens: 8, outputTokens: 0 });
  expect(modern.snapshot("pool", "provider")?.settled).toBe(48);
  const old = createLegacySpendLedger({ journal: disk, salt,
    policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, compactAfterRecords: 1 }, now: () => 3 });
  expect(old.corruptRecords).toBe(0);
  // Unsupported old binaries can still write a newly account-qualified label and strip
  // compatibility metadata. Do not claim an automatic downgrade barrier or its enforcement.
  expect(old.reserve({ sendId: "old-again", scopes: { poolId: "new-old-label" }, inputTokens: 12, outputCeilingTokens: 0 }).reserved).toBe(true);
  old.settle("old-again", { inputTokens: 12, outputTokens: 0 });
  const returned = createSpendReservationLedger({ journal: disk, salt,
    policy: policy({ [pool("old-label")]: "provider" }), now: () => 4 });
  expect(returned.checkPoolContinuity()?.reason).toBe("pool-history-unresolved");
  expect(returned.snapshot("pool", "new-old-label")?.settled).toBe(12);
  returned.reconfigure(policy({ [pool("old-label")]: "provider", [pool("provider")]: "provider", [pool("new-old-label")]: "provider" }));
  expect(returned.checkPoolContinuity()).toBeUndefined();
  expect(returned.snapshot("pool", "provider")?.settled).toBe(60);
});

for (const kind of ["compaction", "combo"] as const) {
  for (const rootId of [undefined, "reservation-root"]) {
    test(`${kind} child spends its own exact-limit reservation (${rootId ?? "rootless"})`, () => {
      const previous = process.env.OPENCODEX_HOME;
      const home = mkdtempSync(join(tmpdir(), "ocx-prepaid-spend-"));
      process.env.OPENCODEX_HOME = home;
      const release = acquireOwnedSpendHome();
      try {
        configureSharedSpendLedger(policy(undefined, { root: { maxTokens: 100 } }));
        const logCtx = { model: "fixture", provider: "provider-display", spendPoolId: "provider", usageLogInputTokens: 100 };
        const tracker = createRequestSpendTracker(logCtx, rootId);
        const sendBudget = createRequestExecutionBudget(undefined, undefined, tracker);
        const reservation = sendBudget.reserveDispatch({ sendClass: "initial", targetKey: "provider/fixture", countedExternally: true });
        expect(reservation.allowed).toBe(true);
        if (!reservation.allowed) throw new Error("synthetic reservation refused");
        if (kind === "combo") expect(reservation.permit.use()).toBe(true);
        expect(sharedSpendLedger().snapshot("pool", "provider")?.reserved).toBe(100);
        const req = new Request("https://fixture.example.test/v1/responses", {
          headers: rootId ? { "x-codex-parent-thread-id": rootId } : {},
        });
        const options = { sendBudget, ...(kind === "compaction"
          ? { compactionRecoveryPermit: reservation.permit } : { comboDispatchPermit: reservation.permit }) };
        const child = createResponsesSendBudget({ req, options, logCtx });
        expect(child).not.toBeInstanceOf(Response);
        if (child instanceof Response) throw new Error("own reservation refused");
        expect(createResponsesSendBudget({ req, options, logCtx })).toBeInstanceOf(Response); // proof is single-use
        if (kind === "compaction") {
          const dispatch = child.adapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey: "provider/fixture" });
          expect(dispatch.allowed).toBe(true);
          if (dispatch.allowed) expect(dispatch.permit.use()).toBe(true);
        } else child.noteTransientSends(1); // synthetic report-only combo dispatch, no fetch
        expect(sendBudget.used).toBe(1);
        tracker.settle({ inputTokens: 100, outputTokens: 0 });
        expect(sharedSpendLedger().snapshot("pool", "provider")).toMatchObject({ settled: 100, reserved: 0 });
        expect(createResponsesSendBudget({ req, options: {}, logCtx })).toBeInstanceOf(Response);
      } finally {
        release();
        if (previous === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = previous;
        removeTreeWithRetry(home);
      }
    });
  }
}

function prepaidFixture(tokens = 100, ceiling = 100) {
  const ledger = createSpendReservationLedger({ salt, policy: policy(undefined, { root: { maxTokens: ceiling }, pool: { maxTokens: ceiling } }) });
  const tracker = createRequestSpendTracker({ provider: "provider", usageLogInputTokens: tokens }, "root", ledger);
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  const reservePermit = () => {
    const decision = budget.reserveDispatch({ sendClass: "initial", targetKey: "provider/fixture", countedExternally: true });
    if (!decision.allowed) throw new Error("synthetic permit refused");
    return decision.permit;
  };
  return { ledger, tracker, budget, reservePermit };
}

for (const end of ["release", "report", "assume"] as const) {
  test(`a prepaid validated rebase preserves proof ownership and exact charges on ${end}`, () => {
    for (const [priorSends, claimBeforeEnd] of [[2, false], [2, true], [3, false], [3, true]] as const) {
      const { ledger, budget } = prepaidFixture(10, (priorSends + 1) * 10);
      for (const [sendClass, targetKey] of [["initial", "a"], ["account-failover", "b"]] as const) {
        const decision = budget.reserveDispatch({ sendClass, targetKey });
        if (!decision.allowed) throw new Error("synthetic initial dispatch refused");
        expect(decision.permit.use()).toBe(true);
      }
      if (priorSends === 3) {
        const third = budget.reserveDispatch({ sendClass: "transient", targetKey: "b" });
        if (!third.allowed) throw new Error("synthetic base dispatch refused");
        expect(third.permit.use()).toBe(true);
      }
      const decision = budget.reserveDispatch({
        sendClass: "repair", targetKey: "c", rebasedTarget: true, countedExternally: true,
      });
      if (!decision.allowed) throw new Error("synthetic rebase refused");
      const { permit } = decision;
      expect(budget.used).toBe(priorSends + 1);
      expect(budget.reserveSpent).toBe(priorSends === 3);
      expect(budget.lastTargetKey).toBe("c");
      expect(budget.alternateTargetSends).toBe(1);
      expect(budget.targetTransitions).toBe(1);
      expect(workflowSpendCeilingReached(undefined, ledger, "provider")).toMatchObject({ scope: "pool" });
      expect(claimDispatchSpendProof(createRequestExecutionBudget(), permit)).toBeUndefined();
      if (claimBeforeEnd) {
        const child = deriveRequestExecutionBudget(budget, budget.policy);
        const proof = claimDispatchSpendProof(child, permit);
        expect(proof?.ledger).toBe(ledger);
        expect(workflowSpendCeilingReached(undefined, ledger, "provider", proof)).toBeUndefined();
        expect(claimDispatchSpendProof(budget, permit)).toBeUndefined();
      }
      if (end === "report") reportDispatchSends(budget, 1, permit);
      if (end === "assume") expect(permit.assumeCharge()).toBe(true);
      permit.release();
      permit.release();
      const expectedSends = priorSends + (end === "release" ? 0 : 1);
      expect(budget.used).toBe(expectedSends);
      expect(budget.reserveSpent).toBe(priorSends === 3 && end !== "release");
      expect(budget.lastTargetKey).toBe(end === "release" ? "b" : "c");
      expect(budget.alternateTargetSends).toBe(1);
      expect(budget.targetTransitions).toBe(1);
      expect(ledger.snapshot("pool", "provider")).toMatchObject({ reserved: expectedSends * 10 });
      expect(claimDispatchSpendProof(budget, permit)).toBeUndefined();
    }
  });
}

test("prepaid proof belongs to one shared budget and one still-pending dispatch", () => {
  for (const end of ["release", "report", "assume"] as const) {
    const { budget, reservePermit } = prepaidFixture();
    const permit = reservePermit();
    if (end === "release") permit.release();
    if (end === "report") reportDispatchSends(budget, 1, permit);
    if (end === "assume") expect(permit.assumeCharge()).toBe(true);
    expect(claimDispatchSpendProof(budget, permit)).toBeUndefined();
  }
  const { ledger, budget, reservePermit } = prepaidFixture();
  const permit = reservePermit();
  expect(permit.use()).toBe(true); // combo use leaves its external receipt pending
  expect(claimDispatchSpendProof(createRequestExecutionBudget(), permit)).toBeUndefined();
  const childBudget = deriveRequestExecutionBudget(budget, budget.policy);
  const proof = claimDispatchSpendProof(childBudget, permit);
  expect(proof).toBeDefined();
  expect(workflowSpendCeilingReached("root", ledger, "provider", proof)).toBeUndefined();
  expect(claimDispatchSpendProof(budget, permit)).toBeUndefined();
  expect(workflowSpendCeilingReached("root", ledger, "provider")).toMatchObject({ scope: "root" });
});

test("receipt identity survives out-of-order handoff and reports cannot authorize another permit", () => {
  const first = prepaidFixture(10, 100);
  const a = first.reservePermit(), b = first.reservePermit();
  expect(b.assumeCharge()).toBe(true);
  expect(claimDispatchSpendProof(first.budget, b)).toBeUndefined();
  expect(claimDispatchSpendProof(first.budget, a)).toBeDefined();
  reportDispatchSends(first.budget, 1, a);
  expect(first.budget.used).toBe(2); // report consumed A; B was already assumed

  const second = prepaidFixture(10, 100);
  const reported = second.reservePermit(), pending = second.reservePermit();
  reportDispatchSends(second.budget, 1, reported);
  expect(claimDispatchSpendProof(second.budget, reported)).toBeUndefined();
  reported.release();
  expect(second.budget.used).toBe(2); // cannot refund a different pending receipt
  expect(claimDispatchSpendProof(second.budget, pending)).toBeDefined();
  pending.release();
  expect(second.budget.used).toBe(1);
  expect(second.ledger.snapshot("pool", "provider")).toMatchObject({ reserved: 10 });
});

test("preflight retains unrelated reservations, debt and mismatched scope or ledger", () => {
  const { ledger, budget, reservePermit } = prepaidFixture(100, 200);
  const permit = reservePermit();
  expect(reserve(ledger, "unrelated", "provider", 100).reserved).toBe(true);
  ledger.reconfigure(policy(undefined, { root: { maxTokens: 200 } }));
  const proof = claimDispatchSpendProof(budget, permit)!;
  expect(workflowSpendCeilingReached(undefined, ledger, "provider", proof)).toMatchObject({ scope: "pool" });
  const foreign = prepaidFixture();
  foreign.reservePermit();
  expect(workflowSpendCeilingReached(undefined, foreign.ledger, "provider", proof)).toMatchObject({ scope: "pool" });
  expect(ledger.markDispatched(proof.sendId)).toBe(true);
  expect(ledger.exhausted("pool", "provider", proof.sendId)).toBe(true);
  ledger.settle(proof.sendId, { inputTokens: 100, outputTokens: 0 });
  expect(ledger.exhausted("pool", "provider", proof.sendId)).toBe(true);

  const zero = prepaidFixture(0, 100);
  expect(reserve(zero.ledger, "full", "provider", 100).reserved).toBe(true);
  const zeroProof = claimDispatchSpendProof(zero.budget, zero.reservePermit());
  expect(workflowSpendCeilingReached(undefined, zero.ledger, "provider", zeroProof)).toMatchObject({ scope: "pool" });
});

test("prepaid exclusion follows only its canonical pool and retains settled/unresolved history", () => {
  const disk = journal([checkpoint([["historical", 30, 10]])]);
  const ledger = createSpendReservationLedger({ salt, journal: disk, policy: policy({ [pool("historical")]: "provider" }), now: () => 2 });
  const tracker = createRequestSpendTracker({ provider: "provider", usageLogInputTokens: 60 }, undefined, ledger);
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  const decision = budget.reserveDispatch({ sendClass: "initial", targetKey: "provider", countedExternally: true });
  if (!decision.allowed) throw new Error("synthetic permit refused");
  const proof = claimDispatchSpendProof(budget, decision.permit)!;
  expect(ledger.snapshot("pool", "provider")).toMatchObject({ settled: 30, unresolved: 10, reserved: 60 });
  expect(workflowSpendCeilingReached(undefined, ledger, "provider", proof)).toBeUndefined();
  ledger.reconfigure(policy({ [pool("historical")]: "renamed", [pool("provider")]: "renamed" }));
  expect(ledger.checkPoolContinuity()).toBeUndefined();
  expect(workflowSpendCeilingReached(undefined, ledger, "renamed", proof)).toBeUndefined();
  expect(reserve(ledger, "other", "unrelated", 100).reserved).toBe(true);
  expect(workflowSpendCeilingReached(undefined, ledger, "unrelated", proof)).toMatchObject({ scope: "pool" });
  ledger.reconfigure(policy(undefined, { pool: { maxTokens: 40 } }));
  expect(workflowSpendCeilingReached(undefined, ledger, "renamed", proof)).toMatchObject({ scope: "pool" });
});


test("actual combo dispatch forwards only its own prepaid permit into the child preflight", async () => {
  const previous = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-combo-prepaid-"));
  process.env.OPENCODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("unexpected network in synthetic combo"); }) as typeof fetch;
  const translatorBudget = createTranslatorBudget();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  try {
    configureSharedSpendLedger(policy());
    const config: OcxConfig = { port: 0, defaultProvider: "provider", providers: {
      provider: { adapter: "openai-chat", apiKey: "fixture-only", baseUrl: "https://provider.example.test/v1" },
    }, combos: { prepaid: { strategy: "failover", targets: [{ provider: "provider", model: "fixture" }] } } };
    const logCtx = { model: "", provider: "", usageLogInputTokens: 100 };
    const tracker = createRequestSpendTracker(logCtx, undefined);
    const sendBudget = createRequestExecutionBudget(undefined, undefined, tracker);
    const body = { model: "combo/prepaid", input: [] };
    let sends = 0;
    const response = await executeComboResponses(new Request("https://fixture.example.test/v1/responses", {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
    }), body, "prepaid", config, logCtx, { sendBudget, translatorBudget }, {
      handleResponses: async (req, _config, childLog, options) => {
        const child = createResponsesSendBudget({ req, logCtx: childLog, options: options! });
        expect(child).not.toBeInstanceOf(Response);
        if (child instanceof Response) return child;
        sends += 1;
        child.noteTransientSends(1);
        return Response.json({ id: "synthetic-response", output: [] });
      },
      handleComboResponses: async () => { throw new Error("unexpected nested combo"); },
    });
    expect(response.status).toBe(200);
    expect(sends).toBe(1);
    expect(sendBudget.used).toBe(1);
    tracker.settle({ inputTokens: 100, outputTokens: 0 });
    expect(sharedSpendLedger().snapshot("pool", "provider")).toMatchObject({ settled: 100, reserved: 0 });
  } finally {
    globalThis.fetch = originalFetch;
    translatorBudget.dispose();
    clearComboSelectionState();
    clearComboTargetCooldowns();
    release();
    if (previous === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(home);
  }
});

test("a later child report preserves the earlier receipt and refunds its exact pool", () => {
  const ledger = createSpendReservationLedger({ salt });
  const logCtx = { provider: "earlier", usageLogInputTokens: 10 };
  const tracker = createRequestSpendTracker(logCtx, "root", ledger);
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  const first = budget.reserveDispatch({ sendClass: "initial", targetKey: "same", countedExternally: true });
  logCtx.provider = "later";
  logCtx.usageLogInputTokens = 30;
  const second = budget.reserveDispatch({ sendClass: "initial", targetKey: "same", countedExternally: true });
  if (!first.allowed || !second.allowed) throw new Error("synthetic reservation refused");
  const child = createResponsesSendBudget({
    req: new Request("http://localhost/v1/responses"), logCtx: {},
    options: { sendBudget: deriveRequestExecutionBudget(budget, budget.policy), comboDispatchPermit: second.permit },
  });
  if (child instanceof Response) throw new Error("synthetic child refused");
  child.noteTransientSends(1);
  expect(claimDispatchSpendProof(budget, first.permit)).toBeDefined();
  expect(claimDispatchSpendProof(budget, second.permit)).toBeUndefined();
  second.permit.release();
  expect(budget.used).toBe(2);
  first.permit.release();
  expect(budget.used).toBe(1);
  expect(ledger.snapshot("pool", "earlier")).toMatchObject({ reserved: 0, unresolved: 0 });
  expect(ledger.snapshot("pool", "later")).toMatchObject({ reserved: 30, unresolved: 0 });
  tracker.settle({ inputTokens: 25, outputTokens: 0 });
  expect(ledger.snapshot("pool", "later")).toMatchObject({ settled: 25, reserved: 0, unresolved: 0 });
});

test("captured reporters retain receipt ownership across handoffs, cancellation and retries", () => {
  for (const finish of ["release", "report", "assume"] as const) {
    const { ledger, tracker, budget, reservePermit } = prepaidFixture(10, 100);
    const a = reservePermit();
    const owner = createResponsesSendBudget({
      req: new Request("http://localhost/v1/responses"), logCtx: {}, options: { sendBudget: budget },
    });
    if (owner instanceof Response) throw new Error("synthetic owner refused");
    owner.pendingHopPermit = a;
    const reportA = owner.transientSendReporter();
    const b = reservePermit();
    owner.pendingHopPermit = b;
    const reportB = owner.transientSendReporter();
    reportB(0); // A cancelled/no-send helper cannot settle a receipt.
    reportB(1);
    b.release();
    expect(budget.used).toBe(2);
    expect(claimDispatchSpendProof(budget, b)).toBeUndefined();
    expect(claimDispatchSpendProof(budget, a)).toBeDefined();
    if (finish === "report") reportA(1);
    if (finish === "assume") expect(a.assumeCharge()).toBe(true);
    a.release();
    a.release();
    expect(budget.used).toBe(finish === "release" ? 1 : 2);
    // The same reporter's next count is a real retry, never another prepaid receipt.
    reportB(1);
    expect(budget.used).toBe(finish === "release" ? 2 : 3);
    tracker.settle(undefined);
    expect(ledger.snapshot("pool", "provider")).toMatchObject({
      reserved: 0, settled: 0, unresolved: finish === "release" ? 20 : 30,
    });
  }
});

test("unnamed and foreign reports cannot consume a pending receipt", () => {
  const { ledger, budget, reservePermit } = prepaidFixture(10, 100);
  const a = reservePermit(), b = reservePermit();
  const foreign = prepaidFixture(10, 100).reservePermit();
  budget.used += 1;
  reportDispatchSends(deriveRequestExecutionBudget(budget, budget.policy), 1, foreign);
  expect(budget.used).toBe(4);
  expect(claimDispatchSpendProof(budget, a)).toBeDefined();
  expect(claimDispatchSpendProof(budget, b)).toBeDefined();
  a.release();
  b.release();
  expect(budget.used).toBe(2);
  expect(ledger.snapshot("pool", "provider")).toMatchObject({ reserved: 20, unresolved: 0 });
  reportDispatchSends(budget, 1, a); // A late physical report is counted; no proof is revived.
  expect(budget.used).toBe(3);
  expect(claimDispatchSpendProof(budget, a)).toBeUndefined();
});

test("releasing an older receipt preserves the later target and its recovery charges", () => {
  const budget = createRequestExecutionBudget();
  const a = budget.reserveDispatch({ sendClass: "initial", targetKey: "a", countedExternally: true });
  const b = budget.reserveDispatch({ sendClass: "account-failover", targetKey: "b", countedExternally: true });
  if (!a.allowed || !b.allowed) throw new Error("synthetic reservation refused");
  reportDispatchSends(budget, 1, b.permit);
  a.permit.release();
  expect(budget.used).toBe(1);
  expect(budget.lastTargetKey).toBe("b");
  expect(budget.alternateTargetSends).toBe(1);
  expect(budget.targetTransitions).toBe(1);
  b.permit.release();
  expect(budget.used).toBe(1);
});
