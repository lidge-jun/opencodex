import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../../src/adapters/openai-responses";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../../src/providers/derive";
import { getProviderRegistryEntry } from "../../../src/providers/registry";
import { routedProviderConfig } from "../../../src/router";
import type { OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const MODEL = "grok-4.6";

const createResponsesPassthroughAdapter = (
  ...args: Parameters<typeof createResponsesPassthroughAdapterProduction>
) => withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

function xaiOauthResponses(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    authMode: "oauth",
    ...overrides,
  };
}

function buildBody(provider: OcxProviderConfig, rawBody: Record<string, unknown>): Record<string, unknown> {
  const requestBody = typeof rawBody.model === "string" ? rawBody : { model: MODEL, ...rawBody };
  const before = structuredClone(requestBody);
  const built = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: typeof requestBody.model === "string" ? requestBody.model : MODEL,
    context: { messages: [] },
    stream: true,
    options: {},
    previousResponseId: typeof rawBody.previous_response_id === "string"
      ? rawBody.previous_response_id
      : undefined,
    _rawBody: requestBody,
  } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], {
    headers: new Headers(),
  });
  if (built instanceof Promise) throw new Error("Expected a synchronous Responses request builder");
  expect(requestBody).toEqual(before);
  return JSON.parse(String(built.body)) as Record<string, unknown>;
}

