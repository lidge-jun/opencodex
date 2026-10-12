/**
 * Issue #875 (local half): DeepSeek's Responses API accepts plaintext reasoning
 * replay (its compatibility guide merges reasoning items into the adjacent
 * assistant message), but the passthrough serializer blanked reasoning `content`
 * for EVERY provider — a rule only the ChatGPT native backend needs. Providers
 * flagged `preserveResponsesReasoningContent` now keep valid replay content while
 * still stripping proxy-minted `ocxr1` envelopes no upstream can decrypt.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction, sanitizeReasoningInputContent } from "../../src/adapters/openai-responses";
import {
  notePlaintextReasoningDropped,
  plaintextReasoningDroppedNotice,
  resetPlaintextReasoningNoticesForTests,
} from "../../src/adapters/openai-responses/plaintext-reasoning-notice";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { OCX_REASONING_PREFIX } from "../../src/responses/reasoning-envelope";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

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
      // `reasoningItem` omits `summary`, and the sanitizer now supplies the empty array the
      // Responses API requires on every reasoning input item.
      summary: [],
      encrypted_content: "native-blob",
    });
  });

  // Regression: a reasoning item translated from `/v1/chat/completions` or `/v1/messages` carried
  // no `summary`, which responsesRequestSchema allows and the upstream does not — the request was
  // refused with `Missing required parameter: 'input[N].summary'` before inference.
  test("a summary-less reasoning item gains the required empty summary", () => {
    const out = inputOf(sanitizeReasoningInputContent({ model: "m", input: [reasoningItem()] }));
    expect(out[0]!.summary).toEqual([]);
  });

  test("an existing summary is left exactly as it arrived", () => {
    const summary = [{ type: "summary_text", text: "chain" }];
    const out = inputOf(sanitizeReasoningInputContent({ model: "m", input: [reasoningItem({ summary })] }));
    expect(out[0]!.summary).toEqual(summary);
  });

  test("a summary-less item is repaired even where content is preserved", () => {
    const out = inputOf(sanitizeReasoningInputContent(
      { model: "m", input: [reasoningItem()] },
      { preserveRawReasoningContent: true },
    ));
    expect(out[0]!.summary).toEqual([]);
    expect(out[0]!.content).toEqual([{ type: "reasoning_text", text: "think step by step" }]);
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

describe("sanitizeReasoningInputContent plaintext-required replay (#5421)", () => {
  // DeepSeek's thinking mode rejects a reasoning input item that carries no
  // `reasoning_text` content ("The reasoning_text in the thinking mode must be
  // passed back to the API"). Native-minted history reaches a resumed routed
  // subagent as `content: []` plus a ciphertext blob the provider cannot read,
  // so the stripped item must be backfilled before it reaches the wire.
  test("an emptied item replays its summary text as reasoning_text", () => {
    const item = {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "planned the call" }],
      content: [],
      encrypted_content: "native-blob",
    };
    const out = inputOf(sanitizeReasoningInputContent(
      { model: "m", input: [item] },
      { preserveRawReasoningContent: true, stripEncryptedContent: true, requirePlaintextReasoning: true },
    ));
    expect("encrypted_content" in out[0]!).toBe(false);
    expect(out[0]!.content).toEqual([{ type: "reasoning_text", text: "planned the call" }]);
    expect(out[0]!.summary).toEqual([{ type: "summary_text", text: "planned the call" }]);
  });

  test("an emptied item with no usable summary gets a minimal placeholder", () => {
    const item = {
      type: "reasoning",
      summary: [],
      content: [],
      encrypted_content: "native-blob",
    };
    const out = inputOf(sanitizeReasoningInputContent(
      { model: "m", input: [item] },
      { preserveRawReasoningContent: true, stripEncryptedContent: true, requirePlaintextReasoning: true },
    ));
    expect(out[0]!.content).toEqual([{ type: "reasoning_text", text: " " }]);
  });

  test("an untouched empty item is backfilled too", () => {
    // No encrypted_content, no status, a present summary — the sanitizer returns
    // this item unchanged today, which already satisfies DeepSeek's 400 shape.
    const item = { type: "reasoning", summary: [], content: [] };
    const out = inputOf(sanitizeReasoningInputContent(
      { model: "m", input: [item] },
      { requirePlaintextReasoning: true },
    ));
    expect(out[0]!.content).toEqual([{ type: "reasoning_text", text: " " }]);
  });

  test("an item that already carries reasoning_text is left alone", () => {
    const item = reasoningItem({
      content: [{ type: "reasoning_text", text: "real chain" }],
      encrypted_content: "native-blob",
    });
    const out = inputOf(sanitizeReasoningInputContent(
      { model: "m", input: [item] },
      { preserveRawReasoningContent: true, stripEncryptedContent: true, requirePlaintextReasoning: true },
    ));
    expect(out[0]!.content).toEqual([{ type: "reasoning_text", text: "real chain" }]);
  });

  test("the flag is off by default: emptied content stays empty for other providers", () => {
    const item = { type: "reasoning", summary: [], content: [] };
    const out = inputOf(sanitizeReasoningInputContent({ model: "m", input: [item] }));
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

  test("a resumed subagent's emptied reasoning item reaches DeepSeek with reasoning_text (#5421)", () => {
    // The reported failing shape: a resumed routed subagent replays native-minted
    // reasoning items whose text lived only in `encrypted_content` — emptied to
    // `content: []` on sanitize, which DeepSeek's thinking mode rejects with
    // `The reasoning_text in the thinking mode must be passed back to the API`.
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
          {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "decided to check the weather" }],
            content: [],
            encrypted_content: "native-chatgpt-ciphertext",
          },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Seoul\"}" },
          { type: "function_call_output", call_id: "call_1", output: "rain" },
        ],
      },
    } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
    const body = JSON.parse(String(built.body)) as { input: Record<string, unknown>[] };
    expect(body.input[0]).not.toHaveProperty("encrypted_content");
    expect(body.input[0]!.content).toEqual([{ type: "reasoning_text", text: "decided to check the weather" }]);
    expect(body.input[1]).toMatchObject({ type: "function_call", call_id: "call_1" });
    expect(body.input[2]).toMatchObject({ type: "function_call_output", call_id: "call_1" });
  });

  test("a route switch never forwards foreign opaque reasoning and keeps a minimal reasoning_text", () => {
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
    enrichProviderFromRegistry("deepseek", provider);
    const built = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "deepseek-v4-flash",
      context: { messages: [] },
      stream: true,
      options: {},
      _stripReasoningEncryptedContent: true,
      _rawBody: {
        model: "deepseek-v4-flash",
        tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
        input: [reasoningItem({ content: [], encrypted_content: "foreign-provider-blob" })],
      },
    } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
    const body = JSON.parse(String(built.body)) as { input: Record<string, unknown>[] };
    expect(body.input[0]).not.toHaveProperty("encrypted_content");
    expect(body.input[0]!.content).toEqual([{ type: "reasoning_text", text: " " }]);
    expect(JSON.stringify(body.input[0])).not.toContain("foreign-provider-blob");
  });

  test("a canonical OpenAI provider still blanks reasoning content", () => {
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("openai-apikey")!), apiKey: "sk-test" };
    const body = buildBody(provider);
    const item = (body.input as Record<string, unknown>[])[0]!;
    expect(item.content).toEqual([]);
  });
});

// #6675: the default blanking stays, but a custom Responses provider is told once how to opt out.
describe("dropped plaintext reasoning notice", () => {
  afterEach(() => resetPlaintextReasoningNoticesForTests());
  const customVllm = (): OcxProviderConfig => ({ adapter: "openai-responses", baseUrl: "http://gpu-box.local:8000/v1", apiKey: "k" } as OcxProviderConfig);
  const buildBody = (provider: OcxProviderConfig): Record<string, unknown> => {
    const built = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "kimi-k3",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "kimi-k3", input: [reasoningItem()] },
    } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
    return JSON.parse(String(built.body)) as Record<string, unknown>;
  };

  test("the sanitizer reports blanking of nonempty plaintext only", () => {
    let calls = 0;
    const onPlaintextReasoningBlanked = () => { calls += 1; };
    sanitizeReasoningInputContent({ model: "m", input: [reasoningItem(), reasoningItem({ id: "rs_2" })] }, { onPlaintextReasoningBlanked });
    expect(calls).toBe(1);
    sanitizeReasoningInputContent({ model: "m", input: [reasoningItem()] }, { preserveRawReasoningContent: true, onPlaintextReasoningBlanked });
    sanitizeReasoningInputContent({ model: "m", input: [reasoningItem({ content: [] })] }, { onPlaintextReasoningBlanked });
    sanitizeReasoningInputContent({ model: "m", input: [reasoningItem({ content: [{ type: "reasoning_text", text: "" }] })] }, { onPlaintextReasoningBlanked });
    expect(calls).toBe(1);
  });

  test("a custom destination is warned once, with no request content", () => {
    const messages: string[] = [];
    notePlaintextReasoningDropped(customVllm(), message => messages.push(message));
    notePlaintextReasoningDropped(customVllm(), message => messages.push(message));
    expect(messages).toEqual([plaintextReasoningDroppedNotice("gpu-box.local:8000")]);
    expect(messages[0]).toContain("preserveResponsesReasoningContent");
    expect(messages[0]).not.toContain("think step by step");
  });

  test("registry presets and OpenAI-operated destinations stay silent", () => {
    const messages: string[] = [];
    const warn = (message: string) => messages.push(message);
    notePlaintextReasoningDropped({ ...providerConfigSeed(getProviderRegistryEntry("openai-apikey")!), apiKey: "sk-test" }, warn);
    notePlaintextReasoningDropped({ ...providerConfigSeed(getProviderRegistryEntry("opengateway")!), adapter: "openai-responses", apiKey: "k" }, warn);
    notePlaintextReasoningDropped({ adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" } as OcxProviderConfig, warn);
    notePlaintextReasoningDropped({ ...customVllm(), authMode: "oauth" } as OcxProviderConfig, warn);
    notePlaintextReasoningDropped({ ...customVllm(), adapter: "openai-chat" } as OcxProviderConfig, warn);
    // Hand-configured openai-responses rows pointing at Azure's per-resource hosts.
    for (const baseUrl of [
      "https://contoso.openai.azure.com/openai/v1",
      "https://contoso.services.ai.azure.com/openai/v1",
      "https://contoso.cognitiveservices.azure.com/openai/v1",
    ]) notePlaintextReasoningDropped({ ...customVllm(), baseUrl } as OcxProviderConfig, warn);
    expect(messages).toEqual([]);
  });

  test("a lookalike host outside Azure is still treated as custom", () => {
    const messages: string[] = [];
    notePlaintextReasoningDropped({ ...customVllm(), baseUrl: "https://openai.azure.com.example.net/v1" } as OcxProviderConfig, message => messages.push(message));
    expect(messages).toHaveLength(1);
  });

  test("the passthrough serializer still blanks a custom provider's reasoning and emits the notice", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = buildBody(customVllm());
      expect((body.input as Record<string, unknown>[])[0]!.content).toEqual([]);
      expect(warnSpy.mock.calls.map(call => String(call[0]))).toEqual([plaintextReasoningDroppedNotice("gpu-box.local:8000")]);
      const preserved = buildBody({ ...customVllm(), baseUrl: "http://other-box.local/v1", preserveResponsesReasoningContent: true });
      expect((preserved.input as Record<string, unknown>[])[0]!.content).toEqual([{ type: "reasoning_text", text: "think step by step" }]);
      expect(warnSpy.mock.calls).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
