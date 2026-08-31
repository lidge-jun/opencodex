import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { parseRequest } from "../src/responses/parser";
import { buildModelsRequest } from "../src/oauth";
import {
  isXaiResponsesDestination,
  resolveProviderTransport,
  deriveXaiConvId,
  XAI_CONV_ID_HEADER,
  XAI_GROK_CLI_BASE_URL,
  XAI_GROK_CLIENT_VERSION,
} from "../src/providers/xai-transport";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { XAI_RESPONSES_OPT_IN_MODELS } from "../src/providers/xai-responses-opt-in";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import type { OcxAssistantMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OMITTED = [
  "x-grok-model-override",
  "x-grok-agent-id",
  "x-grok-turn-idx",
  "x-grok-deployment-id",
  "x-grok-user-id",
  "x-grok-client-mode",
] as const;

function provider(authMode: "oauth" | "key"): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authMode,
    apiKey: authMode === "oauth" ? "oauth-token" : "xai-api-key",
    defaultModel: "grok-4.5",
  };
}

function cliProvider(): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: XAI_GROK_CLI_BASE_URL,
    authMode: "oauth",
    apiKey: "oauth-token",
    defaultModel: "grok-4.5",
  };
}

function parsed(): OcxParsedRequest {
  return {
    modelId: "grok-4.5",
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: { reasoning: "low" },
  };
}

describe("xAI Responses destination detection", () => {
  test.each([
    "https://api.x.ai/v1",
    "https://api.x.ai:443/v1",
    XAI_GROK_CLI_BASE_URL,
    "https://CLI-CHAT-PROXY.GROK.COM:443/v1",
  ])("accepts the exact xAI HTTPS destination %s", baseUrl => {
    expect(isXaiResponsesDestination({ baseUrl })).toBe(true);
  });

  test.each([
    "http://api.x.ai/v1",
    "https://api.x.ai:444/v1",
    "https://api.x.ai.evil.test/v1",
    "https://cli-chat-proxy.grok.com.evil.test/v1",
    "not a URL",
  ])("rejects a non-xAI or malformed destination %s", baseUrl => {
    expect(isXaiResponsesDestination({ baseUrl })).toBe(false);
  });
});

