import { expect, spyOn, test } from "bun:test";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY } from "../../src/lib/spend-reservation-ledger";
import { createRequestExecutionBudget, deriveRequestExecutionBudget, CODEX_TEXT_GUARDED_BUDGET_POLICY, createPhysicalSendReporter } from "../../src/lib/request-execution-budget";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { fetchWithResetRetry, fetchWithTransientRetry } from "../../src/lib/upstream-retry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureSharedSpendLedger, sharedSpendLedger } from "../../src/lib/spend-reservation-ledger";
import { handleNativeMessages } from "../../src/server/messages-native";
import { handleNativeChatCompletions, runNativeChatAttempt } from "../../src/server/chat-native";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { beginInferenceAttempt } from "../../src/server/inference/attempt";
import { routeModel } from "../../src/router";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { OcxConfig } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";
import type { RequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { acquireSpendLedgerServerLifecycle } from "../../src/server/index/spend-ledger-lifecycle";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { SpendLedgerOwnerError } from "../../src/lib/spend-ledger-owner";

function fixture(enforced = true, capacity = 8) {
  const lines: string[] = [];
  const ledger = createSpendReservationLedger({ salt: "anchor-fixture", policy: {
    ...DEFAULT_SPEND_RESERVATION_POLICY, maxTrackedSends: capacity,
    ...(enforced ? { pool: { maxTokens: 10000 } } : {}),
  }, journal: { read: () => [], append: line => { lines.push(line); } } });
  const ctx = { provider: "P", spendPoolId: "P", accountLogLabel: "A", spendInputEstimateTokens: 10, spendOutputCeilingTokens: 20 };
  const tracker = createRequestSpendTracker(ctx, undefined, ledger);
  const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY }, undefined, tracker);
  const reporter = () => createPhysicalSendReporter(budget, () => ({ poolId: ctx.spendPoolId, identityId: ctx.accountLogLabel }));
  return { lines, ledger, ctx, tracker, budget, reporter };
}

test("retry helper refuses a normal seed before its first fetch at capacity", async () => {
  const f = fixture(true, 1);
  f.ledger.reserve({ sendId: "busy", scopes: { poolId: "P" }, inputTokens: 1, outputCeilingTokens: 0 });
  let wires = 0;
  await expect(fetchWithTransientRetry(async () => { wires++; return new Response(); }, { attempts: 1, onSendsConsumed: f.reporter() })).rejects.toThrow();
  expect(wires).toBe(0);
  expect(f.tracker.refusals).toBe(1);
});

test("retry helper adopts one prepaid normal seed", async () => {
  const f = fixture();
  const decision = f.budget.reserveDispatch({ sendClass: "initial", targetKey: "P/A", countedExternally: true });
  expect(decision.allowed).toBe(true);
  if (!decision.allowed) throw new Error("dispatch refused");
  await fetchWithResetRetry(async () => { expect(decision.permit.use()).toBe(true); return new Response(); }, {
    attempts: 1, onSendsConsumed: createPhysicalSendReporter(f.budget, () => ({ poolId: "P", identityId: "A", targetKey: "P/A" }), decision.permit),
  });
  expect(f.lines.filter(line => JSON.parse(line).kind === "reserve")).toHaveLength(1);
  f.tracker.settle({ inputTokens: 2, outputTokens: 3 });
  expect(f.ledger.snapshot("pool", "P")?.settled).toBe(5);
});

test("stable reset and transient helper invocations reuse one scope entry", async () => {
  const f = fixture(true, 1);
  for (const helper of [fetchWithResetRetry, fetchWithTransientRetry, fetchWithResetRetry]) {
    await helper(async () => new Response(), { attempts: 1, onSendsConsumed: f.reporter() });
  }
  f.tracker.settle({ inputTokens: 4 });
  expect(f.ledger.snapshot("pool", "P")?.unresolved).toBe(60);
  expect(f.ledger.snapshot("pool", "P")?.settled).toBe(4);
  expect(f.budget.physicalStarted).toBe(3);
});

