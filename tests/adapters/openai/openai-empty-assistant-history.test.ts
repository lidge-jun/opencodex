import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../../src/adapters/openai-responses";
import { parseRequest } from "../../../src/responses/parser";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import type { OcxProviderConfig } from "../../../src/types";

const provider: OcxProviderConfig = {
  adapter: "openai-responses", baseUrl: "https://api.kimi.com/coding/v1",
  authMode: "oauth", apiKey: "test-credential", modelSuffixBracketStrip: true,
  preserveReasoningContentModels: ["k3", "k3[1m]"],
  requiresAdjacentResponsesToolResults: true,
};
const user = { type: "message", role: "user", content: "continue" };
const assistant = (content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: "message", role: "assistant", content, ...extra });

function build(input: unknown[], wire: "responses" | "chat" = "responses", target = provider) {
  const raw = { model: "k3[1m]", input, store: true };
  const snapshot = JSON.stringify(raw);
  const parsed = parseRequest(raw);
  const adapter = wire === "responses"
    ? createResponsesPassthroughAdapter(target)
    : createOpenAIChatAdapter({ ...target, adapter: "openai-chat" });
  const budget = createTranslatorBudget();
  const request = adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget });
  request.releaseBodyObservation?.();
  budget.dispose();
  expect(JSON.stringify(raw)).toBe(snapshot);
  expect(JSON.stringify(parsed._rawBody)).toBe(snapshot);
  return { parsed, request, body: JSON.parse(request.body) as Record<string, any> };
}

