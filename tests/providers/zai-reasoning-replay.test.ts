import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

describe("Z.AI Responses reasoning replay", () => {
  test("preserves plaintext reasoning and never inherits the Volcengine drop capability", async () => {
    const provider = {
      ...providerConfigSeed(getProviderRegistryEntry("zai")!),
      apiKey: "test-key",
    };
    enrichProviderFromRegistry("zai", provider);
    expect(provider.preserveResponsesReasoningContent).toBe(true);
    expect(provider.dropResponsesReasoningItems).toBeUndefined();

    const request = await createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "glm-5.3",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {
        model: "glm-5.3",
        input: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            content: [{ type: "reasoning_text", text: "keep this plaintext reasoning" }],
          },
          { type: "function_call", call_id: "call_1", name: "echo", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "ok" },
        ],
      },
    }, { headers: new Headers() });

    const body = JSON.parse(request.body) as { input: Array<Record<string, unknown>> };
    expect(body.input).toHaveLength(3);
    expect(body.input[0]).toMatchObject({
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "keep this plaintext reasoning" }],
    });
  });
});
