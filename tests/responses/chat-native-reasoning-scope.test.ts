import { afterEach, describe, expect, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest, createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { chatReasoningReplayPolicy } from "../../src/adapters/openai-chat/reasoning-replay";
import { nativeChatReplayScope, bindNativeChatReplayScope, nativeChatReasoningCapture } from "../../src/server/chat-native-reasoning";
import { nativeChatSse } from "../../src/server/chat-native-sse";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import type { OcxProviderConfig, OcxReasoningReplayScopeRef } from "../../src/types";

const MODEL = "deepseek-v4.1-flash";
const PROVIDER: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key" };
const tool = (id: string) => ({ id, type: "function", function: { name: "inspect", arguments: "{}" } });
const history = (id = "call_a") => ({ messages: [{ role: "assistant", content: null, tool_calls: [tool(id)] }] });
function scope(thread = "fixture-thread", provider = PROVIDER, providerName = "fixture", model = MODEL) {
  const value = nativeChatReplayScope(new Headers({ "thread-id": thread }))!;
  bindNativeChatReplayScope(value, provider, providerName, model);
  return value;
}
function reasoning(value: OcxReasoningReplayScopeRef | undefined, provider = PROVIDER, model = MODEL, id = "call_a") {
  const request = buildOpenAIChatPassthroughRequest(provider, history(id), model, false, undefined, undefined, "fixture", value);
  return JSON.parse(request.body).messages[0].reasoning_content;
}
afterEach(() => clearReasoningReplayCacheForTests());

describe("native Chat reasoning policy and physical replay ownership", () => {
  test("family detection is version-agnostic and independent of provider names", () => {
    for (const model of [MODEL, "deepseek-v4-flash", "deepseek-v15.12-pro-20261015",
      "deepseek/deepseek-v4.1-flash-free", "gateway/DeepSeek-V5.2-Flash:thinking", "deepseek-flash"]) {
      expect(chatReasoningReplayPolicy(PROVIDER, model)).toEqual({ preserve: true, placeholder: true });
    }
    for (const model of ["deepseek-chat", "deepseek-reasoner", "deepseek-r1-distill-llama",
      "not-deepseek-v4.1-flash", "deepseek-flashlight", "plain-model"]) {
      expect(chatReasoningReplayPolicy(PROVIDER, model)).toEqual({ preserve: false, placeholder: false });
    }
  });
  test("explicit lists remain authoritative, including both opt-outs", () => {
    expect(chatReasoningReplayPolicy({ ...PROVIDER, preserveReasoningContentModels: [] }, MODEL).preserve).toBe(false);
    expect(chatReasoningReplayPolicy({ ...PROVIDER, requiresReasoningPlaceholderModels: [] }, MODEL))
      .toEqual({ preserve: true, placeholder: false });
    expect(chatReasoningReplayPolicy({ ...PROVIDER, preserveReasoningContentModels: ["custom"] }, "custom"))
      .toEqual({ preserve: true, placeholder: true });
  });
  test("translated Chat shares the family fallback and honors preserve opt-out", () => {
    for (const [provider, expected] of [[PROVIDER, " "], [{ ...PROVIDER, preserveReasoningContentModels: [] }, undefined]] as const) {
      const request = createOpenAIChatAdapter(provider).buildRequest({ modelId: MODEL, stream: false, options: {},
        context: { messages: [{ role: "assistant", content: [{ type: "toolCall", id: "call_a", name: "inspect", arguments: {} }] }], tools: [] } });
      expect(JSON.parse(request.body).messages.find((message: { role: string }) => message.role === "assistant").reasoning_content).toBe(expected);
    }
  });
  test("JSON capture isolates choices and every scope dimension; rebinding cannot recover the old key", () => {
    const owner = scope();
    const budget = createTranslatorBudget();
    const capture = nativeChatReasoningCapture(PROVIDER, MODEL, owner, budget);
    capture.json({ choices: [
      { index: 0, message: { reasoning_content: "alpha", tool_calls: [tool("call_a")] } },
      { index: 1, message: { reasoning_content: "beta", tool_calls: [tool("call_b")] } },
    ] });
    expect(reasoning(owner)).toBe("alpha");
    expect(reasoning(owner, PROVIDER, MODEL, "call_b")).toBe("beta");
    for (const foreign of [scope("other-thread"), scope("fixture-thread", PROVIDER, "other-provider"),
      scope("fixture-thread", { ...PROVIDER, baseUrl: "https://other.invalid/v1" }),
      scope("fixture-thread", { ...PROVIDER, apiKey: "other-key" }),
      scope("fixture-thread", PROVIDER, "fixture", "deepseek-v5.2-flash")]) {
      expect(reasoning(foreign)).toBe(" ");
    }
    bindNativeChatReplayScope(owner, { ...PROVIDER, apiKey: "rotated-key" }, "fixture", MODEL);
    expect(reasoning(owner)).toBe(" ");
    expect(reasoning(undefined)).toBe(" ");
    expect(nativeChatReplayScope(new Headers())).toBeUndefined();
    const keyless = scope("fixture-thread", { ...PROVIDER, apiKey: undefined });
    expect(keyless.current).toBeUndefined();
    expect(reasoning(keyless)).toBe(" ");
    budget.dispose();
  });
  test("repair leaves caller input untouched and unrelated models verbatim", () => {
    const input = history();
    buildOpenAIChatPassthroughRequest(PROVIDER, input, MODEL, false);
    expect(input).toEqual(history());
    const raw = { ...PROVIDER, preserveReasoningContentModels: ["custom"], reasoningDetailsModels: ["custom"] };
    expect(reasoning(scope(), raw, "custom")).toBeUndefined();
    expect(reasoning(scope(), PROVIDER, "plain-model")).toBeUndefined();
  });
  test("plain-answer placeholders require DeepSeek, tools and both policy opt-ins", () => {
    const messages = [{ role: "assistant", content: "Earlier answer" }];
    const tools = [{ type: "function", function: { name: "inspect", parameters: { type: "object", properties: {} } } }];
    for (const [provider, model, requestedTools, expected] of [
      [PROVIDER, MODEL, tools, " "],
      [PROVIDER, MODEL, [], undefined],
      [{ ...PROVIDER, preserveReasoningContentModels: [] }, MODEL, tools, undefined],
      [{ ...PROVIDER, requiresReasoningPlaceholderModels: [] }, MODEL, tools, undefined],
      [{ ...PROVIDER, preserveReasoningContentModels: ["custom"] }, "custom", tools, undefined],
    ] as const) {
      const request = buildOpenAIChatPassthroughRequest(provider, { messages, tools: requestedTools }, model, false);
      expect(JSON.parse(request.body).messages[0].reasoning_content).toBe(expected);
    }
    expect(messages).toEqual([{ role: "assistant", content: "Earlier answer" }]);
  });
});

describe("native SSE reasoning capture lifecycle", () => {
  async function consume(mode: "done" | "error" | "truncated" | "oversized" | "cancel") {
    const owner = scope();
    const budget = createTranslatorBudget();
    const capture = nativeChatReasoningCapture(PROVIDER, MODEL, owner, budget);
    const abort = new AbortController();
    const frames = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_" }] } }] },
      { choices: [{ index: 1, delta: { reasoning_content: "other-choice", tool_calls: [{ index: 0, id: "call_b" }] } },
        { index: 0, delta: { reasoning_content: "original ", tool_calls: [{ index: 0, id: "a" }] } }] },
      { choices: [{ index: 0, delta: { reasoning_content: mode === "oversized" ? "x".repeat(256 * 1024) : "reasoning" } }] },
    ];
    const ending = mode === "done" || mode === "oversized" ? "data: [DONE]\n\n"
      : mode === "error" ? 'data: {"error":{"message":"failed"}}\n\n' : "";
    const source = new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + ending).body!;
    const stream = nativeChatSse(source, { requestedModel: MODEL, translatorBudget: budget, signal: abort.signal,
      onUsage() {}, onChunk: capture.observe, onTerminal: status => capture.finish(status < 400), onCancel: () => capture.finish(false) });
    if (mode === "cancel") {
      const reader = stream.getReader();
      await reader.read();
      await reader.cancel();
    } else await new Response(stream).text();
    const result = [reasoning(owner), reasoning(owner, PROVIDER, MODEL, "call_b")];
    budget.dispose();
    return result;
  }
  test("[DONE] commits complete reasoning for each choice, including fragmented ids", async () => {
    expect(await consume("done")).toEqual(["original reasoning", "other-choice"]);
  });
  for (const mode of ["error", "truncated", "oversized", "cancel"] as const) {
    test(`${mode} discards incomplete or over-budget reasoning`, async () => {
      expect(await consume(mode)).toEqual([" ", " "]);
    });
  }
});
