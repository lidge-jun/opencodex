import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpendReservationLedger, configureSharedSpendLedger, sharedSpendLedger, DEFAULT_SPEND_RESERVATION_POLICY, type SpendJournal, type SpendReservationPolicy } from "../../src/lib/spend-reservation-ledger";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { createRequestExecutionBudget, claimDispatchSpendProof, createPhysicalSendReporter } from "../../src/lib/request-execution-budget";
import { workflowSpendCeilingReached } from "../../src/lib/workflow-budget";
import { parseRequest } from "../../src/responses/parser";
import { routeModel } from "../../src/router";
import { applyFinalRouteRequestNormalization } from "../../src/server/responses/core-normalize";
import { handleNativeMessages } from "../../src/server/messages-native";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const salt = "6".repeat(64);
const pool = (id: string) => createHash("sha256").update(salt).update("\0pool\0").update(id).digest("hex").slice(0, 32);
const policy = (poolAliases?: unknown, limit = 100): SpendReservationPolicy => ({
  ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: limit }, poolAliases, canonicalProviderIds: ["P", "Q"],
});
const journal = (records: unknown[] = []): SpendJournal & { lines: string[] } => {
  const lines = records.map(record => JSON.stringify(record));
  return { lines, read: () => [...lines], append: line => { lines.push(line); },
    rewrite: next => { lines.splice(0, lines.length, ...next); } };
};
const checkpoint = (entries: Array<[string, number, number]>) => ({
  v: 1, kind: "checkpoint", at: 1, sends: [],
  scopes: entries.map(([id, settled, unresolved]) => ({ scope: "pool", alias: pool(id), settled, unresolved, seenAt: 1 })),
});
const reserve = (ledger: ReturnType<typeof createSpendReservationLedger>, sendId: string, poolId: string, tokens: number) =>
  ledger.reserve({ sendId, scopes: { poolId }, inputTokens: tokens, outputCeilingTokens: 0 });
const log = (provider = "P"): RequestLogContext => ({ model: "model", provider, spendPoolId: provider,
  usageLogInputTokens: 10, spendOutputCeilingTokens: 0 });

test("Responses A B and Messages share canonical ceiling", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-contract-c-messages-"));
  const priorHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  const translatorBudget = createTranslatorBudget();
  let sends = 0;
  const config: OcxConfig = { port: 0, defaultProvider: "P", providers: { P: {
    adapter: "anthropic", apiKey: "fixture-key", baseUrl: "https://messages.example.test/v1",
    fetch: async () => {
      sends += 1;
      return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "model",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 } });
    },
  } } };
  try {
    writeFileSync(join(home, "spend-ledger.salt"), salt + "\n", { mode: 0o600 });
    configureSharedSpendLedger(policy(undefined, 31));
    const ledger = sharedSpendLedger();
    for (const account of ["A", "B"]) {
      const ctx = log();
      const parsed = parseRequest({ model: "P/model", input: [] });
      await applyFinalRouteRequestNormalization({ parsed, route: routeModel(config, parsed.modelId), config,
        req: new Request("http://localhost/v1/responses"), logCtx: ctx, inboundWire: "responses" });
      ctx.provider = `P-${account}`;
      ctx.accountLogLabel = account;
      const tracker = createRequestSpendTracker(ctx, undefined, ledger);
      const budget = createRequestExecutionBudget(undefined, undefined, tracker);
      const report = createPhysicalSendReporter(budget, () => ({ poolId: "P", identityId: account }));
      expect(report.beforeSend?.()).toBe(true);
      report(1); report.close?.();
      tracker.settle({ inputTokens: 10, outputTokens: 0 });
    }
    const ctx = log("stale");
    const body = { model: "model", messages: [{ role: "user", content: "hello" }], max_tokens: 1, stream: false };
    const response = await handleNativeMessages({ req: new Request("http://localhost/v1/messages", { method: "POST" }),
      config, logCtx: ctx, route: routeModel(config, "P/model"), body, requestedModel: "P/model", translatorBudget });
    expect(response.status).toBe(200);
    await response.text();
    ctx.spendTracker?.settle({ inputTokens: 10, outputTokens: 0 });
    expect(sends).toBe(1);
    expect(ctx.spendPoolId).toBe("P");
    expect(ledger.snapshot("pool", "P")).toMatchObject({ settled: 30, reserved: 0, unresolved: 0 });
    const over = log("P-C"); over.spendPoolId = "P";
    expect(createRequestSpendTracker(over, undefined, ledger).charge()).toBe(false);
    const records = (await Bun.file(join(home, "spend-ledger.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(records.filter(record => record.kind === "reserve").flatMap(record => record.targets)
      .filter(target => target.scope === "pool").map(target => target.alias)).toEqual([pool("P"), pool("P"), pool("P")]);
    expect(records.some(record => record.poolContinuity !== undefined)).toBe(false);
  } finally {
    translatorBudget.dispose(); release();
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = priorHome;
    removeTreeWithRetry(home);
  }
});