describe("xAI auth-mode transport selection", () => {
  test("OAuth selects the Grok CLI subscription transport and required headers", () => {
    const effective = resolveProviderTransport("xai", provider("oauth"));
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());

    expect(effective.baseUrl).toBe(XAI_GROK_CLI_BASE_URL);
    expect(request.url).toBe(`${XAI_GROK_CLI_BASE_URL}/chat/completions`);
    expect(request.headers).toMatchObject({
      Authorization: "Bearer oauth-token",
      "x-grok-client-identifier": "opencodex",
      "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  test("OAuth model discovery uses the subscription transport", () => {
    const request = buildModelsRequest(provider("oauth"), "oauth-token", "xai");

    expect(request.url).toBe(`${XAI_GROK_CLI_BASE_URL}/models`);
    expect(request.headers).toMatchObject({
      Authorization: "Bearer oauth-token",
      "x-grok-client-identifier": "opencodex",
      "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  test("API key keeps the xAI API transport without subscription headers", () => {
    const configured = provider("key");
    const effective = resolveProviderTransport("xai", configured);
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());
    const modelsRequest = buildModelsRequest(configured, "xai-api-key", "xai");

    expect(effective).not.toBe(configured);
    expect(request.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(modelsRequest.url).toBe("https://api.x.ai/v1/models");
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer xai-api-key",
    });
    expect(modelsRequest.headers).toEqual({ Authorization: "Bearer xai-api-key" });
  });

  test("custom providers and configured header overrides remain untouched", () => {
    const custom = provider("oauth");
    custom.headers = { "x-grok-client-version": "0.2.94", "x-custom": "kept" };

    expect(resolveProviderTransport("custom-xai", custom)).toBe(custom);
    expect(resolveProviderTransport("xai", custom).headers).toMatchObject({
      "x-grok-client-version": "0.2.94",
      "x-custom": "kept",
      "x-grok-client-identifier": "opencodex",
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  test("omits a CLI union whose properties are only on some branches; api.x.ai keeps the native union", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { mode: { type: "string", enum: ["view"] } } },
        { oneOf: [{ type: "object", properties: { path: { type: "string" } } }, { type: "object", properties: {} }] },
      ],
      $defs: { shared: { type: "string" } },
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "automation_update", description: "Update", parameters: schema }] },
    });
    expect(JSON.parse(request.body).tools).toBeUndefined();

    const apiRequest = createOpenAIChatAdapter(provider("key")).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "automation_update", description: "Update", parameters: schema }] },
    });
    expect((JSON.parse(apiRequest.body) as { tools: Array<{ function: { parameters: unknown } }> }).tools[0].function.parameters).toEqual({ ...schema, type: "object" });

    const otherRequest = createOpenAIChatAdapter({ ...provider("key"), baseUrl: "https://example.test/v1" }).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "automation_update", description: "Update", parameters: schema }] },
    });
    expect((JSON.parse(otherRequest.body) as { tools: Array<{ function: { parameters: unknown } }> }).tools[0].function.parameters).toEqual({ ...schema, type: "object" });
  });

  test("omits a CLI union with a branch-local property even when additionalProperties is omitted", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { mode: { type: "string" } } },
        { type: "object", properties: { path: { type: "string" } } },
      ],
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "local", description: "Local", parameters: schema }] },
    });
    expect(JSON.parse(request.body).tools).toBeUndefined();
  });

  test("omits a CLI union with a branch-local property even when additionalProperties is true", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { a: { type: "string" } }, additionalProperties: true },
        { type: "object", properties: { b: { type: "number" } }, additionalProperties: true },
      ],
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "open", description: "Open", parameters: schema }] },
    });
    expect(JSON.parse(request.body).tools).toBeUndefined();
  });

  test("preserves shared root properties when every xAI branch has the same required set", () => {
    const schema = {
      type: "object",
      properties: { token: { type: "string" } },
      required: ["token"],
      oneOf: [
        { properties: { mode: { const: "path" } } },
        { properties: { mode: { const: "url" } } },
      ],
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "automation_update", description: "Update", parameters: schema }] },
    });
    const xaiParameters = (JSON.parse(request.body) as { tools: Array<{ function: { parameters: Record<string, unknown> } }> }).tools[0].function.parameters;

    expect(xaiParameters.type).toBe("object");
    expect(xaiParameters.oneOf).toBeUndefined();
    expect(xaiParameters.anyOf).toBeUndefined();
    expect(xaiParameters.properties).toEqual({
      token: { type: "string" },
      mode: { anyOf: [{ const: "path" }, { const: "url" }] },
    });
    // `mode` absent matched BOTH branches, which the root `oneOf` rejects, so flattening has to
    // require the discriminator to keep accepting exactly what the original accepted.
    expect(xaiParameters.required).toEqual(["token", "mode"]);
  });

  test("omits an xAI union whose branch required fields cannot be flattened", () => {
    const schema = {
      type: "object",
      properties: { token: { type: "string" } },
      required: ["token"],
      oneOf: [
        { properties: { mode: { const: "path" }, path: { type: "string" } }, required: ["mode", "path"] },
        { properties: { mode: { const: "url" }, url: { type: "string" } }, required: ["mode", "url"] },
      ],
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "automation_update", description: "Update", parameters: schema }] },
    });
    expect(JSON.parse(request.body).tools).toBeUndefined();
  });

  test("omits equal-required CLI unions whose property types are correlated", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { kind: { const: "email" }, value: { type: "string" } }, required: ["kind", "value"] },
        { type: "object", properties: { kind: { const: "sms" }, value: { type: "number" } }, required: ["kind", "value"] },
      ],
    };
    const cli = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "contact", description: "Contact", parameters: schema }] },
    });
    expect(JSON.parse(cli.body).tools).toBeUndefined();

    const api = createOpenAIChatAdapter(provider("key")).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "contact", description: "Contact", parameters: schema }] },
    });
    expect((JSON.parse(api.body) as { tools: Array<{ function: { parameters: unknown } }> }).tools[0].function.parameters).toEqual({ ...schema, type: "object" });
  });

  test("omits a $ref union whose resolved properties are only on some branches", () => {
    const schema = {
      $defs: {
        path: { type: "object", properties: { mode: { const: "path" }, path: { type: "string" } } },
        url: { type: "object", properties: { mode: { const: "url" }, url: { type: "string" } } },
      },
      oneOf: [{ $ref: "#/$defs/path" }, { $ref: "#/$defs/url" }],
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "automation_update", description: "Update", parameters: schema }] },
    });
    expect(JSON.parse(request.body).tools).toBeUndefined();
  });

  test("resolves local $ref variants and flattens when every property is shared", () => {
    const schema = {
      $defs: {
        path: { type: "object", properties: { mode: { const: "path" } } },
        url: { type: "object", properties: { mode: { const: "url" } } },
      },
      oneOf: [{ $ref: "#/$defs/path" }, { $ref: "#/$defs/url" }],
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "automation_update", description: "Update", parameters: schema }] },
    });
    const xaiParameters = (JSON.parse(request.body) as { tools: Array<{ function: { parameters: Record<string, unknown> } }> }).tools[0].function.parameters;
    expect(xaiParameters.type).toBe("object");
    expect(xaiParameters.oneOf).toBeUndefined();
    expect(xaiParameters.properties).toEqual({
      mode: { anyOf: [{ const: "path" }, { const: "url" }] },
    });
    expect(xaiParameters.$defs).toEqual(schema.$defs);
  });

  test("omits an xAI $ref union that would collapse to an empty object", () => {
    const schema = {
      $defs: {
        named: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
      oneOf: [{ $ref: "#/$defs/named" }, { type: "object", properties: { id: { type: "number" } } }],
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "lookup", description: "Lookup", parameters: schema }] },
    });
    expect(JSON.parse(request.body).tools).toBeUndefined();
  });

  test("omits a closed CLI union whose exclusive properties cannot be flattened", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
        { type: "object", properties: { b: { type: "string" } }, additionalProperties: false },
      ],
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "closed", description: "Closed", parameters: schema }] },
    });
    expect(JSON.parse(request.body).tools).toBeUndefined();
  });

  test("keeps additionalProperties: false when every closed CLI variant shares the same properties", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { a: { const: "one" } }, additionalProperties: false },
        { type: "object", properties: { a: { const: "two" } }, additionalProperties: false },
      ],
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "closed", description: "Closed", parameters: schema }] },
    });
    const xaiParameters = (JSON.parse(request.body) as { tools: Array<{ function: { parameters: Record<string, unknown> } }> }).tools[0].function.parameters;
    expect(xaiParameters.additionalProperties).toBe(false);
    expect(xaiParameters.properties).toEqual({ a: { anyOf: [{ const: "one" }, { const: "two" }] } });
  });

  test("omits an xAI union that would tighten additionalProperties", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { a: { type: "string" } }, additionalProperties: true },
        { type: "object", properties: { b: { type: "string" } }, additionalProperties: false },
      ],
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "mixed", description: "Mixed", parameters: schema }] },
    });
    expect(JSON.parse(request.body).tools).toBeUndefined();
  });

  test("omits a CLI union that would drop branch-level minProperties", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { a: { type: "string" } }, minProperties: 1 },
        { type: "object", properties: { a: { type: "string" } } },
      ],
    };
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "min", description: "Min", parameters: schema }] },
    });
    expect(JSON.parse(request.body).tools).toBeUndefined();
  });

  test("non-xAI providers preserve nested nullable and annotation schema content", () => {
    const schema = {
      type: "object",
      properties: {
        path: { anyOf: [{ type: "string" }, { type: "null" }] },
        opts: { default: { type: "null" }, enum: [{ type: "null" }, "a"] },
      },
    };
    const request = createOpenAIChatAdapter({ ...provider("key"), baseUrl: "https://example.test/v1" }).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "t", description: "T", parameters: schema }] },
    });
    expect((JSON.parse(request.body) as { tools: Array<{ function: { parameters: unknown } }> }).tools[0].function.parameters).toEqual(schema);
  });

  test("omits an xAI tool whose root schema cannot be normalized safely", () => {
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest({
      ...parsed(),
      context: { messages: [], tools: [{ name: "unsafe", description: "Unsafe", parameters: { oneOf: [{ type: "string" }] } }] },
    });
    expect(JSON.parse(request.body).tools).toBeUndefined();
  });

  test("normalizes a tool loaded from tool_search history on later turns", () => {
    const parsedRequest = parseRequest({
      model: "xai/grok-4.5",
      input: [
        { type: "tool_search_call", call_id: "search-1", arguments: { query: "automation" } },
        {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          tools: [{
            type: "function",
            name: "automation_update",
            description: "Update an automation",
            parameters: { oneOf: [{ type: "object", properties: {} }, { oneOf: [{ type: "object", properties: {} }] }] },
          }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    });
    const request = createOpenAIChatAdapter(cliProvider()).buildRequest(parsedRequest);
    const body = JSON.parse(request.body) as { tools: Array<{ function: { name: string; parameters: Record<string, unknown> } }> };
    const tool = body.tools.find(entry => entry.function.name === "automation_update");

    expect(tool?.function.parameters.type).toBe("object");
    expect(tool?.function.parameters.oneOf).toBeUndefined();
    expect(tool?.function.parameters.properties).toEqual({});
  });
});

describe("xAI prompt-cache conv-id affinity", () => {
  test("promptCacheKey derives a stable hashed x-grok-conv-id in oauth mode", () => {
    const effective = resolveProviderTransport("xai", provider("oauth"), "codex-session-abc");
    const again = resolveProviderTransport("xai", provider("oauth"), "codex-session-abc");

    expect(effective.headers?.[XAI_CONV_ID_HEADER]).toBe(deriveXaiConvId("codex-session-abc"));
    expect(effective.headers?.[XAI_CONV_ID_HEADER]).toMatch(/^[0-9a-f]{32}$/);
    // Stable across requests (cache affinity) and never the raw session id.
    expect(again.headers?.[XAI_CONV_ID_HEADER]).toBe(effective.headers?.[XAI_CONV_ID_HEADER]);
    expect(effective.headers?.[XAI_CONV_ID_HEADER]).not.toContain("codex-session-abc");
  });

  test("key mode gains conv-id affinity without touching baseUrl or CLI headers", () => {
    const configured = provider("key");
    const effective = resolveProviderTransport("xai", configured, "codex-session-abc");
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());

    expect(effective.baseUrl).toBe("https://api.x.ai/v1");
    expect(request.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(effective.headers?.[XAI_CONV_ID_HEADER]).toBe(deriveXaiConvId("codex-session-abc"));
    expect(effective.headers?.["x-grok-client-identifier"]).toBeUndefined();
    expect(effective.headers?.["x-grok-client-version"]).toBeUndefined();
    expect(effective.headers?.["x-xai-token-auth"]).toBeUndefined();
    for (const [name, value] of Object.entries(request.headers)) {
      expect(name).not.toContain("codex-session-abc");
      expect(value).not.toContain("codex-session-abc");
    }
  });

  test("missing, empty, and whitespace-only cache keys never emit a conv-id", () => {
    const noKeyOauth = resolveProviderTransport("xai", provider("oauth"));
    const emptyKeyOauth = resolveProviderTransport("xai", provider("oauth"), "");
    const blankKeyOauth = resolveProviderTransport("xai", provider("oauth"), "   ");
    const configuredKey = provider("key");
    const emptyKeyApi = resolveProviderTransport("xai", configuredKey, "");

    expect(noKeyOauth.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    expect(emptyKeyOauth.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    expect(blankKeyOauth.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    expect(emptyKeyApi).not.toBe(configuredKey);
    expect(emptyKeyApi.fetch).toBeFunction();
  });

  test("user-configured conv-id header wins in any casing (no duplicate header pair)", () => {
    const lower = provider("oauth");
    lower.headers = { [XAI_CONV_ID_HEADER]: "user-pinned" };
    const mixed = provider("key");
    mixed.headers = { "X-Grok-Conv-Id": "user-pinned-mixed" };

    const lowerResolved = resolveProviderTransport("xai", lower, "codex-session-abc");
    const mixedResolved = resolveProviderTransport("xai", mixed, "codex-session-abc");

    expect(lowerResolved.headers?.[XAI_CONV_ID_HEADER]).toBe("user-pinned");
    // Mixed casing: the generated lowercase header must be suppressed entirely.
    expect(mixedResolved.headers?.["X-Grok-Conv-Id"]).toBe("user-pinned-mixed");
    expect(mixedResolved.headers?.[XAI_CONV_ID_HEADER]).toBeUndefined();
    const convIdKeys = Object.keys(mixedResolved.headers ?? {}).filter(k => k.toLowerCase() === XAI_CONV_ID_HEADER);
    expect(convIdKeys).toHaveLength(1);
  });

  test("mixed-case user override of a Grok CLI default header suppresses the default", () => {
    const custom = provider("oauth");
    custom.headers = { "X-Grok-Client-Version": "0.2.94" };

    const resolved = resolveProviderTransport("xai", custom);
    const versionKeys = Object.keys(resolved.headers ?? {}).filter(k => k.toLowerCase() === "x-grok-client-version");
    expect(versionKeys).toEqual(["X-Grok-Client-Version"]);
    expect(resolved.headers?.["X-Grok-Client-Version"]).toBe("0.2.94");
    // Untouched defaults still apply.
    expect(resolved.headers?.["x-grok-client-identifier"]).toBe("opencodex");
  });
});

function lower(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function capture(authMode: "oauth" | "key", calls = 1) {
  const seen: Headers[] = [];
  const configured = provider(authMode) as OcxProviderConfig & { fetch?: typeof globalThis.fetch };
  configured.fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers));
    return new Response("{}", { status: 200 });
  };
  const effective = resolveProviderTransport("xai", configured, "codex-session-abc");
  const request = createOpenAIChatAdapter(effective).buildRequest(parsed());
  for (let index = 0; index < calls; index += 1) {
    await effective.fetch!(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  }
  return { effective, seen };
}

describe("xAI outbound compatibility headers", () => {
  test("OAuth snapshot is exact", async () => {
    const { effective, seen } = await capture("oauth");
    expect(effective.baseUrl).toBe(XAI_GROK_CLI_BASE_URL);
    expect(lower(seen[0])).toEqual({
      authorization: "Bearer oauth-token",
      "content-type": "application/json",
      "user-agent": `opencodex-grok/${XAI_GROK_CLIENT_VERSION}`,
      "x-authenticateresponse": "authenticate-response",
      "x-grok-client-identifier": "opencodex",
      "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
      "x-grok-conv-id": deriveXaiConvId("codex-session-abc"),
      "x-grok-req-id": expect.stringMatching(UUID_V4),
      "x-grok-session-id": deriveXaiConvId("codex-session-abc"),
      "x-xai-token-auth": "xai-grok-cli",
    });
    for (const name of OMITTED) expect(seen[0].has(name)).toBe(false);
  });

  test("API-key snapshot is exact and User-Agent is present", async () => {
    const { effective, seen } = await capture("key");
    expect(effective.baseUrl).toBe("https://api.x.ai/v1");
    expect(lower(seen[0])).toEqual({
      authorization: "Bearer xai-api-key",
      "content-type": "application/json",
      "user-agent": `opencodex-grok/${XAI_GROK_CLIENT_VERSION}`,
      "x-grok-conv-id": deriveXaiConvId("codex-session-abc"),
      "x-grok-req-id": expect.stringMatching(UUID_V4),
      "x-grok-session-id": deriveXaiConvId("codex-session-abc"),
    });
    for (const name of [
      "x-authenticateresponse",
      "x-grok-client-identifier",
      "x-grok-client-version",
      "x-xai-token-auth",
      ...OMITTED,
    ]) expect(seen[0].has(name)).toBe(false);
  });

  test("same resolved transport pins one req-id per logical request (identical replays) and keeps conv-id stable", async () => {
    const { seen } = await capture("oauth", 2);
    expect(seen).toHaveLength(2);
    expect(seen[0].get("x-grok-req-id")).toMatch(UUID_V4);
    expect(seen[1].get("x-grok-req-id")).toMatch(UUID_V4);
    // A same-target 429 replay must be byte-identical, including x-grok-req-id; a new resolve
    // (e.g. after key rotation) produces a fresh transport and therefore a fresh id.
    expect(seen[1].get("x-grok-req-id")).toBe(seen[0].get("x-grok-req-id"));
    const freshTransport = await capture("oauth", 1);
    expect(freshTransport.seen[0].get("x-grok-req-id")).not.toBe(seen[0].get("x-grok-req-id"));
    expect(seen[0].get("x-grok-conv-id")).toBe(deriveXaiConvId("codex-session-abc"));
    expect(seen[1].get("x-grok-conv-id")).toBe(seen[0].get("x-grok-conv-id"));
    expect(seen[1].get("x-grok-session-id")).toBe(seen[0].get("x-grok-session-id"));
    for (const headers of seen) {
      expect(headers.get("user-agent")).toBe(`opencodex-grok/${XAI_GROK_CLIENT_VERSION}`);
      for (const name of OMITTED) expect(headers.has(name)).toBe(false);
    }
  });

  test("mixed-case caller overrides win without duplicates", async () => {
    const seen: Headers[] = [];
    const configured = provider("oauth") as OcxProviderConfig & { fetch?: typeof globalThis.fetch };
    configured.headers = { "user-agent": "custom-agent", "X-Grok-Req-Id": "caller-id" };
    configured.fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}", { status: 200 });
    };
    const effective = resolveProviderTransport("xai", configured, "codex-session-abc");
    const request = createOpenAIChatAdapter(effective).buildRequest(parsed());
    await effective.fetch!(request.url, { headers: request.headers });
    await effective.fetch!(request.url, { headers: request.headers });
    for (const headers of seen) {
      expect(headers.get("user-agent")).toBe("custom-agent");
      expect(headers.get("x-grok-req-id")).toBe("caller-id");
      expect([...headers.keys()].filter(name => name === "user-agent")).toHaveLength(1);
      expect([...headers.keys()].filter(name => name === "x-grok-req-id")).toHaveLength(1);
    }
  });

  test("blank cache keys omit affinity but retain UA and fresh req-id in both modes", async () => {
    for (const authMode of ["oauth", "key"] as const) {
      const seen: Headers[] = [];
      const configured = provider(authMode) as OcxProviderConfig & { fetch?: typeof globalThis.fetch };
      configured.fetch = async (_input, init) => {
        seen.push(new Headers(init?.headers));
        return new Response("{}", { status: 200 });
      };
      const effective = resolveProviderTransport("xai", configured, "   ");
      const request = createOpenAIChatAdapter(effective).buildRequest(parsed());
      await effective.fetch!(request.url, { headers: request.headers });
      expect(seen[0].has("x-grok-conv-id")).toBe(false);
      expect(seen[0].has("x-grok-session-id")).toBe(false);
      expect(seen[0].get("user-agent")).toBe(`opencodex-grok/${XAI_GROK_CLIENT_VERSION}`);
      expect(seen[0].get("x-grok-req-id")).toMatch(UUID_V4);
      for (const name of OMITTED) expect(seen[0].has(name)).toBe(false);
    }
  });
});

describe("xAI reasoning_content cache preservation", () => {
  test("registry preset exposes multi-agent only on Responses without claiming replay material", () => {
    const entry = getProviderRegistryEntry("xai");
    expect(entry?.preserveReasoningContentModels).toEqual([
      "grok-4.6",
      "grok-4.5",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
    ]);
    expect(entry?.models).toContain("grok-4.20-multi-agent-0309");
    expect(entry?.preserveReasoningContentModels).not.toContain("grok-4.20-multi-agent-0309");
    expect(entry?.modelSupportsReasoningSummaries?.["grok-4.20-multi-agent-0309"]).toBeUndefined();
    expect(resolveWireProtocolOverride(
      "xai",
      "grok-4.20-multi-agent-0309",
      provider("oauth"),
      "responses",
    ).adapter).toBe("openai-responses");
    expect(resolveWireProtocolOverride(
      "xai",
      "grok-4.20-multi-agent-0309",
      provider("key"),
      "responses",
    ).adapter).toBe("openai-responses");
    expect(resolveWireProtocolOverride(
      "xai",
      "grok-4.20-multi-agent-0309",
      provider("oauth"),
      "chat",
    ).adapter).toBe("openai-responses");
    expect(resolveWireProtocolOverride(
      "xai",
      "grok-4.20-multi-agent-0309",
      provider("key"),
      "chat",
    ).adapter).toBe("openai-responses");
    // The Claude Messages lane resolves with inbound "anthropic" (src/server/claude-messages.ts).
    // It is not a spelling of "responses": an inbound missing from the allow-list makes
    // providerModelWireDefault return undefined, which silently keeps xAI's provider-wide
    // openai-chat adapter — the one wire this model answers with a 400.
    expect(resolveWireProtocolOverride(
      "xai",
      "grok-4.20-multi-agent-0309",
      provider("oauth"),
      "anthropic",
    ).adapter).toBe("openai-responses");
    expect(resolveWireProtocolOverride(
      "xai",
      "grok-4.20-multi-agent-0309",
      provider("key"),
      "anthropic",
    ).adapter).toBe("openai-responses");
    expect(XAI_RESPONSES_OPT_IN_MODELS).not.toContain("grok-4.20-multi-agent-0309");
    expect(entry?.models).toContain("grok-build-0.1");
    for (const noReasoning of entry?.noReasoningModels ?? []) {
      expect(entry?.preserveReasoningContentModels).not.toContain(noReasoning);
    }
  });

  test("parseRequest folds summary reasoning into one Grok assistant wire message", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "grok-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "cached chain" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ content: "answer", reasoning_content: "cached chain" });
  });

  test("parseRequest drops opaque encrypted-only reasoning without detaching an assistant wire message", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "grok-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "reasoning", id: "r-opaque", summary: [], encrypted_content: "opaque-native-blob" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toEqual({ role: "assistant", content: "answer" });
    expect(assistants[0]).not.toHaveProperty("reasoning_content");
  });

  test("parseRequest clears pending reasoning at a user boundary", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "grok-4.5",
      input: [
        { type: "reasoning", id: "r-orphan", summary: [{ type: "summary_text", text: "must drop" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "new turn" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toEqual([{ role: "assistant", content: "answer" }]);
    expect(assistants[0]).not.toHaveProperty("reasoning_content");
  });

  test("parseRequest folds pending reasoning into the assistant turn that carries the call", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "grok-4.5",
      input: [
        { type: "reasoning", id: "r-call", summary: [{ type: "summary_text", text: "call chain" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toHaveLength(2);
    // Grok wire shape: a reasoning model emits reasoning_content and tool_calls on the SAME
    // assistant message (and Anthropic replay requires thinking before tool_use in one turn).
    expect(assistants[0]).toMatchObject({
      reasoning_content: "call chain",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
    });
    expect(assistants[1]).toMatchObject({ content: "answer" });
    expect(assistants[1]).not.toHaveProperty("reasoning_content");
  });

  test("parseRequest newline-joins reasoning siblings before one assistant", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "grok-4.5",
      input: [
        { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "first" }] },
        { type: "reasoning", id: "r2", summary: [{ type: "summary_text", text: "second" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");
    const parsedAssistant = req.context.messages.find(message => message.role === "assistant") as OcxAssistantMessage;
    const thinkingParts = parsedAssistant.content.filter(part => part.type === "thinking");

    expect(thinkingParts).toHaveLength(1);
    expect(thinkingParts[0]).toMatchObject({ thinking: "first\nsecond", itemId: "r2" });
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ content: "answer", reasoning_content: "first\nsecond" });
  });

  test("parseRequest drops trailing reasoning without creating an assistant", () => {
    const req = parseRequest({
      model: "xai/grok-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "reasoning", id: "r-trailing", summary: [{ type: "summary_text", text: "unfinished" }] },
      ],
    });

    expect(req.context.messages.filter(message => message.role === "assistant")).toHaveLength(0);
    expect(req.context.messages).toHaveLength(1);
  });
});
