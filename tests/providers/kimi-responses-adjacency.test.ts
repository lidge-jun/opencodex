import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { normalizeResponsesToolResultAdjacency } from "../../src/adapters/openai-responses/tool-output-recovery";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { routedProviderConfig } from "../../src/router";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const MODEL = "kimi-k2.7-code";

const createResponsesPassthroughAdapter = (
  ...args: Parameters<typeof createResponsesPassthroughAdapterProduction>
) => withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

function buildBody(provider: OcxProviderConfig, input: unknown[]): { input: unknown[] } {
  const built = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: MODEL,
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: MODEL, input },
  } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], {
    headers: new Headers(),
  });
  return JSON.parse(String(built.body)) as { input: unknown[] };
}

describe("Kimi Responses tool-result adjacency", () => {
  test("both Kimi registry entries seed the adjacency capability", () => {
    for (const providerId of ["kimi", "kimi-code"]) {
      const entry = getProviderRegistryEntry(providerId)!;
      expect(entry.requiresAdjacentResponsesToolResults).toBe(true);
      expect(providerConfigSeed(entry).requiresAdjacentResponsesToolResults).toBe(true);
    }
  });

  test("a stale persisted Kimi row is backfilled and activates adjacency repair on replay", () => {
    const stale: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.kimi.com/coding/v1",
      authMode: "oauth",
      statelessResponses: true,
    };
    const routedStale = routedProviderConfig("kimi", { ...stale });
    const call = { type: "custom_tool_call", call_id: "exec_replay", name: "exec", input: "text('hi')" };
    const injected = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "[hook] replay diagnostics" }],
    };
    const output = { type: "custom_tool_call_output", call_id: "exec_replay", output: "hi" };
    const nextTurn = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "continue" }],
    };

    expect(stale.requiresAdjacentResponsesToolResults).toBeUndefined();
    expect(routedStale.requiresAdjacentResponsesToolResults).toBe(true);
    enrichProviderFromRegistry("kimi", stale);
    expect(stale.requiresAdjacentResponsesToolResults).toBe(true);
    expect(buildBody(stale, [call, injected, output, nextTurn]).input).toEqual([
      call,
      output,
      injected,
      nextTurn,
    ]);
  });

  test("moves a result next to its call while preserving an intervening developer message", () => {
    const call = { type: "custom_tool_call", call_id: "exec_single", name: "exec", input: "text('ok')" };
    const injected = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "[hook] LSP diagnostics: none" }],
    };
    const output = { type: "custom_tool_call_output", call_id: "exec_single", output: "ok" };
    const body = { input: [call, injected, output] };

    expect(normalizeResponsesToolResultAdjacency(body)).toEqual({ input: [call, output, injected] });
  });

  test("keeps call_id pairing and all interleaved history with two outstanding replayed calls", () => {
    const priorUser = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "inspect both files" }],
    };
    const callA = { type: "function_call", call_id: "call_a", name: "read_file", arguments: "{\"path\":\"a\"}" };
    const firstInjected = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "[hook] first diagnostic" }],
    };
    const callB = { type: "custom_tool_call", call_id: "call_b", name: "exec", input: "text('b')" };
    const secondInjected = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "[hook] second diagnostic" }],
    };
    const outputA = { type: "function_call_output", call_id: "call_a", output: "A" };
    const outputB = { type: "custom_tool_call_output", call_id: "call_b", output: "B" };
    const nextTurn = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "continue" }],
    };

    const normalized = normalizeResponsesToolResultAdjacency({
      input: [priorUser, callA, firstInjected, callB, secondInjected, outputA, outputB, nextTurn],
    });

    expect(normalized).toEqual({
      input: [priorUser, callA, callB, outputA, outputB, firstInjected, secondInjected, nextTurn],
    });
  });

  test("leaves an already-adjacent call and result input untouched", () => {
    const call = { type: "custom_tool_call", call_id: "exec_adjacent", name: "exec", input: "text('ok')" };
    const output = { type: "custom_tool_call_output", call_id: "exec_adjacent", output: "ok" };
    const tail = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "retained context" }],
    };
    const body = { input: [call, output, tail] };

    expect(normalizeResponsesToolResultAdjacency(body)).toBe(body);
  });
});
