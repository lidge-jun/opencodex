import { describe, expect, test } from "bun:test";
import {
  InteractionsCodecError,
  chatCompletionAnswer,
  consumeInteractionsChatChunk,
  createInteractionsStreamState,
  interactionResource,
  interactionsStreamAnswer,
  interactionsStreamFailure,
  interactionsStreamTerminal,
  interactionsToChat,
  newInteractionId,
} from "../../src/protocols/codecs/gemini-interactions";

const meta = { id: "ocx-int-00000000000000000000000000000000", model: "fx/m1", created: "2026-11-15T00:00:00Z" };
const refused = (body: unknown, message: string) => {
  expect(() => interactionsToChat(body)).toThrow(InteractionsCodecError);
  expect(() => interactionsToChat(body)).toThrow(message);
};
const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  ({ choices: [{ index: 0, delta, finish_reason: finish }], ...extra });

describe("Interactions request → Chat", () => {
  test("string input, models/ prefix, system_instruction and generation_config", () => {
    const plan = interactionsToChat({
      model: "models/fx/m1",
      input: "hi",
      system_instruction: "rules",
      generation_config: { temperature: 0.2, top_p: 0.9, seed: 7, stop_sequences: ["END"], max_output_tokens: 64, thinking_level: "high", thinking_summaries: "auto" },
    });
    expect(plan.model).toBe("fx/m1");
    expect(plan.stream).toBe(false);
    expect(plan.store).toBe(true);
    expect(plan.systemMessages).toEqual([{ role: "system", content: "rules" }]);
    expect(plan.inputMessages).toEqual([{ role: "user", content: "hi" }]);
    expect(plan.chat).toEqual({ model: "fx/m1", stream: false, temperature: 0.2, top_p: 0.9, seed: 7, stop: ["END"], max_tokens: 64, reasoning_effort: "high", include_reasoning: true });
  });

  test("content items become one user message; an image keeps parts", () => {
    expect(interactionsToChat({ model: "m", input: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }).inputMessages)
      .toEqual([{ role: "user", content: "a\nb" }]);
    expect(interactionsToChat({ model: "m", input: [{ type: "text", text: "look" }, { type: "image", mime_type: "image/png", data: "iVBORw0KGgo=" }] }).inputMessages)
      .toEqual([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }]);
  });

  test("step history maps calls, results and a held thought signature", () => {
    const plan = interactionsToChat({ model: "m", input: [
      { type: "user_input", content: [{ type: "text", text: "weather?" }] },
      { type: "thought", signature: "sig-1", summary: [{ type: "text", text: "think" }] },
      { type: "model_output", content: [{ type: "text", text: "checking" }] },
      { type: "function_call", id: "c1", name: "get_weather", arguments: { city: "Paris" } },
      { type: "function_result", call_id: "c1", name: "get_weather", result: { temp: 20 } },
      { type: "function_result", call_id: "c1", result: "oops", is_error: true },
    ] });
    expect(plan.unmatchedResultIds).toEqual([]);
    expect(plan.inputMessages).toEqual([
      { role: "user", content: "weather?" },
      { role: "assistant", content: "checking", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" }, extra_content: { google: { thought_signature: "sig-1" } } }] },
      { role: "tool", tool_call_id: "c1", content: "{\"temp\":20}" },
      { role: "tool", tool_call_id: "c1", content: "{\"error\":\"oops\"}" },
    ]);
  });

  test("a function_result without its call is reported, not refused", () => {
    const plan = interactionsToChat({ model: "m", input: [{ type: "function_result", call_id: "c9", result: "ok" }] });
    expect(plan.unmatchedResultIds).toEqual(["c9"]);
  });

  test("tools, tool_choice and response_format", () => {
    const plan = interactionsToChat({
      model: "m", input: "x",
      tools: [{ type: "function", name: "lookup", description: "find", parameters: { type: "OBJECT", properties: { q: { type: "STRING" } } } }],
      generation_config: { tool_choice: { allowed_tools: { mode: "any", tools: ["lookup"] } } },
      response_format: { type: "text", mime_type: "application/json", schema: { type: "object" } },
    });
    expect(plan.chat.tools).toEqual([{ type: "function", function: { name: "lookup", description: "find", parameters: { type: "object", properties: { q: { type: "string" } } } } }]);
    expect(plan.chat.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
    expect(plan.chat.response_format).toEqual({ type: "json_schema", json_schema: { name: "response", schema: { type: "object" } } });
    expect(interactionsToChat({ model: "m", input: "x", tools: [{ type: "function", name: "f" }], tool_choice: "any" }).chat.tool_choice).toBe("required");
    expect(interactionsToChat({ model: "m", input: "x", tools: [{ type: "function", name: "f" }, { type: "function", name: "g" }], tool_choice: { allowed_tools: { mode: "any", tools: ["f", "g"] } } }).chat.tool_choice)
      .toEqual({ type: "allowed_tools", allowed_tools: { mode: "required", tools: [{ type: "function", function: { name: "f" } }, { type: "function", function: { name: "g" } }] } });
    expect(interactionsToChat({ model: "m", input: "x", tools: [{ type: "function", name: "f" }], tool_choice: { allowed_tools: { mode: "validated", tools: ["f"] } } }).chat.tool_choice)
      .toEqual({ type: "allowed_tools", allowed_tools: { mode: "auto", tools: [{ type: "function", function: { name: "f" } }] } });
    for (const format of [{ type: "text" }, { type: "text", mime_type: "text/plain" }]) {
      expect(interactionsToChat({ model: "m", input: "x", response_format: format }).chat.response_format).toBeUndefined();
    }
    expect(interactionsToChat({ model: "m", input: "x", response_format: [{ type: "text", mime_type: "application/json" }] }).chat.response_format).toEqual({ type: "json_object" });
    expect(interactionsToChat({ model: "m", input: "x", tools: [{ type: "function", name: "f" }], tool_choice: "none" }).chat.tool_choice).toBe("none");
    expect(interactionsToChat({ model: "m", input: "x", tools: [{ type: "function", name: "f" }], tool_choice: "auto" }).chat.tool_choice).toBeUndefined();
  });

  test("background:false and unknown benign fields are accepted", () => {
    expect(interactionsToChat({ model: "m", input: "x", background: false, service_tier: "flex", safety_settings: [] }).inputMessages).toEqual([{ role: "user", content: "x" }]);
  });

  test("store, stream and previous_interaction_id are recorded on the plan", () => {
    const plan = interactionsToChat({ model: "m", input: "x", stream: true, store: false, previous_interaction_id: "ocx-int-abc" });
    expect(plan).toMatchObject({ stream: true, store: false, previousInteractionId: "ocx-int-abc" });
    expect(plan.chat.stream).toBe(true);
  });

  test("requests that cannot be honored are 400s", () => {
    refused({ input: "x" }, "exactly one of model or agent");
    refused({ model: "m", agent: "a", input: "x" }, "exactly one of model or agent");
    refused({ agent: "deep-research-preview-04-2026", input: "x" }, "native Interactions upstream");
    refused({ model: "m", input: "x", stream: "yes" }, "stream must be a boolean");
    refused({ model: "m", input: "x", background: true }, "background interactions are not supported");
    refused({ model: "m", input: "x", tools: [{ type: "google_search" }] }, "unsupported tool type: google_search");
    refused({ model: "m", input: [{ type: "code_execution_call", id: "x", arguments: {} }] }, "unsupported step type: code_execution_call");
    refused({ model: "m", input: [{ type: "image", uri: "https://example.com/a.png", mime_type: "image/png" }] }, "image without inline data");
    refused({ model: "m", input: [{ type: "audio", data: "AAAA", mime_type: "audio/wav" }] }, "unsupported content type: audio");
    refused({ model: "m", input: "x", response_format: { type: "image" } }, "unsupported response_format type: image");
    refused({ model: "m", input: "x", response_modalities: ["IMAGE"] }, "only text output is supported");
    refused({ model: "m", input: [{ type: "function_call", id: "c", name: "f", arguments: {} }, { type: "function_call", id: "c", name: "f", arguments: {} }] }, "Duplicate function_call id");
    refused({ model: "m", input: "x", store: "no" }, "store must be a boolean");
    refused({ model: "m", input: "x", background: "no" }, "background must be a boolean");
    refused({ model: "m", input: "x", previous_interaction_id: 7 }, "Invalid previous_interaction_id");
    refused({ model: "m", input: [{ type: "function_call", id: "c", name: "f", arguments: "{}" }] }, "Invalid function_call arguments");
    refused({ model: "m", input: [{ type: "function_call", id: "c", name: "f", arguments: {} }, { type: "function_result", call_id: "c", result: [{ type: "image", data: "AAAA", mime_type: "image/png" }] }] }, "unsupported content in function_result result");
    refused({ model: "m" }, "Invalid input");
    for (const field of ["webhook_config", "environment", "agent_config"]) refused({ model: "m", input: "x", [field]: {} }, field + " is not supported");
    const deep: Record<string, unknown> = { type: "object" };
    let cursor = deep;
    for (let i = 0; i < 70; i++) { const next: Record<string, unknown> = { type: "object" }; cursor.properties = { a: next }; cursor = next; }
    refused({ model: "m", input: "x", tools: [{ type: "function", name: "f", parameters: deep }] }, "Schema nesting too deep");
    refused({ model: "m", input: "x", tools: [{ type: "function", name: "f", parameters: [] }] }, "Invalid function parameters");
    refused({ model: "m", input: "x", tools: [{ type: "function", name: "f" }], tool_choice: { allowed_tools: { mode: "sometimes" } } }, "Unsupported tool_choice mode");
  });
});

describe("Chat → Interaction", () => {
  const completion = (message: Record<string, unknown>, finish: string, usage?: Record<string, unknown>) =>
    ({ choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage } : {}) });

  test("a text answer is a completed interaction with Google usage names", () => {
    const answer = chatCompletionAnswer(completion({ role: "assistant", content: "Hello", reasoning_content: "hmm" }, "stop",
      { prompt_tokens: 5, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 4 } }));
    expect(interactionResource(meta, answer, "2026-11-15T00:00:01Z")).toEqual({
      id: meta.id, object: "interaction", status: "completed", created: meta.created, updated: "2026-11-15T00:00:01Z", model: "fx/m1",
      steps: [
        { type: "thought", summary: [{ type: "text", text: "hmm" }] },
        { type: "model_output", content: [{ type: "text", text: "Hello" }] },
      ],
      usage: { total_input_tokens: 5, total_cached_tokens: 2, total_output_tokens: 5, total_thought_tokens: 4, total_tokens: 14 },
    });
  });

  test("a tool turn requires action and carries a signature as a thought step", () => {
    const answer = chatCompletionAnswer(completion({ role: "assistant", content: null, tool_calls: [
      { id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" }, extra_content: { google: { thought_signature: "sig" } } },
    ] }, "tool_calls"));
    expect(answer.status).toBe("requires_action");
    expect(interactionResource(meta, answer).steps).toEqual([
      { type: "thought", signature: "sig" },
      { type: "function_call", id: "call_1", name: "lookup", arguments: { q: "x" } },
    ]);
  });

  test("length is incomplete; an unknown finish is an error", () => {
    expect(chatCompletionAnswer(completion({ role: "assistant", content: "cut" }, "length")).status).toBe("incomplete");
    expect(() => chatCompletionAnswer(completion({ role: "assistant", content: "x" }, "weird"))).toThrow();
  });

  test("output tokens never go negative", () => {
    const answer = chatCompletionAnswer(completion({ role: "assistant", content: "x" }, "stop", { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 5 } }));
    expect(answer.usage).toMatchObject({ total_output_tokens: 0, total_thought_tokens: 5 });
  });
});

