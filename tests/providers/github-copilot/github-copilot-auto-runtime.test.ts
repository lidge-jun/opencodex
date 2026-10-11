import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import type { RequestLogContext } from "../../../src/server/request-log";
import { handleResponses } from "../../../src/server/responses";
import { saveConfig } from "../../../src/config";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import { clearCopilotAutoModelsForTests } from "../../../src/providers/github-copilot-auto";
import { fetchProviderModels } from "../../../src/codex/catalog/provider-models";
import { filterCatalogVisibleModels } from "../../../src/codex/catalog/model-visibility";
import { reconcileSuccessfulModelDiscoveries } from "../../../src/providers/new-model-policy";
import type { OcxConfig } from "../../../src/types";
import { createRequestExecutionBudget } from "../../../src/lib/request-execution-budget";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const previousFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home: string;
let release: (() => void) | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-copilot-auto-"));
  process.env.OPENCODEX_HOME = home;
  clearCopilotAutoModelsForTests();
  clearGenericFailoverHealth();
  release = acquireOwnedSpendHome();
});
afterEach(() => {
  release?.();
  globalThis.fetch = previousFetch;
  clearGenericFailoverHealth();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
/** Build an Auto Responses request with caller-supplied history, stream mode, and a lookup tool for wire/continuation assertions. */
function request(input: unknown, stream = true): Request {
  return new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "github-copilot/auto", input, stream,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { name: { type: "string" } } } }] }) });
}
/** Seed two synthetic OAuth accounts in the test-owned home, select A, and return store IDs for rotation assertions. */
async function accounts() {
  for (const account of ["a", "b"]) await saveCredential("github-copilot", {
    access: `synthetic-access-${account}`, refresh: `synthetic-refresh-${account}`, expires: Date.now() + 3_600_000,
    accountId: account, apiBaseUrl: `https://${account}.githubcopilot.com`, source: "oauth",
  });
  const rows = getAccountSet("github-copilot")!.accounts;
  const a = rows.find(row => row.credential.accountId === "a")!.id;
  const b = rows.find(row => row.credential.accountId === "b")!.id;
  await setActiveAccount("github-copilot", a);
  return { a, b };
}
/** Return an Auto provider config and send ledger; options drive refusal, expiry, rotation, and tool events through both inference wires. */
function fixture(options: { nativeExpiry?: boolean; nativeFirst?: boolean; native429?: boolean; onNativeCancel?: () => void; chatRefresh?: boolean; closedNativeBody?: boolean; renewedChatRefusal?: boolean; rotate?: boolean; tool?: boolean; key?: boolean; refusal?: number; negotiationRefusal?: number; negotiationRefusalAt?: number; alwaysRefuse?: boolean; advanceAfterIntent?: () => void; onSession?: (count: number) => void; malformedSessionAt?: number; negotiationRetryAfter?: string } = {}) {
  const sent: Array<{ host: string; path: string; token: string | null; body: any; signal?: AbortSignal | null }> = [];
  let inferenceCount = 0;
  let sessionCount = 0;
  let intentCount = 0;
  let cancelledNativeBodies = 0;
  let refreshCount = 0;
  /** Emulate account-bound discovery, renewal, and inference while recording sends and asserting the selected bearer/session/model binding. */
  const executor = (async (url, init) => {
    const destination = new URL(String(url));
    if (destination.hostname === "api.github.com") {
      const refreshedAccount = new Headers(init?.headers).get("authorization")?.includes("-b") ? "b" : "a";
      if (destination.pathname === "/user") return Response.json({ login: refreshedAccount });
      refreshCount++;
      return Response.json({ token: `synthetic-access-${refreshedAccount}-renewed`, refresh_in: 1500,
        endpoints: { api: `https://${refreshedAccount}.githubcopilot.com` } });
    }
    const account = new Headers(init?.headers).get("authorization")?.includes("-b") ? "b" : "a";
    const renewed = new Headers(init?.headers).get("authorization")!.includes("-renewed");
    const expiredNative = options.nativeExpiry && intentCount > 0;
    const model = expiredNative || options.chatRefresh && renewed ? "gpt-5.4" : account === "a" ? "gpt-4o" : "gpt-5.4";
    const session = `synthetic-session-${account}${expiredNative || options.chatRefresh && renewed ? "-renewed" : ""}`;
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    expect(headers.get("authorization")).toStartWith(`Bearer synthetic-access-${account}`);
    sent.push({ host: destination.host, path: destination.pathname, token: headers.get("copilot-session-token"), body, signal: init?.signal });
    if (destination.pathname === "/models") return Response.json({ data: [{ id: model, model_picker_enabled: false,
      supported_endpoints: [options.nativeExpiry ? (expiredNative ? "/chat/completions" : "/responses") : options.native429 ? (account === "a" ? "/responses" : "/chat/completions") : options.chatRefresh ? (renewed ? "/responses" : "/chat/completions") : options.nativeFirst ? (headers.get("authorization")!.includes("-renewed") ? "/chat/completions" : "/responses") : account === "a" ? "/chat/completions" : "/responses"] }] });
    if (destination.pathname === "/models/session") {
      sessionCount++;
      options.onSession?.(sessionCount);
      if (sessionCount === options.malformedSessionAt) return Response.json({ session_token: "must-not-echo" });
      if (options.negotiationRefusal && (sessionCount === (options.negotiationRefusalAt ?? 1) || (options.alwaysRefuse && sessionCount >= (options.negotiationRefusalAt ?? 1)))) return Response.json({ token: "must-not-echo" },
        { status: options.negotiationRefusal, headers: { "retry-after": options.negotiationRetryAfter ?? "12" } });
      return Response.json({ session_token: session, expires_at: Date.now() / 1000 + 10, available_models: [model] });
    }
    if (destination.pathname === "/models/session/intent") {
      intentCount++;
      if (intentCount === 1) options.advanceAfterIntent?.();
      return Response.json({ candidate_models: [model] });
    }
    expect(body.model).toBe(model);
    expect(headers.get("copilot-session-token")).toBe(session);
    if (options.nativeExpiry && options.negotiationRefusal === 401)
      expect(headers.get("authorization")).toBe(`Bearer synthetic-access-${"a"}-renewed`);
    inferenceCount++;
    if (options.nativeFirst && options.closedNativeBody && inferenceCount === 1)
      return Response.json({ error: { message: "native-inference-secret" } }, { status: 401 });
    if (options.nativeFirst && inferenceCount === 1) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"error":{"message":"native-inference-secret"}}')); },
      cancel() { cancelledNativeBodies++; options.onNativeCancel?.(); },
    }), { status: options.native429 ? 429 : 401, headers: { "content-type": "application/json", "retry-after": "1" } });
    if (options.chatRefresh && inferenceCount === 1) return Response.json({ error: { message: "refresh" } }, { status: 401 });
    if (options.rotate && inferenceCount === 1) return Response.json({ error: { message: "limited" } }, { status: options.refusal ?? 429, headers: { "retry-after": "1" } });
    if (destination.pathname === "/responses") return Response.json({ id: "resp-fixture", model, object: "response", status: "completed",
      output: [{ id: "msg-fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 2, output_tokens: 1 } });
    if (options.renewedChatRefusal && destination.pathname === "/chat/completions")
      return Response.json({ error: { message: "must-not-echo" } }, { status: 401 });
    if ((options.nativeFirst || options.nativeExpiry) && !body.stream) return Response.json({ id: "chat-fixture", model,
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1 } });
    const tool = options.tool && inferenceCount === (options.nativeFirst ? 2 : 1);
    const delta = tool ? { tool_calls: [{ index: 0, id: "call_lookup", type: "function", function: { name: "lookup", arguments: '{"name":"file"}' } }] } : { content: "ok" };
    return new Response(`data: ${JSON.stringify({ id: "chat-fixture", model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "chat-fixture", model, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const config: OcxConfig = { port: 0, defaultProvider: "github-copilot", providers: { "github-copilot": {
    adapter: "openai-chat", authMode: options.key ? "key" : "oauth",
    ...(options.key ? { apiKey: "synthetic-access-a", apiKeyPool: [{ id: "a", key: "synthetic-access-a" }, { id: "b", key: "synthetic-access-b" }] } : {}), baseUrl: "https://api.githubcopilot.com", models: ["gpt-4o"],
    defaultModel: "gpt-4o", selectedModels: ["gpt-4o"], fetch: executor,
  } }, oauthAccountFailover: { enabled: true } } as OcxConfig;
  if (options.key || options.negotiationRefusal || options.nativeFirst || options.nativeExpiry || options.chatRefresh) globalThis.fetch = executor;
  return { config, sent, get cancelledNativeBodies() { return cancelledNativeBodies; }, get refreshCount() { return refreshCount; } };
}
describe("Copilot Auto through the Responses pipeline", () => {
  test.each([[false, false], [true, false], [false, true], [true, true]])(
    "expired native session hands off to Chat before inference with stream=%s negotiation401=%s", async (stream, negotiation401) => {
      await accounts();
      const actualNow = Date.now;
      let offset = 0;
      Date.now = () => actualNow() + offset;
      try {
        const f = fixture({ nativeExpiry: true, advanceAfterIntent: () => { offset = 61_000; },
          ...(negotiation401 ? { negotiationRefusal: 401, negotiationRefusalAt: 2 } : {}) });
        f.config.providers["github-copilot"]!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
        const logCtx: RequestLogContext = { model: "", provider: "" };
        const response = await handleResponses(request("hello", stream), f.config, logCtx);
        expect(response.status).toBe(200);
        const text = await response.text();
        if (stream) {
          expect(text).toContain("event: response.output_text.delta");
          expect(text).toContain('"delta":"ok"');
          expect(text).toContain("event: response.completed");
        } else {
          const result = JSON.parse(text);
          expect(result.object).toBe("response");
          expect(result.status).toBe("completed");
          expect(result.output[0].content[0]).toMatchObject({ type: "output_text", text: "ok" });
        }
        expect(text).not.toContain('"choices"');
        expect(text).not.toContain("must-not-echo");
        expect(logCtx.providerAdapter).toBe("openai-chat");
        expect(logCtx.model).toBe("gpt-5.4");
        const inference = f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path));
        expect(inference).toHaveLength(1);
        expect(inference[0]).toMatchObject({ path: "/chat/completions", token: "synthetic-session-a-renewed",
          body: { model: "gpt-5.4", stream } });
        expect(f.sent.filter(call => call.path === "/models/session")).toHaveLength(negotiation401 ? 3 : 2);
        expect(f.refreshCount).toBe(negotiation401 ? 1 : 0);
      } finally { Date.now = actualNow; }
    });
  test.each([false, true])("passthrough OAuth refresh migrates Responses to Chat with stream=%s", async stream => {
    await accounts();
    const f = fixture({ nativeFirst: true });
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request("hello", stream), f.config, logCtx);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(stream ? '\"delta\":\"ok\"' : '\"text\":\"ok\"');
    expect(text).not.toContain("native-inference-secret");
    expect(logCtx.providerAdapter).toBe("openai-chat");
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path)).map(call => call.path))
      .toEqual(["/responses", "/chat/completions"]);
    expect(f.sent.filter(call => call.path === "/models/session")).toHaveLength(2);
    expect(f.refreshCount).toBe(1);
    expect(f.cancelledNativeBodies).toBe(1);
    expect(f.sent.find(call => call.path === "/responses")!.signal!.aborted).toBe(true);
  });
  test.each([401, 403, 429])("passthrough refresh negotiation refusal %s stays secret-safe", async status => {
    await accounts();
    const f = fixture({ nativeFirst: true, negotiationRefusal: status, negotiationRefusalAt: 2 });
    const response = await handleResponses(request("hello", false), f.config, { model: "", provider: "" });
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.text()).not.toContain("must-not-echo");
    expect(f.refreshCount).toBe(1);
    expect(f.cancelledNativeBodies).toBe(1);
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(1);
    expect(f.sent.find(call => call.path === "/responses")!.signal!.aborted).toBe(true);
  });
  test("passthrough refresh negotiation cancellation releases the original inference", async () => {
    await accounts();
    const controller = new AbortController();
    const f = fixture({ nativeFirst: true, onSession: count => { if (count === 2) controller.abort(); } });
    const response = await handleResponses(request("hello", false), f.config, { model: "", provider: "" }, { abortSignal: controller.signal });
    expect(response.status).toBe(499);
    expect(f.refreshCount).toBe(1);
    expect(f.cancelledNativeBodies).toBe(1);
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(1);
    expect(f.sent.find(call => call.path === "/responses")!.signal!.aborted).toBe(true);
  });

  test("migrated Chat tool calls retain full-history continuation and the renewed binding", async () => {
    await accounts();
    const f = fixture({ nativeFirst: true, tool: true });
    const first = await handleResponses(request("lookup file"), f.config, { model: "", provider: "" });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("call_lookup");
    const next = await handleResponses(request([
      { role: "user", content: "lookup file" },
      { type: "function_call", call_id: "call_lookup", name: "lookup", arguments: '{"name":"file"}' },
      { type: "function_call_output", call_id: "call_lookup", output: "found" },
    ]), f.config, { model: "", provider: "" });
    expect(next.status).toBe(200);
    expect(await next.text()).toContain('"delta":"ok"');
    const calls = f.sent.filter(call => call.path === "/chat/completions");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.messages.some((message: any) => message.role === "tool"
      && message.tool_call_id === "call_lookup" && message.content === "found")).toBe(true);
    expect(f.refreshCount).toBe(1);
  });
  test("a refreshed Chat refusal cannot refresh the same request twice", async () => {
    await accounts();
    const f = fixture({ nativeFirst: true, renewedChatRefusal: true });
    const response = await handleResponses(request("hello", false), f.config, { model: "", provider: "" });
    expect(response.status).toBe(401);
    await response.text();
    expect(f.refreshCount).toBe(1);
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(2);
    expect(f.sent.filter(call => call.path === "/models/session")).toHaveLength(2);
  });
  test.each([1, 2])("wire handoff retains a total send ceiling of %s", async limit => {
    await accounts();
    const f = fixture({ nativeFirst: true, closedNativeBody: limit === 1 });
    const budget = createRequestExecutionBudget({ maxTotalModelSends: limit, baseSendAllowance: limit, finalRecoveryAllowance: 0 });
    const response = await handleResponses(request("hello", false), f.config, { model: "", provider: "" }, { sendBudget: budget });
    expect(response.status).toBe(limit === 1 ? 401 : 200);
    await response.text();
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(limit);
    expect(f.refreshCount).toBe(limit - 1);
  });
  test("passthrough refresh discards unsafe retry metadata and malformed session secrets", async () => {
    await accounts();
    const f = fixture({ nativeFirst: true, negotiationRefusal: 429, negotiationRefusalAt: 2,
      negotiationRetryAfter: "must-not-echo" });
    const response = await handleResponses(request("hello", false), f.config, { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.text()).not.toContain("must-not-echo");
    expect(f.sent.find(call => call.path === "/responses")!.signal!.aborted).toBe(true);
  });
  test("passthrough refresh malformed session remains a bounded 502", async () => {
    await accounts();
    const f = fixture({ nativeFirst: true, malformedSessionAt: 2 });
    const response = await handleResponses(request("hello", false), f.config, { model: "", provider: "" });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("must-not-echo");
    expect(f.sent.find(call => call.path === "/responses")!.signal!.aborted).toBe(true);
  });
  test("passthrough refresh request-signal cancellation has priority over a refusal", async () => {
    await accounts();
    const controller = new AbortController();
    const f = fixture({ nativeFirst: true, negotiationRefusal: 403, negotiationRefusalAt: 2,
      onSession: count => { if (count === 2) controller.abort(); } });
    const req = new Request(request("hello", false), { signal: controller.signal });
    const response = await handleResponses(req, f.config, { model: "", provider: "" });
    expect(response.status).toBe(499);
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(1);
    expect(f.sent.find(call => call.path === "/responses")!.signal!.aborted).toBe(true);
  });
  test.each([[false, false], [true, false], [false, true]])("native 429 migrates Responses to Chat stream=%s compaction=%s", async (stream, compaction) => {
    await accounts();
    const f = fixture({ nativeFirst: true, native429: true });
    await saveConfig(f.config);
    let charges = 0; let refunds = 0;
    const budget = createRequestExecutionBudget({ maxTotalModelSends: 2, baseSendAllowance: 1, finalRecoveryAllowance: 1, maxAlternateTargetSends: 1, maxTargetTransitions: 1 }, undefined, { charge: () => { charges++; return true; }, refund: () => { refunds++; } });
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request("hello", stream), f.config, logCtx, { sendBudget: budget, compactionRecoveryAttempted: compaction });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path)).map(call => [call.host, call.path]))
      .toEqual([["a.githubcopilot.com", "/responses"], ["b.githubcopilot.com", "/chat/completions"]]);
    expect(logCtx.providerAdapter).toBe("openai-chat");
    expect(budget.used).toBe(2);
    expect(charges - refunds).toBe(2);
    expect(f.cancelledNativeBodies).toBe(1);
  });
  test("cancelled native handoff refunds its unclaimed hop before adapter dispatch", async () => {
    await accounts();
    const controller = new AbortController();
    const f = fixture({ nativeFirst: true, native429: true, onNativeCancel: () => controller.abort() });
    await saveConfig(f.config);
    const budget = createRequestExecutionBudget();
    const response = await handleResponses(request("hello", false), f.config, { model: "", provider: "" }, { sendBudget: budget, abortSignal: controller.signal });
    expect(response.status).toBe(499);
    expect(budget.used).toBe(1);
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(1);
  });
  test.each([401, 403, 429])("native 429 replacement refusal %s releases its reserved send", async status => {
    await accounts();
    const f = fixture({ nativeFirst: true, native429: true, negotiationRefusal: status, negotiationRefusalAt: 2, alwaysRefuse: true });
    await saveConfig(f.config);
    const budget = createRequestExecutionBudget();
    const response = await handleResponses(request("hello", false), f.config, { model: "", provider: "" }, { sendBudget: budget });
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.text()).not.toContain("must-not-echo");
    expect(budget.used).toBe(1);
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(1);
    expect(f.sent.find(call => call.path === "/responses")!.signal!.aborted).toBe(true);
    expect(f.cancelledNativeBodies).toBe(1);
  });
  test.each([false, true])("native 429 replacement malformed/cancel=%s refunds the reservation", async cancel => {
    await accounts();
    const controller = new AbortController();
    const f = fixture({ nativeFirst: true, native429: true, malformedSessionAt: cancel ? undefined : 2,
      onSession: count => { if (cancel && count === 2) controller.abort(); } });
    await saveConfig(f.config);
    const budget = createRequestExecutionBudget();
    const response = await handleResponses(request("hello", false), f.config, { model: "", provider: "" }, { sendBudget: budget, abortSignal: controller.signal });
    expect(response.status).toBe(cancel ? 499 : 502);
    expect(await response.text()).not.toContain("must-not-echo");
    expect(budget.used).toBe(1);
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(1);
    expect(f.sent.find(call => call.path === "/responses")!.signal!.aborted).toBe(true);
  });
  test.each([false, true])("Chat inference 401 negotiates a fresh Responses session stream=%s", async stream => {
    await accounts();
    const f = fixture({ chatRefresh: true });
    const response = await handleResponses(request("hello", stream), f.config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path)).map(call => [call.path, call.body.model, call.token]))
      .toEqual([["/chat/completions", "gpt-4o", "synthetic-session-a"], ["/responses", "gpt-5.4", "synthetic-session-a-renewed"]]);
    expect(f.refreshCount).toBe(1);
    expect(f.sent.filter(call => call.path === "/models/session")).toHaveLength(2);
  });
  test.each([401, 403, 429])("Chat 401 replacement negotiation refusal %s is bounded and mapped", async status => {
    await accounts();
    const f = fixture({ chatRefresh: true, negotiationRefusal: status, negotiationRefusalAt: 2 });
    const response = await handleResponses(request("hello", false), f.config, { model: "", provider: "" });
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.text()).not.toContain("must-not-echo");
    expect(f.refreshCount).toBe(1);
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(1);
    expect(f.sent.find(call => call.path === "/chat/completions")!.signal!.aborted).toBe(true);
  });
  test("a session that expires while preparing dispatch is renewed without a second concurrency lease", async () => {
    await accounts();
    const actualNow = Date.now;
    let offset = 0;
    Date.now = () => actualNow() + offset;
    try {
      const { config, sent } = fixture({ advanceAfterIntent: () => { offset = 20_000; } });
      config.providers["github-copilot"]!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
      const response = await handleResponses(request("hello"), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"delta":"ok"');
      expect(sent.filter(call => call.path === "/models/session")).toHaveLength(2);
      expect(sent.filter(call => call.path === "/chat/completions")).toHaveLength(1);
    } finally { Date.now = actualNow; }
  });
  test("negotiation 401 refreshes OAuth once, then dispatches with the new credential", async () => {
    await accounts();
    const { config, sent } = fixture({ negotiationRefusal: 401 });
    const response = await handleResponses(request("hello"), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"delta":"ok"');
    expect(sent.filter(call => call.path === "/models/session")).toHaveLength(2);
    expect(sent.filter(call => call.path === "/chat/completions")).toHaveLength(1);
  });
  test("a second negotiation 401 stops after the one allowed OAuth refresh", async () => {
    await accounts();
    const { config, sent } = fixture({ negotiationRefusal: 401, alwaysRefuse: true });
    const response = await handleResponses(request("hello"), config, { model: "", provider: "" });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("must-not-echo");
    expect(sent.filter(call => call.path === "/models/session")).toHaveLength(2);
    expect(sent.filter(call => call.path === "/chat/completions")).toHaveLength(0);
  });
  test("OAuth rotation followed by negotiation 401 keeps the renewed account snapshot", async () => {
    await accounts();
    const { config, sent } = fixture({ rotate: true, negotiationRefusal: 401, negotiationRefusalAt: 2 });
    await saveConfig(config);
    const response = await handleResponses(request("hello", false), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text()).status).toBe("completed");
    expect(sent.filter(call => call.path === "/models/session").map(call => call.host)).toEqual([
      "a.githubcopilot.com", "b.githubcopilot.com", "b.githubcopilot.com",
    ]);
    expect(sent.filter(call => call.path === "/responses")).toHaveLength(1);
    expect(getAccountSet("github-copilot")!.accounts.find(row => row.credential.accountId === "b")!.credential.access)
      .toBe("synthetic-access-b-renewed");
  });
  test("expired-dispatch negotiation 429 uses the existing bounded recovery path", async () => {
    await accounts();
    const actualNow = Date.now;
    let offset = 0;
    Date.now = () => actualNow() + offset;
    try {
      const { config, sent } = fixture({ advanceAfterIntent: () => { offset = 20_000; },
        negotiationRefusal: 429, negotiationRefusalAt: 2 });
      await saveConfig(config);
      const response = await handleResponses(request("hello", false), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      const result = await response.json() as { status: string };
      expect(result.status).toBe("completed");
      expect(JSON.stringify(result)).not.toContain("must-not-echo");
      expect(sent.filter(call => call.path === "/models/session")).toHaveLength(3);
      expect(sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(1);
      expect(sent.find(call => call.path === "/responses")!.host).toBe("b.githubcopilot.com");
    } finally { Date.now = actualNow; }
  });
  test("negotiation 429 preserves Retry-After and never dispatches inference or echoes its body", async () => {
    await accounts();
    const { config, sent } = fixture({ negotiationRefusal: 429 });
    const response = await handleResponses(request("hello"), config, { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.text()).not.toContain("must-not-echo");
    expect(sent.filter(call => call.path === "/chat/completions")).toHaveLength(0);
  });
  test.each([401, 429])("key pool %s rotation reacquires a new session and endpoint", async status => {
    const { config, sent } = fixture({ key: true, rotate: true, refusal: status });
    await saveConfig(config);
    const response = await handleResponses(request("hello", false), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    const result = JSON.parse(await response.text());
    expect(result.status).toBe("completed");
    const inference = sent.filter(call => ["/chat/completions", "/responses"].includes(call.path));
    expect(inference.map(call => [call.path, call.body.model, call.token])).toEqual([
      ["/chat/completions", "gpt-4o", "synthetic-session-a"],
      ["/responses", "gpt-5.4", "synthetic-session-b"],
    ]);
  });

  for (const firstStatus of [401, 429]) {
    test.each([401, 403, 429])(`key ${firstStatus} replacement negotiation refusal %s is mapped safely`, async status => {
      const { config, sent } = fixture({ key: true, rotate: true, refusal: firstStatus,
        negotiationRefusal: status, negotiationRefusalAt: 2 });
      saveConfig(config);
      const response = await handleResponses(request("hello", false), config, { model: "", provider: "" });
      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe("12");
      expect(await response.text()).not.toContain("must-not-echo");
      expect(sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(1);
    });
    test(`key ${firstStatus} replacement malformed negotiation is a bounded 502`, async () => {
      const { config, sent } = fixture({ key: true, rotate: true, refusal: firstStatus, malformedSessionAt: 2 });
      saveConfig(config);
      const response = await handleResponses(request("hello", false), config, { model: "", provider: "" });
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("must-not-echo");
      expect(sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(1);
    });
    test(`key ${firstStatus} replacement negotiation cancellation is contained`, async () => {
      const controller = new AbortController();
      const { config, sent } = fixture({ key: true, rotate: true, refusal: firstStatus,
        onSession: count => { if (count === 2) controller.abort(); } });
      saveConfig(config);
      const response = await handleResponses(request("hello", false), config, { model: "", provider: "" },
        { abortSignal: controller.signal });
      expect(response.status).toBe(499);
      expect(sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(1);
    });
  }
  test("replacement negotiation discards a secret-bearing Retry-After", async () => {
    const { config } = fixture({ key: true, rotate: true, negotiationRefusal: 429,
      negotiationRefusalAt: 2, negotiationRetryAfter: "must-not-echo" });
    saveConfig(config);
    const response = await handleResponses(request("hello", false), config, { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.text()).not.toContain("must-not-echo");
  });
  test.each(["key", "oauth"])("web-search %s rotation keeps the original 429 when negotiation fails", async mode => {
    if (mode === "oauth") await accounts();
    const { config, sent } = fixture({ key: mode === "key", rotate: true, negotiationRefusal: 403, negotiationRefusalAt: 2 });
    config.webSearchSidecar = { backend: "exa", exaApiKey: "synthetic-search-key" };
    saveConfig(config);
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "github-copilot/auto", input: "hello", stream: false, tools: [{ type: "web_search" }] }) });
    const response = await handleResponses(req, config, { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("limited");
    expect(sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(1);
    expect(sent.filter(call => call.path === "/models/session")).toHaveLength(2);
  });

  test("Auto-only catalog retains manual preferences and requires explicit picker selection", async () => {
    await accounts();
    const { config } = fixture();
    const provider = config.providers["github-copilot"]!;
    const models = await fetchProviderModels("github-copilot", provider, 1000);
    expect(models.map(model => model.id)).toEqual(["auto"]);
    expect(provider.defaultModel).toBe("gpt-4o");
    expect(provider.selectedModels).toEqual(["gpt-4o"]);
    expect(filterCatalogVisibleModels(models, config)).toEqual([]);
    provider.selectedModels = ["auto"];
    expect(filterCatalogVisibleModels(models, config).map(model => model.id)).toEqual(["auto"]);
    provider.initialModelSelection = { version: 1, registrationId: "00000000-0000-4000-8000-000000000000", status: "pending" };
    expect(filterCatalogVisibleModels(models, config)).toEqual([]);
    provider.initialModelSelection.status = "ready";
    expect(filterCatalogVisibleModels(models, config).map(model => model.id)).toEqual(["auto"]);
    provider.disabled = true;
    expect(filterCatalogVisibleModels(models, config)).toEqual([]);
  });
  test("an existing Off-policy baseline disables new Auto until the operator enables it", async () => {
    await accounts();
    const { config } = fixture();
    delete config.providers["github-copilot"]!.selectedModels;
    config.modelDiscovery = { newModelPolicy: "off", knownModels: {
      "github-copilot": { ids: ["gpt-4o"], removed: [], updatedAt: "2026-01-01T00:00:00Z" },
    } };
    const models = await fetchProviderModels("github-copilot", config.providers["github-copilot"]!, 1000);
    reconcileSuccessfulModelDiscoveries({ config, models, authoritativeProviders: ["github-copilot"],
      now: "2026-10-02T00:00:00Z", mode: "discovery" });
    expect(config.disabledModels).toEqual(["github-copilot/auto"]);
    expect(config.modelDiscovery.recentArrivals?.["github-copilot"]).toEqual([{ id: "auto", at: "2026-10-02T00:00:00Z" }]);
    expect(filterCatalogVisibleModels(models, config)).toEqual([]);
    config.disabledModels = [];
    reconcileSuccessfulModelDiscoveries({ config, models, authoritativeProviders: ["github-copilot"],
      now: "2026-10-02T00:01:00Z", mode: "discovery" });
    expect(config.disabledModels).toEqual([]);
    expect(filterCatalogVisibleModels(models, config).map(model => model.id)).toEqual(["auto"]);
    config.disabledModels = ["github-copilot/auto"];
    reconcileSuccessfulModelDiscoveries({ config, models, authoritativeProviders: ["github-copilot"],
      now: "2026-10-02T00:02:00Z", mode: "discovery" });
    expect(config.disabledModels).toEqual(["github-copilot/auto"]);
    expect(filterCatalogVisibleModels(models, config)).toEqual([]);
  });
  test("streamed function calls and their result history use existing Chat adapter", async () => {
    await accounts();
    const { config, sent } = fixture({ tool: true });
    const first = await handleResponses(request("look up file"), config, { model: "", provider: "" });
    expect(first.status).toBe(200);
    const stream = await first.text();
    expect(stream).toContain("response.function_call_arguments.done");
    expect(stream).toContain("call_lookup");
    const second = await handleResponses(request([
      { role: "user", content: "look up file" },
      { type: "function_call", call_id: "call_lookup", name: "lookup", arguments: '{"name":"file"}' },
      { type: "function_call_output", call_id: "call_lookup", output: "found" },
    ]), config, { model: "", provider: "" });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("ok");
    const inference = sent.filter(call => call.path === "/chat/completions");
    expect(inference).toHaveLength(2);
    expect(inference[1]!.body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "call_lookup" && message.content === "found")).toBe(true);
    expect(sent.filter(call => call.path === "/models/session")).toHaveLength(2);
  });
  test("429 rotation reacquires account-bound Auto session and switches to Responses wire", async () => {
    await accounts();
    const { config, sent } = fixture({ rotate: true });
    await saveConfig(config);
    const response = await handleResponses(request("hello", false), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    const resultText = await response.text();
    expect(JSON.parse(resultText).status).toBe("completed");
    expect(JSON.parse(resultText).output[0].content[0].text).toBe("ok");
    const inference = sent.filter(call => ["/chat/completions", "/responses"].includes(call.path));
    expect(inference.map(call => [call.host, call.path, call.body.model, call.token])).toEqual([
      ["a.githubcopilot.com", "/chat/completions", "gpt-4o", "synthetic-session-a"],
      ["b.githubcopilot.com", "/responses", "gpt-5.4", "synthetic-session-b"],
    ]);
    expect(sent.filter(call => call.path === "/models/session").map(call => call.host)).toEqual(["a.githubcopilot.com", "b.githubcopilot.com"]);
  });
});

for (const bDiscovery of ["named", "outage"] as const) test(`leaving Auto on account rotation restores the configured Chat wire (${bDiscovery} discovery)`, async () => {
  await accounts();
  const sent: Array<{ account: string; path: string; model?: string; token: string | null; apiVersion: string | null }> = [];
  const executor = (async (url, init) => {
    const destination = new URL(String(url));
    const headers = new Headers(init?.headers);
    const account = headers.get("authorization")?.includes("-b") ? "b" : "a";
    if (destination.hostname === "api.github.com") return Response.json({ login: account });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    sent.push({ account, path: destination.pathname, model: body.model, token: headers.get("copilot-session-token"),
      apiVersion: headers.get("x-github-api-version") });
    if (destination.pathname === "/models" && account === "b" && bDiscovery === "outage")
      return Response.json({ error: { message: "unavailable" } }, { status: 503 });
    if (destination.pathname === "/models") return Response.json({ data: account === "a"
      ? [{ id: "gpt-5.4", model_picker_enabled: false, supported_endpoints: ["/responses"] }]
      : [{ id: "gpt-4o", model_picker_enabled: true, supported_endpoints: ["/chat/completions"] }] });
    if (destination.pathname === "/models/session")
      return Response.json({ session_token: "synthetic-session-a", expires_at: Date.now() / 1000 + 10, available_models: ["gpt-5.4"] });
    if (destination.pathname === "/models/session/intent") return Response.json({ candidate_models: ["gpt-5.4"] });
    if (account === "a") return Response.json({ error: { message: "limited" } }, { status: 429, headers: { "retry-after": "1" } });
    if (destination.pathname !== "/chat/completions") return Response.json({ error: { message: "wrong wire" } }, { status: 404 });
    return Response.json({ id: "chat-fixture", model: "gpt-4o", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1 } });
  }) as typeof fetch;
  globalThis.fetch = executor;
  const config = { port: 0, defaultProvider: "github-copilot", providers: { "github-copilot": {
    adapter: "openai-chat", authMode: "oauth", baseUrl: "https://api.githubcopilot.com", models: ["gpt-4o"],
    defaultModel: "gpt-4o", selectedModels: ["gpt-4o"], fetch: executor,
  } }, oauthAccountFailover: { enabled: true } } as OcxConfig;
  await saveConfig(config);
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "github-copilot/gpt-4o", input: "hello", stream: false }) }), config, { model: "", provider: "" });
  expect(response.status).toBe(200);
  const inference = sent.filter(call => ["/chat/completions", "/responses"].includes(call.path));
  expect(inference.map(call => [call.account, call.path, call.model])).toEqual([
    ["a", "/responses", "gpt-5.4"],
    ["b", "/chat/completions", "gpt-4o"],
  ]);
  const named = inference[1]!;
  expect(named.token).toBeNull();
  expect(named.apiVersion).not.toBe("2026-08-01");
});