test("delayed key A batch remains on A after key B reselection", () => {
  const f = fixture();
  const a = f.reporter();
  expect(a.beforeSend?.()).toBe(true);
  f.ctx.accountLogLabel = "B";
  const b = f.reporter();
  expect(b.beforeSend?.()).toBe(true);
  b(1); b.close?.();
  a(1); a.close?.();
  f.tracker.settle({ inputTokens: 7 });
  expect(f.ledger.snapshot("identity", "A")?.unresolved).toBe(30);
  expect(f.ledger.snapshot("identity", "B")?.settled).toBe(7);
});

test("derived budget reporter adopts B seed on a shared parent observer", () => {
  const f = fixture();
  const child = deriveRequestExecutionBudget(f.budget, CODEX_TEXT_GUARDED_BUDGET_POLICY);
  const report = createPhysicalSendReporter(child, () => ({ poolId: "B", identityId: "account-B" }));
  expect(report.beforeSend?.()).toBe(true); report(1); report.close?.();
  expect(f.budget.physicalStarted).toBe(1);
  f.tracker.settle({ inputTokens: 11 });
  expect(f.ledger.snapshot("pool", "B")?.settled).toBe(11);
  const reserve = f.lines.map(line => JSON.parse(line)).find(record => record.kind === "reserve");
  expect(reserve.targets.filter((target: { scope: string }) => target.scope === "pool")).toHaveLength(1);
  expect(f.ledger.snapshot("identity", "account-B")?.settled).toBe(11);
});

test("retry helpers enforce the frozen physical limit despite policy mutation", async () => {
  const f = fixture();
  let wires = 0;
  for (let i = 0; i < 4; i++) await fetchWithResetRetry(async () => { wires++; return new Response(); }, { attempts: 1, onSendsConsumed: f.reporter() });
  Object.assign(f.budget.policy, { maxTotalModelSends: 100 });
  await expect(fetchWithResetRetry(async () => { wires++; return new Response(); }, { attempts: 1, onSendsConsumed: f.reporter() })).rejects.toThrow();
  expect(wires).toBe(4);
  expect(f.budget.physicalLimit).toBe(4);
});

test("physical reporter refuses a fifth count claim at the default limit", () => {
  const f = fixture();
  const report = f.reporter();
  for (let i = 0; i < 4; i++) expect(report.beforeSend?.()).toBe(true);
  expect(report.beforeSend?.()).toBe(false);
  report(4); report.close?.();
  expect(f.budget.physicalStarted).toBe(4);
});

test("terminal settlement and ledger drain wait for an open reporter", async () => {
  const f = fixture();
  const report = f.reporter();
  expect(report.beforeSend?.()).toBe(true);
  f.tracker.settle(undefined);
  let drained = false;
  const drain = f.ledger.waitForReporterDrain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(f.ledger.snapshot("pool", "P")?.reserved).toBe(30);
  report(1); report.close?.();
  await drain;
  expect(f.ledger.snapshot("pool", "P")?.unresolved).toBe(30);
});

test("recovery telemetry cannot mint unclaimed sends", () => {
  const f = fixture();
  const report = f.reporter();
  report(70); report.close?.();
  f.budget.used += 70;
  expect(f.budget.physicalStarted).toBe(0);
  expect(f.lines.filter(line => JSON.parse(line).kind === "reserve")).toHaveLength(0);
});

test("unconfigured helper keeps shipped no-refusal behavior", async () => {
  const f = fixture(false, 1);
  f.ledger.reserve({ sendId: "busy", scopes: { poolId: "P" }, inputTokens: 1, outputCeilingTokens: 0 });
  let wires = 0;
  await fetchWithResetRetry(async () => { wires++; return new Response(); }, { attempts: 1, onSendsConsumed: f.reporter() });
  expect(wires).toBe(1);
  expect(f.tracker.refusals).toBe(0);
});


// These cases exercise production entrypoints; only the external wire is faked.

