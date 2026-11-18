import { hashSpendAlias } from "../../src/lib/spend-pool-alias-validation";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpendReservationLedger,
  DEFAULT_SPEND_RESERVATION_POLICY,
  type SpendJournal,
} from "../../src/lib/spend-reservation-ledger";
import { createRequestExecutionBudget, reportDispatchSends, createPhysicalSendReporter } from "../../src/lib/request-execution-budget";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { estimateTokens } from "../../src/lib/token-estimate";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { SpendLedgerOwnerError, type SpendLedgerOwnerErrorCode } from "../../src/lib/spend-ledger-owner";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { parseRequest } from "../../src/responses/parser";
import { routeModel } from "../../src/router";
import { applyFinalRouteRequestNormalization } from "../../src/server/responses/core-normalize";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";

/**
 * The durable spend ledger had no production caller (#4707).
 *
 * Every verb existed -- reserve, markDispatched, settle, abandon, markLost -- and nothing in
 * the request path reached any of them, so `spend-ledger.jsonl` was never written by ordinary
 * traffic and the ceilings the feature advertised stayed process-local and count-only.
 *
 * These pin the three properties the wiring has to have: one entry per physical send, a
 * settlement that tells the send that reported usage apart from the ones that did not, and a
 * restart that neither resets a ceiling nor hands back tokens that may already have been
 * billed.
 */
const memoryJournal = (): SpendJournal & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    read: () => [...lines],
    append: (line: string) => { lines.push(line); },
    rewrite: (next: string[]) => { lines.splice(0, lines.length, ...next); },
  };
};

/** A journal that cannot persist: the disk-full and permission case durability exists for. */
const unwritableJournal = (): SpendJournal => ({
  read: () => [],
  append: () => { throw new Error("ENOSPC: no space left on device"); },
});

const logContext = (overrides: Record<string, unknown> = {}) => ({
  provider: "test-pool",
  accountLogLabel: "k0123456789abcdef0123456789abcdef",
  usageLogInputTokens: 100,
  spendOutputCeilingTokens: 400,
  ...overrides,
}) as Parameters<typeof createRequestSpendTracker>[0];

