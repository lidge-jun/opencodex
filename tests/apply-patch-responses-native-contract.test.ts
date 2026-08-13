import { expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const execDescription =
  "Run JavaScript. declare const tools: { apply_patch(input: string): Promise<unknown>; };";

test("routed Responses conversion preserves the nested Code Mode apply_patch declaration", () => {
  const rawBody = {
    model: "deepseek-v4-flash",
    input: "Patch a file.",
    tools: [{
      type: "custom",
      name: "exec",
      description: execDescription,
      format: { type: "grammar", syntax: "lark" },
    }],
  };
  const parsed = {
    modelId: rawBody.model,
    stream: true,
    options: {},
    context: { messages: [] },
    _rawBody: rawBody,
  } as OcxParsedRequest;
  const adapter = createResponsesPassthroughAdapter({
    adapter: "openai-responses",
    baseUrl: "https://api.deepseek.com",
    responsesPath: "/responses",
    authMode: "key",
    apiKey: "test-key",
  } as OcxProviderConfig);

  const request = adapter.buildRequest(parsed, { headers: new Headers() });
  const body = JSON.parse(request.body) as {
    tools: Array<Record<string, unknown>>;
  };

  expect(body.tools).toHaveLength(1);
  expect(body.tools[0]).toMatchObject({
    type: "function",
    name: "exec",
    description: execDescription,
  });
  expect(JSON.stringify(body.tools[0])).toContain("apply_patch");
});
