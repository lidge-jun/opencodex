import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (
  ...args: Parameters<typeof createResponsesPassthroughAdapterProduction>
) => withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const meta = { headers: new Headers({ authorization: "Bearer token" }) };
const rawBody = {
  model: "gpt-5.6-sol",
  input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
  stream: true,
  store: false,
  max_output_tokens: 32000,
  metadata: { user_id: "u-1" },
  reasoning: { effort: "low" },
};

describe("OpenAI Responses forward output cap", () => {
  test("noncanonical forward mode keeps the caller's max_output_tokens cap", () => {
    const adapter = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://gateway.internal.example/v1",
      authMode: "forward" as const,
    });
    const request = adapter.buildRequest({
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { ...rawBody },
    }, meta);
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body.max_output_tokens).toBe(32000);
    expect(body).not.toHaveProperty("metadata");
  });
});