test("self-bound canonical bucket is counted once for absent partial complete maps", () => {
  for (const aliases of [undefined, { [pool("old-A")]: "P" },
    { [pool("old-A")]: "P", [pool("old-B")]: "P", [pool("P")]: "P" }]) {
    const disk = journal([checkpoint([["P", 20, 0], ["old-A", 30, 0], ["old-B", 0, 10]])]);
    const ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(aliases), now: () => 2 });
    expect(ledger.snapshot("pool", "P")).toMatchObject({ settled: 50, unresolved: 10, reserved: 0 });
    expect(reserve(ledger, "exact", "P", 40).reserved).toBe(true);
    const written = disk.lines.map(line => JSON.parse(line)).findLast(record => record.kind === "reserve");
    expect(written.targets).toEqual([{ scope: "pool", alias: pool("P") }]);
    expect(ledger.snapshot("pool", "P")).toMatchObject({ settled: 50, unresolved: 10, reserved: 40 });
    expect(reserve(ledger, "over", "P", 1)).toMatchObject({ reserved: false, denial: { projected: 101 } });
  }
});

test("restart keeps configured canonical history self-bound without persisted metadata", () => {
  const disk = journal();
  let ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 2 });
  expect(reserve(ledger, "initial", "P", 40).reserved).toBe(true);
  expect(ledger.settle("initial", { inputTokens: 40, outputTokens: 0 })).toBe(true);
  ledger = createSpendReservationLedger({ journal: disk, salt, policy: policy(), now: () => 3 });
  expect(ledger.hasUnboundPositivePoolHistory()).toBe(false);
  expect(ledger.snapshot("pool", "P")?.settled).toBe(40);
  expect(ledger.snapshot("pool", "Q")).toBeUndefined();
  expect(reserve(ledger, "other-independent", "Q", 100).reserved).toBe(true);
  ledger.abandon("other-independent");
  ledger.reconfigure({ ...policy(), canonicalProviderIds: ["Q"] });
  expect(ledger.hasUnboundPositivePoolHistory()).toBe(true);
  expect(ledger.snapshot("pool", "Q")?.settled).toBe(40);
  ledger.reconfigure(policy());
  expect(ledger.snapshot("pool", "Q")?.settled ?? 0).toBe(0);
  expect(disk.lines.some(line => JSON.parse(line).poolContinuity !== undefined)).toBe(false);
});

test("combo A to B preserves exact current permit exclusion", async () => {
  const config: OcxConfig = { port: 0, defaultProvider: "A", providers: {
    A: { adapter: "openai-chat", apiKey: "fixture-a", baseUrl: "https://a.example.test/v1" },
    B: { adapter: "openai-chat", apiKey: "fixture-b", baseUrl: "https://b.example.test/v1" },
  }, combos: { spend: { strategy: "failover", targets: [{ provider: "A", model: "m" }, { provider: "B", model: "m" }] } } };
  const disk = journal();
  const ledger = createSpendReservationLedger({ journal: disk, salt,
    policy: { ...policy({ [pool("A")]: "A", [pool("B")]: "B" }, 10), canonicalProviderIds: ["A", "B"] } });
  const ctx = log("stale");
  const tracker = createRequestSpendTracker(ctx, undefined, ledger);
  const budget = createRequestExecutionBudget(undefined, "combo-contract-c", tracker);
  const translatorBudget = createTranslatorBudget();
  clearComboSelectionState(); clearComboTargetCooldowns();
  const visited: string[] = [];
  try {
    const body = { model: "combo/spend", input: [], max_output_tokens: 10 };
    const result = await executeComboResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), body, "spend", config, ctx, { sendBudget: budget, translatorBudget }, {
      handleResponses: async (_req, _config, child, options) => {
        const provider = ctx.spendPoolId!;
        visited.push(provider);
        const proof = claimDispatchSpendProof(options!.sendBudget!, options!.comboDispatchPermit);
        expect(proof).toBeDefined();
        expect(workflowSpendCeilingReached(undefined, ledger, provider, proof)).toBeUndefined();
        expect(ledger.snapshot("pool", provider)?.reserved).toBe(10);
        if (provider === "B") expect(workflowSpendCeilingReached(undefined, ledger, "A", proof)?.scope).toBe("pool");
        const report = createPhysicalSendReporter(options!.sendBudget!, () => ({ poolId: provider }), options!.comboDispatchPermit);
        expect(report.beforeSend?.()).toBe(true);
        report(1); report.close?.();
        return provider === "A" ? Response.json({ error: { message: "fixture outage" } }, { status: 503 })
          : Response.json({ id: "fixture", output: [] });
      },
      handleComboResponses: async () => { throw new Error("unexpected nested combo"); },
    });
    expect(result.status).toBe(200);
    expect(visited).toEqual(["A", "B"]);
    tracker.settle({ inputTokens: 10, outputTokens: 0 });
    expect(ledger.snapshot("pool", "A")).toMatchObject({ unresolved: 10, reserved: 0 });
    expect(ledger.snapshot("pool", "B")).toMatchObject({ settled: 10, reserved: 0 });
    expect(disk.lines.some(line => JSON.parse(line).poolContinuity !== undefined)).toBe(false);
  } finally { translatorBudget.dispose(); clearComboSelectionState(); clearComboTargetCooldowns(); }
});
