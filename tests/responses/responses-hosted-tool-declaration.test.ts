import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { stripUnsupportedHostedTools } from "../../src/adapters/openai-responses/tool-schema";
import {
  DECLARABLE_HOSTED_TOOL_TYPES,
  declaredUnsupportedHostedTools,
  isHostedToolUnsupportedForModel,
} from "../../src/responses/hosted-tool-policy";
import { HOSTED_TOOL_TYPES } from "../../src/responses/schema";
import { modelPreferHostedToolsConfigError } from "../../src/config";
import { providerManagementConfigError } from "../../src/server/auth-cors";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

/**
 * #5002. A gateway that speaks the Responses API but accepts a narrower capability set
 * than OpenAI used to be unrepresentable: it could only be handled by adding a hard-coded
 * baseUrl rule to src/responses/hosted-tool-policy.ts. The reported destination accepts
 * plain Responses requests and function tools but rejects hosted web_search with HTTP 400
 * unsupported_request, so even "Reply exactly with OK" failed before the model answered,
 * because the hosted declaration travelled with the text-only prompt.
 *
 * These cases live in their own file rather than in
 * tests/responses/openai-responses-passthrough.test.ts: that file is exactly at its
 * file-size ratchet cap (4,809 lines in tests/fixtures/file-size-baseline.json), and the
 * cap only ever moves downward, so appending there would fail the ratchet for every later
 * pull request.
 */

const createResponsesPassthroughAdapter = (
  ...args: Parameters<typeof createResponsesPassthroughAdapterProduction>
) => withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const GATEWAY_BASE_URL = "https://gateway.example/v1";
const GATEWAY_MODEL = "gateway-mini";

/** A user-defined OpenAI-compatible Responses gateway; deliberately not a registry row. */
function gateway(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: GATEWAY_BASE_URL,
    apiKey: "test-key",
    models: [GATEWAY_MODEL],
    ...overrides,
  } as OcxProviderConfig;
}

const functionTool = {
  type: "function",
  name: "noop",
  description: "Do nothing",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

function build(rawBody: Record<string, unknown>, provider: OcxProviderConfig): Record<string, unknown> {
  const request = createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: GATEWAY_MODEL,
    context: { messages: [] },
    stream: true,
    options: {},
    _rawBody: { model: GATEWAY_MODEL, input: "Reply exactly with OK.", ...rawBody },
  }, { headers: new Headers() });
  return JSON.parse(request.body) as Record<string, unknown>;
}

/**
 * The declaration reaches the wire. Two adapter-level cases only, because the rest of the
 * passthrough chain is not what changed; the body shapes are covered directly against
 * stripUnsupportedHostedTools below.
 */
describe("a declared hosted-tool denial reaches the serialized request", () => {
  test("a gateway can deny hosted web_search while keeping function tools", () => {
    const body = build(
      { tools: [{ type: "web_search" }, functionTool] },
      gateway({ unsupportedHostedTools: ["web_search"] }),
    );

    expect(body.tools).toEqual([functionTool]);
  });

  test("an undeclared gateway still forwards hosted web_search", () => {
    // The declaration is the only thing that changes behaviour here: without it this
    // destination is an unclassified gateway and the hosted tool must pass through, or the
    // fix would silently break every gateway that does support web search.
    const body = build({ tools: [{ type: "web_search" }, functionTool] }, gateway());

    expect(body.tools).toEqual([{ type: "web_search" }, functionTool]);
  });
});

describe("provider-declared unsupported hosted tools", () => {
  const strip = (body: Record<string, unknown>, declared?: string[]): Record<string, unknown> =>
    stripUnsupportedHostedTools(
      { model: GATEWAY_MODEL, ...body },
      gateway(declared ? { unsupportedHostedTools: declared } : {}),
    ) as Record<string, unknown>;

  test("declaring one spelling of the web-search capability denies both", () => {
    expect(strip({ tools: [{ type: "web_search_preview" }, functionTool] }, ["web_search"]).tools)
      .toEqual([functionTool]);
    expect(strip({ tools: [{ type: "web_search" }, functionTool] }, ["web_search_preview"]).tools)
      .toEqual([functionTool]);
    expect(declaredUnsupportedHostedTools({ unsupportedHostedTools: ["web_search_preview"] }))
      .toEqual(new Set(["web_search", "web_search_preview"]));
  });

  test("a denied hosted tool is removed from tool_choice rather than left dangling", () => {
    expect(strip({ tools: [{ type: "web_search" }], tool_choice: { type: "web_search" } }, ["web_search"]).tool_choice)
      .toBe("none");
    expect(strip({
      tools: [{ type: "web_search" }, functionTool],
      tool_choice: {
        type: "allowed_tools",
        mode: "auto",
        tools: [{ type: "web_search" }, { type: "function", name: "noop" }],
      },
    }, ["web_search"]).tool_choice).toEqual({
      type: "allowed_tools",
      mode: "auto",
      tools: [{ type: "function", name: "noop" }],
    });
  });

  test("the declaration also filters client-loaded additional_tools", () => {
    expect(strip({
      input: [{ type: "additional_tools", tools: [{ type: "web_search" }, functionTool] }],
    }, ["web_search"]).input).toEqual([{ type: "additional_tools", tools: [functionTool] }]);
  });

  test("the declaration denies only what it names", () => {
    // OpenCode Go Grok accepts hosted
    // web_search once the xAI-refused fields are normalized away (xai-web-search.ts), so
    // neither an unrelated declaration nor the table may remove it there.
    const declaredImageOnly = declaredUnsupportedHostedTools({ unsupportedHostedTools: ["image_generation"] });

    for (const model of ["grok-4.6", "grok-4.7"]) {
      expect(isHostedToolUnsupportedForModel(model, "web_search", "https://opencode.ai/zen/go/v1", declaredImageOnly))
        .toBe(false);
    }
    expect(isHostedToolUnsupportedForModel("grok-4.6", "web_search", GATEWAY_BASE_URL, declaredImageOnly))
      .toBe(false);
    expect(isHostedToolUnsupportedForModel(GATEWAY_MODEL, "image_gen", GATEWAY_BASE_URL, declaredImageOnly))
      .toBe(true);
  });

  test("no declaration allocates no set and strips nothing", () => {
    expect(declaredUnsupportedHostedTools(undefined).size).toBe(0);
    expect(declaredUnsupportedHostedTools({}).size).toBe(0);
    expect(declaredUnsupportedHostedTools({ unsupportedHostedTools: [] }).size).toBe(0);
    expect(declaredUnsupportedHostedTools({ unsupportedHostedTools: ["   "] }).size).toBe(0);

    const body = { model: GATEWAY_MODEL, tools: [{ type: "web_search" }] };
    expect(stripUnsupportedHostedTools(body, gateway())).toBe(body);
  });

  test("a gateway can deny anything a client is able to declare", () => {
    // The declaration vocabulary must cover the inbound hosted tool schema, otherwise a
    // client could send a tool the destination rejects and the operator would have no way
    // to say so.
    for (const tool of HOSTED_TOOL_TYPES) {
      expect(DECLARABLE_HOSTED_TOOL_TYPES.has(tool)).toBe(true);
    }
  });
});

