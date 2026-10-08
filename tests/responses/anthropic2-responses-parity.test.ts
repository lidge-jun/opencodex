/** Both instances enter the real translated handlers and preserve one canonical Anthropic wire. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnthropicInstanceFixture, instanceFixtureUuid, type AnthropicInstanceFixture } from "../helpers/anthropic-instance-fixture";
import type { AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";
import type { RequestLogContext } from "../../src/server/request-log";

let f: AnthropicInstanceFixture;
let releaseSpend: (() => void) | undefined;
let responses: typeof import("../../src/server/responses");
let chat: typeof import("../../src/server/chat-completions");
let messages: typeof import("../../src/server/claude-messages");
let seen: Array<{ instance: AnthropicInstanceId; body: Record<string, unknown>; headers: Headers; url: string }>;
let toolReply: boolean;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TOOL = { name: "lookup", description: "Look up a value", parameters: { type: "object", properties: { value: { type: "string" } } } };
const SIGNATURE = "synthetic-anthropic-signature";
const REDACTED = "synthetic-redacted-state";

beforeEach(async () => {
  f = await createAnthropicInstanceFixture(); await f.seed();
  const { acquireOwnedSpendHome } = await import("../helpers/owned-spend-home"); releaseSpend = acquireOwnedSpendHome();
  responses = await import("../../src/server/responses");
  chat = await import("../../src/server/chat-completions");
  messages = await import("../../src/server/claude-messages");
  (await import("../../src/responses/reasoning-replay-cache")).clearReasoningReplayCacheForTests();
  seen = []; toolReply = false;
  // Explicit opt-out makes the Messages input exercise the scoped Responses bridge.
  f.config.protocols = { rollout: { managedMessagesNative: false, managedMessagesNativeOAuth: false } };
  f.config.cacheRetention = "long";
  for (const instance of ["anthropic", "anthropic2"] as const) {
    Object.assign(f.config.providers[instance]!, { models: ["claude-opus-5-5", f.model],
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const token = headers.get("authorization")!.replace(/^Bearer /, "");
        const row = f.store.getAccountSet(instance)!.accounts.find(account => account.credential.access === token)!;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        // This checks stored identity, not wire UUID ownership: translated sends carry only the bearer.
        expect(row.credential.anthropicIdentity?.accountUuid).toBe(instanceFixtureUuid(instance, f.ids.indexOf(row.id as typeof f.ids[number]) + 1));
        f.ledger.record({ instance, accountId: row.id, token, model: String(body.model) });
        seen.push({ instance, body, headers, url: String(input) });
        const message = { id: "msg_parity", type: "message", role: "assistant", model: body.model,
          content: toolReply ? [{ type: "tool_use", id: "toolu_reply", name: "custom_lookup", input: { value: "done" } }]
            : [{ type: "text", text: "The answer is complete." }],
          stop_reason: toolReply ? "tool_use" : "end_turn", usage: { input_tokens: 8, output_tokens: 6 },
        };
        const quotaHeaders = { "anthropic-ratelimit-unified-5h-utilization": instance === "anthropic" ? "0.21" : "0.63" };
        if (body.stream !== true) return Response.json(message, { headers: quotaHeaders });
        const frames = [
          { type: "message_start", message: { ...message, content: [], stop_reason: null } },
          { type: "content_block_start", index: 0, content_block: toolReply
            ? { type: "tool_use", id: "toolu_reply", name: "custom_lookup", input: {} } : { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: toolReply
            ? { type: "input_json_delta", partial_json: '{"value":"done"}' } : { type: "text_delta", text: "The answer is complete." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: message.usage },
          { type: "message_stop" },
        ];
        return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), {
          headers: { ...quotaHeaders, "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    });
  }
  f.publishConfig();
});
afterEach(async () => {
  try {
    f.ledger.assertNoCrossSend(); releaseSpend?.(); releaseSpend = undefined;
    (await import("../../src/responses/state")).clearResponseStateForTests();
  } finally { f.dispose(); }
});

type Surface = "responses" | "chat" | "messages";
async function send(surface: Surface, instance: AnthropicInstanceId, body: Record<string, unknown>, model = f.model) {
  const path = surface === "responses" ? "/v1/responses" : surface === "chat" ? "/v1/chat/completions" : "/v1/messages";
  const req = new Request(`http://localhost${path}`, { method: "POST", headers: {
    "content-type": "application/json", "session-id": `${f.sessionKey}-${instance}`, authorization: "Bearer access-token-value-test-caller-excluded",
  }, body: JSON.stringify({ model: `${instance}/${model}`, stream: false, ...body }) });
  const log: RequestLogContext = { model: "", provider: "" };
  const response = surface === "responses" ? await responses.handleResponses(req, f.config, log)
    : surface === "chat" ? await chat.handleChatCompletions(req, f.config, log)
      : await messages.handleClaudeMessages(req, f.config, log);
  const text = await response.text();
  expect(response.status).toBe(200);
  if (surface !== "responses") {
    const { protocolTraceForRequest } = await import("../../src/protocols/trace");
    expect(protocolTraceForRequest(log, log.attempts)?.mode).toBe("legacy-bridge");
  }
  return { text, log };
}
function expectPair(model = f.model) {
  expect(seen).toHaveLength(2);
  expect(seen.map(send => send.instance)).toEqual(["anthropic", "anthropic2"]);
  expect(seen[0]!.body).toEqual(seen[1]!.body);
  for (const send of seen) {
    expect(send.url).toBe("https://api.anthropic.com/v1/messages");
    expect(send.body.model).toBe(model);
    expect(send.headers.get("x-api-key")).toBeNull();
    expect(send.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(send.headers.get("authorization")).not.toContain("caller");
  }
}

for (const surface of ["responses", "chat", "messages"] as const) {
  test(`${surface}: translated text, provider prefix stripping and passive quota belong to the instance`, async () => {
    const body = surface === "responses" ? { input: "Answer briefly", max_output_tokens: 64 }
      : { messages: [{ role: "user", content: "Answer briefly" }], max_tokens: 64 };
    for (const instance of ["anthropic", "anthropic2"] as const) {
      const { text, log } = await send(surface, instance, body);
      expect(text).toContain("The answer is complete."); expect(log.provider).toStartWith(instance);
    }
    expectPair();
    expect(f.quota.getCachedProviderAccountQuota("anthropic", f.ids[0])?.fiveHourPercent).toBe(21);
    expect(f.quota.getCachedProviderAccountQuota("anthropic2", f.ids[0])?.fiveHourPercent).toBe(63);
  });

  test(`${surface}: parallel-tool constraint, tool replay/results and OAuth name restoration match`, async () => {
    toolReply = true;
    const body = surface === "responses" ? {
      input: [
        { type: "message", role: "user", content: "Look up a value" },
        { type: "function_call", call_id: "toolu_prior", name: "lookup", arguments: '{"value":"prior"}' },
        { type: "function_call_output", call_id: "toolu_prior", output: "prior result" },
      ], tools: [{ type: "function", ...TOOL }], parallel_tool_calls: false,
    } : surface === "chat" ? {
      messages: [
        { role: "user", content: "Look up a value" },
        { role: "assistant", content: null, tool_calls: [{ id: "toolu_prior", type: "function", function: { name: "lookup", arguments: '{"value":"prior"}' } }] },
        { role: "tool", tool_call_id: "toolu_prior", content: "prior result" },
      ], tools: [{ type: "function", function: TOOL }], parallel_tool_calls: false,
    } : {
      max_tokens: 1024, messages: [
        { role: "user", content: "Look up a value" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_prior", name: "lookup", input: { value: "prior" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_prior", content: "prior result" }] },
      ], tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    };
    for (const instance of ["anthropic", "anthropic2"] as const) {
      const { text } = await send(surface, instance, body);
      expect(text).toContain('"name":"lookup"'); expect(text).not.toContain("custom_lookup");
    }
    expectPair();
    expect(seen[0]!.body.tool_choice).toMatchObject({ type: "auto", disable_parallel_tool_use: true });
    const wire = JSON.stringify(seen[0]!.body);
    expect(wire).toContain("custom_lookup"); expect(wire).toContain("tool_result"); expect(wire).toContain("prior result");
  });

  test(`${surface}: cache TTL and real image block survive translation for both instances`, async () => {
    const body = surface === "responses" ? { instructions: "Answer briefly", input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "Describe the image" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
    ] }] } : surface === "chat" ? { messages: [
      { role: "system", content: "Answer briefly" }, { role: "user", content: [
        { type: "text", text: "Describe the image" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
      ] },
    ] } : { max_tokens: 1024, system: "Answer briefly", messages: [{ role: "user", content: [
      { type: "text", text: "Describe the image", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    ] }] };
    for (const instance of ["anthropic", "anthropic2"] as const) await send(surface, instance, body);
    expectPair();
    const wire = JSON.stringify(seen[0]!.body);
    expect(wire).toContain('"type":"image"'); expect(wire).toContain('"media_type":"image/png"');
    expect(wire).toContain('"ttl":"1h"');
  });

  test(`${surface}: adaptive thinking, effort and explicit output limits retain parity`, async () => {
    const body = surface === "responses" ? { input: "Answer briefly", reasoning: { effort: "high" }, max_output_tokens: 4096 }
      : surface === "chat" ? { messages: [{ role: "user", content: "Answer briefly" }], reasoning_effort: "high", max_completion_tokens: 4096 }
        : { messages: [{ role: "user", content: "Answer briefly" }], thinking: { type: "adaptive" }, output_config: { effort: "high" }, max_tokens: 4096 };
    for (const instance of ["anthropic", "anthropic2"] as const) await send(surface, instance, body, "claude-opus-5-5");
    expectPair("claude-opus-5-5");
    expect(seen[0]!.body.thinking).toMatchObject({ type: "adaptive" });
    expect(seen[0]!.body.output_config).toMatchObject({ effort: "high" });
    expect(seen[0]!.body.max_tokens).toBe(4096);
  });
}

test("native-ineligible Messages preserves thinking signatures and redacted state through the bridge", async () => {
  const body = { max_tokens: 4096, thinking: { type: "adaptive" }, output_config: { effort: "high" }, messages: [
    { role: "user", content: "First question" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Synthetic prior reasoning", signature: SIGNATURE },
      { type: "redacted_thinking", data: REDACTED }, { type: "text", text: "Prior answer" },
    ] },
    { role: "user", content: "Follow-up question" },
  ] };
  for (const instance of ["anthropic", "anthropic2"] as const) await send("messages", instance, body, "claude-opus-5-5");
  expectPair("claude-opus-5-5");
  const wire = JSON.stringify(seen[0]!.body);
  expect(wire).toContain(SIGNATURE); expect(wire).toContain(REDACTED); expect(wire).toContain("Synthetic prior reasoning");
});

test("an operator cross-provider redirect may move a Pool 2 selector; the send uses the target's own pool", async () => {
  f.config.blockedModelRedirects = { [`anthropic2/${f.model}`]: `anthropic/${f.model}` };
  f.publishConfig();
  const { text, log } = await send("responses", "anthropic2", { input: "Answer briefly", max_output_tokens: 64 });
  expect(text).toContain("The answer is complete.");
  expect(seen.map(row => row.instance)).toEqual(["anthropic"]);
  expect(log.provider).not.toStartWith("anthropic2");
});
