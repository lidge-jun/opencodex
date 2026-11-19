import { describe, expect, test } from "bun:test";
import {
  GeminiCodecError,
  MAX_GEMINI_TOOL_CALLS,
  chatToGeminiResponse,
  consumeGeminiChatChunk,
  createGeminiStreamState,
  geminiStreamTerminal,
  geminiToChat,
} from "../../src/protocols/codecs/gemini";

const png = "iVBORw0KGgo=";
const declaration = { name: "find", description: "Find", parameters: { type: "OBJECT", properties: { q: { type: "STRING" } }, required: ["q"] } };

describe("Gemini codec request mapping", () => {
  test("projects system, text, image, tools, function call and response onto Chat", () => {
    const result = geminiToChat("fx/m1", {
      systemInstruction: { parts: [{ text: "rules" }] },
      contents: [
        { role: "user", parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: png } }] },
        { role: "model", parts: [{ text: "checking" }, { functionCall: { name: "find", args: { q: "a" } } }] },
        { role: "user", parts: [{ functionResponse: { name: "find", response: { hit: true } } }] },
      ],
      tools: [{ functionDeclarations: [declaration] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["find"] } },
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 50, stopSequences: ["end"], thinkingConfig: { thinkingLevel: "HIGH" } },
    }, true);
    expect(result).toEqual({
      model: "fx/m1",
      stream: true,
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] },
        { role: "assistant", content: "checking", tool_calls: [{ id: "call_gemini_1_1", type: "function", function: { name: "find", arguments: '{"q":"a"}' } }] },
        { role: "tool", tool_call_id: "call_gemini_1_1", content: '{"hit":true}' },
      ],
      tools: [{ type: "function", function: { name: "find", description: "Find", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } } }],
      tool_choice: { type: "function", function: { name: "find" } },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 50,
      stop: ["end"],
      reasoning_effort: "high",
    });
  });

  test("accepts snake_case fields and a plain system string", () => {
    const result = geminiToChat("m", { system_instruction: "be brief", contents: [{ role: "user", parts: [{ text: "hi" }] }], generation_config: { max_output_tokens: 5 } }, false);
    expect(result).toEqual({ model: "m", stream: false, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], max_tokens: 5 });
  });

  test("rejects requests that would silently change the answer", () => {
    const user = [{ role: "user", parts: [{ text: "hi" }] }];
    expect(() => geminiToChat("m", { contents: user, generationConfig: { candidateCount: 2 } }, false)).toThrow(GeminiCodecError);
    expect(() => geminiToChat("m", { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: png } }] }] }, false)).toThrow(GeminiCodecError);
    expect(() => geminiToChat("m", { contents: [{ role: "user", parts: [{ functionResponse: { name: "ghost", response: {} } }] }] }, false)).toThrow("Unmatched function response");
    expect(() => geminiToChat("m", { contents: "hi" }, false)).toThrow(GeminiCodecError);
  });

  test("VALIDATED never forces a call; ANY still does", () => {
    const base = { contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [{ functionDeclarations: [declaration, { ...declaration, name: "open" }] }] };
    const choice = (functionCallingConfig: unknown) => geminiToChat("m", { ...base, toolConfig: { functionCallingConfig } }, false).tool_choice;
    expect(choice({ mode: "VALIDATED" })).toBeUndefined();
    expect(choice({ mode: "VALIDATED", allowedFunctionNames: ["find"] })).toEqual({ type: "allowed_tools", allowed_tools: { mode: "auto", tools: [{ type: "function", function: { name: "find" } }] } });
    expect(choice({ mode: "VALIDATED", allowedFunctionNames: ["find", "open"] })).toEqual({ type: "allowed_tools", allowed_tools: { mode: "auto", tools: [{ type: "function", function: { name: "find" } }, { type: "function", function: { name: "open" } }] } });
    expect(choice({ mode: "ANY" })).toBe("required");
    expect(choice({ mode: "ANY", allowedFunctionNames: ["find"] })).toEqual({ type: "function", function: { name: "find" } });
  });

  test("an image inside functionResponse.parts reaches the next turn after the tool batch; other nested parts are refused", () => {
    const contents = (parts: unknown[]) => [
      { role: "user", parts: [{ text: "shoot" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "screenshot", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "screenshot", response: { ok: true }, parts } }] },
    ];
    const result = geminiToChat("m", { contents: contents([{ inlineData: { mimeType: "image/png", data: png } }]) }, false);
    expect((result.messages as unknown[]).slice(2)).toEqual([
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
      { role: "user", content: [{ type: "text", text: "Image output of screenshot (call c1):" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] },
    ]);
    expect(() => geminiToChat("m", { contents: contents([{ fileData: { mimeType: "image/png", fileUri: "gs://x" } }]) }, false)).toThrow("Unsupported functionResponse part");
    expect(() => geminiToChat("m", { contents: contents([{ inlineData: { mimeType: "audio/wav", data: png } }]) }, false)).toThrow(GeminiCodecError);
  });

  test("bounds function calls in one request", () => {
    const parts = Array.from({ length: MAX_GEMINI_TOOL_CALLS + 1 }, (_, i) => ({ functionCall: { id: `c${i}`, name: "f", args: {} } }));
    expect(() => geminiToChat("m", { contents: [{ role: "model", parts }] }, false)).toThrow("Too many function calls");
  });
});