describe("xAI Responses include compatibility", () => {
  for (const baseUrl of ["https://api.x.ai/v1", "https://us.api.x.ai/v1", "https://cli-chat-proxy.grok.com/v1"]) {
    test(`preserves Grok 4.7 encrypted tool continuation at ${baseUrl}`, () => {
      const raw = {
        model: "grok-4.7",
        store: false,
        reasoning: { effort: "xhigh" },
        include: ["output.encrypted_content", "reasoning.encrypted_content", "web_search_call.action.sources", "output.encrypted_content"],
        tools: [{ type: "function", name: "read_fixture", parameters: { type: "object", properties: {} } }],
        input: [
          { type: "reasoning", encrypted_content: "synthetic-native-ciphertext", summary: [] },
          { type: "function_call", call_id: "call_fixture", name: "read_fixture", arguments: "{}" },
          { type: "function_call_output", call_id: "call_fixture", output: "nonce=synthetic-fixture" },
        ],
      };
      const before = structuredClone(raw);
      const body = buildBody(xaiOauthResponses({ baseUrl }), raw);

      expect(body.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"]);
      expect(body.model).toBe("grok-4.7");
      expect(body.reasoning).toEqual(raw.reasoning);
      expect(body.store).toBe(false);
      expect(body.tools).toEqual(raw.tools);
      expect(body.input).toEqual(raw.input);
      expect(raw).toEqual(before);
    });
  }

  test("does not invent include values for absent, empty or non-array input", () => {
    const provider = xaiOauthResponses();
    expect(buildBody(provider, { input: [] })).not.toHaveProperty("include");
    expect(buildBody(provider, { input: [], include: [] }).include).toEqual([]);
    expect(buildBody(provider, { input: [], include: "reasoning.encrypted_content" }).include)
      .toBe("reasoning.encrypted_content");
  });

  for (const baseUrl of ["https://chatgpt.com/backend-api/codex", "https://gateway.example/v1", "https://api.x.ai.evil.example/v1", "https://api.x.ai:444/v1"]) {
    test(`preserves include entries and caller input outside xAI at ${baseUrl}`, () => {
      const raw = { include: ["output.encrypted_content", "reasoning.encrypted_content"], input: [] };
      const before = structuredClone(raw);
      const body = buildBody(xaiOauthResponses({ baseUrl, authMode: "key" }), raw);

      expect(body.include).toEqual(raw.include);
      expect(raw).toEqual(before);
    });
  }

  test("drops the include entry xAI rejects instead of ignoring", () => {
    const body = buildBody(xaiOauthResponses(), {
      include: ["output.encrypted_content", "reasoning.encrypted_content"],
      input: [],
    });

    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("drops an include that only carried the unsupported entry", () => {
    const body = buildBody(xaiOauthResponses(), {
      include: ["output.encrypted_content"],
      input: [],
    });

    expect(body).not.toHaveProperty("include");
  });

  test("strips the rejected include entry for the US regional endpoint", () => {
    const provider = xaiOauthResponses({ baseUrl: "https://us.api.x.ai/v1", authMode: "key" });
    const body = buildBody(provider, {
      include: ["output.encrypted_content", "reasoning.encrypted_content"], input: [],
    });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(buildBody(provider, { include: ["output.encrypted_content"], input: [] }))
      .not.toHaveProperty("include");
  });

  test("leaves another Responses destination's include untouched", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authMode: "key",
    };
    const body = buildBody(provider, { include: ["output.encrypted_content"], input: [] });

    expect(body.include).toEqual(["output.encrypted_content"]);
  });
});

describe("xAI Responses tool-result adjacency", () => {
  test("the xAI registry entry seeds adjacency and pairing without marking the provider stateless", () => {
    const entry = getProviderRegistryEntry("xai")!;
    expect(entry.requiresAdjacentResponsesToolResults).toBe(true);
    expect(entry.requiresPairedResponsesToolResults).toBe(true);
    expect(entry.statelessResponses).toBeUndefined();
    const seed = providerConfigSeed(entry);
    expect(seed.requiresAdjacentResponsesToolResults).toBe(true);
    expect(seed.requiresPairedResponsesToolResults).toBe(true);
    expect(seed.statelessResponses).toBeUndefined();
  });

  test("a stale persisted xAI row is backfilled and repairs a dangling function_call on replay", () => {
    const stale: OcxProviderConfig = xaiOauthResponses();
    const routedStale = routedProviderConfig("xai", { ...stale });
    const call = { type: "function_call", call_id: "call_interrupted", name: "exec_command", arguments: "{}" };
    const nextTurn = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "continue" }],
    };

    expect(stale.requiresAdjacentResponsesToolResults).toBeUndefined();
    expect(routedStale.requiresAdjacentResponsesToolResults).toBe(true);
    expect(routedStale.requiresPairedResponsesToolResults).toBe(true);
    enrichProviderFromRegistry("xai", stale);
    expect(stale.requiresAdjacentResponsesToolResults).toBe(true);
    expect(stale.requiresPairedResponsesToolResults).toBe(true);
    expect(stale.statelessResponses).toBeUndefined();

    const body = buildBody(stale, {
      previous_response_id: "resp_xai_store",
      store: true,
      input: [call, nextTurn],
    });
    expect(body.previous_response_id).toBe("resp_xai_store");
    expect(body.store).toBe(true);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "function_call", call_id: "call_interrupted" });
    expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "call_interrupted" });
    expect(String(input[1].output)).toContain("no tool result was recorded");
    expect(input[2]).toMatchObject({ type: "message", role: "user" });
  });

  test("moves a result next to its call while preserving an intervening developer message", () => {
    const provider = xaiOauthResponses({ requiresAdjacentResponsesToolResults: true });
    const call = { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{}" };
    const injected = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "[hook] LSP diagnostics: none" }],
    };
    const output = { type: "function_call_output", call_id: "call_exec", output: "ok" };
    const body = buildBody(provider, { input: [call, injected, output] });
    expect(body.input).toEqual([call, output, injected]);
  });

  test("preserves output-only continuations whose call remains in xAI state", () => {
    const functionOutput = { type: "function_call_output", call_id: "call_stored", output: "result" };
    const customOutput = { type: "custom_tool_call_output", call_id: "custom_stored", output: "patch" };
    const body = buildBody(xaiOauthResponses({ requiresPairedResponsesToolResults: true }), {
      previous_response_id: "resp_xai_store",
      store: true,
      input: [functionOutput, customOutput],
    });

    expect(body.previous_response_id).toBe("resp_xai_store");
    expect(body.store).toBe(true);
    expect(body.input).toEqual([functionOutput, customOutput]);

    const standalone = buildBody(xaiOauthResponses({ requiresPairedResponsesToolResults: true }), {
      input: [functionOutput],
    });
    expect(standalone.input).toEqual([expect.objectContaining({ type: "message", role: "user" })]);
  });

  test("keeps call_id pairing for two outstanding replayed calls and synthesizes only the missing output", () => {
    const provider = xaiOauthResponses({
      requiresAdjacentResponsesToolResults: true,
      requiresPairedResponsesToolResults: true,
    });
    const callA = { type: "function_call", call_id: "call_a", name: "exec_command", arguments: "{}" };
    const callB = { type: "function_call", call_id: "call_b", name: "exec_command", arguments: "{}" };
    const injected = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "[hook] replay diagnostics" }],
    };
    const outputB = { type: "function_call_output", call_id: "call_b", output: "B" };
    const body = buildBody(provider, { input: [callA, callB, injected, outputB] });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "function_call", call_id: "call_a" });
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "call_b" });
    expect(input[2]).toMatchObject({ type: "function_call_output", call_id: "call_a" });
    expect(String(input[2].output)).toContain("no tool result was recorded");
    expect(input[3]).toMatchObject({ type: "function_call_output", call_id: "call_b", output: "B" });
    expect(input[4]).toMatchObject({ type: "message", role: "developer" });
  });

  test("forward-auth xAI replay still does not synthesize a dangling call", () => {
    const provider = xaiOauthResponses({
      authMode: "forward",
      requiresAdjacentResponsesToolResults: true,
      requiresPairedResponsesToolResults: true,
      headers: { authorization: "Bearer xai-oauth" },
    });
    const call = { type: "function_call", call_id: "call_fwd", name: "exec_command", arguments: "{}" };
    const body = buildBody(provider, { input: [call] });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: "function_call", call_id: "call_fwd" });
    expect(JSON.stringify(body)).not.toContain("no tool result was recorded");
  });

  test("adjacency alone never synthesizes an output the client did not send", () => {
    // Kimi and kimi-code carry the adjacency flag because their parser rejects a hook-split pair
    // (#4726), but that same report shows a call left without any result is accepted. Inventing a
    // placeholder there would put a tool turn into the conversation that never happened, so the
    // two capabilities stay separate rather than one widening into the other.
    for (const providerName of ["kimi", "kimi-code"]) {
      const entry = getProviderRegistryEntry(providerName)!;
      expect(entry.requiresAdjacentResponsesToolResults).toBe(true);
      expect(entry.requiresPairedResponsesToolResults).toBeUndefined();
      expect(entry.statelessResponses).toBeUndefined();
    }

    const provider = xaiOauthResponses({ requiresAdjacentResponsesToolResults: true });
    const call = { type: "function_call", call_id: "call_dangling", name: "exec_command", arguments: "{}" };
    const next = { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] };
    const body = buildBody(provider, { input: [call, next] });

    expect(body.input).toEqual([call, next]);
    expect(JSON.stringify(body)).not.toContain("no tool result was recorded");
  });

  test("a dangling custom_tool_call reaches xAI as a paired, lowered function call", () => {
    // The pairing repair runs before rewriteRoutedCustomToolsForUpstream, so a custom call
    // interrupted mid-stream is answered first and the pair is lowered together. xAI rejects the
    // native custom shape (supportsResponsesCustomTools: false on the registry entry), which is
    // what makes the lowering run at all, so the production shape is what this pins.
    const provider = xaiOauthResponses({
      requiresAdjacentResponsesToolResults: true,
      requiresPairedResponsesToolResults: true,
      supportsResponsesCustomTools: false,
    });
    const call = { type: "custom_tool_call", call_id: "call_custom", name: "apply_patch", input: "patch" };
    const next = { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] };
    const body = buildBody(provider, {
      tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch." }],
      input: [call, next],
    });
    const input = body.input as Array<Record<string, unknown>>;

    expect(input[0]).toMatchObject({ type: "function_call", call_id: "call_custom", name: "apply_patch" });
    expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "call_custom" });
    expect(String(input[1].output)).toContain("no tool result was recorded");
    expect(input[2]).toMatchObject({ type: "message", role: "user" });
  });
});
