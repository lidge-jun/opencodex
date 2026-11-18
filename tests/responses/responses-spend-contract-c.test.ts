import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpendReservationLedger, configureSharedSpendLedger, sharedSpendLedger, DEFAULT_SPEND_RESERVATION_POLICY, type SpendJournal, type SpendReservationPolicy } from "../../src/lib/spend-reservation-ledger";
import { createRequestSpendTracker, type RequestSpendTracker } from "../../src/server/responses/request-spend";
import { createRequestExecutionBudget, claimDispatchSpendProof, createPhysicalSendReporter } from "../../src/lib/request-execution-budget";
import { admitWorkflowTurn, resetWorkflowBudgetsForTest, workflowBudgetSnapshot, workflowSpendCeilingReached } from "../../src/lib/workflow-budget";
import { bindWorkflowBudgetConfig, currentWorkflowBudgetPolicy } from "../../src/lib/workflow-budget-config";
import { isProxyError } from "../../src/lib/client-error-body";
import { isNonReplayableResponse } from "../../src/lib/upstream-retry";
import { parseRequest } from "../../src/responses/parser";
import { routeModel } from "../../src/router";
import { applyFinalRouteRequestNormalization } from "../../src/server/responses/core-normalize";
import { handleNativeMessages } from "../../src/server/messages-native";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import * as proxyEnv from "../../src/lib/proxy-env";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { startServer } from "../../src/server";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
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

for (const enforced of [false, true]) for (const status of [503, 429]) {
  test(`native Messages workflow ceiling counts each ${status === 503 ? "503 request" : "429 retry"} once (spend=${enforced})`, async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-messages-workflow-"));
    const priorHome = process.env.OPENCODEX_HOME;
    const codexHome = installIsolatedCodexHome("ocx-messages-workflow-codex-");
    const loopbackFetch = proxyEnv.configuredOutboundFetch;
    process.env.OPENCODEX_HOME = home;
    resetWorkflowBudgetsForTest(); clearKeyCooldowns();
    let sends = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      expect(new URL(req.url).pathname).toBe("/v1/messages");
      sends++;
      return Response.json({ type: "error", error: { type: status === 429 ? "rate_limit_error" : "api_error", message: "temporary fixture refusal" } },
        { status, headers: { "retry-after": "0" } });
    } });
    const upstreamOrigin = upstream.url.origin;
    // Pin only this fixture's outbound transport; inherited proxies never receive its requests.
    const outbound = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== upstreamOrigin) throw new Error("unexpected fixture outbound destination");
      return loopbackFetch(input, { ...init, proxy: false } as proxyEnv.ProxyCapableRequestInit);
    });
    let server: ReturnType<typeof startServer> | undefined;
    try {
      const config: OcxConfig = { port: 0, clientIntegrations: { codex: false }, defaultProvider: "fixture", providers: { fixture: {
        adapter: "anthropic", authMode: "key", apiKey: "fixture-key",
        baseUrl: new URL("/v1", upstream.url).href, allowPrivateNetwork: true,
        liveModels: false, models: ["fixture-model"],
        ...(status === 429 ? { retryOn429: { attempts: 3, respectRetryAfter: true } } : {}),
      } }, protocols: { rollout: { managedMessagesNative: true } }, workflowBudget: { maxPhysicalSends: 2 },
        ...(enforced ? { spend: { pool: { maxTokens: 100_000 } } } : {}) };
      saveConfig(config);
      server = startServer(0);
      // Messages does not opt into 5xx retries: repeated requests share the root instead.
      // Its explicit same-key 429 policy exercises the limit within one native request.
      for (let request = 0; request < (status === 503 ? 3 : 1); request++) {
        const response = await loopbackFetch(new URL("/v1/messages", server.url), {
          method: "POST", headers: { "content-type": "application/json", "x-codex-parent-thread-id": "messages-count-root" },
          body: JSON.stringify({ model: "fixture/fixture-model", messages: [{ role: "user", content: "fixture" }], max_tokens: 1 }),
          proxy: false,
        } as proxyEnv.ProxyCapableRequestInit);
        const body = await response.text();
        if (status === 503 && request < 2) {
          // Native Messages normalizes upstream 503 to its 529 overloaded-error wire shape.
          expect(response.status, body).toBe(529);
          expect(workflowBudgetSnapshot("messages-count-root")?.sends).toBe(request + 1);
        } else {
          expect(response.status, body).toBe(429);
          expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_sends_exhausted");
          expect(JSON.parse(body).error.code).toBe("rate_limit_exceeded");
          if (status === 429) {
            expect(JSON.parse(body)).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
            expect(response.headers.get("access-control-expose-headers")).toContain("x-opencodex-local-refusal");
            expect(body).toContain("no additional provider request was sent");
            expect(body).not.toContain("no provider was contacted");
          } else expect(body).toContain("no provider was contacted");
        }
      }
      expect(sends).toBe(2);
      expect(workflowBudgetSnapshot("messages-count-root")?.sends).toBe(2);
      expect(getRequestLogEntries().findLast(row => row.inboundProtocol === "messages" && row.protocolTrace?.mode === "native")?.protocolTrace)
        .toMatchObject({ mode: "native", requestPath: ["messages", "messages"] });
    } finally {
      let drained = false;
      try {
        try { await server?.stop(true); } finally { await upstream.stop(true); }
        await flushNativeMainStartupReleases(); await flushConfigDirHardeningForTests();
        await flushWindowsSecretAclReapsBeforeRemoval(home);
        await flushWindowsSecretAclReapsBeforeRemoval(codexHome.path);
        drained = true;
      } finally {
        outbound.mockRestore(); resetWorkflowBudgetsForTest(); clearKeyCooldowns(); resetProviderRequestPacingForTest();
        if (priorHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = priorHome;
        codexHome.restoreEnvironment();
        if (drained) { codexHome.removeAfterDrain(); removeTreeWithRetry(home); }
      }
    }
  }, 10_000);
}

