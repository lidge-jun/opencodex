import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { stripUnsupportedHostedTools } from "../../src/adapters/openai-responses/tool-schema";
import { validateConfigCandidate } from "../../src/config/diagnostics";
import { providerManagementConfigError } from "../../src/server/auth-cors";
import { modelPreferHostedToolsConfigError } from "../../src/config/schema/leaf-validators";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

/**
 * #8204. An OpenAI-compatible Responses gateway in front of Gemini accepts hosted
 * web_search alone and function tools alone, but answers HTTP 400 when one request declares
 * both. The unconditional unsupportedHostedTools list (#5002) works around the 400 at the cost
 * of the search-only capability the gateway does serve, so the provider declares the narrower
 * contract: drop the named hosted declarations only when client tools travel with them.
 */

const createResponsesPassthroughAdapter = (
  ...args: Parameters<typeof createResponsesPassthroughAdapterProduction>
) => withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const GATEWAY_BASE_URL = "https://gateway.example/v1";
const GATEWAY_MODEL = "gateway-mini";

function gateway(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: GATEWAY_BASE_URL,
    apiKey: "test-key",
    models: [GATEWAY_MODEL],
    ...overrides,
  } as OcxProviderConfig;
}

const conditional = (tools: string[] = ["web_search"], overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig =>
  gateway({ unsupportedHostedToolsWithClientTools: tools, ...overrides } as Partial<OcxProviderConfig>);

const functionTool = {
  type: "function",
  name: "lookup_marker",
  description: "Read a synthetic diagnostic marker.",
  parameters: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false },
};
const customTool = { type: "custom", name: "apply_patch", description: "Apply a patch" };
const namespaceTool = { type: "namespace", name: "mcp__fixture", description: "Fixture MCP", tools: [functionTool] };

function build(rawBody: Record<string, unknown>, provider: OcxProviderConfig): Record<string, unknown> {
  const request = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: GATEWAY_MODEL,
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: GATEWAY_MODEL, input: "Synthetic test. Reply exactly OK.", ...rawBody },
  }, { headers: new Headers() });
  return JSON.parse(request.body) as Record<string, unknown>;
}

const strip = (body: Record<string, unknown>, provider: OcxProviderConfig): Record<string, unknown> =>
  stripUnsupportedHostedTools({ model: GATEWAY_MODEL, ...body }, provider) as Record<string, unknown>;

describe("conditional hosted-tool denial reaches the serialized request", () => {
  test("hosted search mixed with a function tool is stripped", () => {
    expect(build({ tools: [{ type: "web_search_preview" }, functionTool] }, conditional()).tools)
      .toEqual([functionTool]);
  });

  test("a hosted-search-only request keeps its search", () => {
    expect(build({ tools: [{ type: "web_search_preview" }] }, conditional()).tools)
      .toEqual([{ type: "web_search_preview" }]);
  });

  test("an unset field leaves the serialized mixed request unchanged", () => {
    const tools = [{ type: "web_search" }, functionTool];
    const unset = build({ tools }, gateway());
    expect(unset.tools).toEqual(tools);
    expect(JSON.stringify(build({ tools }, conditional([])))).toBe(JSON.stringify(unset));
  });
});