describe("auxiliary helper spend ownership", () => {
  const target = (key: string) => ({ poolId: "anthropic", identityId: "", targetKey: key,
    estimate: { inputTokens: 2, outputCeilingTokens: 8 } });
  function fixture(enforced: boolean, initialPermit = false, oneSend = false) {
    const journal = memoryJournal();
    const ledger = createSpendReservationLedger({ journal, policy: {
      ...DEFAULT_SPEND_RESERVATION_POLICY, pool: enforced ? { maxTokens: 10_000 } : {},
      canonicalProviderIds: ["parent-pool", "anthropic"],
    } });
    const log = logContext({ accountLogLabel: "parent-account", spendPoolId: "parent-pool" });
    const tracker = createRequestSpendTracker(log, `root-helper-${crypto.randomUUID()}`, ledger);
    let claims = 0;
    const claim = tracker.beforePhysicalSend!.bind(tracker);
    tracker.beforePhysicalSend = () => { claims++; return claim(); };
    const budget = createRequestExecutionBudget(oneSend ? {
      maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0,
    } : undefined, "helper-test", tracker);
    const booking = initialPermit ? budget.reserveDispatch({ sendClass: "initial", targetKey: "parent/a", countedExternally: true }) : undefined;
    if (booking && !booking.allowed) throw new Error("parent booking refused");
    const translatorBudget = createTranslatorBudget();
    const prior = process.env.OPENCODEX_HOME;
    const home = enforced && initialPermit ? mkdtempSync(join(tmpdir(), "auxiliary-parent-booking-")) : undefined;
    let release: (() => void) | undefined;
    if (home) { process.env.OPENCODEX_HOME = home; release = acquireOwnedSpendHome(); }
    const close = () => {
      translatorBudget.dispose(); release?.();
      if (home) {
        if (prior === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = prior;
        removeTreeWithRetry(home);
      }
    };
    let owner: ReturnType<typeof createResponsesSendBudget>;
    try {
      owner = createResponsesSendBudget({ req: new Request("http://localhost/v1/responses"), logCtx: log,
        options: { translatorBudget, sendBudget: budget, ...(booking?.allowed ? { comboInitialSend: { permit: booking.permit } } : {}) } });
    } catch (error) { close(); throw error; }
    if (owner instanceof Response) { close(); throw new Error("owner refused"); }
    return { journal, ledger, tracker, budget, owner, claims: () => claims, close };
  }

  for (const enforced of [false, true]) {
    test(`concurrent helpers cannot share the last slot (enforced=${enforced})`, async () => {
      const f = fixture(enforced, false, true);
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      let calls = 0;
      const first = f.owner.dispatchSidecarSend(target("search:q1"), async () => { calls++; await pending; });
      try {
        expect(f.budget.used).toBe(1);
        await expect(f.owner.dispatchSidecarSend(target("search:q2"), async () => { calls++; })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
        expect(calls).toBe(1);
        expect(f.claims()).toBe(1);
      } finally {
        release(); await first;
        f.tracker.settle(undefined); f.close();
      }
    });

    test(`helper scopes and terminal ownership are isolated (enforced=${enforced})`, async () => {
      const f = fixture(enforced);
      try {
        const parent = f.budget.reserveDispatch({ sendClass: "initial", targetKey: "parent/a" });
        if (!parent.allowed) throw new Error("parent refused");
        expect(parent.permit.use()).toBe(true);
        await f.owner.dispatchSidecarSend(target("search:q1"), async () => "ok");
        expect(f.budget.used).toBe(2);
        expect(f.claims()).toBe(2);
        expect(f.owner.targetSendsUsed).toBe(0);
        expect(f.ledger.snapshot("pool", "anthropic")?.reserved).toBe(10);
        expect(f.ledger.snapshot("identity", "parent-account")?.reserved).toBe(500);
        const rows = f.journal.lines.map(line => JSON.parse(line));
        const parentId = rows.find(row => row.kind === "reserve")!.send;
        const helperId = rows.filter(row => row.kind === "reserve").at(-1)!.send;
        f.tracker.settle({ inputTokens: 7, outputTokens: 3 });
        const settled = f.journal.lines.map(line => JSON.parse(line)).filter(row => row.kind === "settle");
        expect(settled.map(row => row.send)).toContain(parentId);
        expect(settled.map(row => row.send)).not.toContain(helperId);
      } finally { f.close(); }
    });

    test(`a helper cannot consume or retire an unused parent booking (enforced=${enforced})`, async () => {
      const f = fixture(enforced, true);
      try {
        const parentId = JSON.parse(f.journal.lines.find(line => JSON.parse(line).kind === "reserve")!).send;
        await f.owner.dispatchSidecarSend(target("search:q1"), async () => "ok");
        expect(f.budget.used).toBe(2);
        expect(f.owner.targetSendsUsed).toBe(0);
        expect(f.journal.lines.map(line => JSON.parse(line)).filter(row => row.kind === "abandon").map(row => row.send)).not.toContain(parentId);
        f.owner.noteInitialDispatch();
        expect(f.owner.targetSendsUsed).toBe(1);
        expect(f.budget.used).toBe(2);
        expect(f.claims()).toBe(2);
        f.tracker.settle(undefined);
      } finally { f.close(); }
    });
  }

  test("reset attempts share their seed while a new query reserves its own", async () => {
    const f = fixture(true);
    try {
      const reservations = () => f.journal.lines.map(line => JSON.parse(line)).filter(row => row.kind === "reserve").length;
      await f.owner.dispatchSidecarSend(target("search:q1"), async () => { expect(reservations()).toBe(1); });
      await f.owner.dispatchSidecarSend(target("search:q1"), async () => { expect(reservations()).toBe(1); });
      expect(reservations()).toBe(2);
      await f.owner.dispatchSidecarSend(target("search:q2"), async () => { expect(reservations()).toBe(3); });
      expect(f.budget.used).toBe(3);
      expect(f.claims()).toBe(3);
      expect(f.ledger.snapshot("pool", "anthropic")?.reserved).toBe(30);
      expect(f.ledger.snapshot("identity", "parent-account")).toBeUndefined();
      expect(f.ledger.snapshot("pool", "parent-pool")).toBeUndefined();
      f.tracker.settle(undefined);
    } finally { f.close(); }
  });
});

describe("the request path books every physical send on the durable ledger", () => {
  test("one entry per charged send, and the terminal send settles with the real usage", () => {
    const journal = memoryJournal();
    const ledger = createSpendReservationLedger({ journal });
    const tracker = createRequestSpendTracker(logContext(), "root-a", ledger);
    const budget = createRequestExecutionBudget(undefined, "lr-test", tracker);

    // A physical send is charged once by the request budget, so it is booked once here.
    const first = budget.reserveDispatch({ sendClass: "initial", targetKey: "p|m" });
    expect(first.allowed).toBe(true);
    expect(ledger.snapshot("root", "root-a")?.reserved).toBe(500);

    // A retry helper reporting its own send is the same shape: one report, one entry.
    budget.used += 1;
    expect(ledger.snapshot("root", "root-a")?.reserved).toBe(1000);

    // The terminal usage belongs to the send that produced it; the earlier one failed without
    // reporting any and may still have been billed, so it is unresolved rather than free.
    tracker.settle({ inputTokens: 120, outputTokens: 30 });
    const root = ledger.snapshot("root", "root-a");
    expect(root?.reserved).toBe(0);
    expect(root?.settled).toBe(150);
    expect(root?.unresolved).toBe(500);
  });

  test("a request that reports no usage leaves every send unresolved, not free", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal() });
    const tracker = createRequestSpendTracker(logContext(), "root-b", ledger);
    const budget = createRequestExecutionBudget(undefined, "lr-cancel", tracker);
    budget.reserveDispatch({ sendClass: "initial", targetKey: "p|m" });
    budget.used += 1;

    tracker.settle(undefined);
    const root = ledger.snapshot("root", "root-b");
    expect(root?.reserved).toBe(0);
    expect(root?.settled).toBe(0);
    expect(root?.unresolved).toBe(1000);
  });

  test("a canonical pool identity is independent of an account-specific display label", () => {
    const journal = memoryJournal();
    const ledger = createSpendReservationLedger({ journal, salt: "wiring-fixture" });
    const tracker = createRequestSpendTracker(logContext({
      provider: "anthropic-p123abc",
      spendPoolId: "anthropic",
    }), undefined, ledger);

    expect(tracker.charge()).toBe(true);
    expect(ledger.snapshot("pool", "anthropic")?.reserved).toBe(500);
    const record = journal.lines.map(line => JSON.parse(line)).find(record => record.kind === "reserve");
    expect(record.targets.find((target: { scope: string }) => target.scope === "pool").alias).toBe(hashSpendAlias("wiring-fixture", "pool", "anthropic"));
  });

  test("resolved Responses routes share a pool ceiling across account display labels", async () => {
    const config: OcxConfig = { port: 0, defaultProvider: "pool", providers: {
      pool: { adapter: "openai-chat", authMode: "oauth", baseUrl: "https://pool.example.test/v1" },
    } };
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: {
      ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: 500 },
    } });
    for (const [account, allowed] of [["account-a", true], ["account-b", false]] as const) {
      const logCtx: RequestLogContext = { model: "", provider: "", usageLogInputTokens: 100,
        spendOutputCeilingTokens: 300, accountLogLabel: account };
      const parsed = parseRequest({ model: "pool/model", input: [] });
      await applyFinalRouteRequestNormalization({ parsed, route: routeModel(config, parsed.modelId),
        config, req: new Request("http://localhost/v1/responses"), logCtx, inboundWire: "responses" });
      // Credential resolution gives each request its own account-qualified log label.
      logCtx.provider = `pool-${account}`;
      const tracker = createRequestSpendTracker(logCtx, `root-${account}`, ledger);
      const budget = createRequestExecutionBudget(undefined, undefined, tracker);
      const reporter = createPhysicalSendReporter(budget, () => ({ poolId: logCtx.spendPoolId, identityId: logCtx.accountLogLabel }));
      expect(reporter.beforeSend?.()).toBe(allowed);
      if (allowed) reporter(1);
      reporter.close?.();
      if (allowed) tracker.settle({ inputTokens: 100, outputTokens: 300 });
      expect(ledger.snapshot("pool", logCtx.provider)?.reserved ?? 0).toBe(0);
    }
    expect(ledger.snapshot("pool", "pool")?.settled).toBe(400);
    expect(ledger.snapshot("identity", "account-a")?.settled).toBe(400);
    expect(ledger.snapshot("identity", "account-b")).toBeUndefined();
    expect(ledger.snapshot("root", "root-account-a")?.settled).toBe(400);
    expect(ledger.snapshot("root", "root-account-b")).toBeUndefined();
  });

  test("a fallback updates the pool for new sends without moving earlier spend", async () => {
    const config: OcxConfig = { port: 0, defaultProvider: "first", providers: {
      first: { adapter: "openai-chat", baseUrl: "https://first.example.test/v1" },
      second: { adapter: "openai-chat", baseUrl: "https://second.example.test/v1" },
    } };
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: {
      ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: 500 },
      poolAliases: { [hashSpendAlias("wiring-fixture", "pool", "first")]: "first", [hashSpendAlias("wiring-fixture", "pool", "second")]: "second" },
    }, salt: "wiring-fixture" });
    const logCtx: RequestLogContext = { model: "", provider: "", spendPoolId: "stale-route",
      usageLogInputTokens: 100, spendOutputCeilingTokens: 300 };
    const tracker = createRequestSpendTracker(logCtx, "fallback-root", ledger);
    const budget = createRequestExecutionBudget(undefined, undefined, tracker);
    for (const provider of ["first", "second"]) {
      const parsed = parseRequest({ model: `${provider}/model`, input: [] });
      await applyFinalRouteRequestNormalization({ parsed, route: routeModel(config, parsed.modelId),
        config, req: new Request("http://localhost/v1/responses"), logCtx, inboundWire: "responses" });
      logCtx.provider = `${provider}-account`;
      const reporter = createPhysicalSendReporter(budget, () => ({ poolId: logCtx.spendPoolId }));
      expect(reporter.beforeSend?.()).toBe(true); reporter(1); reporter.close?.();
      expect(ledger.snapshot("pool", provider)?.reserved).toBe(400);
    }
    tracker.settle({ inputTokens: 100, outputTokens: 300 });
    expect(ledger.snapshot("pool", "first")?.unresolved).toBe(400);
    expect(ledger.snapshot("pool", "second")?.settled).toBe(400);
    expect(ledger.snapshot("pool", "stale-route")).toBeUndefined();
    expect(ledger.snapshot("root", "fallback-root")?.unresolved).toBe(400);
    expect(ledger.snapshot("root", "fallback-root")?.settled).toBe(400);
  });

  test.each(["first", "second"])("combo reservations charge the resolved %s provider pool", async next => {
    const config: OcxConfig = { port: 0, defaultProvider: "first", providers: {
      first: { adapter: "openai-chat", apiKey: "fixture-first", baseUrl: "https://first.example.test/v1" },
      second: { adapter: "openai-chat", apiKey: "fixture-second", baseUrl: "https://second.example.test/v1" },
    }, combos: { spend: { strategy: "failover", targets: [
      { provider: "first", model: "model-a" }, { provider: next, model: "model-b" },
    ] } } };
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: {
      ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: 500 },
      poolAliases: { [hashSpendAlias("wiring-fixture", "pool", "first")]: "first", [hashSpendAlias("wiring-fixture", "pool", "second")]: "second" },
    }, salt: "wiring-fixture" });
    const logCtx: RequestLogContext = { model: "", provider: "", spendPoolId: "stale-route",
      usageLogInputTokens: 100, spendOutputCeilingTokens: 300 };
    const tracker = createRequestSpendTracker(logCtx, "combo-root", ledger);
    const sendBudget = createRequestExecutionBudget(undefined, "combo-spend", tracker);
    const translatorBudget = createTranslatorBudget();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("unexpected external fetch"); }) as typeof fetch;
    clearComboSelectionState();
    clearComboTargetCooldowns();
    let children = 0;
    try {
      const body = { model: "combo/spend", input: [] };
      const response = await executeComboResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }), body, "spend", config, logCtx, { sendBudget, translatorBudget }, {
        handleResponses: async (_req, _config, childLog, options) => {
          children += 1;
          const reporter = createPhysicalSendReporter(options!.sendBudget!, () => ({ poolId: childLog.spendPoolId,
            identityId: childLog.accountLogLabel }), options!.comboDispatchPermit);
          expect(reporter.beforeSend?.()).toBe(true); reporter(1); reporter.close?.();
          childLog.provider += `-account-${children}`;
          return children === 1
            ? Response.json({ error: { message: "fixture outage" } }, { status: 503 })
            : Response.json({ id: "fixture-response", output: [] });
        },
        handleComboResponses: async () => { throw new Error("unexpected nested combo"); },
      });
      expect(response.status).toBe(next === "first" ? 503 : 200);
      expect(children).toBe(next === "first" ? 1 : 2);
      expect(sendBudget.used).toBe(children);
      expect(ledger.snapshot("pool", "first")?.reserved).toBe(400);
      expect(ledger.snapshot("pool", "second")?.reserved).toBe(next === "second" ? 400 : undefined);
      expect(ledger.snapshot("pool", "combo")).toBeUndefined();
      expect(ledger.snapshot("pool", "stale-route")).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      translatorBudget.dispose();
      clearComboSelectionState();
      clearComboTargetCooldowns();
    }
  });

  test("a reservation the budget hands back releases its tokens instead of booking spend", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal() });
    const tracker = createRequestSpendTracker(logContext(), "root-c", ledger);
    const budget = createRequestExecutionBudget(undefined, "lr-refund", tracker);

    const reserved = budget.reserveDispatch({ sendClass: "account-failover", targetKey: "p|m" });
    expect(reserved.allowed).toBe(true);
    expect(ledger.snapshot("root", "root-c")?.reserved).toBe(500);
    if (!reserved.allowed) throw new Error("unreachable");

    // No alternate credential existed, so nothing left this process.
    reserved.permit.release();
    const root = ledger.snapshot("root", "root-c");
    expect(root?.reserved).toBe(0);
    expect(root?.unresolved).toBe(0);
    expect(root?.settled).toBe(0);
  });

  test("a normal first target refuses while stable retries reuse its anchor", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: {
      ...DEFAULT_SPEND_RESERVATION_POLICY, root: { maxTokens: 900 },
    } });
    const tracker = createRequestSpendTracker(logContext(), "root-d", ledger);
    const budget = createRequestExecutionBudget(undefined, "lr-ceiling", tracker);
    for (const sendClass of ["initial", "transient"] as const) {
      const decision = budget.reserveDispatch({ sendClass, targetKey: "p|m" });
      expect(decision.allowed).toBe(true);
      if (!decision.allowed) throw new Error("stable retry refused");
      expect(decision.permit.use()).toBe(true);
    }
    expect(ledger.snapshot("root", "root-d")?.reserved).toBe(1000);
    const refused = budget.reserveDispatch({ sendClass: "account-failover", targetKey: "other|m" });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("new target admitted");
    expect(refused.reason).toBe("spend-exhausted");
    expect(budget.used).toBe(2);
    expect(tracker.refusals).toBe(1);
  });

  test("a restart resolves the reservations nobody is left to settle", () => {
    const journal = memoryJournal();
    const before = createSpendReservationLedger({ journal });
    const tracker = createRequestSpendTracker(logContext(), "root-e", before);
    const budget = createRequestExecutionBudget(undefined, "lr-crash", tracker);
    // Two sends left; the process dies before either is settled.
    budget.reserveDispatch({ sendClass: "initial", targetKey: "p|m" });
    budget.reserveDispatch({ sendClass: "transient", targetKey: "p|m" });
    expect(before.snapshot("root", "root-e")?.reserved).toBe(1000);

    const after = createSpendReservationLedger({ journal });
    const root = after.snapshot("root", "root-e");
    // Nothing stays reserved: a reservation with no owner would hold its tokens forever.
    expect(root?.reserved).toBe(0);
    // Both keep their tokens as unresolved, including the one still open. A send can dispatch
    // and die before its dispatch record lands, so "open" does not prove nothing was sent --
    // and handing those tokens back would reset a ceiling that had already fired.
    expect(root?.unresolved).toBe(1000);
    expect(root?.settled).toBe(0);

    // Replaying the same journal again is idempotent: the reconciliation was journaled, so a
    // second restart has nothing left to resolve and cannot double-book it.
    const third = createSpendReservationLedger({ journal });
    expect(third.snapshot("root", "root-e")?.unresolved).toBe(1000);
    expect(third.snapshot("root", "root-e")?.reserved).toBe(0);
  });

  test("seeded already-sent usage crosses the ceiling without dropping liability", () => {
    const ledger = createSpendReservationLedger({ journal: memoryJournal(), policy: {
      ...DEFAULT_SPEND_RESERVATION_POLICY, root: { maxTokens: 900 },
    } });
    const tracker = createRequestSpendTracker(logContext(), "root-f", ledger);
    const budget = createRequestExecutionBudget(undefined, "lr-reported", tracker);
    const reporter = createPhysicalSendReporter(budget, () => ({ poolId: "test-pool" }));
    expect(reporter.beforeSend?.()).toBe(true);
    expect(reporter.beforeSend?.()).toBe(true);
    reporter(2); reporter.close?.();
    expect(ledger.snapshot("root", "root-f")?.reserved).toBe(1000);
    expect(ledger.exhausted("root", "root-f")).toBe(true);
    expect(tracker.refusals).toBe(0);
    tracker.settle({ inputTokens: 600 });
    expect(ledger.snapshot("root", "root-f")?.unresolved).toBe(500);
    expect(ledger.snapshot("root", "root-f")?.settled).toBe(600);
    const next = createRequestExecutionBudget(undefined, undefined, createRequestSpendTracker(logContext(), "root-f", ledger));
    expect(next.reserveDispatch({ sendClass: "initial", targetKey: "p|m" }).allowed).toBe(false);
  });

  test("under a configured ceiling a reservation that cannot be made durable refuses the send", () => {
    // Durability before admission is the reason this store is on disk at all: a send whose
    // record a restart would forget is how an exhausted budget comes back with a fresh
    // allowance. The ledger raises this denial only when a limit is configured, so the
    // unconfigured case below is unchanged.
    const ceiling = createSpendReservationLedger({
      journal: unwritableJournal(),
      policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, root: { maxTokens: 10_000 } },
    });
    const guarded = createRequestExecutionBudget(
      undefined,
      "lr-undurable",
      createRequestSpendTracker(logContext(), "root-g", ceiling),
    );
    const refused = guarded.reserveDispatch({ sendClass: "initial", targetKey: "p|m" });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("unreachable");
    expect(refused.reason).toBe("spend-exhausted");

    // With no ceiling configured, the same unwritable journal is a degradation to report and
    // never an outage to cause.
    const observing = createRequestExecutionBudget(
      undefined,
      "lr-observe",
      createRequestSpendTracker(logContext(), "root-h", createSpendReservationLedger({ journal: unwritableJournal() })),
    );
    expect(observing.reserveDispatch({ sendClass: "initial", targetKey: "p|m" }).allowed).toBe(true);
  });

  test("settlement after the reserved send's owner lease ends is dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-spend-wiring-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    const release = acquireOwnedSpendHome();
    try {
      const tracker = createRequestSpendTracker(logContext(), "root-released");
      const budget = createRequestExecutionBudget(undefined, "lr-released", tracker);
      expect(budget.reserveDispatch({ sendClass: "initial", targetKey: "p|m" }).allowed).toBe(true);

      release();
      expect(() => tracker.settle({ inputTokens: 10, outputTokens: 5 })).not.toThrow();
      expect(() => tracker.settle(undefined)).not.toThrow();
    } finally {
      release();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(dir);
    }
  });

  test("other owner and storage failures propagate without losing pending sends", () => {
    const failures: Array<SpendLedgerOwnerErrorCode | "storage"> = [
      "SPEND_LEDGER_OWNER_BUSY",
      "SPEND_LEDGER_OWNER_UNAVAILABLE",
      "SPEND_LEDGER_OWNER_HOME_CONFLICT",
      "storage",
    ];
    for (const failure of failures) {
      const ledger = createSpendReservationLedger({ journal: memoryJournal() });
      const originalMarkLost = ledger.markLost;
      const expected = failure === "storage"
        ? new Error("storage failure")
        : new SpendLedgerOwnerError(failure, "owner failure");
      let failOnce = true;
      const tracker = createRequestSpendTracker(logContext(), `root-${failure}`, {
        ...ledger,
        markLost(sendId) {
          if (failOnce) {
            failOnce = false;
            throw expected;
          }
          return originalMarkLost(sendId);
        },
      });
      const budget = createRequestExecutionBudget(undefined, `lr-${failure}`, tracker);
      budget.used += 1;
      budget.used += 1;

      expect(() => tracker.settle({ inputTokens: 120, outputTokens: 30 })).toThrow(expected);
      const pending = ledger.snapshot("root", `root-${failure}`);
      expect(pending?.reserved).toBe(500);
      expect(pending?.settled).toBe(150);
      tracker.settle({ inputTokens: 120, outputTokens: 30 });
      const complete = ledger.snapshot("root", `root-${failure}`);
      expect(complete?.reserved).toBe(0);
      expect(complete?.settled).toBe(150);
      expect(complete?.unresolved).toBe(500);
    }
  });
});