const executorKinds = ["messages", "chat", "compact", "generic", "passthrough"] as const;
type ExecutorKind = typeof executorKinds[number];
async function withExecutorHome(run: (ledger: ReturnType<typeof sharedSpendLedger>, home: string) => Promise<void>, capacity = 8) {
  const home = mkdtempSync(join(tmpdir(), "ocx-spend-executors-"));
  const previousHome = process.env.OPENCODEX_HOME;
  const originalFetch = globalThis.fetch;
  process.env.OPENCODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  globalThis.fetch = (async () => { throw new Error("Unexpected external transport in executor fixture"); }) as typeof fetch;
  try {
    configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, maxTrackedSends: capacity, pool: { maxTokens: 100000 } });
    await run(sharedSpendLedger(), home);
  } finally {
    release(); globalThis.fetch = originalFetch; resetProviderRequestPacingForTest();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
}
const executorPool = (kind: ExecutorKind) => kind === "compact" ? "openai-apikey" : "P";
function executorConfig(kind: ExecutorKind, wire: typeof fetch): OcxConfig {
  return { port: 0, defaultProvider: executorPool(kind), providers: { [executorPool(kind)]: {
    adapter: kind === "messages" ? "anthropic" : kind === "chat" || kind === "generic" ? "openai-chat" : "openai-responses",
    authMode: "key", apiKey: "fixture-only", baseUrl: kind === "compact" ? "https://api.openai.com/v1" : "https://executor.example.test/v1",
    transientRetryOn5xx: { attempts: 3 }, fetch: wire,
  } } };
}
function executorSuccess(kind: ExecutorKind): Response {
  if (kind === "messages") return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "model",
    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } });
  if (kind === "chat" || kind === "generic") return Response.json({ id: "chat_fixture", object: "chat.completion", model: "model",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } });

  return Response.json({ id: "resp_fixture", object: "response", status: "completed", output: kind === "compact" ? [{ type: "compaction", encrypted_content: "fixture-opaque" }] : [], usage: { input_tokens: 2, output_tokens: 1 } });
}
async function invokeExecutor(kind: ExecutorKind, config: OcxConfig, logCtx: RequestLogContext, sendBudget?: RequestExecutionBudget, signal?: AbortSignal): Promise<Response> {
  const translatorBudget = createTranslatorBudget();
  const body = kind === "messages" || kind === "chat"
    ? { model: "model", messages: [{ role: "user", content: "hello" }], max_tokens: 1, stream: false }
    : { model: `${executorPool(kind)}/model`, input: "hello", max_output_tokens: 1, stream: false };
  const req = new Request(`http://localhost/v1/${kind === "messages" ? "messages" : kind === "chat" ? "chat/completions" : kind === "compact" ? "responses/compact" : "responses"}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
  });
  try {
    let response: Response;
    if (kind === "messages") response = await handleNativeMessages({ req, config, logCtx, route: routeModel(config, "P/model"), body, requestedModel: "P/model", translatorBudget });
    else if (kind === "chat") {
      const options = { req, config, logCtx, route: routeModel(config, "P/model"), chatBody: body, requestedModel: "P/model", requestedStream: false, translatorBudget };
      response = sendBudget ? await runNativeChatAttempt({ ...options, sendBudget, finishLog: () => {} }, beginInferenceAttempt(logCtx, { provider: "P", model: "model", adapter: "openai-chat" })) : await handleNativeChatCompletions(options);
    } else if (kind === "compact") response = await handleResponsesCompact(req, config, logCtx, undefined, undefined, { sendBudget });
    else response = await handleResponses(req, config, logCtx, { sendBudget, translatorBudget, abortSignal: signal });
    // Consume while its translator owner is alive; preserve status/headers for assertions.
    const text = await response.text();
    return new Response(text, { status: response.status, headers: response.headers });
  } finally { translatorBudget.dispose(); }
}

for (const recovery of [false, true]) test(`generic observe-only executor captures before ${recovery ? "same-key recovery" : "an uncounted send"}`, async () => withExecutorHome(async ledger => {
  configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, canonicalProviderIds: ["P"] });
  const ctx: RequestLogContext = { model: "model", provider: "P", spendPoolId: "P", spendInputEstimateTokens: 2, spendOutputCeilingTokens: 1 };
  const tracker = createRequestSpendTracker(ctx, undefined, ledger);
  ctx.spendTracker = tracker;
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  let wires = 0;
  const wire = (async () => {
    wires++;
    expect(budget.spendPolicyStarted).toBe(true);
    if (wires === 1) {
      configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, canonicalProviderIds: ["P"], pool: { maxTokens: 1 } });
      if (recovery) return Response.json({ error: { message: "rate limited" } }, { status: 429 });
    }
    expect(budget.spendEnforced).toBe(false);
    return executorSuccess("generic");
  }) as typeof fetch;
  globalThis.fetch = wire;
  const config = executorConfig("generic", wire);
  delete config.providers.P!.transientRetryOn5xx;
  if (recovery) config.providers.P!.retryOn429 = { attempts: 1, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false };
  const response = await invokeExecutor("generic", config, ctx, budget);
  expect(response.status, await response.text()).toBe(200);
  expect(wires).toBe(recovery ? 2 : 1);
  expect(budget.physicalStarted).toBe(0);
  expect(budget.used).toBe(0);
}));

test("generic terminal continuation retains the policy captured by its uncounted initial send", async () => withExecutorHome(async ledger => {
  configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, canonicalProviderIds: ["P"] });
  const ctx: RequestLogContext = { model: "model", provider: "P", spendPoolId: "P" };
  const tracker = createRequestSpendTracker(ctx, undefined, ledger);
  ctx.spendTracker = tracker;
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  let wires = 0;
  const wire = (async () => {
    wires++;
    expect(budget.spendPolicyStarted).toBe(true);
    if (wires === 1) configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, canonicalProviderIds: ["P"], pool: { maxTokens: 1 } });
    expect(budget.spendEnforced).toBe(false);
    const delta = wires === 1 ? { content: "我接下来会修改相关文件。" }
      : { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "exec_command", arguments: "{}" } }] };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: wires === 1 ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  globalThis.fetch = wire;
  const config = executorConfig("generic", wire);
  delete config.providers.P!.transientRetryOn5xx;
  config.providers.P!.terminalContinuationGuard = true;
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "P/model", input: "Edit the file", stream: true, tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: {} } }] }) });
  const response = await handleResponses(req, config, ctx, { sendBudget: budget });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(text).toContain("exec_command");
  expect(wires).toBe(2);
  expect(budget.physicalStarted).toBe(0);
  expect(budget.used).toBe(0);
}));

for (const originallyEnforced of [false, true]) test(`Responses re-entry retains ${originallyEnforced ? "higher" : "disabled"} starting ceiling after a new lower ceiling`, async () => withExecutorHome(async ledger => {
  configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, canonicalProviderIds: ["P"], pool: originallyEnforced ? { maxTokens: 100 } : {} });
  expect(ledger.reserve({ sendId: "history", scopes: { poolId: "P" }, inputTokens: 10, outputCeilingTokens: 0 }).reserved).toBe(true);
  ledger.settle("history", { inputTokens: 10, outputTokens: 0 });
  const ctx: RequestLogContext = { model: "model", provider: "P", spendPoolId: "P", spendInputEstimateTokens: 1 };
  const tracker = createRequestSpendTracker(ctx, undefined, ledger);
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  expect(budget.spendPolicyStarted).toBe(false);
  budget.startRequest?.({ poolId: "P" });
  configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, canonicalProviderIds: ["P"], pool: { maxTokens: 1 } });
  const req = new Request("http://localhost/v1/responses");
  const child = createResponsesSendBudget({ req, logCtx: ctx, options: { sendBudget: budget } });
  expect(child).not.toBeInstanceOf(Response);
  if (child instanceof Response) throw new Error("frozen request refused by current policy");
  const admission = child.adapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey: "P/model" });
  expect(admission.allowed).toBe(true);
  if (admission.allowed) admission.permit.release();
  expect(createResponsesSendBudget({ req, logCtx: { ...ctx }, options: {} })).toBeInstanceOf(Response);
  tracker.settle(undefined);
}));

for (const change of ["disable", "raise"] as const) test(`Responses re-entry still applies the original seed ceiling after ${change}`, async () => withExecutorHome(async ledger => {
  configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, canonicalProviderIds: ["P"], pool: { maxTokens: 1 } });
  const ctx: RequestLogContext = { model: "model", provider: "P", spendPoolId: "P", spendInputEstimateTokens: 2 };
  const tracker = createRequestSpendTracker(ctx, undefined, ledger);
  const budget = createRequestExecutionBudget(undefined, undefined, tracker);
  budget.startRequest?.({ poolId: "P" });
  configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, canonicalProviderIds: ["P"], pool: change === "disable" ? {} : { maxTokens: 100 } });
  const req = new Request("http://localhost/v1/responses");
  const child = createResponsesSendBudget({ req, logCtx: ctx, options: { sendBudget: budget } });
  expect(child).not.toBeInstanceOf(Response);
  if (child instanceof Response) throw new Error("unexpected preflight refusal");
  expect(child.adapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey: "P/model" }))
    .toMatchObject({ allowed: false, reason: "spend-exhausted" });
}));

for (const change of ["disable", "raise", "lower"] as const) {
  for (const rootId of [undefined, "snapshot-root"]) test(`Responses frozen ${rootId ? "root" : "pool"} preflight keeps one-use prepaid exclusion after ${change}`, async () => withExecutorHome(async ledger => {
    configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, canonicalProviderIds: ["P"], root: { maxTokens: 10 }, pool: { maxTokens: 10 } });
    const ctx: RequestLogContext = { model: "model", provider: "P", spendPoolId: "P", spendInputEstimateTokens: 10 };
    const tracker = createRequestSpendTracker(ctx, rootId, ledger);
    const budget = createRequestExecutionBudget(undefined, undefined, tracker);
    const prepaid = budget.reserveDispatch({ sendClass: "initial", targetKey: "P/model", countedExternally: true });
    if (!prepaid.allowed) throw new Error("prepaid admission refused");
    const scopePolicy = change === "disable" ? {} : { maxTokens: change === "raise" ? 100 : 1 };
    configureSharedSpendLedger({ ...DEFAULT_SPEND_RESERVATION_POLICY, canonicalProviderIds: ["P"], root: scopePolicy, pool: scopePolicy });
    const req = new Request("http://localhost/v1/responses", { headers: rootId ? { "x-codex-parent-thread-id": rootId } : {} });
    const options = { sendBudget: budget, compactionRecoveryPermit: prepaid.permit };
    expect(createResponsesSendBudget({ req, logCtx: ctx, options })).not.toBeInstanceOf(Response);
    const repeated = createResponsesSendBudget({ req, logCtx: ctx, options });
    expect(repeated).toBeInstanceOf(Response);
    if (repeated instanceof Response) {
      expect(repeated.headers.get("x-opencodex-local-refusal")).toBe("workflow_spend_exhausted");
      expect(await repeated.text()).toContain("10");
    }
    prepaid.permit.release();
    tracker.settle(undefined);
  }));
}

for (const kind of executorKinds) {
  test(`${kind} production executor refuses NORMAL capacity before any wire call`, async () => withExecutorHome(async ledger => {
    expect(ledger.reserve({ sendId: "busy", scopes: { poolId: "P" }, inputTokens: 1, outputCeilingTokens: 0 }).reserved).toBe(true);
    let wires = 0;
    const wire = (async () => { wires++; return executorSuccess(kind); }) as typeof fetch;
    globalThis.fetch = wire;
    const ctx: RequestLogContext = { model: "model", provider: "P", spendPoolId: "P", usageLogInputTokens: 2, spendOutputCeilingTokens: 1 };
    const response = await invokeExecutor(kind, executorConfig(kind, wire), ctx);
    expect(wires).toBe(0);
    expect(response.status).toBe(429);
    expect(ctx.errorCode).toBe(kind === "messages" || kind === "chat" ? "workflow_spend_exhausted" : "workflow_tracking_exhausted");
  }, 1));

  test(`${kind} production executor books exactly one initial physical send`, async () => withExecutorHome(async (ledger, home) => {
    let wires = 0;
    const wire = (async (input) => {
      wires++;
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      expect(path).toBe(kind === "messages" ? "/v1/messages" : kind === "chat" || kind === "generic" ? "/v1/chat/completions" : kind === "compact" ? "/v1/responses/compact" : "/v1/responses");
      expect(ledger.snapshot("pool", executorPool(kind))?.reserved).toBeGreaterThan(0);
      return executorSuccess(kind);
    }) as typeof fetch;
    globalThis.fetch = wire;
    const ctx: RequestLogContext = { model: "model", provider: "P", spendPoolId: "P", usageLogInputTokens: 2, spendOutputCeilingTokens: 1 };
    const response = await invokeExecutor(kind, executorConfig(kind, wire), ctx);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(wires).toBe(1);
    ctx.spendTracker?.settle({ inputTokens: 2, outputTokens: 1 });
    await ledger.waitForReporterDrain();
    const records = (await Bun.file(join(home, "spend-ledger.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(records.filter(record => record.kind === "reserve")).toHaveLength(1);
    expect(ledger.snapshot("pool", executorPool(kind))).toMatchObject({ reserved: 0, settled: 3 });
  }));
}

for (const kind of ["chat", "messages"] as const) {
  for (const phase of ["admission", "report"] as const) test(`${kind} closes its shutdown reporter after an owner error during ${phase}`, async () => withExecutorHome(async (ledger, home) => {
    const leases: Array<{ close(): void }> = [];
    const register = ledger.registerReporter.bind(ledger);
    const registrations = spyOn(ledger, "registerReporter").mockImplementation(owner => {
      const lease = register(owner);
      leases.push(lease);
      return lease;
    });
    const error = new SpendLedgerOwnerError("SPEND_LEDGER_OWNER_UNAVAILABLE", "injected owner refusal");
    const fault = phase === "admission"
      ? spyOn(ledger, "reserveSeed").mockImplementation(() => { throw error; })
      : spyOn(ledger, "markDispatched").mockImplementation(() => { throw error; });
    const lifecycle = acquireSpendLedgerServerLifecycle(home);
    const listener = lifecycle.track({ stop: async () => {} });
    let stopping: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      let wires = 0;
      const wire = (async () => { wires++; return executorSuccess(kind); }) as typeof fetch;
      globalThis.fetch = wire;
      const ctx: RequestLogContext = { model: "model", provider: "P", spendPoolId: "P", spendInputEstimateTokens: 2, spendOutputCeilingTokens: 1 };
      const outcome = await Promise.allSettled([invokeExecutor(kind, executorConfig(kind, wire), ctx)]);
      if (outcome[0]!.status === "fulfilled") expect(outcome[0]!.value.status).toBeGreaterThanOrEqual(400);
      expect(wires).toBe(phase === "admission" ? 0 : 1);
      expect(leases).toHaveLength(1);
      fault.mockRestore();
      ledger.prune();
      let stopped = false;
      stopping = Promise.resolve(listener.stop()).then(() => { stopped = true; });
      await Promise.race([stopping, new Promise<void>(resolve => { timeout = setTimeout(resolve, 100); })]);
      expect(stopped).toBe(true);
    } finally {
      if (timeout) clearTimeout(timeout);
      fault.mockRestore();
      // Keep a failing regression from retaining the fixture's ownership. This happens only
      // after the assertion; production closure must be what lets shutdown complete above.
      for (const lease of leases) lease.close();
      await stopping;
      registrations.mockRestore();
      lifecycle.release();
    }
  }));
}

for (const kind of ["chat", "compact", "generic", "passthrough"] as const) {
  test(`${kind} production retries honor the inherited frozen physical limit`, async () => withExecutorHome(async ledger => {
    const ctx: RequestLogContext = { model: "model", provider: executorPool(kind), spendPoolId: executorPool(kind), spendInputEstimateTokens: 2, spendOutputCeilingTokens: 1 };
    const tracker = createRequestSpendTracker(ctx, undefined, ledger);
    ctx.spendTracker = tracker;
    const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 1, baseSendAllowance: 1 }, undefined, tracker);
    let wires = 0;
    const wire = (async () => { wires++; Object.assign(budget.policy, { maxTotalModelSends: 100 }); return Response.json({ error: { message: "temporary outage" } }, { status: 503 }); }) as typeof fetch;
    globalThis.fetch = wire;
    const response = await invokeExecutor(kind, executorConfig(kind, wire), ctx, budget);
    expect(response.ok).toBe(false);
    expect(wires).toBe(1);
    expect(budget.physicalStarted).toBe(1);
    expect(budget.physicalLimit).toBe(1);
    tracker.settle(undefined);
    await ledger.waitForReporterDrain();
    expect(ledger.snapshot("pool", executorPool(kind))?.reserved).toBe(0);
  }));
}

test("native Messages without a supplied budget refuses the fifth real rate-limit retry", async () => withExecutorHome(async (ledger, home) => {
  let wires = 0;
  const wire = (async () => { wires++; return Response.json({ error: { type: "rate_limit_error", message: "busy" } }, { status: 429 }); }) as typeof fetch;
  globalThis.fetch = wire;
  const config = executorConfig("messages", wire);
  config.providers.P!.retryOn429 = { attempts: 6, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false };
  const ctx: RequestLogContext = { model: "model", provider: "P" };
  const response = await invokeExecutor("messages", config, ctx);
  expect(response.status).toBe(429);
  expect(wires).toBe(4);
  ctx.spendTracker?.settle(undefined);
  await ledger.waitForReporterDrain();
  const records = (await Bun.file(join(home, "spend-ledger.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line));
  expect(records.filter(record => record.kind === "reserve")).toHaveLength(4);
  expect(ledger.snapshot("pool", "P")?.reserved).toBe(0);
}));

for (const kind of executorKinds) {
  test(`${kind} terminal settlement waits for its actual pending transport`, async () => withExecutorHome(async ledger => {
    const started = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<Response>();
    let wires = 0;
    const wire = (async () => { wires++; started.resolve(); return completion.promise; }) as typeof fetch;
    globalThis.fetch = wire;
    const ctx: RequestLogContext = { model: "model", provider: executorPool(kind), spendPoolId: executorPool(kind), usageLogInputTokens: 2, spendOutputCeilingTokens: 1 };
    const pending = invokeExecutor(kind, executorConfig(kind, wire), ctx);
    try {
      await started.promise;
      expect(wires).toBe(1);
      ctx.spendTracker!.settle(undefined);
      let drained = false;
      const drain = ledger.waitForReporterDrain().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(ledger.snapshot("pool", executorPool(kind))?.reserved).toBeGreaterThan(0);
      completion.resolve(executorSuccess(kind));
      expect((await pending).status).toBe(200);
      await drain;
      expect(ledger.snapshot("pool", executorPool(kind))?.reserved).toBe(0);
      expect(ledger.snapshot("pool", executorPool(kind))?.unresolved).toBeGreaterThan(0);
    } finally { completion.resolve(executorSuccess(kind)); await pending; }
  }));

  test(`${kind} cancellation drains its actual transport before releasing the seed`, async () => withExecutorHome(async ledger => {
    const started = Promise.withResolvers<void>();
    const controller = new AbortController();
    let wires = 0;
    const wire = (async (_input, init) => {
      wires++;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        started.resolve();
      });
    }) as typeof fetch;
    globalThis.fetch = wire;
    const ctx: RequestLogContext = { model: "model", provider: executorPool(kind), spendPoolId: executorPool(kind), usageLogInputTokens: 2, spendOutputCeilingTokens: 1 };
    const pending = invokeExecutor(kind, executorConfig(kind, wire), ctx, undefined, controller.signal);
    try {
      await started.promise;
      expect(ledger.snapshot("pool", executorPool(kind))?.reserved).toBeGreaterThan(0);
      controller.abort(new DOMException("Fixture cancellation", "AbortError"));
      const response = await pending;
      expect(response.ok).toBe(false);
      ctx.spendTracker!.settle(undefined);
      await ledger.waitForReporterDrain();
      expect(wires).toBe(1);
      expect(ledger.snapshot("pool", executorPool(kind))?.reserved).toBe(0);
      expect(ledger.snapshot("pool", executorPool(kind))?.unresolved).toBeGreaterThan(0);
    } finally { controller.abort(); await pending; }
  }));
}

type SocketListener = (event: unknown) => void;
class SpendFixtureSocket {
  static instances: SpendFixtureSocket[] = [];
  listeners = new Map<string, SocketListener[]>();
  sent: string[] = [];
  closed = false;
  constructor(_url: string, _options?: unknown) {
    SpendFixtureSocket.instances.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(type: string, listener: SocketListener) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  removeEventListener(type: string, listener: SocketListener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }
  emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send(data: string) {
    this.sent.push(data);
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "response.completed", response: {
      id: "resp_ws_fixture", status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1 },
    } }) }));
  }
  close() { if (!this.closed) { this.closed = true; this.emit("close", {}); } }
}
for (const mode of ["normal", "capacity", "exhausted-limit"] as const) {
  test(`Responses WS executor ${mode} preserves seed and count admission before response.create`, async () => withExecutorHome(async ledger => {
    const originalSocket = globalThis.WebSocket;
    SpendFixtureSocket.instances = [];
    globalThis.WebSocket = SpendFixtureSocket as unknown as typeof WebSocket;
    const translatorBudget = createTranslatorBudget();
    const ctx: RequestLogContext = { model: "model", provider: "P", spendPoolId: "P", usageLogInputTokens: 2, spendOutputCeilingTokens: 1 };
    const tracker = createRequestSpendTracker(ctx, undefined, ledger);
    ctx.spendTracker = tracker;
    const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: 1 }, undefined, tracker);
    if (mode === "capacity") expect(ledger.reserve({ sendId: "busy", scopes: { poolId: "P" }, inputTokens: 1, outputCeilingTokens: 0 }).reserved).toBe(true);
    if (mode === "exhausted-limit") {
      const report = createPhysicalSendReporter(budget, () => ({ poolId: "P" }));
      expect(report.beforeSend?.()).toBe(true); report(1); report.close?.();
      Object.assign(budget.policy, { maxTotalModelSends: 100 });
    }
    const config: OcxConfig = { port: 0, defaultProvider: "P", providers: { P: {
      adapter: "openai-responses", authMode: "key", apiKey: "fixture-only", baseUrl: "https://api.openai.com/v1", upstreamWebsocket: true,
    } } };
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "P/model", input: "hello", stream: true, max_output_tokens: 1 }),
      }), config, ctx, { sendBudget: budget, translatorBudget, codexWsRuntimeIdentity: "1.4.0" });
      const text = await response.text();
      expect(SpendFixtureSocket.instances).toHaveLength(mode === "normal" ? 1 : 0);
      if (mode === "normal") {
        expect(response.status).toBe(200);
        expect(text).toContain("response.completed");
        expect(SpendFixtureSocket.instances[0]!.sent).toHaveLength(1);
        expect(JSON.parse(SpendFixtureSocket.instances[0]!.sent[0]!).type).toBe("response.create");
        expect(budget.physicalStarted).toBe(1);
      } else expect(response.status).toBe(429);
      tracker.settle(undefined);
      await ledger.waitForReporterDrain();
    } finally {
      for (const socket of SpendFixtureSocket.instances) socket.close();
      globalThis.WebSocket = originalSocket;
      translatorBudget.dispose();
    }
  }, mode === "capacity" ? 1 : 8));
}

test("server stop waits for a native Messages transport reporter after listener stop", async () => withExecutorHome(async (ledger, home) => {
  const lifecycle = acquireSpendLedgerServerLifecycle(home);
  const wireStarted = Promise.withResolvers<void>();
  const wireCompletion = Promise.withResolvers<Response>();
  const listenerStopped = Promise.withResolvers<void>();
  const wire = (async () => { wireStarted.resolve(); return wireCompletion.promise; }) as typeof fetch;
  globalThis.fetch = wire;
  const ctx: RequestLogContext = { model: "model", provider: "P", usageLogInputTokens: 2, spendOutputCeilingTokens: 1 };
  const pending = invokeExecutor("messages", executorConfig("messages", wire), ctx);
  const listener = lifecycle.track({ async stop() { listenerStopped.resolve(); } });
  let stopping: Promise<void> | undefined;
  try {
    await wireStarted.promise;
    ctx.spendTracker!.settle(undefined);
    let finished = false;
    stopping = listener.stop().then(() => { finished = true; });
    await listenerStopped.promise;
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(ledger.snapshot("pool", "P")?.reserved).toBeGreaterThan(0);
    wireCompletion.resolve(executorSuccess("messages"));
    expect((await pending).status).toBe(200);
    await stopping;
    expect(finished).toBe(true);
    expect(ledger.snapshot("pool", "P")?.reserved).toBe(0);
  } finally {
    wireCompletion.resolve(executorSuccess("messages"));
    await pending;
    await stopping;
    lifecycle.release();
  }
}));
