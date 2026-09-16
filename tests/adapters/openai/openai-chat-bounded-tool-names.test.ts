import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { createOpenAIChatToolNameRegistry } from "../../../src/adapters/openai-chat/tool-name-registry";
import { compileGoogleWireBody } from "../../../src/adapters/google-wire-compiler";
import { kiroToolName } from "../../../src/adapters/kiro-wire";
import { buildResponseJSON } from "../../../src/bridge";
import { parseRequest } from "../../../src/responses/parser";
import { buildToolBridgeMaps } from "../../../src/server/responses";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../../src/types";
import { namespacedToolName } from "../../../src/types/tools";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const LONG_NAMESPACE = "mcp__codex_apps__codex_document_control";
const REPORTED_NAME = "execute_document_command";
const OTHER_LONG_NAME = "get_document_tool_schemas";

function provider(): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    authMode: "key",
  };
}

function tool(namespace: string | undefined, name: string): OcxTool {
  return { namespace, name, description: "Test tool", parameters: { type: "object" } };
}

function parsedWith(
  tools: OcxTool[],
  options: OcxParsedRequest["options"] = {},
  messages: OcxParsedRequest["context"]["messages"] = [{ role: "user", content: "Use the tool", timestamp: 0 }],
): OcxParsedRequest {
  return { modelId: "test-model", stream: false, options, context: { tools, messages } };
}

