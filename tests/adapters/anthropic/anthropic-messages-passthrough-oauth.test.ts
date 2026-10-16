/**
 * The managed native Messages builder for an Anthropic OAuth account (PF-10): the adapter's
 * OAuth header placement, the Claude Code identity block, the OAuth tool-name prefix with its
 * reverse map, and the rule that an OAuth token is sent to `api.anthropic.com` only.
 */
import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { captureAnthropicClientIdentity } from "../../../src/adapters/anthropic/client-identity";
import {
  anthropicMessagesNativeWireBody,
  anthropicOAuthWireBody,
  buildAnthropicMessagesPassthroughRequest,
} from "../../../src/adapters/anthropic/passthrough";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../../src/oauth/anthropic";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const ACCESS = "fixture-oauth-access-token";

function oauthProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "oauth",
    apiKey: ACCESS,
    ...overrides,
  } as OcxProviderConfig;
}

const SOURCE = {
  model: "selector",
  max_tokens: 64,
  stream: true,
  system: "fixture system",
  tools: [
    { name: "lookup", description: "fixture", input_schema: { type: "object", properties: {} } },
    { type: "web_search_20250305", name: "web_search" },
    { type: "bash_20250124", name: "bash" },
  ],
  tool_choice: { type: "tool", name: "lookup" },
  messages: [
    { role: "user", content: "fixture question" },
    { role: "assistant", content: [
      { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
      { type: "tool_use", id: "toolu_2", name: "bash", input: { command: "true" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "fixture result" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "" },
    ] },
  ],
};

// Exact deferred-reference fixture from public #6533 (f7175bfb1e).
const DEFERRED_SOURCE = {
  model: "selector",
  max_tokens: 64,
  stream: true,
  system: "fixture system",
  tools: [
    { name: "lookup", description: "fixture", input_schema: { type: "object", properties: {} } },
    { type: "web_search_20250305", name: "web_search" },
    { type: "bash_20250124", name: "bash" },
  ],
  tool_choice: { type: "tool", name: "lookup" },
  messages: [
    { role: "user", content: "fixture question" },
    { role: "assistant", content: [
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { opaque: { type: "tool_reference", tool_name: "lookup" } } },
      { type: "tool_use", id: "toolu_2", name: "bash", input: { command: "true" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: [
        { type: "text", text: "fixture result", cache_control: { type: "ephemeral", ttl: "1h", scope: "turn" } },
        { type: "tool_reference", tool_name: "lookup" },
      ] },
      { type: "tool_result", tool_use_id: "toolu_2", content: "" },
    ] },
  ],
};

describe("buildAnthropicMessagesPassthroughRequest with OAuth", () => {
  test("places the credential and fingerprint exactly as the adapter does", async () => {
    const built = buildAnthropicMessagesPassthroughRequest(oauthProvider(), "claude-wire", SOURCE);
    expect(built.url).toBe("https://api.anthropic.com/v1/messages");
    expect(built.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(built.headers).not.toHaveProperty("x-api-key");
    expect(built.headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);

    const parsed = {
      modelId: "claude-wire",
      stream: true,
      context: { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
      options: {},
    } as unknown as OcxParsedRequest;
    const adapterRequest = await createAnthropicAdapter(oauthProvider())
      .buildRequest(parsed, { headers: new Headers(), translatorBudget: createTranslatorBudget() });
    const adapterHeaders = adapterRequest.headers as Record<string, string>;
    const perRequest = new Set(["x-client-request-id"]);
    for (const [name, value] of Object.entries(adapterHeaders)) {
      if (name === "Content-Type" || perRequest.has(name)) continue;
      expect(built.headers[name]).toBe(value);
    }
    expect(Object.keys(built.headers).sort()).toEqual(Object.keys(adapterHeaders).sort());
  });

  test("an OAuth token is refused for any destination but api.anthropic.com", () => {
    for (const baseUrl of [
      "https://compatible.example",
      "http://api.anthropic.com",
      "https://api.anthropic.com.example",
      "https://api.anthropic.com:8443",
    ]) {
      expect(() => buildAnthropicMessagesPassthroughRequest(oauthProvider({ baseUrl }), "m", SOURCE))
        .toThrow("only to api.anthropic.com");
    }
    expect(() => buildAnthropicMessagesPassthroughRequest(oauthProvider({ apiKey: "" }), "m", SOURCE))
      .toThrow("oauth token missing");
  });

  test("the body carries the identity block and prefixed client tools; typed tools keep their names", () => {
    const built = buildAnthropicMessagesPassthroughRequest(oauthProvider(), "claude-wire", SOURCE);
    const wire = built.wireBody as Omit<typeof SOURCE, "system"> & { system: unknown[] };
    expect(wire.system).toEqual([
      { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
      { type: "text", text: "fixture system" },
    ]);
    expect(wire.tools.map(tool => tool.name)).toEqual(["custom_lookup", "web_search", "bash"]);
    expect(wire.tool_choice).toEqual({ type: "tool", name: "custom_lookup" });
    const history = wire.messages[1]!.content as { name: string }[];
    expect(history.map(block => block.name)).toEqual(["custom_lookup", "bash"]);
    expect([...built.oauthToolNames!]).toEqual([["custom_lookup", "lookup"]]);
    // The source is untouched.
    expect(SOURCE.tools[0]!.name).toBe("lookup");
    expect(SOURCE.system).toBe("fixture system");
  });

  test("an identity block already present is not repeated", () => {
    const system = [{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION }, { type: "text", text: "more" }];
    expect(anthropicOAuthWireBody({ system, messages: [] }).body.system).toBe(system);
  });

  test("request-local identity selects the same preamble for direct shaping, counting and sending", () => {
    const clientIdentity = captureAnthropicClientIdentity(new Headers({
      "User-Agent": "claude-cli/2.1.288 (external, sdk-cli)",
      "X-App": "cli",
      "X-Claude-Code-Session-Id": "11111111-1111-4111-8111-111111111111",
      "X-Stainless-Lang": "js",
      "X-Stainless-Runtime": "node",
    }));
    expect(clientIdentity).toBeDefined();
    const system = [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.288.fixture; cc_entrypoint=sdk-cli; cch=fixture;" },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." },
      { type: "text", text: "fixture stable prefix", cache_control: { type: "ephemeral", ttl: "1h" } },
    ];
    const source = { ...DEFERRED_SOURCE, system };
    const before = JSON.stringify(source);
    const shaped = anthropicOAuthWireBody(source, clientIdentity);
    const counted = anthropicMessagesNativeWireBody(oauthProvider(), "claude-wire", source, { clientIdentity });
    const built = buildAnthropicMessagesPassthroughRequest(oauthProvider(), "claude-wire", source, undefined, { clientIdentity });
    expect(shaped.body.system).toBe(system);
    expect(counted.wireBody.system).toBe(system);
    expect(built.wireBody.system).toBe(system);
    expect(counted.wireBody).toEqual(built.wireBody);
    expect([...counted.oauthToolNames!]).toEqual([["custom_lookup", "lookup"]]);
    expect([...shaped.toolNames]).toEqual([...counted.oauthToolNames!]);
    expect(JSON.stringify(source)).toBe(before);
    // Omitting the new options keeps the existing synthesized SDK prefix.
    const generic = anthropicMessagesNativeWireBody(oauthProvider(), "m", source);
    expect(generic.wireBody.system).toEqual([{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION }, ...system]);
    // Even a captured handle cannot select first-party behavior for a compatible destination.
    const foreign = anthropicMessagesNativeWireBody(oauthProvider({ baseUrl: "https://compatible.example" }), "m", source, { clientIdentity });
    expect(foreign.wireBody.system).toEqual(generic.wireBody.system);
    const key = anthropicMessagesNativeWireBody(oauthProvider({ authMode: "key" }), "m", source, { clientIdentity });
    expect(key.wireBody.system).toBe(system);
    expect(key.wireBody.messages).toBe(source.messages);
    expect(key.oauthToolNames).toBeUndefined();
  });

  test("two caller names that meet under the prefix are refused", () => {
    const body = { messages: [], tools: [
      { name: "lookup", input_schema: { type: "object" } },
      { name: "custom_lookup", input_schema: { type: "object" } },
    ] };
    expect(() => anthropicOAuthWireBody(body)).toThrow("collide");
  });

  // Inline-name regressions from #6534/#6547 (e3eefbaedf).
  test("renames inline tool additions before references and removals without mutating source or cache metadata", () => {
    const body = {
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "assistant", content: [
        { type: "tool_addition", tool: { type: "tool_reference", name: "ReadNotifications" }, cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "tool_addition", tool: { type: "tool_definition", definition: {
          name: "ReadNotifications", input_schema: { type: "object", properties: { q: { type: "string" } } },
        } } },
        { type: "tool_removal", tool: { type: "tool_reference", name: "ReadNotifications" } },
        { type: "tool_addition", tool: { type: "tool_reference", name: "lookup" } },
        { type: "tool_removal", tool: { type: "tool_reference", name: "lookup" } },
        { type: "text", text: "keep cache", cache_control: { type: "ephemeral", ttl: "1h", scope: "turn" } },
      ] }],
    };
    const original = structuredClone(body);
    const shaped = anthropicOAuthWireBody(body);
    const blocks = (shaped.body.messages as { content: Record<string, unknown>[] }[])[0]!.content;
    expect((blocks[0]!.tool as Record<string, unknown>).name).toBe("custom_ReadNotifications");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect((((blocks[1]!.tool as Record<string, unknown>).definition as Record<string, unknown>).name)).toBe("custom_ReadNotifications");
    expect((blocks[2]!.tool as Record<string, unknown>).name).toBe("custom_ReadNotifications");
    expect((blocks[3]!.tool as Record<string, unknown>).name).toBe("custom_lookup");
    expect((blocks[4]!.tool as Record<string, unknown>).name).toBe("custom_lookup");
    expect(blocks[5]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h", scope: "turn" });
    expect([...shaped.toolNames]).toEqual([
      ["custom_lookup", "lookup"],
      ["custom_ReadNotifications", "ReadNotifications"],
    ]);
    expect(body).toEqual(original);
  });

  test("typed inline builtin definitions and their references keep their fixed names", () => {
    const definition = { type: "bash_20250124", name: "bash", input_schema: { properties: { scope: { type: "string" } } } };
    const content = [{ type: "tool_addition", tool: { type: "tool_definition", definition } },
      { type: "tool_removal", tool: { type: "tool_reference", name: "bash" } }];
    const source = { ...SOURCE, tools: [], messages: [{ role: "system", content }] };
    const built = buildAnthropicMessagesPassthroughRequest(oauthProvider(), "m", source);
    expect(built.wireBody.messages).toEqual(source.messages);
    expect(built.oauthToolNames?.size).toBe(0);
    const collision = { ...source, tools: [{ name: "bash", input_schema: {} }] };
    expect(() => buildAnthropicMessagesPassthroughRequest(oauthProvider(), "m", collision)).toThrow("inline typed and client tool names collide");
    expect(definition.name).toBe("bash");
  });

  test("a key-auth provider gets no OAuth shaping", () => {
    const shaped = anthropicMessagesNativeWireBody({ baseUrl: "https://api.anthropic.com", authMode: "key" }, "m", SOURCE);
    expect(shaped.oauthToolNames).toBeUndefined();
    expect(shaped.wireBody.system).toBe("fixture system");
  });
});

describe("native OAuth typed tool-name preservation", () => {
  test("#6533 nested reference fixture preserves opaque input and cache metadata", () => {
    const before = JSON.stringify(DEFERRED_SOURCE);
    const shaped = anthropicOAuthWireBody(DEFERRED_SOURCE);
    const messages = shaped.body.messages as typeof DEFERRED_SOURCE.messages;
    const content = messages[2]!.content as { content: unknown[] }[];
    expect(content[0]!.content).toEqual([
      { type: "text", text: "fixture result", cache_control: { type: "ephemeral", ttl: "1h", scope: "turn" } },
      { type: "tool_reference", tool_name: "custom_lookup" },
    ]);
    const uses = messages[1]!.content as { input: unknown }[];
    expect(uses[0]!.input).toBe((DEFERRED_SOURCE.messages[1]!.content as { input: unknown }[])[0]!.input);
    expect([...shaped.toolNames]).toEqual([["custom_lookup", "lookup"]]);
    expect(JSON.stringify(DEFERRED_SOURCE)).toBe(before);
  });

  test("collects later cross-message inline declarations before choices, uses and references", () => {
    const source = { tool_choice: { type: "tool", name: "later" }, messages: [
      { role: "assistant", content: [
        { type: "tool_use", name: "later", id: "toolu_later", input: {} },
        { type: "tool_reference", tool_name: "later" },
        { type: "tool_removal", tool: { type: "tool_reference", name: "later" } },
      ] },
      { role: "user", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: {
        type: "custom", name: "later", input_schema: { type: "object" },
      } } }] },
    ] };
    const before = JSON.stringify(source);
    const shaped = anthropicOAuthWireBody(source);
    expect(shaped.body.tool_choice).toEqual({ type: "tool", name: "custom_later" });
    expect(shaped.body.messages).toEqual([
      { role: "assistant", content: [
        { type: "tool_use", name: "custom_later", id: "toolu_later", input: {} },
        { type: "tool_reference", tool_name: "custom_later" },
        { type: "tool_removal", tool: { type: "tool_reference", name: "custom_later" } },
      ] },
      { role: "user", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: {
        type: "custom", name: "custom_later", input_schema: { type: "object" },
      } } }] },
    ]);
    expect([...shaped.toolNames]).toEqual([["custom_later", "later"]]);
    expect(JSON.stringify(source)).toBe(before);
  });

  test("collects and maps declarations through the same nested tool-result containers", () => {
    const content = [
      { type: "tool_reference", tool_name: "nested" },
      { type: "tool_result", tool_use_id: "toolu_outer", content: [
        { type: "tool_result", tool_use_id: "toolu_inner", content: [
          { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "nested", input_schema: {} } } },
          { type: "tool_use", name: "nested", input: {} },
          { type: "tool_removal", tool: { type: "tool_reference", name: "nested" } },
        ] },
      ] },
    ];
    const before = JSON.stringify(content);
    const shaped = anthropicOAuthWireBody({ messages: [{ role: "user", content }] });
    expect(shaped.body.messages).toEqual([{ role: "user", content: [
      { type: "tool_reference", tool_name: "custom_nested" },
      { type: "tool_result", tool_use_id: "toolu_outer", content: [
        { type: "tool_result", tool_use_id: "toolu_inner", content: [
          { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "custom_nested", input_schema: {} } } },
          { type: "tool_use", name: "custom_nested", input: {} },
          { type: "tool_removal", tool: { type: "tool_reference", name: "custom_nested" } },
        ] },
      ] },
    ] }]);
    expect(JSON.stringify(content)).toBe(before);
  });

  for (const kind of ["original", "wire"] as const) {
    for (const typedInline of [false, true]) {
      for (const clientInline of [false, true]) {
        for (const reverse of [false, true]) {
          test(`rejects ${kind} collision: typed inline=${typedInline}, client inline=${clientInline}, reverse=${reverse}`, () => {
            const client = { name: "lookup", input_schema: {} };
            const typed = { type: "bash_20250124", name: kind === "original" ? "lookup" : "custom_lookup" };
            const entries = [
              { inline: clientInline, definition: client },
              { inline: typedInline, definition: typed },
            ];
            if (reverse) entries.reverse();
            const source = {
              tools: entries.filter(e => !e.inline).map(e => e.definition),
              messages: [{ role: "user", content: entries.filter(e => e.inline).map(e => ({
                type: "tool_addition", tool: { type: "tool_definition", definition: e.definition },
              })) }],
            };
            const before = JSON.stringify(source);
            expect(() => anthropicOAuthWireBody(source)).toThrow("collide");
            expect(JSON.stringify(source)).toBe(before);
          });
        }
      }
    }
  }

  for (const reverse of [false, true]) {
    test(`registers unused inline client names for prefix collisions: reverse=${reverse}`, () => {
      const names = reverse ? ["custom_lookup", "lookup"] : ["lookup", "custom_lookup"];
      const source = { messages: names.map(name => ({ role: "user", content: [{
        type: "tool_addition", tool: { type: "tool_definition", definition: { name, input_schema: {} } },
      }] })) };
      expect(() => anthropicOAuthWireBody(source)).toThrow("collide");
    });
  }

  test("nested typed declarations also reject original and wire collisions", () => {
    for (const name of ["lookup", "custom_lookup"]) {
      const source = { tools: [{ name: "lookup", input_schema: {} }], messages: [{ role: "user", content: [{
        type: "tool_result", tool_use_id: "toolu_outer", content: [{
          type: "tool_addition", tool: { type: "tool_definition", definition: { type: "bash_20250124", name } },
        }],
      }] }] };
      expect(() => anthropicOAuthWireBody(source)).toThrow("collide");
    }
  });

  test("typed and undeclared uses, references and inline references retain identity", () => {
    const content = ["bash", "missing"].flatMap(name => [
      { type: "tool_use", name, input: {} },
      { type: "tool_reference", tool_name: name },
      { type: "tool_addition", tool: { type: "tool_reference", name } },
      { type: "tool_removal", tool: { type: "tool_reference", name } },
    ]);
    const tools = [{ type: "bash_20250124", name: "bash" }];
    const messages = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content }] }];
    const tool_choice = { type: "tool", name: "bash" };
    const shaped = anthropicOAuthWireBody({ tools, messages, tool_choice });
    expect(shaped.body.messages).toBe(messages);
    expect(shaped.body.tools).toBe(tools);
    expect(shaped.body.tool_choice).toBe(tool_choice);
    expect(shaped.toolNames.size).toBe(0);
  });

  test("keeps schemas, arguments, unknown containers and cache markers opaque with copy-on-write", () => {
    const hidden = { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "hidden", input_schema: {} } } };
    const payload = { type: "tool_reference", tool_name: "lookup", content: [hidden] };
    const cache = { type: "ephemeral", ttl: "1h", scope: "turn" };
    const schema = { type: "object", properties: { value: { const: payload } }, content: [hidden] };
    const unknown = { type: "future_container", content: [payload, hidden] };
    const text = { type: "text", text: "literal lookup", cache_control: cache, content: [hidden] };
    const use = { type: "tool_use", name: "lookup", input: payload, content: [hidden], cache_control: cache };
    const definition = { name: "inline", input_schema: schema, cache_control: cache };
    const addition = { type: "tool_addition", tool: { type: "tool_definition", definition, content: [hidden] }, cache_control: cache };
    const nested = { type: "tool_result", tool_use_id: "toolu_1", content: [use, unknown, text], cache_control: cache };
    const content = [nested, addition, { type: "tool_reference", tool_name: "hidden" }];
    const untouched = { role: "user", content: "unchanged" };
    const source = { tools: [{ name: "lookup", input_schema: schema, cache_control: cache }], messages: [{ role: "user", content }, untouched] };
    const before = JSON.stringify(source);
    const shaped = anthropicOAuthWireBody(source);
    const messages = shaped.body.messages as { content: Record<string, unknown>[] }[];
    const blocks = messages[0]!.content;
    const inner = blocks[0]!.content as Record<string, unknown>[];
    expect(inner[0]!.name).toBe("custom_lookup");
    expect(inner[0]!.input).toBe(payload);
    expect(inner[0]!.content).toBe(use.content);
    expect(inner[1]).toBe(unknown);
    expect(inner[2]).toBe(text);
    expect(blocks[2]).toBe(content[2]);
    expect(messages[1]).toBe(untouched);
    expect(blocks[0]!.cache_control).toBe(cache);
    expect(inner[0]!.cache_control).toBe(cache);
    const wireTool = (shaped.body.tools as Record<string, unknown>[])[0]!;
    expect(wireTool.input_schema).toBe(schema);
    expect(wireTool.cache_control).toBe(cache);
    const wireInline = blocks[1]!.tool as Record<string, unknown>;
    expect(wireInline.content).toBe(addition.tool.content);
    expect((wireInline.definition as Record<string, unknown>).input_schema).toBe(schema);
    expect((wireInline.definition as Record<string, unknown>).cache_control).toBe(cache);
    expect(blocks[1]!.cache_control).toBe(cache);
    expect([...shaped.toolNames]).toEqual([["custom_lookup", "lookup"], ["custom_inline", "inline"]]);
    expect(JSON.stringify(source)).toBe(before);
  });

  test("already-prefixed client declarations and histories require no copies", () => {
    const tools = [{ type: "custom", name: "custom_lookup", input_schema: {} }];
    const messages = [{ role: "assistant", content: [{ type: "tool_use", name: "custom_lookup", input: {} }] }];
    const shaped = anthropicOAuthWireBody({ tools, messages });
    expect(shaped.body.tools).toBe(tools);
    expect(shaped.body.messages).toBe(messages);
    expect(shaped.toolNames.size).toBe(0);
  });

  test("key auth preserves the exact deferred and inline source histories", () => {
    const source = { ...DEFERRED_SOURCE, messages: [...DEFERRED_SOURCE.messages, { role: "user", content: [{
      type: "tool_addition", tool: { type: "tool_definition", definition: { name: "later", input_schema: {} } },
    }] }] };
    const shaped = anthropicMessagesNativeWireBody({ baseUrl: "https://api.anthropic.com", authMode: "key" }, "m", source);
    expect(shaped.wireBody.messages).toBe(source.messages);
    expect(shaped.wireBody.tools).toBe(source.tools);
    expect(shaped.oauthToolNames).toBeUndefined();
  });
});