/**
 * An explicit native continuation books its own measured successor frame -- the exact
 * reconstructed input and that frame's output ceiling -- rather than reusing the opening
 * request's estimate, and it still owns the routed model's terminal usage like any routed
 * send. Because the reservation is its own keyed booking, it also must not disturb the
 * request's other pending seeds in either direction.
 */
describe("explicit native-continuation spend identity", () => {
  const rootId = `root-native-${crypto.randomUUID()}`;
  function nativeFixture() {
    const journal = memoryJournal();
    const ledger = createSpendReservationLedger({ journal, policy: {
      ...DEFAULT_SPEND_RESERVATION_POLICY, root: { maxTokens: 1_000_000 },
    } });
    // A full RequestLogContext: createResponsesSendBudget prices the successor frame on model.
    const log = { model: "gpt-5.6-sol", provider: "test-pool",
      accountLogLabel: "k0123456789abcdef0123456789abcdef",
      usageLogInputTokens: 100, spendOutputCeilingTokens: 400 };
    const tracker = createRequestSpendTracker(log, rootId, ledger);
    const budget = createRequestExecutionBudget(undefined, "native-continuation-test", tracker);
    const owner = createResponsesSendBudget({ req: new Request("http://localhost/v1/responses"),
      logCtx: log, options: { sendBudget: budget } });
    if (owner instanceof Response) throw new Error("owner refused");
    return { journal, ledger, tracker, owner };
  }

  test("an explicit continuation books the measured successor frame and owns terminal usage", () => {
    const f = nativeFixture();
    const frame = { body: { max_output_tokens: 3900 }, text: "x".repeat(2000) };
    const reporter = f.owner.continuationSendReporter(frame);
    expect(reporter.beforeSend!()).toBe(true);
    // ceil(2000 / ~4) + the frame's own 3900 ceiling; the stale opening estimate (100+400)
    // would have booked 500 for the same send.
    const expected = Math.max(1, estimateTokens(frame.text, "gpt-5.6-sol")) + 3900;
    const reserve = f.journal.lines.map(line => JSON.parse(line)).find(row => row.kind === "reserve");
    expect(reserve.tokens).toBe(expected);
    expect(f.ledger.snapshot("root", rootId)?.reserved).toBe(expected);
    reporter(1); reporter.close!();
    f.tracker.settle({ inputTokens: 7, outputTokens: 3 });
    const settled = f.journal.lines.map(line => JSON.parse(line)).filter(row => row.kind === "settle");
    // The continuation is no auxiliary helper: the routed model's terminal usage is its own.
    expect(settled.map(row => row.send)).toContain(reserve.send);
  });

  for (const [label, body, output] of [
    ["omitted", {}, 400], ["removed", { max_output_tokens: null }, 0],
    ["replaced", { max_output_tokens: 900 }, 900],
  ] as const) test(`successor output reservation is ${label} independently of fresh input`, () => {
    const f = nativeFixture();
    const frame = { body, text: "x".repeat(1200) };
    const reporter = f.owner.continuationSendReporter(frame);
    expect(reporter.beforeSend!()).toBe(true);
    const reserve = f.journal.lines.map(line => JSON.parse(line)).find(row => row.kind === "reserve");
    expect(reserve.tokens).toBe(estimateTokens(frame.text, "gpt-5.6-sol") + output);
    reporter(1); reporter.close!(); f.tracker.settle(undefined);
  });

  test("an explicit-estimate successor neither retires nor is retired by another leg", () => {
    const f = nativeFixture();
    const sendAlias = (id: string) => hashSpendAlias("", "send", id);
    const abandons = () => f.journal.lines.map(line => JSON.parse(line))
      .filter(row => row.kind === "abandon").map(row => row.send);
    const explicitTarget = () => ({ targetKey: "native-continuation:c1",
      explicitEstimate: true as const, estimate: { inputTokens: 10, outputCeilingTokens: 10 } });
    const pending = f.tracker.ensureSeed!({ targetKey: "pending-leg" })!;
    const explicit = f.tracker.ensureSeed!(explicitTarget())!;
    // The successor books beside an unstarted deferred booking instead of retiring it.
    expect(abandons()).toHaveLength(0);
    expect(f.tracker.ensureSeed!({ targetKey: "pending-leg" })).toBe(pending);
    // A later routed admission still retires an unused ordinary anchor, but the unstarted
    // explicit seed its reporter owns is not a provisional anchor it may rebind.
    f.tracker.ensureSeed!({ targetKey: "routed-leg" });
    expect(abandons()).toContain(sendAlias(pending.sendId));
    expect(abandons()).not.toContain(sendAlias(explicit.sendId));
    expect(f.tracker.ensureSeed!(explicitTarget())).toBe(explicit);
    f.tracker.settle(undefined);
  });
});
