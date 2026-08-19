import { describe, expect, test } from "bun:test";
import {
  adapterDefinitions,
  createRegisteredAdapter,
  effectiveAdapterContract,
  getAdapterDefinition,
  type AdapterWire,
} from "../src/adapters/registry";
import { resetMimoJwtCache } from "../src/adapters/mimo-free";
import { bridgeToResponsesSSE } from "../src/bridge";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { parseRequest } from "../src/responses/parser";
import { buildToolBridgeMaps } from "../src/server/responses";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED, type OcxParsedRequest, type OcxProviderConfig } from "../src/types";
import { TOOL_WIRE_DRIVERS } from "./helpers/adapter-conformance/wire-drivers";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const PATCH = `*** Begin Patch
*** Add File: conformance-안녕.txt
+quote: "double"
+slash: \\ path
+unicode: 世界
*** End Patch`;

const EXEC_DESCRIPTION =
  "Run JavaScript. declare const tools: { apply_patch(input: string): Promise<unknown>; };";

const WIRE_MODELS: Record<AdapterWire, string> = {
  "openai-chat": "grok-4.6",
  anthropic: "claude-haiku-4-5",
  google: "gemini-3.5-flash",
  "command-code": "deepseek/deepseek-v4-flash",
  kiro: "claude-sonnet-4.5",
  "openai-responses": "deepseek-v4-flash",
  cursor: "cursor/auto",
};

function providerFixture(adapterId: string, wire: AdapterWire): OcxProviderConfig {
  const baseUrls: Record<AdapterWire, string> = {
    "openai-chat": "https://api.x.ai/v1",
    anthropic: "https://api.anthropic.com",
    google: "https://generativelanguage.googleapis.com",
    "command-code": "https://api.commandcode.ai",
    kiro: "https://runtime.us-east-1.kiro.dev",
    "openai-responses": "https://api.deepseek.com",
    cursor: "https://api2.cursor.sh",
  };
  // Semantic wrappers with provider-specific URL shapes must override the wire-family default here.
  const baseUrl = adapterId === "mimo-free"
    ? "https://api.xiaomimimo.com/api/free-ai/openai/chat"
    : adapterId === "azure" || adapterId === "azure-openai"
      ? "https://example.openai.azure.com/openai/v1"
      : baseUrls[wire];
  return {
    adapter: adapterId,
    baseUrl,
    authMode: wire === "anthropic" || wire === "command-code" ? "oauth" : "key",
    apiKey: wire === "kiro" ? "ksk_test" : "test-key",
    defaultMaxOutputTokens: 64_000,
    googleMode: "ai-studio",
    ...(wire === "openai-responses" ? { responsesPath: "/responses" } : {}),
  } satisfies OcxProviderConfig;
}

function prepareForWire(parsed: OcxParsedRequest, wire: AdapterWire): OcxParsedRequest {
  if (wire !== "kiro") return parsed;
  return { ...parsed, _kiroAuthContext: { apiRegion: "us-east-1" } };
}

