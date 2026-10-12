import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { parseRequest } from "../../src/responses/parser";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const call = { type: "custom_tool_call", call_id: "call_history", name: "exec", input: "text(1)" };
const output = { type: "custom_tool_call_output", call_id: "call_history", output: "observed" };
const reasoning = { type: "reasoning", summary: [{ type: "summary_text", text: "old reasoning" }] };

function wire(input: unknown[], options: {
  support?: boolean;
  previous?: boolean;
  paired?: boolean;
  store?: boolean;
  extra?: Record<string, unknown>;
} = {}) {
  const provider: OcxProviderConfig = {
    adapter: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    authMode: "key",
    apiKey: "fixture-key",
    supportsResponsesCustomTools: options.support,
    requiresPairedResponsesToolResults: options.paired ?? true,
  };
  const body = {
    model: "grok-4.6", input, tools: [],
    ...(options.previous ? { previous_response_id: "resp_stored" } : {}),
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...options.extra,
  };
  const before = JSON.stringify(body);
  const built = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider))
    .buildRequest(parseRequest(body));
  expect(JSON.stringify(body)).toBe(before);
  return { body: JSON.parse(built.body), built };
}

describe("combined Responses continuation boundaries", () => {
  test("stateful function output preserves the upstream pair while replay-miss reasoning is removed", () => {
    const functionOutput = { type: "function_call_output", call_id: "call_stored", output: "done" };
    const { body } = wire([reasoning, functionOutput], { previous: true, support: false, store: true });
    expect(body.previous_response_id).toBe("resp_stored");
    expect(body.store).toBe(true);
    expect(body.input).toEqual([functionOutput]);
  });

  test.each([undefined, true] as const)("stateful custom output remains native when support is %p", support => {
    const { body } = wire([reasoning, output], { previous: true, support, store: true });
    expect(body.previous_response_id).toBe("resp_stored");
    expect(body.input).toEqual([output]);
  });

  test("a previous response ID never permits an unmapped custom output on an explicitly denying destination", () => {
    expect(() => wire([reasoning, output], { previous: true, support: false }))
      .toThrow("custom_tool_compat: final_guard: custom_tool_call_output");
  });

  test.each([undefined, true, false] as const)("historical pairs obey capability before xAI item-ID repair: %p", support => {
    const nested = { type: "custom_tool_call", name: "exec", input: "nested data" };
    const { body, built } = wire([call, { ...output, output: nested }], { support, store: false });
    expect(body.tools).toEqual([]);
    expect([...(built.convertedRoutedCustomToolNames ?? [])]).toEqual([]);
    expect(body.input[0].call_id).toBe(call.call_id);
    expect(body.input[1].call_id).toBe(call.call_id);
    expect(body.input[1].output).toEqual(nested);
    if (support === false) {
      expect(body.input[0].type).toBe("function_call");
      expect(body.input[0].arguments).toBe(JSON.stringify({ input: call.input }));
      expect(body.input[0]).not.toHaveProperty("id");
      expect(body.input[1].type).toBe("function_call_output");
    } else {
      expect(body.input[0].type).toBe("custom_tool_call");
      expect(body.input[0].id).toMatch(/^ctc_[0-9a-f]{40}$/);
      expect(body.input[1].type).toBe("custom_tool_call_output");
      expect(wire([call, output], { support, store: false }).body.input[0].id).toBe(body.input[0].id);
    }
  });

  test("pairing synthesizes exactly one missing result before historical lowering", () => {
    const { body, built } = wire([call], { support: false, previous: true });
    expect(body.input).toHaveLength(2);
    expect(body.input.map((item: { type: string }) => item.type)).toEqual(["function_call", "function_call_output"]);
    expect(body.input[0]).not.toHaveProperty("id");
    expect(body.input[1].call_id).toBe(call.call_id);
    expect(body.input[1].output).toContain("no tool result was recorded");
    expect([...(built.convertedRoutedCustomToolNames ?? [])]).toEqual([]);
  });

  test("a native function cannot claim a custom output in a stateful continuation", () => {
    expect(() => wire([
      { type: "function_call", call_id: call.call_id, name: call.name, arguments: "{}" }, output,
    ], { previous: true, support: false, paired: false }))
      .toThrow("custom_tool_compat: final_guard: custom_tool_call_output");
  });

  test("empty-catalog normalization retains deny-all alongside historical lowering", () => {
    const { body, built } = wire([call, output], {
      support: false,
      extra: { tools: undefined, tool_choice: "none" },
    });
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.tools).toEqual([]);
    expect(body.input[0].type).toBe("function_call");
    expect([...(built.convertedRoutedCustomToolNames ?? [])]).toEqual([]);
  });
});