describe("unsupportedHostedToolsWithClientTools request shaping", () => {
  test("strips the named hosted tool when a function, custom, or populated namespace tool is declared", () => {
    for (const client of [functionTool, customTool, namespaceTool]) {
      expect(strip({ tools: [{ type: "web_search" }, client] }, conditional()).tools).toEqual([client]);
    }
  });

  test("an empty namespace is not a client tool", () => {
    const body = { model: GATEWAY_MODEL, tools: [{ type: "web_search" }, { type: "namespace", name: "mcp__empty", tools: [] }] };
    expect(stripUnsupportedHostedTools(body, conditional())).toBe(body);
  });

  test("a hosted-only request is returned untouched", () => {
    const body = { model: GATEWAY_MODEL, tools: [{ type: "web_search" }, { type: "image_generation" }], tool_choice: { type: "web_search" } };
    expect(stripUnsupportedHostedTools(body, conditional())).toBe(body);
  });

  test("the declaration is alias-expanded like the unconditional list", () => {
    expect(strip({ tools: [{ type: "web_search_preview" }, functionTool] }, conditional(["web_search"])).tools)
      .toEqual([functionTool]);
    expect(strip({ tools: [{ type: "web_search" }, functionTool] }, conditional(["web_search_preview"])).tools)
      .toEqual([functionTool]);
  });

  test("it removes only what it names", () => {
    expect(strip({ tools: [{ type: "web_search" }, { type: "image_generation" }, functionTool] }, conditional()).tools)
      .toEqual([{ type: "image_generation" }, functionTool]);
  });

  test("client tools in a client-loaded catalog count, and the catalog itself is filtered", () => {
    expect(strip({
      tools: [{ type: "web_search" }],
      input: [{ type: "additional_tools", tools: [functionTool] }],
    }, conditional())).toMatchObject({ tools: [], input: [{ type: "additional_tools", tools: [functionTool] }] });
    expect(strip({
      tools: [functionTool],
      input: [{ type: "additional_tools", tools: [{ type: "web_search_preview" }, customTool] }],
    }, conditional())).toMatchObject({ tools: [functionTool], input: [{ type: "additional_tools", tools: [customTool] }] });
    expect(strip({
      tools: [{ type: "web_search" }],
      input: [{ type: "tool_search_output", call_id: "ts_1", status: "completed", execution: "client", tools: [namespaceTool] }],
    }, conditional()).tools).toEqual([]);
  });

  test("selectors are reconciled exactly as for the unconditional list", () => {
    const unconditional = gateway({ unsupportedHostedTools: ["web_search"] });
    for (const body of [
      { tools: [{ type: "web_search" }, functionTool], tool_choice: { type: "web_search" } },
      { tools: [{ type: "web_search" }, functionTool], tool_choice: { type: "web_search_preview" } },
      {
        tools: [{ type: "web_search" }, functionTool],
        tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "web_search" }, { type: "function", name: "lookup_marker" }] },
      },
      { tools: [{ type: "web_search" }, functionTool], tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "web_search" }] } },
      { tools: [{ type: "web_search" }], input: [{ type: "additional_tools", tools: [functionTool] }], tool_choice: "required" },
    ]) {
      expect(strip(body, conditional())).toEqual(strip(body, unconditional));
    }
    expect(strip({ tools: [{ type: "web_search" }, functionTool], tool_choice: { type: "web_search" } }, conditional()).tool_choice)
      .toBe("none");
  });

  test("the unconditional list stays authoritative", () => {
    const provider = conditional(["web_search"], { unsupportedHostedTools: ["web_search"] });
    expect(strip({ tools: [{ type: "web_search" }] }, provider).tools).toEqual([]);
    const imageDenied = conditional(["web_search"], { unsupportedHostedTools: ["image_generation"] });
    expect(strip({ tools: [{ type: "web_search" }, { type: "image_generation" }] }, imageDenied).tools)
      .toEqual([{ type: "web_search" }]);
  });

  test("unset or empty declarations strip nothing", () => {
    for (const provider of [gateway(), conditional([]), conditional(["   "])]) {
      const body = { model: GATEWAY_MODEL, tools: [{ type: "web_search" }, functionTool], tool_choice: { type: "web_search" } };
      expect(stripUnsupportedHostedTools(body, provider)).toBe(body);
    }
  });
});

describe("unsupportedHostedToolsWithClientTools configuration", () => {
  test("the management boundary accepts hosted tool names", () => {
    expect(providerManagementConfigError("relay", { ...gateway(), unsupportedHostedToolsWithClientTools: ["web_search", "web_search_preview"] }))
      .toBeNull();
  });

  test("the management boundary rejects a misspelling or a non-array", () => {
    for (const value of [["web_serch"], "web_search", [42], [""]]) {
      const error = providerManagementConfigError("relay", { ...gateway(), unsupportedHostedToolsWithClientTools: value });
      expect(error).toContain("unsupportedHostedToolsWithClientTools");
    }
  });

  test("the config schema rejects a misspelling instead of persisting a no-op", () => {
    const candidate = (value: unknown) => ({
      port: 10100,
      defaultProvider: "relay",
      providers: { relay: { ...gateway(), unsupportedHostedToolsWithClientTools: value } },
    });
    const accepted = validateConfigCandidate(candidate([" web_search "]));
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.config.providers.relay?.unsupportedHostedToolsWithClientTools).toEqual(["web_search"]);
    const rejected = validateConfigCandidate(candidate(["web_serch"]));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("unsupportedHostedToolsWithClientTools");
  });

  test("a provider cannot prefer a hosted tool its conditional list denies", () => {
    // Codex requests always carry client tools, so the conditional denial would apply on every
    // turn and silently cancel the preference after it already removed the client image tool.
    const error = modelPreferHostedToolsConfigError(
      { [GATEWAY_MODEL]: ["image_generation"] },
      "modelPreferHostedTools",
      "relay",
      { ...gateway(), unsupportedHostedToolsWithClientTools: ["image_gen"] },
    );
    expect(error).toContain("cannot prefer image_generation");
    expect(error).toContain("unsupportedHostedToolsWithClientTools");
    expect(modelPreferHostedToolsConfigError(
      { [GATEWAY_MODEL]: ["image_generation"] },
      "modelPreferHostedTools",
      "relay",
      { ...gateway(), unsupportedHostedToolsWithClientTools: ["web_search"] },
    )).toBeNull();
  });
});