function codeModeParsed(wire: AdapterWire): OcxParsedRequest {
  const model = WIRE_MODELS[wire];
  return prepareForWire(parseRequest({
    model,
    instructions: "Use apply_patch for local file edits.",
    input: "Patch the requested file.",
    stream: true,
    tools: [
      {
        type: "custom",
        name: "exec",
        description: EXEC_DESCRIPTION,
        format: { type: "grammar", syntax: "lark" },
      },
      {
        type: "function",
        name: "wait",
        description: "Wait for work.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  }), wire);
}

function freeformParsed(wire: AdapterWire): OcxParsedRequest {
  return prepareForWire(parseRequest({
    model: WIRE_MODELS[wire],
    input: "Apply the exact patch.",
    stream: true,
    tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
  }), wire);
}

function namespacedCollisionParsed(wire: AdapterWire): OcxParsedRequest {
  return prepareForWire(parseRequest({
    model: WIRE_MODELS[wire],
    input: "Run the requested tool.",
    stream: true,
    tools: [
      {
        type: "namespace",
        name: "mcp__custom",
        tools: [{ type: "custom", name: "exec", description: "Freeform execution." }],
      },
      {
        type: "namespace",
        name: "mcp__remote",
        tools: [{ type: "function", name: "exec", description: "Structured execution.", parameters: { type: "object", properties: {} } }],
      },
    ],
  }), wire);
}

function toolChoiceParsed(wire: AdapterWire, toolChoice?: "none"): OcxParsedRequest {
  return prepareForWire(parseRequest({
    model: WIRE_MODELS[wire],
    input: "Do not call a tool.",
    stream: true,
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    tools: [
      { type: "custom", name: "apply_patch", description: "Apply a patch" },
      {
        type: "function",
        name: "noop",
        description: "No operation",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  }), wire);
}

function continuationParsed(wire: AdapterWire): OcxParsedRequest {
  return prepareForWire(parseRequest({
    model: WIRE_MODELS[wire],
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Apply the patch exactly." }],
      },
      {
        type: "custom_tool_call",
        id: "ctc_patch",
        call_id: "call_continue_patch",
        name: "apply_patch",
        input: PATCH,
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_continue_patch",
        output: "Done!",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue after patch." }],
      },
    ],
    stream: true,
    tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
  }), wire);
}

async function withMimoBootstrap<T>(adapterId: string, run: () => Promise<T>): Promise<T> {
  if (adapterId !== "mimo-free") return await run();
  const originalFetch = globalThis.fetch;
  resetMimoJwtCache();
  let bootstrapCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url !== "https://api.xiaomimimo.com/api/free-ai/bootstrap") {
      throw new Error(`mimo-free conformance made an unexpected request: ${url}`);
    }
    bootstrapCalls++;
    return new Response(JSON.stringify({
      jwt: "e30.eyJleHAiOjQxMDI0NDQ4MDB9.x",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await run();
    if (bootstrapCalls !== 1) {
      throw new Error(`expected one MiMo bootstrap request, got ${bootstrapCalls}`);
    }
    return result;
  } finally {
    globalThis.fetch = originalFetch;
    resetMimoJwtCache();
  }
}

async function outbound(adapterId: string, parsed: OcxParsedRequest): Promise<string> {
  const contract = effectiveAdapterContract(adapterId);
  const adapter = createRegisteredAdapter(providerFixture(adapterId, contract.wire));
  return await withMimoBootstrap(adapterId, () => TOOL_WIRE_DRIVERS[contract.wire].observeOutbound(adapter, parsed));
}

function advertisedToolNames(wire: AdapterWire, body: string): string[] {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (wire === "openai-chat") {
    const tools = parsed.tools as Array<{ function?: { name?: string } }> | undefined;
    return (tools ?? []).flatMap(tool => typeof tool.function?.name === "string" ? [tool.function.name] : []);
  }
  if (wire === "anthropic" || wire === "openai-responses" || wire === "cursor") {
    const tools = parsed.tools as Array<{ name?: string }> | undefined;
    return (tools ?? []).flatMap(tool => typeof tool.name === "string" ? [tool.name] : []);
  }
  if (wire === "google") {
    const tools = parsed.tools as Array<{ functionDeclarations?: Array<{ name?: string }> }> | undefined;
    return (tools ?? []).flatMap(group =>
      (group.functionDeclarations ?? []).flatMap(tool => typeof tool.name === "string" ? [tool.name] : []));
  }
  if (wire === "command-code") {
    const params = parsed.params as { tools?: Array<{ name?: string }> } | undefined;
    return (params?.tools ?? []).flatMap(tool => typeof tool.name === "string" ? [tool.name] : []);
  }
  const state = parsed.conversationState as {
    currentMessage?: {
      userInputMessage?: {
        userInputMessageContext?: {
          tools?: Array<{ toolSpecification?: { name?: string } }>;
        };
      };
    };
  } | undefined;
  const tools = state?.currentMessage?.userInputMessage?.userInputMessageContext?.tools ?? [];
  return tools.flatMap(tool => typeof tool.toolSpecification?.name === "string" ? [tool.toolSpecification.name] : []);
}

function toolCallsDisabled(wire: AdapterWire, body: string): boolean {
  if (advertisedToolNames(wire, body).length === 0) return true;
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (wire === "openai-chat" || wire === "openai-responses") return parsed.tool_choice === "none";
  if (wire === "anthropic") {
    const choice = parsed.tool_choice as { type?: unknown } | undefined;
    return choice?.type === "none";
  }
  if (wire === "google") {
    const config = parsed.toolConfig as { functionCallingConfig?: { mode?: unknown } } | undefined;
    return config?.functionCallingConfig?.mode === "NONE";
  }
  return false;
}

function inputFromValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      const row = JSON.parse(value) as { input?: unknown };
      return typeof row.input === "string" ? row.input : value;
    } catch {
      return value;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const input = (value as Record<string, unknown>).input;
    if (typeof input === "string") return input;
  }
  return undefined;
}

function continuationInput(wire: AdapterWire, body: string): string | undefined {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (wire === "openai-chat") {
    const messages = parsed.messages as Array<{ tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> }> | undefined;
    for (const message of messages ?? []) {
      for (const call of message.tool_calls ?? []) {
        if (call.function?.name?.includes("apply_patch")) return inputFromValue(call.function.arguments);
      }
    }
    return undefined;
  }
  if (wire === "anthropic") {
    const messages = parsed.messages as Array<{ content?: unknown }> | undefined;
    for (const message of messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!block || typeof block !== "object" || Array.isArray(block)) continue;
        const row = block as Record<string, unknown>;
        if (row.type === "tool_use" && typeof row.name === "string" && row.name.includes("apply_patch")) {
          return inputFromValue(row.input);
        }
      }
    }
    return undefined;
  }
  if (wire === "google") {
    const contents = parsed.contents as Array<{ parts?: Array<{ functionCall?: { name?: string; args?: unknown } }> }> | undefined;
    for (const content of contents ?? []) {
      for (const part of content.parts ?? []) {
        if (part.functionCall?.name?.includes("apply_patch")) return inputFromValue(part.functionCall.args);
      }
    }
    return undefined;
  }
  if (wire === "command-code") {
    const params = parsed.params as { messages?: Array<{ content?: Array<Record<string, unknown>> }> } | undefined;
    for (const message of params?.messages ?? []) {
      for (const part of message.content ?? []) {
        if (part.type === "tool-call" && typeof part.toolName === "string" && part.toolName.includes("apply_patch")) {
          return inputFromValue(part.input);
        }
      }
    }
    return undefined;
  }
  if (wire === "kiro") {
    const state = parsed.conversationState as {
      history?: Array<{ assistantResponseMessage?: { toolUses?: Array<{ name?: string; input?: unknown }> } }>;
      currentMessage?: { assistantResponseMessage?: { toolUses?: Array<{ name?: string; input?: unknown }> } };
    } | undefined;
    const entries = [...(state?.history ?? []), ...(state?.currentMessage ? [state.currentMessage] : [])];
    for (const entry of entries) {
      for (const use of entry.assistantResponseMessage?.toolUses ?? []) {
        if (use.name?.includes("apply_patch")) return inputFromValue(use.input);
      }
    }
    return undefined;
  }
  if (wire === "openai-responses") {
    const input = parsed.input as Array<Record<string, unknown>> | undefined;
    for (const item of input ?? []) {
      if (typeof item.name !== "string" || !item.name.includes("apply_patch")) continue;
      if (item.type === "custom_tool_call") return inputFromValue(item.input);
      if (item.type === "function_call") return inputFromValue(item.arguments);
    }
    return undefined;
  }
  const visit = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const row = value as Record<string, unknown>;
    if (typeof row.name === "string" && row.name.includes("apply_patch")) {
      const found = inputFromValue(row.input ?? row.arguments);
      if (found !== undefined) return found;
    }
    for (const nested of Object.values(row)) {
      const found = visit(nested);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(parsed);
}

function parseResponsesFrames(text: string): Array<{ event?: string; data: Record<string, unknown> }> {
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const data = lines.find(line => line.startsWith("data: "))?.slice(6) ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function restoredStreamInput(adapterId: string, wire: AdapterWire): Promise<string | undefined> {
  const driver = TOOL_WIRE_DRIVERS[wire];
  if (!driver.streamingToolCall) return undefined;
  const parsed = freeformParsed(wire);
  const adapter = createRegisteredAdapter(providerFixture(adapterId, wire));
  const body = await withMimoBootstrap(adapterId, () => driver.observeOutbound(adapter, parsed));
  const wireName = driver.extractWireToolName?.(body, "apply_patch") ?? "apply_patch";
  const maps = buildToolBridgeMaps(parsed);
  const bridged = bridgeToResponsesSSE(
    adapter.parseStream(
      driver.streamingToolCall(wireName, JSON.stringify({ input: PATCH })),
      createTestTranslatorBudget(),
    ),
    parsed.modelId,
    maps.toolNsMap,
    maps.freeformToolNames,
    maps.toolSearchToolNames,
    undefined,
    2_000,
    { declaredToolNames: maps.declaredToolNames },
  );
  const frames = parseResponsesFrames(await new Response(bridged).text());
  return frames.find(frame => frame.event === "response.custom_tool_call_input.done")?.data.input as string | undefined;
}

describe("registry-derived routed tool conformance", () => {
  test("provider and model-wire configuration ids are registry members", () => {
    for (const provider of PROVIDER_REGISTRY) {
      expect(getAdapterDefinition(provider.adapter), provider.id).toBeDefined();
      for (const value of Object.values(provider.modelWireDefaults ?? {})) {
        const adapterId = typeof value === "string" ? value : value.wire;
        expect(getAdapterDefinition(adapterId), `${provider.id}:${adapterId}`).toBeDefined();
      }
    }
    for (const adapterId of MODEL_ADAPTER_OVERRIDE_ALLOWED) {
      expect(getAdapterDefinition(adapterId), adapterId).toBeDefined();
    }
  });

  test("every registered adapter keeps the nested apply_patch helper in its final request", async () => {
    for (const [adapterId] of adapterDefinitions()) {
      const contract = effectiveAdapterContract(adapterId);
      const body = await outbound(adapterId, codeModeParsed(contract.wire));
      const advertised = advertisedToolNames(contract.wire, body);
      expect(advertised.some(name => name === "exec" || name.endsWith("_exec")), adapterId).toBe(true);
      const normalized = body.replace(/\\n/g, " ").replace(/\s+/g, " ");
      expect(normalized, adapterId).toContain("apply_patch(input: string)");
      expect(normalized, adapterId).not.toMatch(/(?:do not|don't|never|must not|cannot|can't)[^.]{0,260}\bapply_patch\b/i);
      expect(normalized, adapterId).not.toMatch(/\bapply_patch\b[^.]{0,180}\b(?:forbidden|unavailable|off-limits)\b/i);
    }
  });

  test("tool_choice none disables every registered adapter's callable tool surface", async () => {
    for (const [adapterId] of adapterDefinitions()) {
      const contract = effectiveAdapterContract(adapterId);
      const enabledBody = await outbound(adapterId, toolChoiceParsed(contract.wire));
      expect(advertisedToolNames(contract.wire, enabledBody).length, `${adapterId}:enabled`).toBeGreaterThan(0);
      const disabledBody = await outbound(adapterId, toolChoiceParsed(contract.wire, "none"));
      expect(toolCallsDisabled(contract.wire, disabledBody), adapterId).toBe(true);
    }
  });

  test("every parsed streaming wire restores hostile freeform input exactly", async () => {
    for (const [adapterId] of adapterDefinitions()) {
      const contract = effectiveAdapterContract(adapterId);
      const driver = TOOL_WIRE_DRIVERS[contract.wire];
      if (!driver.streamingToolCall) {
        // OpenAI Responses is a normal passthrough here and only parses routed compaction;
        // Cursor's proprietary runTurn stream has focused parser coverage elsewhere.
        expect(["openai-responses", "cursor"]).toContain(contract.wire);
        continue;
      }
      expect(await restoredStreamInput(adapterId, contract.wire), adapterId).toBe(PATCH);
    }
  });

  test("every buffered adapter preserves same-name tools from different namespaces", async () => {
    for (const [adapterId] of adapterDefinitions()) {
      const contract = effectiveAdapterContract(adapterId);
      if (contract.wire === "openai-responses" || contract.wire === "cursor") {
        // Native Responses passthrough and Cursor's protobuf transport do not use the routed
        // adapter tool declaration surface exercised by this registry-wide check.
        continue;
      }
      const body = await outbound(adapterId, namespacedCollisionParsed(contract.wire));
      const names = advertisedToolNames(contract.wire, body).filter(name => name.includes("exec"));
      expect(new Set(names).size, adapterId).toBe(2);
    }
  });

  test("every routed adapter fails closed for an ambiguous bare selector", async () => {
    for (const [adapterId] of adapterDefinitions()) {
      const contract = effectiveAdapterContract(adapterId);
      if (contract.wire === "openai-responses" || contract.wire === "cursor") continue;
      const parsed = namespacedCollisionParsed(contract.wire);
      // parseRequest rejects this shape for real inbound traffic; keeping the policy mutation here
      // also proves each adapter remains fail-closed when a caller reaches it with a prebuilt AST.
      parsed.options.toolChoice = { allowedTools: ["exec"], mode: "required" };
      if (contract.wire === "kiro") {
        await expect(outbound(adapterId, parsed)).rejects.toThrow("Kiro supports only automatic tool choice or tool_choice:none");
        continue;
      }
      const body = await outbound(adapterId, parsed);
      expect(advertisedToolNames(contract.wire, body), adapterId).toHaveLength(0);
    }
  });

  test("every streaming adapter restores namespaced custom/function collisions distinctly", async () => {
    for (const [adapterId] of adapterDefinitions()) {
      const contract = effectiveAdapterContract(adapterId);
      const driver = TOOL_WIRE_DRIVERS[contract.wire];
      if (!driver.streamingToolCall || !driver.extractWireToolName) {
        expect(["openai-responses", "cursor"]).toContain(contract.wire);
        continue;
      }

      const parsed = namespacedCollisionParsed(contract.wire);
      const body = await outbound(adapterId, parsed);
      const maps = buildToolBridgeMaps(parsed);
      const cases = [
        { logicalName: "mcp__custom__exec", type: "custom_tool_call" },
        { logicalName: "mcp__remote__exec", namespace: "mcp__remote", type: "function_call" },
      ] as const;
      for (const testCase of cases) {
        const wireName = driver.extractWireToolName(body, testCase.logicalName);
        const bridged = bridgeToResponsesSSE(
          createRegisteredAdapter(providerFixture(adapterId, contract.wire)).parseStream(
            driver.streamingToolCall(wireName, JSON.stringify({ input: "ok" })),
            createTestTranslatorBudget(),
          ),
          parsed.modelId,
          maps.toolNsMap,
          maps.freeformToolNames,
          maps.toolSearchToolNames,
          undefined,
          2_000,
          { declaredToolNames: maps.declaredToolNames },
        );
        const frames = parseResponsesFrames(await new Response(bridged).text());
        const item = frames.find(frame => frame.event === "response.output_item.added")?.data.item as Record<string, unknown> | undefined;
        expect(item, `${adapterId}:${testCase.logicalName}`).toMatchObject({
          type: testCase.type,
          name: "exec",
          ...(testCase.namespace ? { namespace: testCase.namespace } : {}),
        });
      }
    }
  });

  test("every registered adapter replays the exact apply_patch input on continuation", async () => {
    for (const [adapterId] of adapterDefinitions()) {
      const contract = effectiveAdapterContract(adapterId);
      const body = await outbound(adapterId, continuationParsed(contract.wire));
      expect(continuationInput(contract.wire, body), adapterId).toBe(PATCH);
    }
  });
});