describe("Kimi empty assistant history on the final Responses wire", () => {
  test.each(["", [], [{ type: "output_text", text: "" }], [
    { type: "output_text", text: "", annotations: [] }, { type: "output_text", text: "" },
  ]].map(content => ({ content })))("removes explicit content-empty messages without inventing text: $content", ({ content }) => {
    const { body } = build([assistant(content), user]);
    expect(body.input).toEqual([user]);
  });

  test("synthetic 585th empty assistant passes an offline strict upstream after filtering", async () => {
    const input: unknown[] = Array.from({ length: 584 }, (_, i) => ({ ...user, content: `turn ${i}` }));
    input.push(assistant([{ type: "output_text", text: "" }]), user);
    const { request, body } = build(input);
    // This models the observed error, not a capture of the user's 585th source item.
    const fakeFetch = async (_url: string, init: RequestInit) => {
      const wire = JSON.parse(String(init.body));
      const bad = wire.input.findIndex((item: any) => item.role === "assistant"
        && Array.isArray(item.content) && item.content.every((part: any) => part.text === ""));
      return bad >= 0
        ? new Response(`Invalid request: the message at position ${bad + 1} with role 'assistant' must not be empty`, { status: 400 })
        : new Response("{}", { status: 200 });
    };
    const original = await fakeFetch(request.url, { body: JSON.stringify({ input }) });
    expect(original.status).toBe(400);
    expect(await original.text()).toBe("Invalid request: the message at position 585 with role 'assistant' must not be empty");
    expect(body.input).toHaveLength(585);
    expect((await fakeFetch(request.url, { body: request.body })).status).toBe(200);
  });

  test("preserves text, whitespace, refusals, unknown parts and independent tools/reasoning", () => {
    const kept = [
      assistant("valid answer"), assistant(" \n"),
      assistant([{ type: "output_text", text: "", annotations: [{ type: "citation", value: "evidence" }] }]),
      assistant([{ type: "refusal", refusal: "refused" }]),
      assistant([{ type: "future_part", payload: "keep" }]),
      assistant("", { reasoning_content: "keep reasoning" }),
      assistant([], { reasoning_details: [{ type: "reasoning.text", text: "keep details" }] }),
      assistant([], { encrypted_content: "opaque-test-state" }),
      assistant("", { tool_calls: [{ id: "legacy", type: "function", function: { name: "read_file", arguments: "{}" } }] }),
      { type: "reasoning", summary: [{ type: "summary_text", text: "reasoning" }] },
      { type: "reasoning", encrypted_content: "opaque-test-state", summary: [] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "result" }, user,
    ];
    expect(build(kept).body.input).toEqual(kept);
  });

  test("drops blank metadata-bearing messages between paired calls without changing the tool history", () => {
    const call = { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" };
    const result = { type: "function_call_output", call_id: "call_1", output: "result" };
    const implicit = { role: "assistant", content: [{ type: "output_text", text: "" }] };
    expect(build([
      call, assistant("", { id: "msg_blank", status: "completed", phase: "commentary" }),
      result, implicit, user,
    ]).body.input).toEqual([call, result, user]);
  });

  test("retains an empty message targeted by a same-input item reference without keeping unreferenced empties", () => {
    const target = assistant("", { id: "msg_referenced" });
    const reference = { type: "item_reference", id: "msg_referenced" };
    expect(build([target, assistant("", { id: "msg_unreferenced" }), reference, user]).body.input)
      .toEqual([target, reference, user]);
  });

  test("keeps multimodal and opaque non-text assistant parts", () => {
    const kept = [assistant([{ type: "output_image", image_url: "https://example.test/fixture.png" }]),
      assistant([{ type: "output_audio", data: "synthetic-audio" }])];
    expect(build([...kept, user]).body.input).toEqual([...kept, user]);
  });

  test.each([
    "https://api.openai.com/v1", "https://api.deepseek.com/v1",
    "https://api.minimax.io/v1", "https://api.moonshot.ai/v1",
    "https://api.kimi.com/v1", "https://api.kimi.com.evil.test/coding/v1",
  ])("keeps other destination contracts unchanged: %s", baseUrl => {
    const input = [assistant(""), user];
    expect(build(input, "responses", { ...provider, baseUrl }).body.input).toEqual(input);
  });
});

describe("translated Chat empty assistant projection", () => {
  test.each(["", [], [{ type: "output_text", text: "" }]].map(content => ({ content })))(
    "retains serialized reasoning despite empty answer content: $content", ({ content }) => {
      const reasoning = { type: "reasoning", summary: [{ type: "summary_text", text: "retained reasoning" }] };
      const { body } = build([reasoning, assistant(content), user], "chat");
      expect(body.messages[0]).toEqual({ role: "assistant", content: "", reasoning_content: "retained reasoning" });
      const details = build([reasoning, assistant(content), user], "chat", {
        ...provider, baseUrl: "https://api.minimax.io/v1", reasoningDetailsModels: ["k3[1m]"],
      }).body.messages[0];
      expect(details.reasoning_details[0].text).toBe("retained reasoning");
      expect(details.content).toBe("");
    },
  );

  test("a standalone empty assistant keeps its slot so strict role alternation survives", () => {
    // Templates such as Mistral's accept an empty assistant string but reject consecutive users.
    const first = { type: "message", role: "user", content: "first" };
    const { parsed, body } = build([first, assistant([{ type: "output_text", text: "" }]), user], "chat");
    expect(parsed.context.messages[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "" }] });
    expect(body.messages).toEqual([
      { role: "user", content: "first" }, { role: "assistant", content: "" }, { role: "user", content: "continue" },
    ]);
  });

  test("an empty assistant does not flush pending calls or duplicate matching results", () => {
    const { body } = build([
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
      assistant([{ type: "output_text", text: "" }]),
      { type: "function_call_output", call_id: "call_1", output: "result" },
      assistant("valid answer"), assistant(" \n"), user,
    ], "chat");
    expect(body.messages.map((item: any) => item.role)).toEqual(["assistant", "tool", "assistant", "assistant", "user"]);
    expect(body.messages[0].tool_calls[0].id).toBe("call_1");
    expect(body.messages[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "result" });
    expect(body.messages[2].content).toBe("valid answer");
    expect(body.messages[3].content).toBe(" \n");
  });
});
