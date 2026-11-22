import { afterEach, describe, expect, test } from "bun:test";
import { createAzureAdapter } from "../../src/adapters/azure";
import { openAIChatTransport } from "../../src/adapters/openai-chat/wire";
import { buildAnthropicMessagesPassthroughRequest } from "../../src/adapters/anthropic/passthrough";
import { resolveProviderHeaderValue, resolveProviderHeaders } from "../../src/providers/provider-header-resolve";
import { resolveGithubCopilotTransport } from "../../src/providers/github-copilot-transport";
import { resolveProviderTransport } from "../../src/providers/xai-transport";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const ENV_NAME = "OCX_TEST_PROVIDER_HEADER_ENV_REF";
const SECOND_ENV_NAME = "OCX_TEST_PROVIDER_HEADER_ENV_REF_SECOND";
const previousValue = process.env[ENV_NAME];
const previousSecondValue = process.env[SECOND_ENV_NAME];

afterEach(() => {
  if (previousValue === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = previousValue;
  if (previousSecondValue === undefined) delete process.env[SECOND_ENV_NAME];
  else process.env[SECOND_ENV_NAME] = previousSecondValue;
});

const parsed: OcxParsedRequest = {
  modelId: "gpt-5.5",
  context: { messages: [] },
  stream: true,
  options: {},
  _rawBody: { model: "gpt-5.5", input: [], stream: true },
};

describe("provider header environment references", () => {
  test("resolves only complete braced and bare references", () => {
    process.env[ENV_NAME] = "resolved-header";
    expect(resolveProviderHeaderValue(`\${${ENV_NAME}}`)).toBe("resolved-header");
    expect(resolveProviderHeaderValue(`$${ENV_NAME}`)).toBe("resolved-header");
    expect(resolveProviderHeaders({
      braced: `\${${ENV_NAME}}`,
      bare: `$${ENV_NAME}`,
      amount: "$10.00",
      bcrypt: "$2b$12$abc",
      empty: "",
      embedded: `pre\${${ENV_NAME}}`,
    })).toEqual({
      braced: "resolved-header",
      bare: "resolved-header",
      amount: "$10.00",
      bcrypt: "$2b$12$abc",
      empty: "",
      embedded: `pre\${${ENV_NAME}}`,
    });
  });

  test("omits an absent reference and leaves the configured object unchanged", () => {
    delete process.env[ENV_NAME];
    const configured = { missing: `$${ENV_NAME}`, literal: "$10.00" };
    expect(resolveProviderHeaders(configured)).toEqual({ literal: "$10.00" });
    expect(configured).toEqual({ missing: `$${ENV_NAME}`, literal: "$10.00" });
  });

  test("resolves an OpenAI Chat authorization override without combining it with apiKey", () => {
    process.env[ENV_NAME] = "resolved-api-key";
    const wire = openAIChatTransport({
      adapter: "openai-chat",
      baseUrl: "https://provider.example/v1",
      apiKey: "fixture-api-key",
      headers: { authorization: `$${ENV_NAME}` },
    });
    expect(new Headers(wire.headers).get("authorization")).toBe("resolved-api-key");
  });

  test("resolves Anthropic provider beta before merging the caller beta", () => {
    process.env[ENV_NAME] = "provider-beta";
    const request = buildAnthropicMessagesPassthroughRequest({
      adapter: "anthropic",
      authMode: "key",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "fixture-api-key",
      headers: { "anthropic-beta": `\${${ENV_NAME}}` },
    }, "claude-sonnet-4-6", {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
    }, undefined, { callerAnthropicBeta: "interleaved-thinking-2025-05-14" });
    expect(request.headers["anthropic-beta"]).toBe("provider-beta,interleaved-thinking-2025-05-14");
    expect(request.headers["anthropic-beta"]).not.toContain(`\${${ENV_NAME}}`);
  });

  test("sends a resolved Azure api-key header from the adapter wire", async () => {
    process.env[ENV_NAME] = "azure-apim-subscription-key";
    const provider: OcxProviderConfig = {
      adapter: "azure-openai",
      baseUrl: "https://resource.openai.azure.com/openai",
      apiKey: "azure-openai-key",
      headers: { "api-key": `\${${ENV_NAME}}` },
    };
    const request = await withTestTranslatorBudget(createAzureAdapter(provider)).buildRequest(parsed);
    expect(new Headers(request.headers).get("api-key")).toBe("azure-apim-subscription-key");
    expect(new Headers(request.headers).get("api-key")).not.toBe("${AZURE_APIM_SUBS_KEY}");
  });

  test("expands a reference once when a transport wrapper sits before the adapter", () => {
    // An environment value that itself looks like a reference must be sent as-is.
    process.env[ENV_NAME] = `$${SECOND_ENV_NAME}`;
    process.env[SECOND_ENV_NAME] = "second-value";
    const configured: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.githubcopilot.com",
      apiKey: "fixture-api-key",
      headers: { "x-custom": `$${ENV_NAME}` },
    };
    const transport = resolveGithubCopilotTransport(configured);
    expect(transport.headers?.["x-custom"]).toBe(`$${ENV_NAME}`);
    expect(new Headers(openAIChatTransport(transport).headers).get("x-custom")).toBe(`$${SECOND_ENV_NAME}`);
  });

  test("xAI generates a request id when the configured reference is unset", async () => {
    delete process.env[ENV_NAME];
    let sent: Headers | undefined;
    const effective = resolveProviderTransport("xai", {
      adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      authMode: "key",
      apiKey: "xai-api-key",
      headers: { "x-grok-req-id": `$${ENV_NAME}` },
      fetch: (async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        sent = new Headers(init?.headers);
        return new Response("{}");
      }) as typeof globalThis.fetch,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch });
    const wire = openAIChatTransport(effective);
    await effective.fetch!(wire.url, { method: "POST", headers: wire.headers, body: "{}" });
    const requestId = sent?.get("x-grok-req-id");
    expect(requestId).toBeTruthy();
    expect(requestId).not.toContain("$");
  });
});
