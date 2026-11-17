/** Bounded Anthropic recovery through real local HTTP ingress and provider endpoints. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Server } from "bun";
import { ADAPTER_REGISTRY } from "../../../src/adapters/registry";
import { createRequestExecutionBudget } from "../../../src/lib/request-execution-budget";
import * as inference from "../../../src/server/inference/context";
import { createAnthropicInstanceFixture, type AnthropicInstanceFixture } from "../../helpers/anthropic-instance-fixture";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";

let fixture: AnthropicInstanceFixture;
let provider: Server<undefined>;
let ingress: Server<undefined>;
let releaseSpend: (() => void) | undefined;
let sends: string[];
let reply: (index: number, body: Record<string, unknown>) => Response | Promise<Response>;
let options: import("../../../src/server/responses/core-options").HandleResponsesOptions;
let budgetSpy: ReturnType<typeof spyOn> | undefined;
let adapterSpy: ReturnType<typeof spyOn> | undefined;
let lastLog: { model: string; provider: string };
const realFetch = globalThis.fetch;
const model = "claude-sonnet-4-6";

function answer(stream = false, text = "The answer is complete."): Response {
  const message = { id: "msg_roster", type: "message", role: "assistant", model,
    content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 8, output_tokens: 6 } };
  if (!stream) return Response.json(message);
  const frames = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: message.usage },
    { type: "message_stop" },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}
function refusal(): Response {
  return Response.json({ type: "error", error: { type: "rate_limit_error", message: "Synthetic roster refusal" } },
    { status: 429, headers: { "retry-after": "30", "anthropic-ratelimit-unified-5h-status": "rejected" } });
}
async function seed(count: number, start = 0) {
  for (let index = start; index < start + count; index++) await fixture.store.saveCredential("anthropic", {
    access: `synthetic-roster-${index}`, refresh: `synthetic-roster-refresh-${index}`, source: "oauth",
    expires: Date.now() + 3_600_000, accountId: `synthetic-roster-account-${index}`,
  });
  if (start === 0) await fixture.store.setActiveAccount("anthropic", fixture.store.getAccountSet("anthropic")!.accounts[0]!.id);
}
async function post(native: boolean, stream = false, signal?: AbortSignal) {
  const response = await realFetch(new URL(native ? "/v1/messages" : "/v1/responses", ingress.url), {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-caller" }, signal,
    body: JSON.stringify(native
      ? { model: `anthropic/${model}`, max_tokens: 64, stream, messages: [{ role: "user", content: "Answer briefly" }] }
      : { model: `anthropic/${model}`, stream, input: "Answer briefly" }),
  });
  return { response, text: await response.text() };
}
beforeEach(async () => {
  fixture = await createAnthropicInstanceFixture({ anthropic: { enabled: false } });
  fixture.quota.resetProviderQuotaReconcileStateForTests();
  releaseSpend = acquireOwnedSpendHome();
  sends = []; options = {};
  reply = (_index, body) => answer(body.stream === true);
  provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    sends.push(request.headers.get("authorization") ?? "");
    return reply(sends.length, await request.json() as Record<string, unknown>);
  } });
  Object.assign(fixture.config.providers.anthropic!, { models: [model],
    fetch: ((_: RequestInfo | URL, init?: RequestInit) => realFetch(provider.url, init)) as typeof fetch });
  fixture.config.protocols = { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } };
  fixture.publishConfig();
  const { handleResponses } = await import("../../../src/server/responses");
  const { handleClaudeMessages } = await import("../../../src/server/claude-messages");
  ingress = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const log = lastLog = { model: "", provider: "" };
    return new URL(request.url).pathname === "/v1/messages"
      ? handleClaudeMessages(request, fixture.config, log)
      : handleResponses(request, fixture.config, log, options);
  } });
});
afterEach(async () => {
  budgetSpy?.mockRestore(); budgetSpy = undefined;
  adapterSpy?.mockRestore(); adapterSpy = undefined;
  await ingress?.stop(true); await provider?.stop(true);
  releaseSpend?.(); releaseSpend = undefined;
  const { clearResponseStateForTests } = await import("../../../src/responses/state");
  clearResponseStateForTests();
  await fixture?.dispose();
});

for (const native of [false, true]) {
  test(`native=${native}: four fresh refusals reach healthy fifth despite shrinking eligibility`, async () => {
    await seed(6);
    const createBudget = inference.createInferenceSendBudget;
    let fundedBudget: ReturnType<typeof createBudget>;
    budgetSpy = spyOn(inference, "createInferenceSendBudget").mockImplementation((...args) => {
      fundedBudget = createBudget(...args); return fundedBudget;
    });
    reply = (index, body) => {
      expect(fundedBudget.policy.baseSendAllowance).toBe(18);
      expect(fundedBudget.policy.maxTotalModelSends).toBe(18);
      if (index <= 4) return refusal();
      expect(fixture.routing.getEligibleAnthropicAccounts()).toHaveLength(2);
      return answer(body.stream === true);
    };
    const { response, text } = await post(native);
    expect(response.status).toBe(200);
    expect(text).toContain("The answer is complete.");
    expect(sends).toEqual(Array.from({ length: 5 }, (_, index) => `Bearer synthetic-roster-${index}`));
    expect(fixture.config.anthropicAccountPool?.enabled).toBe(false);
    expect(fixture.routing.anthropicSessionAffinitySizeForTests()).toBe(0);
  });
  test(`native=${native}: zero physical-send budget refuses before initial dispatch`, async () => {
    await seed(6);
    const budget = createRequestExecutionBudget({ maxTotalModelSends: 0, baseSendAllowance: 0,
      finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
    if (native) budgetSpy = spyOn(inference, "createInferenceSendBudget").mockReturnValue(budget);
    else options.sendBudget = budget;
    const { response, text } = await post(native);
    expect(response.status).toBe(429);
    expect(text).toContain("send_budget_exhausted");
    expect(sends).toHaveLength(0);
  });
  test.each([0, 1])(`native=${native}: explicit physical ceiling includes %i prior sends`, async prior => {
    await seed(8);
    const budget = createRequestExecutionBudget({ maxTotalModelSends: 3, baseSendAllowance: 3,
      finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
    budget.used = prior;
    if (native) budgetSpy = spyOn(inference, "createInferenceSendBudget").mockReturnValue(budget);
    else options.sendBudget = budget;
    reply = () => refusal();
    const { response, text } = await post(native);
    expect(response.status).toBe(429);
    expect(text).toContain(native ? "rate_limit_error" : "Synthetic roster refusal");
    expect(budget.policy.maxTotalModelSends).toBe(3);
    expect(sends).toHaveLength(3 - prior);
  });
  test(`native=${native}: roster above six stops at finite cap and preserves final refusal`, async () => {
    await seed(8); reply = () => refusal();
    const { response, text } = await post(native);
    expect(response.status).toBe(429);
    expect(text).toContain(native ? "rate_limit_error" : "Synthetic roster refusal");
    expect(text).not.toContain("usage_limit_reached");
    expect(text).not.toContain("send_budget_exhausted");
    expect(sends).toHaveLength(6);
    expect(new Set(sends).size).toBe(6);
    expect(fixture.routing.getEligibleAnthropicAccounts()).toHaveLength(2);
  });
  test(`native=${native}: accounts added mid-turn cannot expand initial four-account snapshot`, async () => {
    await seed(4);
    reply = async index => { if (index === 1) await seed(4, 4); return refusal(); };
    const { response, text } = await post(native);
    expect(response.status).toBe(429);
    expect(text).toContain(native ? "rate_limit_error" : "Synthetic roster refusal");
    expect(sends).toHaveLength(4);
  });
  test(`native=${native}: cancellation at refusal admission sends no replacement`, async () => {
    await seed(6);
    const abort = new AbortController();
    if (native) {
      reply = () => { abort.abort(); return refusal(); };
      await expect(post(native, false, abort.signal)).rejects.toThrow();
    } else {
      options.abortSignal = abort.signal;
      reply = () => { abort.abort(); return refusal(); };
      await post(native);
    }
    expect(sends).toHaveLength(1);
  });
  test(`native=${native}: spent shared send budget retains upstream refusal`, async () => {
    await seed(6); reply = () => refusal();
    const budget = createRequestExecutionBudget({ maxTotalModelSends: 1, baseSendAllowance: 1,
      finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
    if (native) budgetSpy = spyOn(inference, "createInferenceSendBudget").mockReturnValue(budget);
    else options.sendBudget = budget;
    const { response, text } = await post(native);
    expect(response.status).toBe(429);
    expect(text).toContain(native ? "rate_limit_error" : "Synthetic roster refusal");
    expect(text).not.toContain("send_budget_exhausted");
    expect(sends).toHaveLength(1);
  });
}

test("empty continuation shares funded snapshot and reaches fifth account", async () => {
  await seed(6); fixture.config.emptyCompletionRetry = true; fixture.publishConfig();
  reply = index => index === 1 ? answer(true, "") : index <= 5 ? refusal() : answer(true);
  const { text } = await post(false, true);
  expect(text).toContain("The answer is complete.");
  expect(sends).toEqual(["Bearer synthetic-roster-0", ...Array.from({ length: 5 }, (_, index) => `Bearer synthetic-roster-${index}`)]);
});

test("empty continuation cannot rotate after shared send budget is spent", async () => {
  await seed(6); fixture.config.emptyCompletionRetry = true; fixture.publishConfig();
  const budget = createRequestExecutionBudget({ maxTotalModelSends: 2, baseSendAllowance: 2,
    finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
  options.sendBudget = budget;
  reply = index => {
    if (index === 1) return answer(true, "");
    budget.used = 2;
    return refusal();
  };
  const { text } = await post(false, true);
  expect(text).toContain("empty_completion_retry_failed");
  expect(text).not.toContain("usage_limit_reached");
  expect(sends).toEqual(["Bearer synthetic-roster-0", "Bearer synthetic-roster-0"]);
});

test("continuation after committed assistant output never replays on another account", async () => {
  await seed(6);
  reply = index => index === 1 ? answer(true, "I will modify the file now.") : refusal();
  const response = await realFetch(new URL("/v1/responses", ingress.url), { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: `anthropic/${model}`, stream: true,
      input: "Please modify the file now", tools: [{ type: "function", name: "read_file", description: "read a file", parameters: { type: "object" } }] }) });
  expect(await response.text()).toContain("I will modify the file now.");
  expect(sends).toEqual(["Bearer synthetic-roster-0", "Bearer synthetic-roster-0"]);
  expect(fixture.store.getAccountSet("anthropic")!.activeAccountId).toBe(fixture.store.getAccountSet("anthropic")!.accounts[0]!.id);
});

for (const replacementSends of [false, true]) test(`continuation refusal stays on refused account unless replacement sends (${replacementSends})`, async () => {
  await seed(3); fixture.config.emptyCompletionRetry = true; fixture.publishConfig();
  const create = ADAPTER_REGISTRY.anthropic.create;
  if (!replacementSends) adapterSpy = spyOn(ADAPTER_REGISTRY.anthropic, "create").mockImplementation((provider, context) => {
    const adapter = create(provider, context);
    if (provider.apiKey === "synthetic-roster-1") adapter.buildRequest = async () => { throw new Error("synthetic replacement setup failure"); };
    return adapter;
  });
  let refusedProvider = "";
  reply = index => {
    if (index === 1) return answer(true, "");
    if (index === 2) { refusedProvider = lastLog.provider; return refusal(); }
    return Response.json({ type: "error", error: { type: "api_error", message: "Synthetic replacement failure" } }, { status: 500 });
  };
  await post(false, true);
  expect(sends).toEqual(["Bearer synthetic-roster-0", "Bearer synthetic-roster-0",
    ...(replacementSends ? ["Bearer synthetic-roster-1"] : [])]);
  expect(refusedProvider).not.toBe("");
  if (replacementSends) expect(lastLog.provider).not.toBe(refusedProvider);
  else expect(lastLog.provider).toBe(refusedProvider);
});
