import { describe, expect, test } from "bun:test";
import { ollamaToChat, ollamaBufferedResponse, createOllamaStreamState, consumeOllamaChatChunk, ollamaStreamTerminal, OllamaCodecError, MAX_OLLAMA_TOOL_CALLS } from "../../src/protocols/codecs/ollama";

const png = "iVBORw0KGgo=";
const schema = { type: "object", properties: { q: { type: "string", enum: ["a", "b"] } }, required: ["q"], additionalProperties: false };

describe("Ollama codec", () => {
  test("projects chat, images, tools and matched results without changing schema", () => {
    const result = ollamaToChat("chat", { model: "m", messages: [
      { role: "system", content: "rules" }, { role: "user", content: "look", images: [png] },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "find", arguments: { q: "a" } } }] },
      { role: "tool", tool_name: "find", content: "result" },
    ], tools: [{ type: "function", function: { name: "find", description: "Find", parameters: schema } }], options: { temperature: 0.3, top_p: 0.8, num_predict: 10, stop: ["end"] }, format: "json" });
    expect(result).toEqual({ model: "m", stream: true, messages: [
      { role: "system", content: "rules" }, { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] },
      { role: "assistant", content: "", tool_calls: [{ id: "call_ollama_2_0", type: "function", function: { name: "find", arguments: '{"q":"a"}' } }] },
      { role: "tool", content: "result", tool_call_id: "call_ollama_2_0" },
    ], tools: [{ type: "function", function: { name: "find", description: "Find", parameters: schema } }], temperature: 0.3, top_p: 0.8, max_tokens: 10, stop: ["end"], response_format: { type: "json_object" } });
  });
  test("generate maps system, prompt, image and explicit stream", () => {
    expect(ollamaToChat("generate", { model: "m", prompt: "hi", system: "s", images: [png], stream: false })).toEqual({ model: "m", stream: false, messages: [{ role: "system", content: "s" }, { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] }] });
  });
  test("matches explicit IDs and rejects ambiguous or reused results", () => {
    const calls = [{ function: { name: "f", arguments: {} } }, { function: { name: "f", arguments: {} } }];
    const messages = [{ role: "assistant", content: "", tool_calls: calls }, { role: "tool", content: "x", tool_call_id: "call_ollama_0_1" }, { role: "tool", content: "y", tool_name: "f" }];
    expect((ollamaToChat("chat", { model: "m", messages }).messages as any[]).slice(1).map(m => m.tool_call_id)).toEqual(["call_ollama_0_1", "call_ollama_0_0"]);
    expect(() => ollamaToChat("chat", { model: "m", messages: [messages[0], messages[2]] })).toThrow(OllamaCodecError);
    expect(() => ollamaToChat("chat", { model: "m", messages: [...messages, messages[1]] })).toThrow(OllamaCodecError);
  });
  test("a replayed response tool call keeps its returned id through the result", () => {
    const replay = [
      { role: "assistant", content: "", tool_calls: [{ id: "id1", function: { name: "f", arguments: { x: 1 } } }, { id: "id2", function: { name: "f", arguments: {} } }] },
      { role: "tool", content: "x", tool_call_id: "id2" },
      { role: "tool", content: "y", tool_name: "f" },
    ];
    const out = ollamaToChat("chat", { model: "m", messages: replay }).messages as { tool_calls?: { id: string }[]; tool_call_id?: string }[];
    expect(out[0]!.tool_calls!.map(call => call.id)).toEqual(["id1", "id2"]);
    expect(out.slice(1).map(m => m.tool_call_id)).toEqual(["id2", "id1"]);
    const duplicate = [{ role: "assistant", content: "", tool_calls: [{ id: "same", function: { name: "f", arguments: {} } }, { id: "same", function: { name: "g", arguments: {} } }] }];
    expect(() => ollamaToChat("chat", { model: "m", messages: duplicate })).toThrow(OllamaCodecError);
    expect(() => ollamaToChat("chat", { model: "m", messages: [{ role: "assistant", content: "", tool_calls: [{ id: 7, function: { name: "f", arguments: {} } }] }] })).toThrow(OllamaCodecError);
  });
  test("bounds aggregate tool-call validation work", () => {
    expect(MAX_OLLAMA_TOOL_CALLS).toBe(1_024);
    const calls = Array.from({ length: MAX_OLLAMA_TOOL_CALLS }, (_, i) => ({ id: `id${i}`, function: { name: "f", arguments: {} } }));
    expect((ollamaToChat("chat", { model: "m", messages: [{ role: "assistant", content: "", tool_calls: calls }] }).messages as any[])[0].tool_calls).toHaveLength(MAX_OLLAMA_TOOL_CALLS);
    calls.push({ id: "overflow", function: { name: "f", arguments: {} } });
    expect(() => ollamaToChat("chat", { model: "m", messages: [{ role: "assistant", content: "", tool_calls: calls }] })).toThrow("Too many tool calls");
  });
  test("counts calls across assistant messages even after their results are matched", () => {
    const calls = Array.from({ length: 1_024 }, (_, i) => ({ id: `id${i}`, function: { name: "f", arguments: {} } }));
    const laterCalls = calls.slice(512);
    const messages = [
      { role: "assistant", content: "", tool_calls: calls.slice(0, 512) },
      ...calls.slice(0, 512).map(call => ({ role: "tool", content: "done", tool_call_id: call.id })),
      { role: "assistant", content: "", tool_calls: laterCalls },
    ];
    const accepted = ollamaToChat("chat", { model: "m", messages }).messages as { tool_calls?: unknown[] }[];
    expect(accepted.at(-1)!.tool_calls).toHaveLength(512);
    laterCalls.push({ id: "overflow", function: { name: "f", arguments: {} } });
    expect(() => ollamaToChat("chat", { model: "m", messages })).toThrow("Too many tool calls");
  });
  test("matches the latest unambiguous name group before falling back to earlier calls", () => {
    const call = (id: string) => ({ id, function: { name: "f", arguments: {} } });
    const history = [
      { role: "assistant", content: "", tool_calls: [call("older")] },
      { role: "assistant", content: "", tool_calls: [call("newer-a"), call("newer-b")] },
    ];
    const byName = { role: "tool", content: "done", tool_name: "f" };
    expect(() => ollamaToChat("chat", { model: "m", messages: [...history, byName] })).toThrow("Ambiguous tool result");
    const messages = [...history, { role: "tool", content: "done", tool_call_id: "newer-b" }, byName, byName];
    const matched = ollamaToChat("chat", { model: "m", messages }).messages as { tool_call_id?: string }[];
    expect(matched.slice(2).map(message => message.tool_call_id)).toEqual(["newer-b", "newer-a", "older"]);
  });
  test("keeps duplicate IDs reserved after a result and refuses mismatched explicit IDs", () => {
    const assistant = { role: "assistant", content: "", tool_calls: [{ id: "stable", function: { name: "f", arguments: {} } }] };
    const result = { role: "tool", content: "done", tool_call_id: "stable" };
    expect(() => ollamaToChat("chat", { model: "m", messages: [assistant, result, assistant] })).toThrow("Duplicate tool call id");
    for (const unmatched of [
      { ...result, tool_name: "other" },
      { ...result, tool_call_id: "missing", tool_name: "f" },
    ]) expect(() => ollamaToChat("chat", { model: "m", messages: [assistant, unmatched] })).toThrow("Unmatched tool result");
  });
  test("rejects unsupported and malformed shapes with bounded errors", () => {
    for (const body of [
      { model: "m", prompt: "x", suffix: "y" }, { model: "m", prompt: "x", think: false },
      { model: "m", prompt: "x", options: { top_k: 3 } }, { model: "m", prompt: "x", format: {} },
      { model: "m", prompt: "x", images: ["https://example.com/x"] }, { model: "m", prompt: "x", images: ["aGVsbG8="] },
      { model: "m", prompt: "x", images: ["iVBORw0KGgo=garbage"] }, { model: "m", prompt: 5 },
    ]) {
      try { ollamaToChat("generate", body); throw new Error("accepted"); } catch (e) { expect(e).toBeInstanceOf(OllamaCodecError); expect((e as OllamaCodecError).status).toBe(400); expect((e as OllamaCodecError).message.length).toBeLessThan(200); }
    }
  });
  test("buffered responses preserve calls and usage and reject bad finishes", () => {
    const base = { choices: [{ message: { content: "hello", tool_calls: [{ id: "id1", type: "function", function: { name: "f", arguments: '{"x":1}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 2 } };
    expect(ollamaBufferedResponse("chat", "m", base, "time")).toEqual({ model: "m", created_at: "time", message: { role: "assistant", content: "hello", tool_calls: [{ id: "id1", function: { name: "f", arguments: { x: 1 } } }] }, done: true, done_reason: "tool_calls", prompt_eval_count: 4, eval_count: 2 });
    expect(ollamaBufferedResponse("generate", "m", { choices: [{ message: { content: "hi" }, finish_reason: "length" }] }, "time")).toEqual({ model: "m", created_at: "time", response: "hi", done: true, done_reason: "length" });
    for (const finish_reason of ["content_filter", "other", null]) expect(ollamaBufferedResponse("chat", "m", { choices: [{ message: { content: "x" }, finish_reason }] }, "time")).toEqual({ error: expect.any(String) });
  });
  test("stream retains finish and latest usage without producing a success until settlement", () => {
    const state = createOllamaStreamState("chat", "m", "time");
    expect(consumeOllamaChatChunk(state, { choices: [{ delta: { content: "hi" }, finish_reason: null }] })).toEqual([{ model: "m", created_at: "time", message: { role: "assistant", content: "hi" }, done: false }]);
    expect(consumeOllamaChatChunk(state, { choices: [{ delta: {}, finish_reason: "stop" }] })).toEqual([]);
    expect(consumeOllamaChatChunk(state, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } })).toEqual([]);
    expect(ollamaStreamTerminal(state)).toEqual({ model: "m", created_at: "time", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 1 });
    expect(ollamaStreamTerminal(createOllamaStreamState("generate", "m", "time"))).toEqual({ error: expect.any(String) });
  });
  test("streamed tool fragments retain identity and object arguments", () => {
    const state = createOllamaStreamState("chat", "m", "time");
    consumeOllamaChatChunk(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: "abc", function: { name: "f", arguments: '{"x":' } }] }, finish_reason: null }] });
    expect(consumeOllamaChatChunk(state, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: "tool_calls" }] })).toEqual([{ model: "m", created_at: "time", message: { role: "assistant", content: "", tool_calls: [{ id: "abc", function: { name: "f", arguments: { x: 1 } } }] }, done: false }]);
  });
  test("accepts supported image signatures with exact encoded bytes", () => {
    for (const [data, mime] of [["/9j/AA==", "jpeg"], ["R0lGODlh", "gif"], ["UklGRgAAAABXRUJQ", "webp"]]) {
      expect(ollamaToChat("generate", { model: "m", prompt: "", images: [data] })).toMatchObject({ messages: [{ content: [{ type: "text", text: "" }, { image_url: { url: `data:image/${mime};base64,${data}` } }] }] });
    }
  });
  test("rejects extra message, call and tool fields and malformed options", () => {
    for (const body of [
      { model: "m", messages: [{ role: "user", content: "x", audio: [] }] },
      { model: "m", messages: [{ role: "system", content: "x", images: [png] }] },
      { model: "m", messages: [{ role: "assistant", content: "", tool_calls: [{ function: { name: "f", arguments: "{}" } }] }] },
      { model: "m", messages: [{ role: "tool", content: "x", tool_name: "f" }] },
      { model: "m", messages: [], tools: [{ type: "function", function: { name: "f", parameters: schema, strict: true } }] },
      { model: "m", messages: [], options: { num_predict: -1 } },
      { model: "m", messages: [], options: { stop: "x" } },
      { model: "m", messages: [], stream: "false" },
    ]) expect(() => ollamaToChat("chat", body)).toThrow(OllamaCodecError);
    expect(() => ollamaToChat("generate", { model: "m", prompt: "x", images: ["/9j/AB=="] })).toThrow(OllamaCodecError);
  });
  test("stream terminal maps finishes and keeps failures distinct", () => {
    for (const reason of ["stop", "length", "tool_calls", "content_filter", "unknown"]) {
      const state = createOllamaStreamState("generate", "m", "time");
      consumeOllamaChatChunk(state, { choices: [{ delta: {}, finish_reason: reason }] });
      const terminal = ollamaStreamTerminal(state);
      if (["stop", "length", "tool_calls"].includes(reason)) expect(terminal).toMatchObject({ done: true, done_reason: reason });
      else expect(terminal).toEqual({ error: expect.any(String) });
      expect(() => consumeOllamaChatChunk(state, { choices: [{ delta: { content: "late" }, finish_reason: null }] })).toThrow();
      expect(() => consumeOllamaChatChunk(state, { error: { message: "failure" }, choices: [] })).toThrow();
    }
  });
  test("stable fallback IDs and invalid tool argument streams", () => {
    const state = createOllamaStreamState("chat", "m", "time");
    const records = consumeOllamaChatChunk(state, { choices: [{ delta: { tool_calls: [{ index: 2, function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
    expect(records[0]).toMatchObject({ message: { tool_calls: [{ id: "call_ollama_response_2" }] } });
    const bad = createOllamaStreamState("chat", "m", "time");
    expect(() => consumeOllamaChatChunk(bad, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "f", arguments: "{" } }] }, finish_reason: "tool_calls" }] })).toThrow();
    expect(ollamaStreamTerminal(bad)).toEqual({ error: expect.any(String) });
  });
});