describe("unsupportedHostedTools configuration", () => {
  test("an accepted declaration names only hosted tool types", () => {
    expect(providerManagementConfigError("relay", {
      ...gateway(),
      unsupportedHostedTools: ["web_search", "image_generation"],
    })).toBeNull();
  });

  test("a misspelled hosted tool is rejected instead of silently stripping nothing", () => {
    // The provider schema ends in .passthrough(), so an unvalidated "web_serch" would be
    // stored and then match no tool: the operator would keep receiving the upstream 400
    // this field exists to prevent, with nothing explaining why (#2106).
    const error = providerManagementConfigError("relay", {
      ...gateway(),
      unsupportedHostedTools: ["web_serch"],
    });

    expect(error).toContain("unsupportedHostedTools");
    expect(error).toContain("web_search");
  });

  test("a provider cannot both deny and prefer the same hosted tool", () => {
    const error = modelPreferHostedToolsConfigError(
      { [GATEWAY_MODEL]: ["image_generation"] },
      "modelPreferHostedTools",
      "relay",
      { ...gateway(), unsupportedHostedTools: ["image_generation"] },
    );

    expect(error).toContain("cannot prefer image_generation");
    expect(error).toContain("unsupportedHostedTools");
  });
});

// #5501: MiMo rejects hosted search before processing even a plain text prompt.
describe("MiMo destination hosted-tool policy", () => {
  for (const baseUrl of [
    "https://api.xiaomimimo.com/v1",
    "https://token-plan-cn.xiaomimimo.com/v1",
    "https://xiaomimimo.com/v1",
    "https://API.XIAOMIMIMO.COM:8443/v1",
  ]) {
    for (const type of ["web_search", "web_search_preview"]) {
      test(`${baseUrl} strips ${type} on the serialized Responses request`, () => {
        const body = build({ tools: [{ type }, functionTool] }, gateway({ baseUrl }));
        expect(body.tools).toEqual([functionTool]);
      });
      test(`${baseUrl} reconciles ${type} selectors and loaded tools`, () => {
        const provider = gateway({ baseUrl });
        expect(stripUnsupportedHostedTools({
          tools: [{ type }], tool_choice: { type },
        }, provider)).toEqual({ tools: [], tool_choice: "none" });
        expect(stripUnsupportedHostedTools({
          input: [{ type: "additional_tools", tools: [{ type }, functionTool] }],
          tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type }, functionTool] },
        }, provider)).toEqual({
          input: [{ type: "additional_tools", tools: [functionTool] }],
          tool_choice: { type: "allowed_tools", mode: "auto", tools: [functionTool] },
        });
      });
    }
  }

  for (const baseUrl of [
    "https://api.openai.com/v1", GATEWAY_BASE_URL,
    "https://xiaomimimo.com.example/v1", "https://notxiaomimimo.com/v1",
    "https://gateway.example/api.xiaomimimo.com/v1",
    "https://gateway.example/?next=api.xiaomimimo.com/v1",
  ]) {
    test(`${baseUrl} preserves hosted search even for a MiMo model`, () => {
      const tools = [{ type: "web_search" }, { type: "web_search_preview" }, functionTool];
      expect(build({ model: "mimo-v2-pro", tools }, gateway({ baseUrl })).tools).toEqual(tools);
    });
  }

  test("missing or invalid URLs do not classify a destination as MiMo", () => {
    for (const baseUrl of [undefined, "", "not a URL"]) {
      expect(isHostedToolUnsupportedForModel("mimo-v2-pro", "web_search", baseUrl)).toBe(false);
    }
  });
});