// Complete root builder contract, independent of the later native-client compatibility layer.
describe("inline tool feature beta at the native builder boundary", () => {
  const beta = "inline-tools-2026-09-15";
  const definition = { type: "tool_addition", tool: { type: "tool_definition", definition: {
    name: "lookup", input_schema: { type: "object" },
  } }, cache_control: { type: "ephemeral", ttl: "1h" } };
  const request = (block: unknown) => ({ max_tokens: 64, tools: [{ name: "initial", input_schema: {} }],
    messages: [{ role: "user", content: "fixture" }, { role: "system", content: [block] }] });

  test("forwards the required requested beta with an inline definition and OAuth names", () => {
    const body = request(definition);
    const before = structuredClone(body);
    const built = buildAnthropicMessagesPassthroughRequest(oauthProvider(), "claude-wire", body, undefined,
      { callerAnthropicBeta: `${beta.toUpperCase()},${beta}` });
    expect(built.headers["anthropic-beta"]).toBe(`${ANTHROPIC_OAUTH_BETA},${beta}`);
    expect(built.droppedBetas).toBe(false);
    const content = (built.wireBody.messages as typeof body.messages)[1]!.content as typeof definition[];
    expect(content[0]!.tool.definition.name).toBe("custom_lookup");
    expect(JSON.parse(built.body)).toEqual(built.wireBody);
    expect(content[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(built.oauthToolNames?.get("custom_lookup")).toBe("lookup");
    expect(body).toEqual(before);
  });

  for (const type of ["tool_addition", "tool_removal"]) test(`forwards the beta for ${type} references`, () => {
    const body = request({ type, tool: { type: "tool_reference", name: "initial" } });
    const built = buildAnthropicMessagesPassthroughRequest(oauthProvider(), "m", body, undefined,
      { callerAnthropicBeta: beta });
    expect(built.headers["anthropic-beta"]).toBe(`${ANTHROPIC_OAUTH_BETA},${beta}`);
    expect(built.droppedBetas).toBe(false);
  });

  test("does not synthesize betas and still drops unknown or oversized caller headers", () => {
    const body = request(definition);
    expect(buildAnthropicMessagesPassthroughRequest(oauthProvider(), "m", body).headers["anthropic-beta"])
      .toBe(ANTHROPIC_OAUTH_BETA);
    const built = buildAnthropicMessagesPassthroughRequest(oauthProvider(), "m", body, undefined,
      { callerAnthropicBeta: `${beta},unknown-feature` });
    expect(built.headers["anthropic-beta"]).toBe(`${ANTHROPIC_OAUTH_BETA},${beta}`);
    expect(built.droppedBetas).toBe(true);
    expect(buildAnthropicMessagesPassthroughRequest(oauthProvider(), "m", body, undefined,
      { callerAnthropicBeta: `${beta},${"x".repeat(2048)}` }).headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
  });

  test("key auth gets the feature beta only on a first-party destination", () => {
    const first = buildAnthropicMessagesPassthroughRequest(oauthProvider({ authMode: "key" }), "m", request(definition), undefined,
      { callerAnthropicBeta: beta });
    expect(first.headers["anthropic-beta"]).toBe(beta);
    const compatible = buildAnthropicMessagesPassthroughRequest(oauthProvider({ authMode: "key", baseUrl: "https://compatible.example" }), "m", request(definition), undefined,
      { callerAnthropicBeta: beta });
    expect(compatible.headers).not.toHaveProperty("anthropic-beta");
    expect(compatible.droppedBetas).toBe(true);
  });

  test("opaque lookalikes and unsupported placement do not enable beta forwarding", () => {
    for (const body of [SOURCE, request({ type: "text", text: JSON.stringify(definition) }),
      request({ type: "tool_use", name: "initial", input: definition }),
      request({ type: "unknown", content: [definition] }),
      request({ type: "tool_addition", tool: { type: "tool_definition", definition: null } }),
      request({ type: "tool_removal", tool: { type: "tool_definition", definition: { name: "lookup" } } }),
      request({ type: "tool_result", content: [definition] }),
      { ...request(definition), messages: [{ role: "assistant", content: [definition] }] },
      { ...SOURCE, tools: [{ name: "initial", input_schema: definition }] }]) {
      const built = buildAnthropicMessagesPassthroughRequest(oauthProvider(), "m", body, undefined,
        { callerAnthropicBeta: beta });
      expect(built.headers["anthropic-beta"]).toBe(ANTHROPIC_OAUTH_BETA);
      expect(built.droppedBetas).toBe(true);
    }
  });
});
