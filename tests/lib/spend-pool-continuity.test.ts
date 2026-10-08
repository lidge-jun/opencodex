import { executeComboResponses } from "../../src/server/responses/core-combo";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { OcxConfig } from "../../src/types";
import { createShippedSpendLedger } from "../helpers/shipped-spend-ledger";
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
import { admitHttpWorkflowTurn, unboundPoolSpendRefusalMessage, unboundPoolSpendRefusalResponse } from "../../src/server/workflow-refusal";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { claimDispatchSpendProof, createRequestExecutionBudget, deriveRequestExecutionBudget, reportDispatchSends } from "../../src/lib/request-execution-budget";
import { resolvePoolAliases } from "../../src/lib/spend-pool-continuity";
import { admitWorkflowTurn, listWorkflowBudgetEvents, resetWorkflowBudgetsForTest, workflowDenialSummary, workflowSpendCeilingReached } from "../../src/lib/workflow-budget";
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
    for (const [a, b] of [["A", "B"], ["B", "A"]]) {
      const config = { [pool(a!)]: b!, [pool(b!)]: "target" };
      const continuity = resolvePoolAliases(config, salt);
      expect(continuity.valid).toBe(true);
      expect(continuity.resolve(pool(a!))).toBe(pool("target"));
      expect(continuity.resolve(pool(b!))).toBe(pool("target"));
      expect(resolvePoolAliases({ [pool(a!)]: b!, [pool(b!)]: a! }, salt).valid).toBe(false);
      // Resolution is read-only and cannot change another previously resolved view.
      expect(resolvePoolAliases({ [pool(a!)]: "other" }, salt).resolve(pool(a!))).toBe(pool("other"));
      expect(continuity.resolve(pool(a!))).toBe(pool("target"));
    }
  });

  test("unbound positive history is charged once against every candidate pool across pruning and restart", () => {
    const disk = journal([checkpoint([["provider-old-label", 100, 0]])]);
    for (let restart = 0; restart < 2; restart += 1) {
      const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 2 });
      expect(ledger.checkPoolContinuity()).toBeUndefined();
      expect(ledger.hasUnboundPositivePoolHistory()).toBe(true);
      ledger.prune();
      for (const id of ["provider", "provider-old-label", "unrelated-provider"]) {
        expect(reserve(ledger, `${restart}-${id}`, id)).toMatchObject({
          reserved: false,
          denial: { reason: "spend-limit-exceeded", scope: "pool", limit: 100, projected: 101, includesUnboundPoolHistory: true },
        });
      }
      expect(ledger.snapshot("pool", "provider-old-label")?.settled).toBe(100);
    }
  });

  test("tracking capacity pressure cannot evict unbound positive pool history", () => {
    const disk = journal([checkpoint([["old-label", 10, 0]])]);
    const ledger = createSpendReservationLedger({ journal: disk, salt,
      policy: policy(undefined, { maxTrackedScopes: 1 }), now: () => 2 });
    expect(reserve(ledger, "cannot-forget-history", "provider", 1)).toMatchObject({
      reserved: false, denial: { reason: "tracking-capacity-exhausted", scope: "pool" },
    });
    expect(ledger.snapshot("pool", "old-label")?.settled).toBe(10);
    expect(disk.lines.map(line => JSON.parse(line)).filter(record => record.kind === "drop")).toEqual([]);
  });

  test("dormant unbound overlay expires before under-limit proven group retention", () => {
    const disk = journal([checkpoint([["verified-label", 60, 0], ["unbound-label", 40, 0], ["empty-old-label", 0, 0]])]);
    const ledger = createSpendReservationLedger({ journal: disk, salt,
      policy: policy({ [pool("verified-label")]: "provider" }, { retentionMs: 5 }), now: () => 100 });
    expect(ledger.snapshot("pool", "provider")?.settled).toBe(100);
    ledger.prune(100);
    expect(ledger.snapshot("pool", "provider")).toBeUndefined();
    expect(disk.lines.map(line => JSON.parse(line)).filter(record => record.kind === "drop")).toEqual([
      { v: 1, kind: "drop", scope: "pool", alias: pool("unbound-label"), at: 100 },
      { v: 1, kind: "drop", scope: "pool", alias: pool("empty-old-label"), at: 100 },
      { v: 1, kind: "drop", scope: "pool", alias: pool("verified-label"), at: 100 },
    ]);
  });

  test("proven group plus each unbound balance admits under/exact totals and refuses over", () => {
    const disk = journal([checkpoint([["verified-label", 25, 0], ["unbound-label", 10, 5]])]);
    const ledger = createSpendReservationLedger({ journal: disk, salt,
      policy: policy({ [pool("verified-label")]: "provider", [pool("provider")]: "provider" }), now: () => 2 });

    // Proven group: 25. Unbound history: 10 settled + 5 unresolved. Neither bucket is copied.
    expect(ledger.snapshot("pool", "provider")).toEqual({ settled: 35, reserved: 0, unresolved: 5, exhausted: false });
    expect(reserve(ledger, "under", "provider", 59).reserved).toBe(true); // 99 total
    expect(ledger.abandon("under")).toBe(true);
    expect(reserve(ledger, "exact", "provider", 60).reserved).toBe(true); // 100 total
    expect(reserve(ledger, "over", "provider", 1)).toMatchObject({
      reserved: false,
      denial: { reason: "spend-limit-exceeded", projected: 101, includesUnboundPoolHistory: true },
    });

    // The same unbound 15 is also counted once for a different candidate provider.
    expect(reserve(ledger, "other-exact", "unrelated-provider", 85).reserved).toBe(true);
    expect(ledger.snapshot("pool", "unrelated-provider")).toEqual({ settled: 10, reserved: 85, unresolved: 5, exhausted: true });
    expect(ledger.hasUnboundPositivePoolHistory()).toBe(true);
  });

  test("configured provider history self-binds without manual aliases and survives restart", () => {
    const disk = journal([checkpoint([["provider", 40, 0]])]);
    const current = policy(undefined, { canonicalProviderIds: ["provider", "unrelated-provider"] });
    let ledger = createSpendReservationLedger({ journal: disk, salt, policy: current, now: () => 2 });
    expect(ledger.hasUnboundPositivePoolHistory()).toBe(false);
    expect(reserve(ledger, "exact", "provider", 60).reserved).toBe(true);
    expect(ledger.snapshot("pool", "provider")).toEqual({ settled: 40, reserved: 60, unresolved: 0, exhausted: true });
    expect(JSON.parse(disk.lines.at(-1)!).targets).toEqual([{ scope: "pool", alias: pool("provider") }]);
    expect(reserve(ledger, "unrelated", "unrelated-provider", 100).reserved).toBe(true);
    ledger = createSpendReservationLedger({ journal: disk, salt, policy: current, now: () => 3 });
    expect(ledger.snapshot("pool", "provider")).toMatchObject({ settled: 40, unresolved: 60 });
    expect(ledger.snapshot("pool", "unrelated-provider")).toMatchObject({ settled: 0, unresolved: 100 });
    expect(ledger.hasUnboundPositivePoolHistory()).toBe(false);
  });

  test("five configured provider ceilings stay independent while historical labels overlay each once", () => {
    const ids = ["P", "Q", "R", "S", "T"];
    for (const historical of [0, 20]) {
      const disk = journal(historical ? [checkpoint([["P-account-2", historical, 0]])] : []);
      const current = policy(undefined, { canonicalProviderIds: ids });
      let ledger = createSpendReservationLedger({ journal: disk, salt, policy: current, now: () => 2 });
      for (const id of ids) {
        expect(reserve(ledger, `fill-${id}`, id, 100 - historical).reserved).toBe(true);
        expect(ledger.settle(`fill-${id}`, { inputTokens: 100 - historical, outputTokens: 0 })).toBe(true);
        expect(reserve(ledger, `over-${id}`, id, 1)).toMatchObject({ reserved: false, denial: { projected: 101 } });
      }
      ledger = createSpendReservationLedger({ journal: disk, salt, policy: current, now: () => 3 });
      for (const id of ids) expect(ledger.snapshot("pool", id)).toMatchObject({ settled: 100 });
      expect(ledger.hasUnboundPositivePoolHistory()).toBe(historical > 0);
      expect(disk.lines.some(line => JSON.parse(line).poolContinuity !== undefined)).toBe(false);
    }
  });

  test("unbound history is overlaid when a pool ceiling is enabled later", () => {
    const disk = journal([checkpoint([["old-label", 40, 0]])]);
    const ledger = createSpendReservationLedger({ journal: disk, salt,
      policy: policy(undefined, { pool: {} }), now: () => 2 });

    expect(reserve(ledger, "observe-only", "provider", 10).reserved).toBe(true);
    expect(ledger.settle("observe-only", { inputTokens: 10, outputTokens: 0 })).toBe(true);
    expect(ledger.hasUnboundPositivePoolHistory()).toBe(true);
    ledger.reconfigure(policy());

    expect(reserve(ledger, "exact-after-enable", "provider", 50).reserved).toBe(true);
    expect(reserve(ledger, "over-after-enable", "provider", 1)).toMatchObject({
      reserved: false,
      denial: { reason: "spend-limit-exceeded", projected: 101, includesUnboundPoolHistory: true },
    });
  });

  test("competing same-process admissions include the shared unbound balance", async () => {
    const ledger = createSpendReservationLedger({
      journal: journal([checkpoint([["old-label", 40, 0]])]), salt, policy: policy(), now: () => 2,
    });
    const attempts = await Promise.all([
      Promise.resolve().then(() => reserve(ledger, "contender-a", "provider", 35)),
      Promise.resolve().then(() => reserve(ledger, "contender-b", "provider", 35)),
    ]);
    expect(attempts[0]?.reserved).toBe(true);
    expect(attempts[1]).toMatchObject({ reserved: false,
      denial: { reason: "spend-limit-exceeded", scope: "pool", projected: 110, includesUnboundPoolHistory: true } });
    expect(ledger.snapshot("pool", "provider")).toMatchObject({ settled: 40, reserved: 35 });
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
    // Read-time mappings must be supplied after restart; original counters never move.
    for (let restart = 0; restart < 3; restart += 1) {
      ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(aliases, { compactAfterRecords: 1 }), now: () => 3 });
      expect(ledger.checkPoolContinuity()).toBeUndefined();
      expect(ledger.snapshot("pool", "provider")).toEqual({ settled: 70, unresolved: 30, reserved: 0, exhausted: true });
      expect(reserve(ledger, `denied-${restart}`)).toMatchObject({ reserved: false, denial: { reason: "spend-limit-exceeded", projected: 101 } });
    }
    expect(disk.lines.join("\n")).not.toContain("label-a");
    expect(disk.lines.join("\n")).not.toContain("provider");
  });

  test("old open/dispatched sends become unresolved exactly once; replay reclaims IDs durably", () => {
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
      expect(ledger.knows("a")).toBe(false);
      expect(reserve(ledger, "a").reserved).toBe(true);
      expect(ledger.snapshot("pool", "provider")?.reserved).toBe(1);
      expect(ledger.abandon("a")).toBe(true);
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
    expect(ledger.snapshot("pool", "other")).toBeUndefined();
    expect(ledger.snapshot("root", "new-root")?.reserved).toBe(1);
    const restarted = createSpendReservationLedger({ journal: disk, salt, policy: config, now: () => 50 });
    expect(restarted.snapshot("pool", "provider")?.settled).toBe(20);
    expect(restarted.snapshot("pool", "other")).toBeUndefined();
    expect(restarted.snapshot("root", "new-root")?.unresolved).toBe(1);
  });

  test("observe-only charges already-sent requests while unbound history still constrains admission", () => {
    const disk = journal([checkpoint([["unknown-label", 40, 0]])]);
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 2 });
    const context: RequestLogContext = { model: "fixture", provider: "provider-display", spendPoolId: "provider", usageLogInputTokens: 10 };
    const tracker = createRequestSpendTracker(context, undefined, ledger);
    expect(tracker.charge({ alreadySent: true })).toBe(true);
    expect(tracker.refusals).toBe(0);
    expect(context.errorCode).toBeUndefined();
    tracker.settle({ inputTokens: 8, outputTokens: 0 });
    expect(ledger.snapshot("pool", "provider")?.settled).toBe(48); // current settled 8 plus shared unknown 40
    expect(ledger.snapshot("pool", "unknown-label")?.settled).toBe(48); // both unmapped originals overlay every candidate
    expect(reserve(ledger, "exact", "provider", 52).reserved).toBe(true);
    expect(ledger.abandon("exact")).toBe(true);
    const refused = reserve(ledger, "over", "provider", 53);
    expect(refused).toMatchObject({ reserved: false,
      denial: { reason: "spend-limit-exceeded", projected: 101, includesUnboundPoolHistory: true } });
    const rootRefusal = admitWorkflowTurn("root-with-unbound-history", "interactive", undefined, undefined, 2,
      { sendId: "root-over", poolId: "provider", inputTokens: 53, outputCeilingTokens: 0 }, ledger);
    expect(rootRefusal).toMatchObject({ admitted: false, reason: "workflow-spend-exhausted",
      spendScope: "pool", spendIncludesUnboundPoolHistory: true });
    const message = workflowDenialSummary("workflow-spend-exhausted", {
      scope: "pool", limit: 100, projected: 101, includesUnboundPoolHistory: true,
    }).message;
    expect(message).toContain("unassigned historical provider-pool balances");
    expect(message).not.toContain("unknown-label");
    expect(message).not.toContain(alias("pool", "unknown-label"));
    expect(message).not.toContain(salt);
  });

  test("reservation crossing explains unbound-history refusal without exposing its alias", async () => {
    resetWorkflowBudgetsForTest();
    const disk = journal([checkpoint([["private-old-label", 40, 0]])]);
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 2 });
    const context: RequestLogContext = {
      model: "fixture", provider: "provider", spendPoolId: "provider", usageLogInputTokens: 10,
    };
    const tracker = createRequestSpendTracker(context, "root-unbound", ledger);

    expect(tracker.charge({ alreadySent: true })).toBe(true);
    context.usageLogInputTokens = 51; // the next physical send would cross the cap after that upstream contact
    expect(tracker.charge()).toBe(false);
    const message = unboundPoolSpendRefusalMessage(context);
    expect(message).toContain("unassigned historical provider-pool balances");
    expect(message).toContain("this send was refused before contacting a provider");
    expect(message).not.toContain("private-old-label");
    expect(message).not.toContain(alias("pool", "private-old-label"));
    expect(message).not.toContain(salt);
    const response = unboundPoolSpendRefusalResponse(context);
    expect(response?.status).toBe(429);
    expect(await response!.text()).toContain(message!);
    expect(listWorkflowBudgetEvents(1)[0]).toMatchObject({
      reason: "workflow-spend-exhausted", spendIncludesUnboundPoolHistory: true,
    });
  });

  test("malformed or conflicting maps fail closed without clearing ceilings or original balances", () => {
    const disk = journal([checkpoint([["label", 40, 0]])]);
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy({ [pool("label")]: "provider" }), now: () => 2 });
    expect(ledger.checkPoolContinuity()).toBeUndefined();
    for (const aliases of [null, [], { label: "provider" }, { [pool("provider")]: "different-provider" }]) {
      ledger.reconfigure(policy(aliases, { canonicalProviderIds: ["provider"] }));
      expect(ledger.policy.pool.maxTokens).toBe(100);
      expect(ledger.checkPoolContinuity()?.reason).toBe("pool-history-unresolved");
      expect(reserve(ledger, "new").reserved).toBe(false);
      expect(ledger.snapshot("pool", "provider")?.settled).toBe(40);
    }
    ledger.reconfigure(policy());
    expect(ledger.checkPoolContinuity()).toBeUndefined();
  });

  test("reserve write failure cannot authorize a send or erase historical balances", () => {
    const disk = journal([checkpoint([["label", 40, 0]])]);
    disk.append = () => { throw new Error("synthetic write failure"); };
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy({ [pool("label")]: "provider" }), now: () => 2 });
    expect(reserve(ledger, "new")).toMatchObject({ reserved: false, denial: { reason: "reserve-not-durable" } });
    expect(ledger.snapshot("pool", "provider")?.settled).toBe(40); // the unbound view is visible without a committed link
    expect(ledger.snapshot("pool", "label")?.settled).toBe(40);
    expect(disk.lines).toHaveLength(1);
  });

  test("experimental checkpoint metadata is ignored while valid original counters survive", () => {
    const experimental = { ...checkpoint([["label", 40, 0]]), poolContinuity: { unexpected: true } };
    const disk = journal([experimental]);
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 2 });
    expect(ledger.corruptRecords).toBe(0);
    expect(ledger.checkPoolContinuity()).toBeUndefined();
    expect(ledger.snapshot("pool", "provider")?.settled).toBe(40);
    expect(parseSpendJournalRecord(JSON.stringify(experimental))).toEqual(checkpoint([["label", 40, 0]]));
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


