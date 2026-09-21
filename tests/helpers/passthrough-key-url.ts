import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { withTestTranslatorBudget } from "./translator-budget";

/**
 * The upstream URL a key-auth Responses passthrough adapter would actually request.
 *
 * Moved out of tests/responses/openai-responses-passthrough.test.ts verbatim, including the
 * test translator budget its local adapter wrapper applied: that file is at its file-size cap,
 * and the repository answer to a cap is a sibling helper rather than compressed control flow.
 */
export function buildKeyAuthUrl(baseUrl: string, responsesPath?: string): string {
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
    adapter: "openai-responses",
    baseUrl,
    authMode: "key" as const,
    apiKey: "sk-test",
    ...(responsesPath === undefined ? {} : { responsesPath }),
  }));
  return adapter.buildRequest({
    modelId: "test-model",
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: "test-model", input: "ping" },
  }, { headers: new Headers() }).url;
}
