import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

/**
 * #5132. The pre-fix additional_tools restoration collected every stripped container index
 * in a Set and spread it into Math.min. A request carrying enough additional_tools containers
 * exceeds the argument-count limit and throws RangeError, so an attacker-sized request becomes
 * a denial of service. Indices arrive in order, so the tracked first index is the minimum.
 *
 * This case lives in its own file rather than in
 * tests/responses/openai-responses-passthrough.test.ts: that file is exactly at its
 * file-size ratchet cap (4,809 lines in tests/fixtures/file-size-baseline.json), and the
 * cap only ever moves downward, so appending there would fail the ratchet for every later
 * pull request.
 */

const createResponsesPassthroughAdapter = (
  ...args: Parameters<typeof createResponsesPassthroughAdapterProduction>
) => withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

describe("OpenAI Responses hosted-tool name conflicts", () => {
  const keyedProvider = {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.example/v1",
    authMode: "key" as const,
    apiKey: "sk-test",
  };
  const meta = { headers: new Headers({ authorization: "Bearer token" }) };

  test("additional_tools restoration does not spread stripped indices into Math.min", () => {
    // The pre-fix code collected every stripped container index in a Set and spread it
    // into Math.min. A request carrying enough additional_tools containers exceeds the
    // argument-count limit and throws RangeError — an attacker-sized request becomes a
    // denial of service. Indices arrive in order, so the tracked first index is the min.
    const adapter = createResponsesPassthroughAdapter({
      ...keyedProvider,
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    });
    const input = Array.from({ length: 3 }, () => ({
      type: "additional_tools",
      tools: [{ type: "namespace", name: "image_gen", tools: [] }],
    }));
    const originalMin = Math.min;
    Math.min = (...values: number[]) => {
      if (values.length > 2) throw new RangeError("too many arguments");
      return originalMin(...values);
    };

    try {
      expect(() => adapter.buildRequest({
        modelId: "provider-image-model",
        context: { messages: [] },
        stream: true,
        options: {},
        _rawBody: { model: "provider-image-model", input },
      }, meta)).not.toThrow();
    } finally {
      Math.min = originalMin;
    }
  });
});