describe("bounded OpenAI Chat tool wire names (#4679)", () => {
  test("bounds and restores the exact reported identity across request, replay, tool_choice, and response", async () => {
    const declared = tool(LONG_NAMESPACE, REPORTED_NAME);
    const originalWireName = namespacedToolName(LONG_NAMESPACE, REPORTED_NAME);
    const replayMessages: OcxParsedRequest["context"]["messages"] = [
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_replay",
          namespace: LONG_NAMESPACE,
          name: REPORTED_NAME,
          arguments: {},
        }],
        timestamp: 0,
      },
      { role: "toolResult", toolCallId: "call_replay", toolName: REPORTED_NAME, content: "ok", timestamp: 1 },
      { role: "user", content: "Run it again", timestamp: 2 },
    ];
    const parsed = parsedWith([declared], { toolChoice: { name: REPORTED_NAME } }, replayMessages);
    const adapter = createOpenAIChatAdapter(provider());
    const request = adapter.buildRequest(parsed, {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    });
    if (request instanceof Promise) throw new Error("OpenAI Chat request unexpectedly became async");
    const body = JSON.parse(request.body) as {
      tools: Array<{ function: { name: string } }>;
      messages: Array<{ tool_calls?: Array<{ function: { name: string } }> }>;
      tool_choice: { function: { name: string } };
    };
    const alias = body.tools[0].function.name;

    expect(new TextEncoder().encode(originalWireName).byteLength).toBeGreaterThan(64);
    expect(alias).not.toBe(originalWireName);
    expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(new TextEncoder().encode(alias).byteLength).toBeLessThanOrEqual(64);
    expect(body.messages.find(message => message.tool_calls)?.tool_calls?.[0].function.name).toBe(alias);
    expect(body.tool_choice.function.name).toBe(alias);

    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      choices: [{
        message: { tool_calls: [{ id: "call_echo", function: { name: alias, arguments: "{}" } }] },
        finish_reason: "tool_calls",
      }],
    })), createTestTranslatorBudget());
    expect(events.find(event => event.type === "tool_call_start")).toMatchObject({
      type: "tool_call_start",
      id: "call_echo",
      name: originalWireName,
    });

    const streamed: AdapterEvent[] = [];
    const streamBody = `data: ${JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: "call_stream", function: { name: alias, arguments: "{}" } }] },
        finish_reason: "tool_calls",
      }],
    })}\n\ndata: [DONE]\n\n`;
    for await (const event of adapter.parseStream(
      new Response(streamBody),
      createTestTranslatorBudget(),
    )) streamed.push(event);
    expect(streamed.find(event => event.type === "tool_call_start")).toMatchObject({
      type: "tool_call_start",
      id: "call_stream",
      name: originalWireName,
    });

    const responseRequest = parseRequest({
      model: "test-model",
      input: "Use the tool",
      tools: [{
        type: "namespace",
        name: LONG_NAMESPACE,
        tools: [{ type: "function", name: REPORTED_NAME, parameters: { type: "object" } }],
      }],
    });
    const maps = buildToolBridgeMaps(responseRequest);
    const bridged = buildResponseJSON(events, "test-model", maps);
    const call = (bridged.output as Record<string, unknown>[])[0];
    if (!call) throw new Error("Expected a bridged function call");
    expect(call).toMatchObject({
      type: "function_call",
      namespace: LONG_NAMESPACE,
      name: REPORTED_NAME,
    });

    const replayed = parseRequest({
      model: "test-model",
      tools: [{
        type: "namespace",
        name: LONG_NAMESPACE,
        tools: [{ type: "function", name: REPORTED_NAME, parameters: { type: "object" } }],
      }],
      input: [call],
    });
    const replayedCall = replayed.context.messages
      .flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(part => part.type === "toolCall");
    expect(replayedCall).toMatchObject({ namespace: LONG_NAMESPACE, name: REPORTED_NAME });
  });

  test("leaves names at or under 64 characters and ordinary bare names byte-identical", () => {
    const exactly64 = tool("n".repeat(30), "x".repeat(32));
    const ordinary = tool("mcp__short", "read");
    const longBare = tool(undefined, "b".repeat(200));
    const registry = createOpenAIChatToolNameRegistry([exactly64, ordinary, longBare]);

    expect(new TextEncoder().encode(namespacedToolName(exactly64.namespace, exactly64.name)).byteLength).toBe(64);
    expect(registry.alias(exactly64)).toBe(namespacedToolName(exactly64.namespace, exactly64.name));
    expect(registry.alias(ordinary)).toBe(namespacedToolName(ordinary.namespace, ordinary.name));
    expect(registry.alias(longBare)).toBe(longBare.name);
    expect(namespacedToolName(undefined, longBare.name)).toBe(longBare.name);

    const adapter = createOpenAIChatAdapter(provider());
    const request = adapter.buildRequest(parsedWith([exactly64, ordinary, longBare]), {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    });
    if (request instanceof Promise) throw new Error("OpenAI Chat request unexpectedly became async");
    const body = JSON.parse(request.body) as { tools: Array<{ function: { name: string } }> };
    expect(body.tools.map(entry => entry.function.name)).toEqual([
      namespacedToolName(exactly64.namespace, exactly64.name),
      namespacedToolName(ordinary.namespace, ordinary.name),
      longBare.name,
    ]);
  });

  test("bounds and restores a replay-only historical call absent from the current catalog", async () => {
    const originalWireName = namespacedToolName(LONG_NAMESPACE, REPORTED_NAME);
    const replayed = parseRequest({
      model: "test-model",
      tools: [],
      input: [
        {
          type: "function_call",
          call_id: "call_historical",
          namespace: LONG_NAMESPACE,
          name: REPORTED_NAME,
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_historical", output: "ok" },
        { role: "user", content: "Continue" },
      ],
    });
    expect(replayed.context.tools ?? []).toHaveLength(0);

    const adapter = createOpenAIChatAdapter(provider());
    const request = adapter.buildRequest(replayed, {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    });
    if (request instanceof Promise) throw new Error("OpenAI Chat request unexpectedly became async");
    const body = JSON.parse(request.body) as {
      tools?: unknown;
      messages: Array<{ tool_calls?: Array<{ function: { name: string } }> }>;
    };
    const alias = body.messages.find(message => message.tool_calls)?.tool_calls?.[0].function.name;
    if (!alias) throw new Error("Expected the historical tool call on replay");

    expect(body.tools).toBeUndefined();
    expect(alias).not.toBe(originalWireName);
    expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);

    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      choices: [{
        message: { tool_calls: [{ id: "call_echo", function: { name: alias, arguments: "{}" } }] },
        finish_reason: "tool_calls",
      }],
    })), createTestTranslatorBudget());
    expect(events.find(event => event.type === "tool_call_start")).toMatchObject({
      type: "tool_call_start",
      name: originalWireName,
    });
  });

  test("derives deterministic distinct aliases independent of catalog order", () => {
    const catalog = [
      tool(LONG_NAMESPACE, REPORTED_NAME),
      tool(LONG_NAMESPACE, OTHER_LONG_NAME),
      tool(`${LONG_NAMESPACE}_other`, REPORTED_NAME),
    ];
    const forward = createOpenAIChatToolNameRegistry(catalog);
    const reverse = createOpenAIChatToolNameRegistry([...catalog].reverse());
    const forwardAliases = catalog.map(entry => forward.alias(entry));

    expect(catalog.map(entry => reverse.alias(entry))).toEqual(forwardAliases);
    expect(new Set(forwardAliases).size).toBe(catalog.length);
    for (const alias of forwardAliases) expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);

    const longTool = catalog[0]!;
    const identityAlias = createOpenAIChatToolNameRegistry([longTool]).alias(longTool);
    const aliasShapedBareTool = tool(undefined, identityAlias);
    const collisionCatalog = [longTool, aliasShapedBareTool];
    const collisionRegistry = createOpenAIChatToolNameRegistry(collisionCatalog);
    const reversedCollisionRegistry = createOpenAIChatToolNameRegistry([...collisionCatalog].reverse());
    const reservedNameAlias = collisionRegistry.alias(aliasShapedBareTool);
    expect(collisionRegistry.alias(longTool)).toBe(identityAlias);
    expect(reversedCollisionRegistry.alias(longTool)).toBe(identityAlias);
    expect(reservedNameAlias).not.toBe(identityAlias);
    expect(reservedNameAlias).toMatch(/^ocx_[a-zA-Z0-9_-]{16}_[a-zA-Z0-9_-]{43}$/);
    expect(collisionRegistry.restore(reservedNameAlias)).toBe(identityAlias);
  });

  test("aliases colliding identities but leaves their ambiguous replay spelling unchanged", () => {
    const first = tool("a__b", "c");
    const second = tool("a", "b__c");
    const flattened = namespacedToolName(first.namespace, first.name);
    expect(namespacedToolName(second.namespace, second.name)).toBe(flattened);

    const registry = createOpenAIChatToolNameRegistry([first, second]);
    const reversed = createOpenAIChatToolNameRegistry([second, first]);
    const firstAlias = registry.alias(first);
    const secondAlias = registry.alias(second);
    expect(firstAlias).not.toBe(flattened);
    expect(secondAlias).not.toBe(flattened);
    expect(firstAlias).not.toBe(secondAlias);
    expect(reversed.alias(first)).toBe(firstAlias);
    expect(reversed.alias(second)).toBe(secondAlias);
    expect(registry.aliasWireName(flattened)).toBe(flattened);

    const adapter = createOpenAIChatAdapter(provider());
    const request = adapter.buildRequest(parsedWith([first, second], {}, [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_ambiguous", namespace: first.namespace, name: first.name, arguments: {} }],
        timestamp: 0,
      },
      { role: "user", content: "Continue", timestamp: 1 },
    ]), {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    });
    if (request instanceof Promise) throw new Error("OpenAI Chat request unexpectedly became async");
    const body = JSON.parse(request.body) as {
      tools: Array<{ function: { name: string } }>;
      messages: Array<{ tool_calls?: Array<{ function: { name: string } }> }>;
    };
    expect(body.tools.map(entry => entry.function.name)).toEqual([firstAlias, secondAlias]);
    expect(body.messages.find(message => message.tool_calls)?.tool_calls?.[0].function.name).toBe(flattened);
  });

  test("keeps shared naming untouched so Kiro and Google retain adapter-owned normalization", () => {
    const original = namespacedToolName(LONG_NAMESPACE, REPORTED_NAME);
    expect(original).toBe(`${LONG_NAMESPACE}__${REPORTED_NAME}`);
    expect(new TextEncoder().encode(original).byteLength).toBeGreaterThan(64);

    const kiro = kiroToolName(original);
    expect(kiro).not.toBe(original);
    expect(kiro).toMatch(/_[0-9a-f]{8}$/);
    expect(kiro.length).toBeLessThanOrEqual(64);

    const google = compileGoogleWireBody({
      tools: [{ functionDeclarations: [{ name: original, parameters: { type: "object" } }] }],
    });
    const googleName = (google.body.tools as Array<{
      functionDeclarations: Array<{ name: string }>;
    }>)[0].functionDeclarations[0].name;
    expect(googleName).not.toBe(original);
    expect(googleName).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
    expect(google.restoreToolName(googleName)).toBe(original);
  });
});
