import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import type { RequestLogContext } from "../../../src/server/request-log";
import { handleResponses } from "../../../src/server/responses";
import { handleChatCompletions } from "../../../src/server/chat-completions";
import { handleClaudeMessages } from "../../../src/server/claude-messages";
import { saveConfig } from "../../../src/config";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import { clearCopilotAutoModelsForTests } from "../../../src/providers/github-copilot-auto";
import { fetchProviderModels } from "../../../src/codex/catalog/provider-models";
import { filterCatalogVisibleModels } from "../../../src/codex/catalog/model-visibility";
import { reconcileSuccessfulModelDiscoveries } from "../../../src/providers/new-model-policy";
import type { OcxConfig } from "../../../src/types";
import { createRequestExecutionBudget } from "../../../src/lib/request-execution-budget";
import { createSpendReservationLedger } from "../../../src/lib/spend-reservation-ledger";
import { createRequestSpendTracker } from "../../../src/server/responses/request-spend";
import { createInferenceSendBudget } from "../../../src/server/inference/context";
import { spendTestJournal, spendTestPolicy, testSpendSalt } from "../../helpers/shipped-spend-ledger";
import { isNonReplayableResponse } from "../../../src/lib/upstream-retry";
import { clearComboSelectionState } from "../../../src/combos/resolve";
import { clearComboTargetCooldowns, isComboTargetInCooldown } from "../../../src/combos/failover";
import { clearFallbackEventsForTests, recentFallbackEvents } from "../../../src/routing/fallback-policy";
import { closeRequestHistoryIndex } from "../../../src/routing/history/indexer";
import { clearResponseStateForTests, flushResponseState } from "../../../src/responses/state";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeAfterBackgroundWork } from "../../helpers/remove-tree";

const previousFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home: string;
let release: (() => void) | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-copilot-auto-"));
  process.env.OPENCODEX_HOME = home;
  clearCopilotAutoModelsForTests();
  clearGenericFailoverHealth();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearResponseStateForTests();
  release = acquireOwnedSpendHome();
});
afterEach(async () => {
  try {
    await flushResponseState();
    closeRequestHistoryIndex();
    release?.();
    release = undefined;
    await removeTreeAfterBackgroundWork(home);
  } finally {
    release?.();
    release = undefined;
    globalThis.fetch = previousFetch;
    closeRequestHistoryIndex();
    clearResponseStateForTests();
    clearGenericFailoverHealth();
    clearComboSelectionState();
    clearComboTargetCooldowns();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  }
}, 35_000); // Background settlement and removal each have a 15s bound, plus scheduling headroom.
/** Build an Auto Responses request with caller-supplied history, stream mode, and a lookup tool for wire/continuation assertions. */
function request(input: unknown, stream = true, overrides: { model?: string; tool_choice?: unknown; tools?: unknown[] } = {}): Request {
  return new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "github-copilot/auto", input, stream,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { name: { type: "string" } } } }], ...overrides }) });
}

