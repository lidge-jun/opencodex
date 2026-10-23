import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction, sanitizeReasoningInputContent } from "../../src/adapters/openai-responses";
import { backfillBareToolCallTurnReasoning } from "../../src/adapters/openai-responses/reasoning";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

type Item = Record<string, unknown>;
const PLACEHOLDER = { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: " " }] };
const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const call = (id: string): Item => ({ type: "function_call", call_id: id, name: "get_weather", arguments: "{}" });
const output = (id: string): Item => ({ type: "function_call_output", call_id: id, output: "rain" });

describe("backfillBareToolCallTurnReasoning (#7298)", () => {
  test("a bare tool-call turn gets one placeholder reasoning item at its head", () => {
    const input = [user("weather?"), call("c1"), output("c1")];
    expect(backfillBareToolCallTurnReasoning(input)).toEqual([user("weather?"), PLACEHOLDER, call("c1"), output("c1")]);
  });

  test("every bare turn of a multi-step loop is backfilled; parallel calls share one item", () => {
    const text: Item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "checking" }] };
    const input = [user("go"), text, call("a"), call("b"), output("a"), output("b"), call("c"), output("c")];
    expect(backfillBareToolCallTurnReasoning(input)).toEqual([
      user("go"), PLACEHOLDER, text, call("a"), call("b"), output("a"), output("b"), PLACEHOLDER, call("c"), output("c"),
    ]);
  });

  test("a turn that already carries reasoning, and a turn with no tool call, are untouched", () => {
    const reasoning: Item = { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "plan" }] };
    const answer: Item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] };
    const input = [user("go"), reasoning, call("a"), output("a"), answer, user("thanks")];
    expect(backfillBareToolCallTurnReasoning(input)).toBe(input);
  });

  test("custom tool calls count as tool calls", () => {
    const custom: Item = { type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: "*** Begin" };
    const customOutput: Item = { type: "custom_tool_call_output", call_id: "p1", output: "ok" };
    expect(backfillBareToolCallTurnReasoning([custom, customOutput])).toEqual([PLACEHOLDER, custom, customOutput]);
  });

  test("the sanitizer applies it only for plaintext-required destinations", () => {
    const body = { model: "m", input: [user("go"), call("a"), output("a")] };
    expect(sanitizeReasoningInputContent(body, { preserveRawReasoningContent: true })).toBe(body);
    const strict = sanitizeReasoningInputContent(body, { requirePlaintextReasoning: true }) as { input: Item[] };
    expect(strict.input[1]).toEqual(PLACEHOLDER);
    expect(body.input).toHaveLength(3);
  });
});

describe("DeepSeek Responses wire receives a replayable reasoning item for a foreign tool call (#7298)", () => {
  function build(input: Item[], providerName: string): Item[] {
    const provider = { ...providerConfigSeed(getProviderRegistryEntry(providerName)!), apiKey: "sk-test" };
    enrichProviderFromRegistry(providerName, provider);
    const built = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "deepseek-v4-flash",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "deepseek-v4-flash", input, tools: [{ type: "function", name: "get_weather", parameters: { type: "object", properties: {} } }] },
    } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
    return (JSON.parse(String(built.body)) as { input: Item[] }).input;
  }

  test("a GPT-issued bare call reaches DeepSeek preceded by reasoning_text", () => {
    const wire = build([user("weather?"), call("c1"), output("c1")], "deepseek");
    expect(wire.map(item => item.type)).toEqual(["message", "reasoning", "function_call", "function_call_output"]);
    expect(wire[1]!.content).toEqual([{ type: "reasoning_text", text: " " }]);
  });
});