test("unbound history waits for routing, then limits each candidate before any synthetic fetch", async () => {
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
    expect(rooted).toMatchObject({ admitted: true, lease: { rootId: "synthetic-root" } });
    if (rooted?.admitted) rooted.lease.release();
    expect(listWorkflowBudgetEvents()).toHaveLength(0);
    let syntheticFetches = 0;
    const decision = admitHttpWorkflowTurn(new Headers());
    expect(decision).toBeUndefined();
    const budget = createResponsesSendBudget({ req: new Request("https://fixture.example.test/v1/responses"), options: {}, logCtx: { model: "fixture", provider: "provider" } });
    expect(budget).toBeInstanceOf(Response);
    if (budget instanceof Response) {
      expect(budget.status).toBe(429);
      expect(budget.headers.get("x-opencodex-local-refusal")).toBe("workflow_spend_exhausted");
      const body = await budget.text();
      expect(body).toContain("unassigned historical provider-pool balances");
      expect(body).not.toContain("old-label");
    } else syntheticFetches += 1;
    expect(syntheticFetches).toBe(0);
    expect(listWorkflowBudgetEvents()).toHaveLength(0); // rootless refusals add no event
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
  const old = createShippedSpendLedger({ journal: disk, salt,
    policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, compactAfterRecords: 1 }, now: () => 3 });
  expect(old.corruptRecords).toBe(0);
  // Contract C restores the shipped per-label interpretation; aggregate allowance is not promised.
  expect(old.reserve({ sendId: "old-again", scopes: { poolId: "new-old-label" }, inputTokens: 12, outputCeilingTokens: 0 }).reserved).toBe(true);
  old.settle("old-again", { inputTokens: 12, outputTokens: 0 });
  const returned = createSpendReservationLedger({ journal: disk, salt,
    policy: policy({ [pool("old-label")]: "provider" }), now: () => 4 });
  expect(returned.checkPoolContinuity()).toBeUndefined();
  expect(returned.snapshot("pool", "new-old-label")?.settled).toBe(20); // unbound 12 plus canonical-looking 8, both still unassigned
  expect(returned.snapshot("pool", "provider")?.settled).toBe(60);
  expect(returned.snapshot("pool", "unrelated-provider")?.settled).toBe(20);
  expect(reserve(returned, "candidate-after-old-writer", "unrelated-provider", 80).reserved).toBe(true);
  expect(returned.abandon("candidate-after-old-writer")).toBe(true);
  returned.reconfigure(policy({ [pool("old-label")]: "provider", [pool("provider")]: "provider", [pool("new-old-label")]: "provider" }));
  expect(returned.checkPoolContinuity()).toBeUndefined();
  expect(returned.snapshot("pool", "provider")?.settled).toBe(60);
  const restarted = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 5 });
  expect(restarted.checkPoolContinuity()).toBeUndefined();
  expect(restarted.snapshot("pool", "provider")?.settled).toBe(60);
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
        } else {
          const report = child.transientSendReporter();
          expect(report.beforeSend?.()).toBe(true); // synthetic executor reaches its before-wire seam
          report(1); report.close?.();
        }
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
  second.ledger.reconfigure(policy(undefined, { root: {}, pool: {} }));
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
  const disk = journal([checkpoint([["historical", 30, 10], ["unbound", 10, 5]])]);
  const ledger = createSpendReservationLedger({ salt, journal: disk, policy: policy({ [pool("historical")]: "provider" }), now: () => 2 });
  const tracker = createRequestSpendTracker({ provider: "provider", usageLogInputTokens: 45 }, undefined, ledger);
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  const decision = budget.reserveDispatch({ sendClass: "initial", targetKey: "provider", countedExternally: true });
  if (!decision.allowed) throw new Error("synthetic permit refused");
  const proof = claimDispatchSpendProof(budget, decision.permit)!;
  expect(ledger.snapshot("pool", "provider")).toMatchObject({ settled: 40, unresolved: 15, reserved: 45 });
  expect(workflowSpendCeilingReached(undefined, ledger, "provider", proof)).toBeUndefined();
  ledger.reconfigure(policy({ [pool("historical")]: "renamed", [pool("provider")]: "renamed" }));
  expect(ledger.checkPoolContinuity()).toBeUndefined();
  expect(workflowSpendCeilingReached(undefined, ledger, "renamed", proof)).toBeUndefined();
  expect(reserve(ledger, "other", "unrelated", 85).reserved).toBe(true);
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
        const report = child.transientSendReporter();
        expect(report.beforeSend?.()).toBe(true);
        report(1); report.close?.();
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
  const ledger = createSpendReservationLedger({ salt,
    policy: policy({ [pool("earlier")]: "earlier", [pool("later")]: "later" }, { pool: {} }) });
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
    expect(reportB.beforeSend?.()).toBe(true);
    reportB(1);
    b.release();
    expect(budget.used).toBe(2);
    expect(claimDispatchSpendProof(budget, b)).toBeUndefined();
    expect(claimDispatchSpendProof(budget, a)).toBeDefined();
    if (finish === "report") { expect(reportA.beforeSend?.()).toBe(true); reportA(1); }
    if (finish === "assume") expect(a.assumeCharge()).toBe(true);
    a.release();
    a.release();
    expect(budget.used).toBe(finish === "release" ? 1 : 2);
    // The same reporter's next count is a real retry, never another prepaid receipt.
    expect(reportB.beforeSend?.()).toBe(true);
    reportB(1);
    expect(budget.used).toBe(finish === "release" ? 2 : 3);
    reportA.close?.(); reportB.close?.();
    tracker.settle(undefined);
    expect(ledger.snapshot("pool", "provider")).toMatchObject({
      reserved: 0, settled: 0, unresolved: finish === "release" ? 20 : 30,
    });
  }
});

test("unnamed and foreign reports cannot consume a pending receipt", () => {
  const { ledger, budget, reservePermit } = prepaidFixture(10, 100);
  ledger.reconfigure(policy(undefined, { root: {}, pool: {} })); // legacy observe-only numeric reporting
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