describe("Chat stream → Interactions events", () => {
  const types = (events: { event: string }[]) => events.map(event => event.event);

  test("reasoning then text: created, thought step, output step, completed with usage", () => {
    const state = createInteractionsStreamState(meta);
    const events = [
      ...consumeInteractionsChatChunk(state, chunk({ role: "assistant" })),
      ...consumeInteractionsChatChunk(state, chunk({ reasoning_content: "think" })),
      ...consumeInteractionsChatChunk(state, chunk({ content: "Hel" })),
      ...consumeInteractionsChatChunk(state, chunk({ content: "lo" })),
      ...consumeInteractionsChatChunk(state, chunk({}, "stop")),
      ...consumeInteractionsChatChunk(state, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    ];
    const answer = interactionsStreamAnswer(state)!;
    const terminal = interactionsStreamTerminal(state, answer, "2026-11-15T00:00:02Z");
    expect(types([...events, ...terminal])).toEqual([
      "interaction.created", "step.start", "step.delta", "step.stop", "step.start", "step.delta", "step.delta", "step.stop", "interaction.completed",
    ]);
    expect(events[0]!.data).toEqual({ event_type: "interaction.created", interaction: { id: meta.id, object: "interaction", status: "in_progress", model: "fx/m1", created: meta.created, updated: meta.created } });
    expect(events[1]!.data).toEqual({ event_type: "step.start", index: 0, step: { type: "thought" } });
    expect(events[2]!.data).toEqual({ event_type: "step.delta", index: 0, delta: { type: "thought_summary", content: { type: "text", text: "think" } } });
    expect(events[5]!.data).toEqual({ event_type: "step.delta", index: 1, delta: { type: "text", text: "Hel" } });
    expect(terminal.at(-1)!.data).toEqual({ event_type: "interaction.completed", interaction: {
      id: meta.id, object: "interaction", status: "completed", model: "fx/m1", created: meta.created, updated: "2026-11-15T00:00:02Z",
      usage: { total_input_tokens: 3, total_cached_tokens: 0, total_output_tokens: 2, total_thought_tokens: 0, total_tokens: 5 },
    } });
  });

  test("streamed tool calls arrive whole at finish as function_call steps", () => {
    const state = createInteractionsStreamState(meta);
    const events = [
      ...consumeInteractionsChatChunk(state, chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "look", arguments: "{\"q\":" } }] })),
      ...consumeInteractionsChatChunk(state, chunk({ tool_calls: [{ index: 0, function: { name: "up", arguments: "\"x\"}" } }] })),
      ...consumeInteractionsChatChunk(state, chunk({}, "tool_calls")),
    ];
    expect(types(events)).toEqual(["interaction.created", "step.start", "step.delta", "step.stop"]);
    expect(events[1]!.data).toEqual({ event_type: "step.start", index: 0, step: { type: "function_call", id: "call_1", name: "lookup", arguments: {} } });
    expect(events[2]!.data).toEqual({ event_type: "step.delta", index: 0, delta: { type: "arguments_delta", arguments: "{\"q\":\"x\"}" } });
    expect(interactionsStreamAnswer(state)).toMatchObject({ status: "requires_action", calls: [{ id: "call_1", name: "lookup", arguments: { q: "x" } }] });
  });

  test("no terminal before a finish; failure frames still open with interaction.created", () => {
    const state = createInteractionsStreamState(meta);
    consumeInteractionsChatChunk(state, chunk({ content: "partial" }));
    expect(interactionsStreamAnswer(state)).toBeUndefined();
    const fresh = createInteractionsStreamState(meta);
    expect(interactionsStreamFailure(fresh, 502, "request did not complete").map(event => event.data)).toEqual([
      { event_type: "interaction.created", interaction: { id: meta.id, object: "interaction", status: "in_progress", model: "fx/m1", created: meta.created, updated: meta.created } },
      { event_type: "error", error: { code: "internal", message: "request did not complete" } },
    ]);
    expect(() => consumeInteractionsChatChunk(state, chunk({}, "stop")) && consumeInteractionsChatChunk(state, chunk({ content: "late" }))).toThrow("Chat chunk after finish");
  });
});

test("interaction ids carry 128 random bits", () => {
  const id = newInteractionId();
  expect(id).toMatch(/^ocx-int-[0-9a-f]{32}$/);
  expect(newInteractionId()).not.toBe(id);
});