const usage = { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9, completion_tokens_details: { reasoning_tokens: 1 } };

describe("Gemini codec response mapping", () => {
  test("buffered completion carries text, thought, tool call, finish and usage", () => {
    const body = chatToGeminiResponse("fx/m1", {
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "Hi", reasoning_content: "hmm", tool_calls: [{ id: "call_1", type: "function", function: { name: "find", arguments: '{"q":"a"}' } }] } }],
      usage,
    });
    expect(body).toEqual({
      candidates: [{ content: { role: "model", parts: [{ text: "hmm", thought: true }, { text: "Hi" }, { functionCall: { id: "call_1", name: "find", args: { q: "a" } } }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 9, thoughtsTokenCount: 1 },
      modelVersion: "fx/m1",
    });
  });

  test("length maps to MAX_TOKENS and an unfinished completion is an error", () => {
    const choice = (finish: unknown) => ({ choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: "x" } }] });
    expect((chatToGeminiResponse("m", choice("length")).candidates as any[])[0].finishReason).toBe("MAX_TOKENS");
    expect((chatToGeminiResponse("m", choice("content_filter")).candidates as any[])[0].finishReason).toBe("SAFETY");
    expect(() => chatToGeminiResponse("m", choice("mystery"))).toThrow();
    expect(() => chatToGeminiResponse("m", choice(null))).toThrow();
  });

  test("a stream emits text and thought deltas, then one complete tool call, then the terminal with usage", () => {
    const state = createGeminiStreamState("fx/m1");
    const chunk = (delta: Record<string, unknown>, finish: unknown = null, extra: Record<string, unknown> = {}) => ({ choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
    const records = [
      ...consumeGeminiChatChunk(state, chunk({ role: "assistant", reasoning_content: "think" })),
      ...consumeGeminiChatChunk(state, chunk({ content: "Hel" })),
      ...consumeGeminiChatChunk(state, chunk({ content: "lo" })),
      ...consumeGeminiChatChunk(state, chunk({ tool_calls: [{ index: 0, id: "call_9", function: { name: "find", arguments: '{"q"' } }] })),
      ...consumeGeminiChatChunk(state, chunk({ tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] })),
    ];
    expect(geminiStreamTerminal(state)).toBeUndefined();
    records.push(...consumeGeminiChatChunk(state, chunk({}, "tool_calls")));
    expect(consumeGeminiChatChunk(state, { choices: [], usage })).toEqual([]);
    const parts = records.map(record => (record.candidates as any[])[0].content.parts[0]);
    expect(parts).toEqual([
      { text: "think", thought: true }, { text: "Hel" }, { text: "lo" },
      { functionCall: { id: "call_9", name: "find", args: { q: "a" } } },
    ]);
    expect(geminiStreamTerminal(state)).toEqual({
      candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 9, thoughtsTokenCount: 1 },
      modelVersion: "fx/m1",
    });
  });

  test("a stream error chunk or chunk after finish fails the stream", () => {
    const state = createGeminiStreamState("m");
    expect(() => consumeGeminiChatChunk(state, { error: { message: "x" } })).toThrow();
    consumeGeminiChatChunk(state, { choices: [{ index: 0, delta: { content: "a" }, finish_reason: "stop" }] });
    expect(() => consumeGeminiChatChunk(state, { choices: [{ index: 0, delta: { content: "b" } }] })).toThrow();
  });
});