function scopedAdmission(config: OcxConfig, allowedModels: string[]) {
  config.apiKeys = [{ id: "copilot-scope", name: "fixture", allowedModels }] as OcxConfig["apiKeys"];
  return { kind: "configured" as const, keyId: "copilot-scope", source: "bearer" as const };
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
function fixture(options: { pauseRefusal?: boolean; chatOnly?: boolean; nativeExpiry?: boolean; nativeFirst?: boolean; native429?: boolean; onNativeCancel?: () => void; chatRefresh?: boolean; closedNativeBody?: boolean; renewedChatRefusal?: boolean; rotate?: boolean; rotateAt?: number; tool?: boolean; key?: boolean; refusal?: number; negotiationRefusal?: number; negotiationRefusalAt?: number; alwaysRefuse?: boolean; advanceAfterIntent?: () => void | Promise<void>; onSession?: (count: number) => void | Promise<void>; malformedSessionAt?: number; negotiationRetryAfter?: string; replyText?: string; onInference?: (count: number) => void | Promise<void> } = {}) {
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
      supported_endpoints: [options.chatOnly ? "/chat/completions" : options.nativeExpiry ? (expiredNative ? "/chat/completions" : "/responses") : options.native429 ? (account === "a" ? "/responses" : "/chat/completions") : options.chatRefresh ? (renewed ? "/responses" : "/chat/completions") : options.nativeFirst ? (headers.get("authorization")!.includes("-renewed") ? "/chat/completions" : "/responses") : account === "a" ? "/chat/completions" : "/responses"] }] });
    if (destination.pathname === "/models/session") {
      sessionCount++;
      await options.onSession?.(sessionCount);
      if (sessionCount === options.malformedSessionAt) return Response.json({ session_token: "must-not-echo" });
      if (options.negotiationRefusal && (sessionCount === (options.negotiationRefusalAt ?? 1) || (options.alwaysRefuse && sessionCount >= (options.negotiationRefusalAt ?? 1)))) return Response.json({ token: "must-not-echo" },
        { status: options.negotiationRefusal, headers: { "retry-after": options.negotiationRetryAfter ?? "12" } });
      return Response.json({ session_token: session, expires_at: Date.now() / 1000 + 10, available_models: [model] });
    }
    if (destination.pathname === "/models/session/intent") {
      intentCount++;
      if (intentCount === 1) await options.advanceAfterIntent?.();
      return Response.json({ candidate_models: [model] });
    }
    expect(body.model).toBe(model);
    expect(headers.get("copilot-session-token")).toBe(session);
    if (options.nativeExpiry && options.negotiationRefusal === 401)
      expect(headers.get("authorization")).toBe(`Bearer synthetic-access-${"a"}-renewed`);
    inferenceCount++;
    await options.onInference?.(inferenceCount);
    if (options.pauseRefusal && inferenceCount === 1) return Response.json({ error: {
      type: "permission_error", message: "OAuth authentication is currently not allowed for this organization",
    } }, { status: 403 });
    if (options.nativeFirst && options.closedNativeBody && inferenceCount === 1)
      return Response.json({ error: { message: "native-inference-secret" } }, { status: 401 });
    if (options.nativeFirst && inferenceCount === 1) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"error":{"message":"native-inference-secret"}}')); },
      cancel() { cancelledNativeBodies++; options.onNativeCancel?.(); },
    }), { status: options.native429 ? 429 : 401, headers: { "content-type": "application/json", "retry-after": "1" } });
    if (options.chatRefresh && inferenceCount === 1) return Response.json({ error: { message: "refresh" } }, { status: 401 });
    if (options.rotate && inferenceCount === (options.rotateAt ?? 1)) return Response.json({ error: { message: "limited" } }, { status: options.refusal ?? 429, headers: { "retry-after": "1" } });
    if (destination.pathname === "/responses") return Response.json({ id: "resp-fixture", model, object: "response", status: "completed",
      output: [{ id: "msg-fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 2, output_tokens: 1 } });
    if (options.renewedChatRefusal && destination.pathname === "/chat/completions")
      return Response.json({ error: { message: "must-not-echo" } }, { status: 401 });
    if ((options.chatOnly || options.nativeFirst || options.nativeExpiry) && !body.stream) return Response.json({ id: "chat-fixture", model,
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1 } });
    const tool = options.tool && inferenceCount === (options.nativeFirst ? 2 : 1);
    const delta = tool ? { tool_calls: [{ index: 0, id: "call_lookup", type: "function", function: { name: "lookup", arguments: '{"name":"file"}' } }] } : { content: options.replyText ?? "ok" };
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
  test.each(["Chat", "Messages"])("%s retains the local mandatory-tool refusal after Copilot OAuth refresh", async wire => {
    await accounts();
    const f = fixture({ chatRefresh: true, chatOnly: true });
    f.config.providers["github-copilot"]!.autoToolChoiceOnlyModels = ["gpt-5.4"];
    const req = new Request(`http://localhost/v1/${wire === "Chat" ? "chat/completions" : "messages"}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "github-copilot/auto", messages: [{ role: "user", content: "Use lookup." }], stream: false,
        ...(wire === "Chat" ? {
          tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }], tool_choice: "required",
        } : { max_tokens: 64, tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }], tool_choice: { type: "tool", name: "lookup" } }) }) });
    const response = await (wire === "Chat" ? handleChatCompletions : handleClaudeMessages)(req, f.config, {});
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.message).toContain("mandatory tool_choice cannot be preserved");
    expect(f.sent.filter(call => call.path === "/models/session/intent").map(call => call.host))
      .toEqual(["a.githubcopilot.com", "a.githubcopilot.com"]);
    expect(f.sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(1);
    expect(f.refreshCount).toBe(1);
  });
  test("mandatory tool choice uses the negotiated Responses wire instead of the initial Chat route", async () => {
    const { b } = await accounts();
    await setActiveAccount("github-copilot", b);
    const f = fixture(), choice = { type: "computer_use" };
    const response = await handleResponses(request("hello", false, { tool_choice: choice, tools: [choice] }), f.config, {});
    expect(response.status, await response.text()).toBe(200);
    expect(f.sent.some(call => call.path === "/models/session/intent")).toBe(true);
    expect(f.sent.filter(call => call.path === "/chat/completions")).toHaveLength(0);
    expect(f.sent.find(call => call.path === "/responses")?.body.tool_choice).toEqual(choice);
  });
  test("mandatory tool choice refuses a negotiated Chat wire after an initial Responses route", async () => {
    await accounts();
    const f = fixture(), choice = { type: "computer_use" };
    const log: RequestLogContext = {};
    const response = await handleResponses(request("hello", true, {
      model: "github-copilot/gpt-5.4", tool_choice: choice, tools: [choice],
    }), f.config, log);
    const body = await response.text();
    expect(response.status).toBe(400);
    expect(body).toContain("mandatory tool_choice cannot be preserved");
    expect(f.sent.some(call => call.path === "/models/session/intent")).toBe(true);
    expect(f.sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(0);
    expect(log.model).toBe("gpt-5.4");
    expect(log.activeAttempt?.model).not.toBe("gpt-4o");
  });
  test.each([["combo", false, false], ["policy", false, false], ["combo", true, false], ["policy", true, false],
    ["combo", true, true], ["policy", true, true]] as const)(
    "mandatory tool choice negotiates a %s child and hops its local refusal (mid-dispatch=%s translated=%s)", async (mode, midDispatch, translated) => {
    const { a, b } = await accounts();
    if (midDispatch) await setActiveAccount("github-copilot", translated ? a : b);
    const f = fixture(midDispatch ? { chatOnly: translated,
      advanceAfterIntent: async () => { await setActiveAccount("github-copilot", translated ? b : a); } } : {});
    if (translated) f.config.providers["github-copilot"]!.autoToolChoiceOnlyModels = ["gpt-5.4"];
    const choice = translated ? { type: "function", name: "lookup" } : { type: "mcp", server_label: "remote", name: "shell" };
    const mcp = { type: "mcp", server_label: "remote", server_url: "https://mcp.example.test", require_approval: "never" };
    const tools = translated ? [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }] : [mcp];
    const fallbackBodies: any[] = [];
    const output = translated ? [{ id: "call_fixture", type: "function_call", status: "completed", call_id: "lookup_fixture", name: "lookup", arguments: "{}" }]
      : [{ id: "mcp_fixture", type: "mcp_call", status: "completed", server_label: "remote", name: "shell", arguments: "{}", output: "done" }];
    f.config.providers.fallback = { adapter: "openai-responses", authMode: "key", apiKey: "fixture",
      baseUrl: "https://fallback.example.test/v1", fetch: async (_url, init) => {
        fallbackBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "resp_fallback", object: "response", status: "completed", model: "fallback-model", output });
      } };
    f.config.combos = { mandatoryAuto: { strategy: "failover", targets: [
      { provider: "github-copilot", model: "auto" }, { provider: "fallback", model: "fallback-model" },
    ] } };
    f.config.routingProfiles = { mandatoryAuto: { candidates: [
      { provider: "github-copilot", model: "auto" }, { provider: "fallback", model: "fallback-model" },
    ] } };
    const log: RequestLogContext = {};
    const spendTargets: Array<{ poolId?: string; identityId?: string }> = [];
    const budget = mode === "policy" ? createRequestExecutionBudget(undefined, undefined, {
      startRequest: target => { spendTargets.push({ ...target }); }, charge: () => true, refund: () => {},
    }) : undefined;
    const response = await handleResponses(request("hello", false, {
      model: `${mode}/mandatoryAuto`, tool_choice: choice, tools,
    }), f.config, log, { sendBudget: budget });
    const body = await response.json();
    expect(response.status).toBe(200); expect(body.output).toEqual(output);
    expect(f.sent.some(call => call.path === "/models/session/intent")).toBe(true);
    if (midDispatch) expect(f.sent.filter(call => call.path === "/models/session/intent").map(call => call.host))
      .toEqual(translated ? ["a.githubcopilot.com", "b.githubcopilot.com"] : ["b.githubcopilot.com", "a.githubcopilot.com"]);
    expect(f.sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(0);
    expect(fallbackBodies).toHaveLength(1); expect(fallbackBodies[0].tool_choice).toEqual(choice);
    expect(fallbackBodies[0].tools).toEqual(tools); expect(log.provider).toBe(mode === "combo" ? "combo" : "fallback");
    // The generic key route keeps its existing pre-key-commit identity, never Copilot's candidate.
    if (mode === "policy") expect(spendTargets.at(-1)).toEqual({ poolId: "fallback", identityId: undefined });
    if (mode === "combo") {
      expect(isComboTargetInCooldown("mandatoryAuto", { provider: "github-copilot", model: "auto" })).toBe(false);
      clearComboSelectionState(); // Reset selection history, retaining any real target cooldown.
      const compatible = await handleResponses(request("hello", true, { model: "combo/mandatoryAuto" }), f.config, {});
      expect(compatible.status).toBe(200);
      await compatible.text();
      expect(f.sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(1);
      expect(fallbackBodies).toHaveLength(1);
    }
  });
  test("policy fallback treats a post-send renegotiation refusal as a taken hop", async () => {
    // The Copilot child sends once, takes a 401, refreshes its OAuth credential, and only THEN
    // learns the renewed negotiation settled on a Chat wire that cannot preserve tool_choice.
    // That refusal is not a pre-send skip: the hop it rode must commit, and the next candidate's
    // hop is guarded FROM github-copilot — the provider scope an operator can switch off.
    await accounts();
    const f = fixture({ chatRefresh: true, chatOnly: true });
    f.config.providers["github-copilot"]!.autoToolChoiceOnlyModels = ["gpt-5.4"];
    let primarySends = 0, tailSends = 0;
    f.config.providers.primary = { adapter: "openai-chat", authMode: "key", apiKey: "fixture",
      baseUrl: "https://primary.example.test/v1", models: ["m1"], fetch: async () => { primarySends++;
        return Response.json({ error: { type: "rate_limit_error", message: "limited" } }, { status: 429 }); } };
    f.config.providers.tail = { adapter: "openai-chat", authMode: "key", apiKey: "fixture",
      baseUrl: "https://tail.example.test/v1", models: ["m3"], fetch: async () => { tailSends++;
        return Response.json({ id: "chat-tail", object: "chat.completion", choices: [{ index: 0,
          message: { role: "assistant", content: "tail" }, finish_reason: "stop" }] }); } };
    f.config.fallback = { providers: { "github-copilot": { provider: false } } };
    f.config.routingProfiles = { postSend: { candidates: [
      { provider: "primary", model: "m1" },
      { provider: "github-copilot", model: "auto" },
      { provider: "tail", model: "m3" },
    ] } };
    clearFallbackEventsForTests();
    const response = await handleResponses(request("hello", false, {
      model: "policy/postSend", tool_choice: "required",
    }), f.config, {});
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("fallback_refused");
    expect(body.error.fallback).toMatchObject({ kind: "provider", scope: "provider",
      scopeKey: "github-copilot", from: "github-copilot/auto", to: "tail/m3" });
    expect(f.refreshCount).toBe(1);
    expect(f.sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(1);
    expect(primarySends).toBeGreaterThanOrEqual(1);
    expect(tailSends).toBe(0);
    expect(recentFallbackEvents().map(event => ({ from: event.from, to: event.to, outcome: event.outcome })))
      .toEqual([
        { from: "primary/m1", to: "github-copilot/auto", outcome: "taken" },
        { from: "github-copilot/auto", to: "tail/m3", outcome: "refused" },
      ]);
  });
  test("negotiated Chat refuses required with an empty translated catalog before inference", async () => {
    await accounts();
    const f = fixture();
    const response = await handleResponses(request("hello", false, {
      tool_choice: "required", tools: [{ type: "computer_use" }],
    }), f.config, {});
    expect(response.status, await response.text()).toBe(400);
    expect(f.sent.filter(call => call.path === "/models/session/intent")).toHaveLength(1);
    expect(f.sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(0);
  });
  test("a denied combo send reservation retains the local refusal instead of claiming target exhaustion", async () => {
    await accounts();
    let reservations = 0;
    const budget = createRequestExecutionBudget(undefined, undefined, {
      charge: () => ++reservations === 1, refund: () => {},
    });
    const f = fixture();
    let fallbackCalls = 0;
    f.config.providers.fallback = { adapter: "openai-responses", authMode: "key", apiKey: "fixture",
      baseUrl: "https://fallback.example.test/v1", fetch: async () => { fallbackCalls++; return Response.json({ status: "completed", output: [] }); } };
    f.config.combos = { mandatoryAuto: { strategy: "failover", targets: [
      { provider: "github-copilot", model: "auto" }, { provider: "fallback", model: "fallback-model" },
    ] } };
    const response = await handleResponses(request("hello", false, {
      model: "combo/mandatoryAuto", tool_choice: { type: "mcp", server_label: "remote", name: "shell" },
      tools: [{ type: "mcp", server_label: "remote", server_url: "https://mcp.example.test" }],
    }), f.config, {}, { sendBudget: budget });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("cannot preserve mandatory tool_choice");
    expect(fallbackCalls).toBe(0);
    expect(reservations).toBe(2);
    expect(budget.used).toBe(0);
    expect(f.sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(0);
  });
  test.each(["combo", "policy"] as const)("%s exhaustion identifies mandatory tool incompatibility without inference", async mode => {
    await accounts();
    const f = fixture();
    const targets = [{ provider: "github-copilot", model: "auto" }];
    f.config.combos = { mandatoryAuto: { strategy: "failover", targets } };
    f.config.routingProfiles = { mandatoryAuto: { candidates: targets } };
    const response = await handleResponses(request("hello", false, {
      model: `${mode}/mandatoryAuto`, tool_choice: { type: "mcp", server_label: "remote", name: "shell" },
      tools: [{ type: "mcp", server_label: "remote", server_url: "https://mcp.example.test" }],
    }), f.config, {});
    const body = await response.json();
    expect(response.status).toBe(mode === "combo" ? 503 : 400);
    expect(body.error.message).toContain("mandatory tool_choice");
    expect(f.sent.filter(call => call.path === "/models/session/intent")).toHaveLength(1);
    expect(f.sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(0);
    expect(isComboTargetInCooldown("mandatoryAuto", targets[0]!)).toBe(false);
  });
  test.each([["combo", false], ["combo", true], ["policy", false], ["policy", true]] as const)(
    "%s mixed exhaustion does not claim all targets refused tools (upstream-first=%s)", async (mode, upstreamFirst) => {
    await accounts();
    const f = fixture();
    let fallbackCalls = 0;
    f.config.providers.fallback = { adapter: "openai-responses", authMode: "key", apiKey: "fixture",
      baseUrl: "https://fallback.example.test/v1", transientRetryOn5xx: { attempts: 1 }, fetch: async () => {
        fallbackCalls++;
        return Response.json({ error: { type: "upstream_error", message: "synthetic failure" } }, { status: 500 });
      } };
    const targets = [{ provider: "github-copilot", model: "auto" }, { provider: "fallback", model: "fallback-model" }];
    if (upstreamFirst) targets.reverse();
    f.config.combos = { mandatoryAuto: { strategy: "failover", targets } };
    f.config.routingProfiles = { mandatoryAuto: { candidates: targets } };
    const response = await handleResponses(request("hello", false, {
      model: `${mode}/mandatoryAuto`, tool_choice: { type: "mcp", server_label: "remote", name: "shell" },
      tools: [{ type: "mcp", server_label: "remote", server_url: "https://mcp.example.test" }],
    }), f.config, {});
    expect(response.status).toBe(mode === "combo" && upstreamFirst ? 409 : 500);
    expect(await response.text()).not.toContain("cannot preserve mandatory tool_choice");
    expect(fallbackCalls).toBe(1);
    expect(f.sent.filter(call => call.path === "/models/session/intent")).toHaveLength(1);
    expect(f.sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(0);
  });
  test.each([false, true])("auto-pause negotiation refusal stays local after native=%s inference", async native => {
    const { a, b } = await accounts();
    const log: RequestLogContext = {};
    let sentIdentity: Pick<RequestLogContext, "model" | "accountLogLabel" | "providerAdapter"> | undefined;
    let sentAttemptModel: string | undefined;
    const f = fixture({ pauseRefusal: true, native429: native, chatOnly: !native,
      onInference: async () => {
        sentIdentity = { model: log.model, accountLogLabel: log.accountLogLabel, providerAdapter: log.providerAdapter };
        sentAttemptModel = log.activeAttempt?.model;
        await setActiveAccount("github-copilot", b);
      } });
    f.config.providers["github-copilot"]!.accountAutoPause = { enabled: true, consecutiveFailures: 1 };
    if (!native) f.config.providers["github-copilot"]!.autoToolChoiceOnlyModels = ["gpt-5.4"];
    saveConfig(f.config);
    const choice = native ? { type: "mcp", server_label: "remote", name: "shell" } : { type: "function", name: "lookup" };
    const tools = native ? [{ type: "mcp", server_label: "remote", server_url: "https://mcp.example.test" }]
      : [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
    const budget = createRequestExecutionBudget();
    const response = await handleResponses(request("hello", false, { tool_choice: choice, tools }), f.config, log, { sendBudget: budget });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("mandatory tool_choice cannot be preserved");
    expect(f.sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(1);
    expect(f.sent.filter(call => call.path === "/models/session/intent").map(call => call.host))
      .toEqual(["a.githubcopilot.com", "b.githubcopilot.com"]);
    expect(getAccountSet("github-copilot")!.accounts.find(account => account.id === a)?.paused).toBe(true);
    expect(budget.used).toBe(1);
    expect(sentIdentity?.model).toBe("gpt-4o");
    expect(log.model).toBe(sentIdentity?.model);
    expect(log.accountLogLabel).toBe(sentIdentity?.accountLogLabel);
    expect(log.providerAdapter).toBe(sentIdentity?.providerAdapter);
    expect(log.activeAttempt?.model).toBe(sentAttemptModel);
    expect(getAccountSet("github-copilot")!.activeAccountId).toBe(b);
  });
  test.each([false, true])("Copilot funds only ingress-owned roster budgets before sending (ingress=%s)", async ingress => {
    await accounts();
    const req = request("hello", false), log: RequestLogContext = {};
    const budget = ingress ? createInferenceSendBudget(req, log) : createRequestExecutionBudget({
      maxTotalModelSends: 2, baseSendAllowance: 2, finalRecoveryAllowance: 0, maxAlternateTargetSends: 1, maxTargetTransitions: 1,
    });
    let ceilingAtSend: number | undefined;
    const f = fixture({ chatOnly: true, onInference: () => { ceilingAtSend = budget.policy.maxTotalModelSends; } });
    try {
      const response = await handleResponses(req, f.config, log, { sendBudget: budget });
      expect(response.status, await response.text()).toBe(200);
      expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(1);
      expect(ceilingAtSend).toBe(ingress ? 6 : 2);
      expect(budget.policy.maxTotalModelSends).toBe(ingress ? 6 : 2);
    } finally { log.spendTracker?.settle(undefined); }
  });
  test.each([false, true])("accepted account negotiation preserves physical attribution (deny B=%s)", async deny => {
    const { a, b } = await accounts();
    const log: RequestLogContext = { provider: "github-copilot", spendInputEstimateTokens: 1 };
    let firstLabel: string | undefined;
    const targets: Array<string | undefined> = [];
    const tracker = createRequestSpendTracker(log, undefined, createSpendReservationLedger({
      journal: spendTestJournal(), salt: testSpendSalt, policy: spendTestPolicy({ pool: { maxTokens: 100_000 } }),
    }));
    const budget = createRequestExecutionBudget(undefined, undefined, { ...tracker,
      ensureSeed: (target, proof) => {
        targets.push(target.identityId);
        if (deny && firstLabel && target.identityId && target.identityId !== firstLabel) return undefined;
        return tracker.ensureSeed(target, proof);
      },
    });
    const f = fixture({ chatOnly: true, pauseRefusal: true, onInference: async count => {
      if (count === 1) { firstLabel = log.accountLogLabel; await setActiveAccount("github-copilot", b); }
    } });
    f.config.providers["github-copilot"]!.accountAutoPause = { enabled: true, consecutiveFailures: 1 };
    saveConfig(f.config);
    try {
      const response = await handleResponses(request("hello", false), f.config, log, { sendBudget: budget });
      const text = await response.text();
      expect(response.status, text).toBe(deny ? 429 : 200);
      expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path)).map(call => call.body.model))
        .toEqual(deny ? ["gpt-4o"] : ["gpt-4o", "gpt-5.4"]);
      expect(budget.used).toBe(deny ? 1 : 2);
      expect((log.attempts ?? []).filter(attempt => attempt.sendCount > 0).map(attempt => attempt.model))
        .toEqual(deny ? ["gpt-4o"] : ["gpt-4o", "gpt-5.4"]);
      expect(log.model).toBe(deny ? "gpt-4o" : "gpt-5.4");
      if (deny) expect(log.accountLogLabel).toBe(firstLabel);
      else expect(log.accountLogLabel).not.toBe(firstLabel);
      expect(targets.some(identity => identity && identity !== firstLabel)).toBe(true);
      expect(getAccountSet("github-copilot")!.accounts.find(account => account.id === a)?.paused).toBe(true);
      expect(getAccountSet("github-copilot")!.activeAccountId).toBe(b);
    } finally { tracker.settle(undefined); }
  });
  test.each([false, true])("physical spend denial leaves no Copilot attempt (Chat=%s)", async chat => {
    await accounts();
    const f = fixture({ nativeFirst: !chat, chatOnly: chat });
    const budget = createRequestExecutionBudget(undefined, undefined, {
      enforced: true, startRequest: () => {}, charge: () => true, refund: () => {}, ensureSeed: () => undefined,
    });
    const log: RequestLogContext = {};
    const response = await handleResponses(request("hello", false), f.config, log, { sendBudget: budget });
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("request_send_budget_exhausted");
    expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(0);
    expect({ charged: budget.used, physical: budget.physicalStarted,
      attempts: (log.attempts ?? []).reduce((total, attempt) => total + attempt.sendCount, 0) })
      .toEqual({ charged: 0, physical: 0, attempts: 0 });
  });
  test.each([[false, false], [true, false], [false, true], [true, true]] as const)(
    "pre-physical tool refusal consumes no send or attempt (Chat=%s negotiation401=%s)", async (chat, negotiation401) => {
    const { a } = await accounts();
    const actualNow = Date.now;
    let offset = 0;
    Date.now = () => actualNow() + offset;
    try {
      const f = fixture({ nativeExpiry: true, chatOnly: chat, advanceAfterIntent: () => { offset = 61_000; },
        ...(negotiation401 ? { negotiationRefusal: 401, negotiationRefusalAt: 2 } : {}) });
      f.config.providers["github-copilot"]!.autoToolChoiceOnlyModels = ["gpt-5.4"];
      const budget = createRequestExecutionBudget(), log: RequestLogContext = {};
      const response = await handleResponses(request("hello", false, { tool_choice: { type: "function", name: "lookup" } }),
        f.config, log, { sendBudget: budget });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("mandatory tool_choice cannot be preserved");
      expect(f.sent.filter(call => ["/responses", "/chat/completions"].includes(call.path))).toHaveLength(0);
      expect({ charged: budget.used, attempts: (log.attempts ?? []).reduce((total, attempt) => total + attempt.sendCount, 0) })
        .toEqual({ charged: 0, attempts: 0 });
      expect(log.model).toBe("auto"); // No physical send published a negotiated model.
      expect(f.refreshCount).toBe(negotiation401 ? 1 : 0);
      expect(getAccountSet("github-copilot")!.accounts.find(account => account.id === a)!.credential.access.endsWith("-renewed"))
        .toBe(negotiation401);
    } finally { Date.now = actualNow; }
  });
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
    expect((logCtx.attempts ?? []).filter(attempt => attempt.sendCount > 0)
      .map(attempt => [attempt.model, attempt.adapter, attempt.sendCount]))
      .toEqual([["gpt-4o", "openai-responses", 1], ["gpt-4o", "openai-chat", 1]]);
    expect(f.sent.filter(call => call.path === "/models/session")).toHaveLength(2);
    expect(f.refreshCount).toBe(1);
    expect(f.cancelledNativeBodies).toBe(1);
    expect(f.sent.find(call => call.path === "/responses")!.signal!.aborted).toBe(true);
  });
  test.each([false, true])("same-account model refresh preserves each physical model (stream=%s)", async stream => {
    await accounts();
    const f = fixture({ chatRefresh: true, chatOnly: true }), log: RequestLogContext = {};
    const response = await handleResponses(request("hello", stream), f.config, log);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
    expect(f.sent.filter(call => call.path === "/chat/completions").map(call => [call.host, call.body.model]))
      .toEqual([["a.githubcopilot.com", "gpt-4o"], ["a.githubcopilot.com", "gpt-5.4"]]);
    expect((log.attempts ?? []).filter(attempt => attempt.sendCount > 0).map(attempt => [attempt.model, attempt.adapter, attempt.sendCount]))
      .toEqual([["gpt-4o", "openai-chat", 1], ["gpt-5.4", "openai-chat", 1]]);
    expect(f.refreshCount).toBe(1);
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
  test("passthrough refresh regenerates numeric retry advice instead of relaying its bytes", async () => {
    const numericKey = "73915028461739205817";
    for (const [raw, expected] of [["9999", "3600"], [numericKey, null]] as const) {
      await accounts();
      const f = fixture({ nativeFirst: true, negotiationRefusal: 429, negotiationRefusalAt: 2, negotiationRetryAfter: raw });
      const response = await handleResponses(request("hello", false), f.config, { model: "", provider: "" });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe(expected);
      expect(await response.text()).not.toContain(numericKey);
    }
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
  test("Auto negotiation is denied when its selected model is outside the admission scope", async () => {
    await accounts();
    const { config, sent } = fixture();
    const admission = scopedAdmission(config, ["github-copilot/auto"]);
    const response = await handleResponses(request("hello"), config, { model: "", provider: "" }, { admission });

    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("model_not_allowed_for_key");
    expect(body).not.toContain("gpt-4o");
    expect(sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(0);
  });
  test("a negotiated denial names the caller's selector, not the resolved Auto model id", async () => {
    await accounts();
    const { config } = fixture();
    const admission = scopedAdmission(config, ["github-copilot/auto"]);
    const response = await handleResponses(request("hello", false), config, { model: "", provider: "" }, { admission });
    expect(response.status).toBe(403);
    const { error } = await response.json() as { error: { type: string; model: string; message: string } };
    expect(error.type).toBe("model_not_allowed_for_key");
    expect(error.model).toBe("github-copilot/auto");
    expect(error.message).toContain("github-copilot/auto");
  });
  test("a key scope removed while negotiation is in flight does not widen the request", async () => {
    await accounts();
    let config!: OcxConfig;
    const f = fixture({ onSession: () => { config.apiKeys = []; } });
    config = f.config;
    const admission = scopedAdmission(config, ["github-copilot/auto"]);
    const response = await handleResponses(request("hello", false), config, { model: "", provider: "" }, { admission });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("model_not_allowed_for_key");
    expect(f.sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(0);
  });
  test("Auto negotiation dispatches a model admitted by scope", async () => {
    await accounts();
    const { config, sent } = fixture();
    const admission = scopedAdmission(config, ["github-copilot/auto", "gpt-4o"]);
    const response = await handleResponses(request("hello"), config, { model: "", provider: "" }, { admission });

    expect(response.status).toBe(200);
    expect(sent.filter(call => call.path === "/chat/completions").map(call => call.body.model)).toEqual(["gpt-4o"]);
  });
  test("dispatch-retried Auto selection outside admission scope returns 403", async () => {
    const { b } = await accounts();
    const { config, sent } = fixture({
      advanceAfterIntent: async () => { await setActiveAccount("github-copilot", b); },
    });
    const admission = scopedAdmission(config, ["github-copilot/auto", "gpt-4o"]);
    const response = await handleResponses(request("hello", false), config, { model: "", provider: "" }, { admission });

    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("model_not_allowed_for_key");
    expect(body).not.toContain("gpt-5.4");
    expect(sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(0);
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
  test("web-search key rotation into a model outside the key scope ends with the scope refusal", async () => {
    const { config, sent } = fixture({ key: true, rotate: true });
    config.webSearchSidecar = { backend: "exa", exaApiKey: "synthetic-search-key" };
    saveConfig(config);
    const admission = scopedAdmission(config, ["github-copilot/auto", "gpt-4o"]);
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "github-copilot/auto", input: "hello", stream: false, tools: [{ type: "web_search" }] }) });
    const response = await handleResponses(req, config, { model: "", provider: "" }, { admission });
    expect(response.status).toBe(403);
    expect(isNonReplayableResponse(response)).toBe(true);
    const text = await response.text();
    expect(JSON.parse(text).error.type).toBe("model_not_allowed_for_key");
    expect(text).not.toContain("gpt-5.4");
    // Account A's gpt-4o was sent once and refused; B's gpt-5.4 was negotiated but never sent.
    expect(sent.filter(call => ["/chat/completions", "/responses"].includes(call.path)).map(call => call.body.model))
      .toEqual(["gpt-4o"]);
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
    expect(config.modelDiscovery.recentArrivals?.["github-copilot"]).toEqual([{ id: "auto", at: "2026-10-02T00:00:00Z", disabledByPolicy: true }]);
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
  test.each([false, true])("expired native Auto scope denial is terminal before inference, stream=%s", async stream => {
    await accounts();
    const actualNow = Date.now;
    let offset = 0;
    Date.now = () => actualNow() + offset;
    try {
      const { config, sent } = fixture({
        nativeExpiry: true, advanceAfterIntent: () => { offset = 61_000; },
      });
      const admission = scopedAdmission(config, ["github-copilot/auto", "gpt-4o"]);
      const response = await handleResponses(request("hello", stream), config, { model: "", provider: "" }, { admission });
      expect(response.status).toBe(403);
      expect(isNonReplayableResponse(response)).toBe(true);
      const text = await response.text();
      expect(text).toContain("model_not_allowed_for_key");
      expect(text).not.toContain("gpt-5.4");
      expect(sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(0);
    } finally { Date.now = actualNow; }
  });
  test.each([false, true])("Auto scope denial stops account recovery, key=%s", async key => {
    await accounts();
    const { config, sent } = fixture({ key, rotate: true });
    if (key) await saveConfig(config);
    const admission = scopedAdmission(config, ["github-copilot/auto", "gpt-4o"]);
    const response = await handleResponses(request("hello", false), config, { model: "", provider: "" }, { admission });
    expect(response.status).toBe(403);
    expect(isNonReplayableResponse(response)).toBe(true);
    const text = await response.text();
    expect(text).toContain("model_not_allowed_for_key");
    expect(text).not.toContain("gpt-5.4");
    expect(sent.filter(call => ["/chat/completions", "/responses"].includes(call.path)).map(call => call.body.model))
      .toEqual(["gpt-4o"]);
  });
  test("a local Auto scope refusal cannot hop to an otherwise allowed combo target", async () => {
    await accounts();
    const { config } = fixture();
    let fallbackSends = 0;
    config.providers.fallback = {
      adapter: "openai-chat", authMode: "key", apiKey: "synthetic-fallback-key",
      baseUrl: "https://fallback.invalid/v1", models: ["allowed"],
      fetch: (async () => {
        fallbackSends++;
        return Response.json({
          id: "fallback-fixture", model: "allowed",
          choices: [{ message: { role: "assistant", content: "unexpected fallback" }, finish_reason: "stop" }],
        });
      }) as typeof fetch,
    };
    config.combos = {
      scopedAuto: {
        strategy: "failover",
        targets: [{ provider: "github-copilot", model: "auto" }, { provider: "fallback", model: "allowed" }],
      },
    };
    const admission = scopedAdmission(config, ["github-copilot/auto", "fallback/allowed"]);
    const req = new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/scopedAuto", stream: false, input: "hello" }),
    });
    const response = await handleResponses(req, config, { model: "", provider: "" }, { admission });
    expect(response.status).toBe(403);
    expect(isNonReplayableResponse(response)).toBe(true);
    // The combo boundary keeps the stable scope envelope instead of rewrapping it as upstream_error.
    const { error } = await response.json() as { error: { type: string; model: string } };
    expect(error.type).toBe("model_not_allowed_for_key");
    expect(fallbackSends).toBe(0);
  });
  test("terminal continuation emits the scope refusal without a replacement inference", async () => {
    const { b } = await accounts();
    const { config, sent } = fixture({
      replyText: "I will modify the file now.",
      onInference: async count => { if (count === 1) await setActiveAccount("github-copilot", b); },
    });
    config.providers["github-copilot"]!.terminalContinuationGuard = true;
    const admission = scopedAdmission(config, ["github-copilot/auto", "gpt-4o"]);
    const response = await handleResponses(request("Modify the file now."), config, { model: "", provider: "" }, { admission });
    const text = await response.text();
    expect(text).toContain("model_not_allowed_for_key");
    expect(text).not.toContain("gpt-5.4");
    expect(sent.filter(call => ["/chat/completions", "/responses"].includes(call.path))).toHaveLength(1);
  });
  test("OAuth 429 during terminal continuation preserves the scope refusal", async () => {
    await accounts();
    const { config, sent } = fixture({ rotate: true, rotateAt: 2, replyText: "I will modify the file now." });
    globalThis.fetch = config.providers["github-copilot"]!.fetch as typeof fetch;
    config.providers["github-copilot"]!.terminalContinuationGuard = true;
    const admission = scopedAdmission(config, ["github-copilot/auto", "gpt-4o"]);
    const response = await handleResponses(request("Modify the file now."), config, { model: "", provider: "" }, { admission });
    const text = await response.text();
    const inference = sent.filter(call => ["/chat/completions", "/responses"].includes(call.path));
    expect(inference.map(call => [call.host, call.body.model])).toEqual([
      ["a.githubcopilot.com", "gpt-4o"], ["a.githubcopilot.com", "gpt-4o"],
    ]);
    const sessions = sent.filter(call => call.path === "/models/session").map(call => call.host);
    expect(sessions[0]).toBe("a.githubcopilot.com");
    expect(sessions.at(-1)).toBe("b.githubcopilot.com");
    expect(text).toContain("model_not_allowed_for_key");
    expect(text).not.toContain("gpt-5.4");
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


