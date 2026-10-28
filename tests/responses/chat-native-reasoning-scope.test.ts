import { afterEach, describe, expect, test } from "bun:test";
import { buildOpenAIChatPassthroughRequest, createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { chatReasoningReplayPolicy, planNativeChatReasoningReplay } from "../../src/adapters/openai-chat/reasoning-replay";
import { nativeChatReplayScope, bindNativeChatReplayScope, nativeChatReasoningCapture } from "../../src/server/chat-native-reasoning";
import { nativeChatSse } from "../../src/server/chat-native-sse";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import type { OcxProviderConfig, OcxReasoningReplayScopeRef } from "../../src/types";

const MODEL = "deepseek-v4.1-flash";
const PROVIDER: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key" };
const tool = (id: string) => ({ id, type: "function", function: { name: "inspect", arguments: "{}" } });
const history = (id = "call_a") => ({ messages: [{ role: "assistant", content: null, tool_calls: [tool(id)] }] });
function scope(thread = "fixture-thread", provider = PROVIDER, providerName = "fixture", model = MODEL,
  principal = "fixture-principal") {
  const value = nativeChatReplayScope(new Headers({ "thread-id": thread }), principal)!;
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
      "deepseek/deepseek-v4.1-flash-free", "gateway/DeepSeek-V5.2-Flash:thinking", "deepseek-flash",
      "reflection-beam", "reflection/beam", "command-code/reflection-beam:free", "stealth-glyph-cluster:free"]) {
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
      scope("fixture-thread", PROVIDER, "fixture", "deepseek-v5.2-flash"),
      scope("fixture-thread", PROVIDER, "fixture", MODEL, "other-principal")]) {
      expect(reasoning(foreign)).toBe(" ");
    }
    bindNativeChatReplayScope(owner, { ...PROVIDER, apiKey: "rotated-key" }, "fixture", MODEL);
    expect(reasoning(owner)).toBe(" ");
    expect(reasoning(undefined)).toBe(" ");
    expect(nativeChatReplayScope(new Headers(), "fixture-principal")).toBeUndefined();
    const keyless = nativeChatReplayScope(new Headers({ "thread-id": "fixture-thread" }), undefined)!;
    bindNativeChatReplayScope(keyless, PROVIDER, "fixture", MODEL);
    // Physical identity remains available to other scope consumers even though a keyless caller
    // cannot address the principal-scoped plaintext replay cache.
    expect(keyless.current).toMatchObject({ providerName: "fixture", modelId: MODEL });
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
  test("bounds repeated escaped replay before building the expanded request", () => {
    const owner = scope();
    const budget = createTranslatorBudget();
    const capture = nativeChatReasoningCapture(PROVIDER, MODEL, owner, budget);
    budget.chargeRetained(60, { kind: "request_copies" });
    const secretLikeReasoning = 'quoted "reasoning" \\ and unicode 🧠';
    const secondReasoning = "second\nline";
    capture.json({ choices: [
      { message: { reasoning_content: secretLikeReasoning, tool_calls: [tool("call_a")] } },
      { message: { reasoning_content: secondReasoning, tool_calls: [tool("call_b")] } },
    ] });
    const retainedBeforeBuild = budget.snapshot().currentBytes;
    const messages = Array.from({ length: 40 }, () => ({
      role: "assistant", content: null, tool_calls: [tool("call_a"), tool("call_b")],
    }));
    const raw = { messages };
    const replayed = `${secretLikeReasoning}\n${secondReasoning}`;
    const expandedBytes = Buffer.byteLength(JSON.stringify({
      messages: messages.map(message => ({ ...message, reasoning_content: replayed })),
    }));
    expect(expandedBytes).toBeGreaterThan(512);
    expect(() => buildOpenAIChatPassthroughRequest(
      PROVIDER, raw, MODEL, false, undefined, undefined, "fixture", owner, 512,
    )).toThrow(expect.objectContaining({ code: "translation_buffer_limit" }));
    expect(raw.messages).toHaveLength(40);
    expect(raw.messages[0]).not.toHaveProperty("reasoning_content");
    const single = { messages: [{ role: "assistant", content: null, tool_calls: [tool("call_a"), tool("call_b")] }] };
    const full = buildOpenAIChatPassthroughRequest(PROVIDER, single, MODEL, false, undefined, undefined, "fixture", owner);
    const exactBytes = Buffer.byteLength(full.body);
    expect(JSON.parse(buildOpenAIChatPassthroughRequest(
      PROVIDER, single, MODEL, false, undefined, undefined, "fixture", owner, exactBytes, budget,
    ).body).messages[0].reasoning_content).toBe(replayed);
    expect(() => buildOpenAIChatPassthroughRequest(
      PROVIDER, single, MODEL, false, undefined, undefined, "fixture", owner, exactBytes - 1,
    )).toThrow(expect.objectContaining({ code: "translation_buffer_limit" }));
    const preflightBudget = createTranslatorBudget({ maxTurnBytes: exactBytes - 1 });
    preflightBudget.chargeRetained(60, { kind: "request_copies" });
    const preflightBaseline = preflightBudget.snapshot().currentBytes;
    expect(() => buildOpenAIChatPassthroughRequest(
      PROVIDER, single, MODEL, false, undefined, undefined, "fixture", owner, undefined, preflightBudget,
    )).toThrow(expect.objectContaining({ code: "translation_buffer_limit" }));
    expect(preflightBudget.snapshot().currentBytes).toBe(preflightBaseline);
    expect(budget.snapshot().currentBytes).toBe(retainedBeforeBuild);
    preflightBudget.dispose();
    budget.dispose();
  });
  test("exact value-delta accounting replaces a prior reasoning_content of any JSON shape", () => {
    const owner = scope();
    const budget = createTranslatorBudget();
    nativeChatReasoningCapture(PROVIDER, MODEL, owner, budget).json({ choices: [
      { message: { reasoning_content: "cached-text", tool_calls: [tool("call_a")] } },
    ] });
    // "", null, object and number priors already serialize inside the message: the plan credits
    // their exact bytes, so the boundary is the real final size in every shape.
    for (const prior of ["", null, { nested: ["object"] }, 42] as const) {
      const raw = { messages: [{ role: "assistant", content: null, tool_calls: [tool("call_a")], reasoning_content: prior }] };
      const exactBytes = Buffer.byteLength(buildOpenAIChatPassthroughRequest(
        PROVIDER, raw, MODEL, false, undefined, undefined, "fixture", owner).body);
      expect(JSON.parse(buildOpenAIChatPassthroughRequest(
        PROVIDER, raw, MODEL, false, undefined, undefined, "fixture", owner, exactBytes,
      ).body).messages[0].reasoning_content).toBe("cached-text");
      expect(() => buildOpenAIChatPassthroughRequest(
        PROVIDER, raw, MODEL, false, undefined, undefined, "fixture", owner, exactBytes - 1,
      )).toThrow(expect.objectContaining({ code: "translation_buffer_limit" }));
    }
    budget.dispose();
  });
  test("plan charges the net serialized delta, still applies at zero, and reports the caller limit", () => {
    const owner = scope();
    const budget = createTranslatorBudget();
    nativeChatReasoningCapture(PROVIDER, MODEL, owner, budget).json({ choices: [
      { message: { reasoning_content: "aa", tool_calls: [tool("call_a")] } },
    ] });
    // Replacing null (4 serialized bytes) with "aa" (4) nets zero but must still rewrite the wire.
    const replacingNull = [{ role: "assistant", content: null, tool_calls: [tool("call_a")], reasoning_content: null }];
    const nullPlan = planNativeChatReasoningReplay(replacingNull, PROVIDER, MODEL, owner, false, 0);
    expect(nullPlan.serializedBytes).toBe(0);
    expect(nullPlan.hasChanges).toBe(true);
    const netZero = { messages: replacingNull };
    expect(JSON.parse(buildOpenAIChatPassthroughRequest(
      PROVIDER, netZero, MODEL, false, undefined, undefined, "fixture", owner,
    ).body).messages[0].reasoning_content).toBe("aa");
    // "" credits its 2 serialized bytes: only the escaped value difference is charged.
    const replacingEmpty = [{ role: "assistant", content: null, tool_calls: [tool("call_a")], reasoning_content: "" }];
    expect(planNativeChatReasoningReplay(replacingEmpty, PROVIDER, MODEL, owner, false, 2).serializedBytes).toBe(2);
    // An absent field pays the envelope: "reasoning_content": is 20 bytes, the comma 1, "aa" 4.
    const absent = [{ role: "assistant", content: null, tool_calls: [tool("call_a")] }];
    expect(planNativeChatReasoningReplay(absent, PROVIDER, MODEL, owner, false, 25).serializedBytes).toBe(25);
    // Inner measurements cap at what is left; the thrown error still reports the caller's limit.
    for (const max of [1, 10, 24]) {
      expect(() => planNativeChatReasoningReplay(absent, PROVIDER, MODEL, owner, false, max))
        .toThrow(expect.objectContaining({ code: "translation_buffer_limit", limitBytes: max }));
    }
    // An assistant message carrying reasoning instead of tool_calls also pays the envelope delta.
    const withReasoning = [{ role: "assistant", content: null, reasoning: "aa" }];
    expect(planNativeChatReasoningReplay(withReasoning, PROVIDER, MODEL, owner, false, 25).serializedBytes).toBe(25);
    for (const max of [1, 10, 24]) {
      expect(() => planNativeChatReasoningReplay(withReasoning, PROVIDER, MODEL, owner, false, max))
        .toThrow(expect.objectContaining({ code: "translation_buffer_limit", limitBytes: max }));
    }
    budget.dispose();
  });
  test("enforces maxSerializedBytes even when replayPlan has no changes", () => {
    const raw = { messages: [{ role: "user", content: "hello world" }] };
    const exactBytes = Buffer.byteLength(
      buildOpenAIChatPassthroughRequest(PROVIDER, raw, MODEL, false).body,
    );
    expect(
      JSON.parse(
        buildOpenAIChatPassthroughRequest(PROVIDER, raw, MODEL, false, undefined, undefined, "fixture", undefined, exactBytes).body,
      ).messages[0].content,
    ).toBe("hello world");
    expect(() =>
      buildOpenAIChatPassthroughRequest(PROVIDER, raw, MODEL, false, undefined, undefined, "fixture", undefined, exactBytes - 1),
    ).toThrow(expect.objectContaining({ code: "translation_buffer_limit" }));
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
  test("reflection models replay placeholder on prior assistant turns even without tools", () => {
    const messages = [{ role: "assistant", content: "Earlier plain answer" }];
    const request = buildOpenAIChatPassthroughRequest(PROVIDER, { messages, tools: [] }, "reflection/beam", false);
    expect(JSON.parse(request.body).messages[0].reasoning_content).toBe(" ");
  });
  test("replays captured reasoning from delta.reasoning and message.reasoning rather than placeholder", async () => {
    const replayModel = "reflection/beam";
    const owner = scope("fixture-thread", PROVIDER, "fixture", replayModel);
    const budget = createTranslatorBudget();
    const capture = nativeChatReasoningCapture(PROVIDER, replayModel, owner, budget);

    capture.json({ choices: [
      { message: { reasoning: "from-json-message-reasoning", tool_calls: [tool("call_json")] } },
    ] });

    const frames = [
      { choices: [{ index: 0, delta: { reasoning: "from-sse-delta-reasoning", tool_calls: [{ index: 0, id: "call_sse" }] } }] },
    ];
    const source = new Response(frames.map(v => `data: ${JSON.stringify(v)}\n\n`).join("") + "data: [DONE]\n\n").body!;
    const stream = nativeChatSse(source, {
      requestedModel: replayModel,
      translatorBudget: budget,
      signal: new AbortController().signal,
      onUsage() {},
      onChunk: capture.observe,
      onTerminal: s => capture.finish(s < 400),
      onCancel: () => capture.finish(false),
    });
    await new Response(stream).text();

    const reqJson = buildOpenAIChatPassthroughRequest(
      PROVIDER,
      { messages: [{ role: "assistant", content: null, tool_calls: [tool("call_json")] }] },
      "reflection/beam",
      false,
      undefined,
      undefined,
      "test-session",
      owner,
    );
    expect(JSON.parse(reqJson.body).messages[0].reasoning_content).toBe("from-json-message-reasoning");

    const reqSse = buildOpenAIChatPassthroughRequest(
      PROVIDER,
      { messages: [{ role: "assistant", content: null, tool_calls: [tool("call_sse")] }] },
      "reflection/beam",
      false,
      undefined,
      undefined,
      "test-session",
      owner,
    );
    expect(JSON.parse(reqSse.body).messages[0].reasoning_content).toBe("from-sse-delta-reasoning");
    budget.dispose();
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
