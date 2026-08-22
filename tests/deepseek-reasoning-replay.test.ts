/**
 * Issue #875 (local half): DeepSeek's Responses API accepts plaintext reasoning
 * replay (its compatibility guide merges reasoning items into the adjacent
 * assistant message), but the passthrough serializer blanked reasoning `content`
 * for EVERY provider — a rule only the ChatGPT native backend needs. Providers
 * flagged `preserveResponsesReasoningContent` now keep valid replay content while
 * still stripping proxy-minted `ocxr1` envelopes no upstream can decrypt.
 */
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction, sanitizeReasoningInputContent } from "../src/adapters/openai-responses";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { OCX_REASONING_PREFIX } from "../src/responses/reasoning-envelope";
import type { OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const reasoningItem = (extra: Record<string, unknown> = {}) => ({
  type: "reasoning",
  id: "rs_1",
  content: [{ type: "reasoning_text", text: "think step by step" }],
  ...extra,
});

function inputOf(result: unknown): Record<string, unknown>[] {
  return (result as { input: Record<string, unknown>[] }).input;
}

describe("sanitizeReasoningInputContent scoping", () => {
  test("retains native encrypted content while stripping output-only status", () => {
    const out = inputOf(sanitizeReasoningInputContent({
      model: "m",
      input: [reasoningItem({ encrypted_content: "native-blob", status: "completed" })],
    }));
    expect(out[0]).toEqual({
      type: "reasoning",
      id: "rs_1",
      content: [],
      encrypted_content: "native-blob",
    });
  });

  test("default behavior still blanks reasoning content (ChatGPT backend rule)", () => {
    const out = inputOf(sanitizeReasoningInputContent({ model: "m", input: [reasoningItem()] }));
    expect(out[0]!.content).toEqual([]);
  });

  test("preservation keeps plaintext reasoning content", () => {
    const out = inputOf(sanitizeReasoningInputContent({ model: "m", input: [reasoningItem()] }, { preserveRawReasoningContent: true }));
    expect(out[0]!.content).toEqual([{ type: "reasoning_text", text: "think step by step" }]);
  });

  test("preservation still strips an ocxr1 envelope but keeps the plaintext content", () => {
    const item = reasoningItem({ encrypted_content: `${OCX_REASONING_PREFIX}Zm9v` });
    const out = inputOf(sanitizeReasoningInputContent({ model: "m", input: [item] }, { preserveRawReasoningContent: true }));
    expect("encrypted_content" in out[0]!).toBe(false);
    expect(out[0]!.content).toEqual([{ type: "reasoning_text", text: "think step by step" }]);
  });

  test("default behavior strips the envelope AND blanks content", () => {
    const item = reasoningItem({ encrypted_content: `${OCX_REASONING_PREFIX}Zm9v` });
    const out = inputOf(sanitizeReasoningInputContent({ model: "m", input: [item] }));
    expect("encrypted_content" in out[0]!).toBe(false);
    expect(out[0]!.content).toEqual([]);
  });
});

describe("DeepSeek Responses replay keeps reasoning on the wire", () => {
  function buildBody(provider: OcxProviderConfig): Record<string, unknown> {
    const built = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "deepseek-v4-flash",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "deepseek-v4-flash", input: [reasoningItem()] },
    } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
    return JSON.parse(String(built.body)) as Record<string, unknown>;
  }

  test("a DeepSeek continuation keeps reasoning_text", () => {
    // Mirror the runtime flow: saved configs carry no registry-only flags; the
    // enrich backfill supplies them before the adapter serializes.
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
    enrichProviderFromRegistry("deepseek", provider);
    const body = buildBody(provider);
    const item = (body.input as Record<string, unknown>[])[0]!;
    expect(item.content).toEqual([{ type: "reasoning_text", text: "think step by step" }]);
  });

  test("a real tool-call continuation (reasoning → call → output) keeps all three for DeepSeek", () => {
    // The documented DeepSeek failure shape: the turn AFTER a tool call must
    // carry reasoning_content, or the upstream answers HTTP 400.
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
    enrichProviderFromRegistry("deepseek", provider);
    const built = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "deepseek-v4-flash",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "deepseek-v4-flash",
        input: [
          reasoningItem(),
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Seoul\"}" },
          { type: "function_call_output", call_id: "call_1", output: "rain" },
        ],
      },
    } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
    const body = JSON.parse(String(built.body)) as { input: Record<string, unknown>[] };
    expect(body.input).toHaveLength(3);
    expect(body.input[0]!.content).toEqual([{ type: "reasoning_text", text: "think step by step" }]);
    expect(body.input[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "get_weather" });
    expect(body.input[2]).toMatchObject({ type: "function_call_output", call_id: "call_1", output: "rain" });
  });

  test("a canonical OpenAI provider still blanks reasoning content", () => {
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("openai-apikey")!), apiKey: "sk-test" };
    const body = buildBody(provider);
    const item = (body.input as Record<string, unknown>[])[0]!;
    expect(item.content).toEqual([]);
  });
});