test("native Messages keeps the Anthropic envelope when request and root send ceilings coincide", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-messages-root-envelope-"));
  const priorHome = process.env.OPENCODEX_HOME;
  const codexHome = installIsolatedCodexHome("ocx-messages-envelope-codex-");
  process.env.OPENCODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  const translatorBudget = createTranslatorBudget();
  const ctx = log("fixture");
  let releaseRoot = () => {};
  let sends = 0;
  const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: {
    adapter: "anthropic", authMode: "key", apiKey: "fixture-key", baseUrl: "http://127.0.0.1:1/v1",
    allowPrivateNetwork: true, liveModels: false, models: ["fixture-model"],
    retryOn429: { attempts: 4, respectRetryAfter: true },
    fetch: async () => {
      sends++;
      return Response.json({ type: "error", error: { type: "rate_limit_error", message: "fixture upstream rate limit" } },
        { status: 429, headers: { "retry-after": "0" } });
    },
  } }, workflowBudget: { maxPhysicalSends: 4 } };
  const outbound = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation(() => { throw new Error("unexpected network fetch in memory fixture"); });
  try {
    resetWorkflowBudgetsForTest(); clearKeyCooldowns();
    bindWorkflowBudgetConfig(config);
    configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, pool: { maxTokens: 100_000 }, canonicalProviderIds: ["fixture"] });
    const decision = admitWorkflowTurn("messages-envelope-root", "interactive", currentWorkflowBudgetPolicy());
    expect(decision?.admitted).toBe(true);
    if (!decision?.admitted) throw new Error("fixture workflow admission failed");
    releaseRoot = () => decision.lease.release();
    const response = await handleNativeMessages({
      req: new Request("http://localhost/v1/messages", { method: "POST", headers: { "x-codex-parent-thread-id": "messages-envelope-root" } }),
      config, logCtx: ctx, route: routeModel(config, "fixture/fixture-model"),
      body: { model: "fixture-model", messages: [{ role: "user", content: "fixture" }], max_tokens: 1, stream: false },
      requestedModel: "fixture/fixture-model", translatorBudget,
    });
    expect(sends).toBe(4);
    expect(workflowBudgetSnapshot("messages-envelope-root")?.sends).toBe(4);
    // The request's physical cap refuses before the root observer. No tracker refusal means
    // this reaches SendBudgetExhaustedError, not the NativeMessagesSpendRefusal branch.
    expect((ctx.spendTracker as RequestSpendTracker).enforced).toBe(true);
    expect((ctx.spendTracker as RequestSpendTracker).refusals).toBe(0);
    expect(ctx.localTerminalReason).toBe("workflow_sends_exhausted");
    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_sends_exhausted");
    expect(response.headers.get("access-control-expose-headers")).toContain("x-opencodex-local-refusal");
    expect(isProxyError(response)).toBe(true);
    expect(isNonReplayableResponse(response)).toBe(true);
    const body = await response.json();
    expect(body).toMatchObject({ type: "error", error: { type: "rate_limit_error", code: "rate_limit_exceeded" } });
    expect(body.error.message).toContain("no additional provider request was sent");
  } finally {
    ctx.spendTracker?.settle(undefined);
    translatorBudget.dispose(); releaseRoot(); release();
    outbound.mockRestore(); bindWorkflowBudgetConfig(null);
    resetWorkflowBudgetsForTest(); clearKeyCooldowns(); resetProviderRequestPacingForTest();
    await flushNativeMainStartupReleases(); await flushConfigDirHardeningForTests();
    await flushWindowsSecretAclReapsBeforeRemoval(home);
    await flushWindowsSecretAclReapsBeforeRemoval(codexHome.path);
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = priorHome;
    codexHome.restoreEnvironment(); codexHome.removeAfterDrain(); removeTreeWithRetry(home);
  }
});

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
