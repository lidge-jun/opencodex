import { create, fromBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_REGISTRY,
  adapterDefinitions,
  createRegisteredAdapter,
  effectiveAdapterContract,
} from "../src/adapters/registry";
import { REQUIRED_ROUTED_TOOL_CONTRACTS } from "../src/adapters/contracts";
import type { AdapterWire } from "../src/adapters/contracts";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  WriteArgsSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { handleCursorNativeExec } from "../src/adapters/cursor/native-exec";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import {
  cursorRequestAdvertisesApplyPatch,
  isCursorSyntheticStructuredEditTool,
} from "../src/adapters/cursor/tool-definitions";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { ensureStrictCatalogFields, normalizeRoutedCatalogEntry } from "../src/codex/catalog/parsing";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { parseRequest } from "../src/responses/parser";
import { buildToolBridgeMaps } from "../src/server/responses";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED } from "../src/types";
import {
  APPLY_PATCH_FIXTURE,
  applyPatchContractFailures,
  type ApplyPatchContractId,
  type ApplyPatchObservation,
} from "./helpers/apply-patch-conformance/contracts";
import { TOOL_WIRE_DRIVERS } from "./helpers/apply-patch-conformance/wire-drivers";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const serverDir = fileURLToPath(new URL("../src/server/", import.meta.url));
const adapterResolvePath = fileURLToPath(new URL("../src/server/adapter-resolve.ts", import.meta.url));
const routerPath = fileURLToPath(new URL("../src/router.ts", import.meta.url));
const execDescription =
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

async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

async function directAdapterFactoryImports(path: string): Promise<string[]> {
  const source = await readFile(path, "utf8");
  return [...source.matchAll(
    /import\s+\{[^}]*\bcreate\w+Adapter\b[^}]*\}\s+from\s+["'][^"']*adapters\/(?!registry(?:["']))[^"']+["']/gs,
  )].map(match => match[0]!);
}

function providerFixture(adapter: string, wire: AdapterWire): OcxProviderConfig {
  const baseUrls: Record<AdapterWire, string> = {
    "openai-chat": "https://api.x.ai/v1",
    anthropic: "https://api.anthropic.com",
    google: "https://generativelanguage.googleapis.com",
    "command-code": "https://api.commandcode.ai",
    kiro: "https://runtime.us-east-1.kiro.dev",
    "openai-responses": "https://api.deepseek.com",
    cursor: "https://api2.cursor.sh",
  };
  return {
    adapter,
    baseUrl: baseUrls[wire],
    authMode: wire === "anthropic" || wire === "command-code" ? "oauth" : "key",
    apiKey: wire === "kiro" ? "ksk_test" : "test-key",
    defaultMaxOutputTokens: 64_000,
    googleMode: "ai-studio",
    ...(wire === "openai-responses" ? { responsesPath: "/responses" } : {}),
  } as OcxProviderConfig;
}

function prepareWireParsed(parsed: OcxParsedRequest, wire: AdapterWire): OcxParsedRequest {
  if (wire === "kiro") parsed._kiroAuthContext = { apiRegion: "us-east-1" };
  return parsed;
}

function codeModeParsed(wire: AdapterWire): OcxParsedRequest {
  const model = WIRE_MODELS[wire];
  return prepareWireParsed({
    modelId: model,
    stream: true,
    options: {},
    context: {
      systemPrompt: ["Use apply_patch for local file edits."],
      messages: [{ role: "user", content: "Patch the requested file.", timestamp: 0 }],
      tools: [
        { name: "exec", description: execDescription, parameters: {} },
        { name: "wait", description: "Wait for work.", parameters: {} },
      ],
    },
    _rawBody: {
      model,
      input: "Patch the requested file.",
      stream: true,
      tools: [{
        type: "custom",
        name: "exec",
        description: execDescription,
        format: { type: "grammar", syntax: "lark" },
      }],
    },
  }, wire);
}

function freeformParsed(wire: AdapterWire): OcxParsedRequest {
  return prepareWireParsed(parseRequest({
    model: WIRE_MODELS[wire],
    input: "Apply the exact patch.",
    stream: true,
    tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
  }), wire);
}

function toolChoiceNoneParsed(wire: AdapterWire): OcxParsedRequest {
  return prepareWireParsed(parseRequest({
    model: WIRE_MODELS[wire],
    input: "Do not call a tool.",
    stream: true,
    tool_choice: "none",
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
  return prepareWireParsed(parseRequest({
    model: WIRE_MODELS[wire],
    input: [
      {
        type: "custom_tool_call",
        id: "ctc_patch",
        call_id: "call_continue_patch",
        name: "apply_patch",
        input: APPLY_PATCH_FIXTURE,
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

function continuationInput(wire: AdapterWire, body: string): string | undefined {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (wire === "openai-chat") {
    const messages = parsed.messages as Array<{
      tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
    }> | undefined;
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
    const contents = parsed.contents as Array<{
      parts?: Array<{ functionCall?: { name?: string; args?: unknown } }>;
    }> | undefined;
    for (const content of contents ?? []) {
      for (const part of content.parts ?? []) {
        if (part.functionCall?.name?.includes("apply_patch")) return inputFromValue(part.functionCall.args);
      }
    }
    return undefined;
  }
  if (wire === "command-code") {
    const params = parsed.params as {
      messages?: Array<{ content?: Array<Record<string, unknown>> }>;
    } | undefined;
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

async function restoredFreeformInput(adapterId: string, wire: AdapterWire): Promise<string | undefined> {
  const driver = TOOL_WIRE_DRIVERS[wire];
  if (!driver.streamingToolCall) return undefined;
  const parsed = freeformParsed(wire);
  const adapter = createRegisteredAdapter(providerFixture(adapterId, wire));
  const outbound = await driver.observeOutbound(adapter, parsed);
  const wireToolName = driver.extractWireToolName?.(outbound, "apply_patch") ?? "apply_patch";
  const upstream = driver.streamingToolCall(wireToolName, JSON.stringify({ input: APPLY_PATCH_FIXTURE }));
  const maps = buildToolBridgeMaps(parsed);
  const bridged = bridgeToResponsesSSE(
    adapter.parseStream(upstream, createTestTranslatorBudget()),
    parsed.modelId,
    maps.toolNsMap,
    maps.freeformToolNames,
    maps.toolSearchToolNames,
    undefined,
    2_000,
    { declaredToolNames: maps.declaredToolNames },
  );
  const frames = parseResponsesFrames(await new Response(bridged).text());
  return frames.find(frame => frame.event === "response.custom_tool_call_input.done")?.data.input as
    | string
    | undefined;
}

function bufferedToolResponse(wire: AdapterWire, wireName: string): Response | undefined {
  const args = { input: APPLY_PATCH_FIXTURE };
  if (wire === "openai-chat") {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call_buffered_patch",
            type: "function",
            function: { name: wireName, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }));
  }
  if (wire === "anthropic") {
    return new Response(JSON.stringify({
      content: [{ type: "tool_use", id: "call_buffered_patch", name: wireName, input: args }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  }
  if (wire === "google") {
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ functionCall: { name: wireName, args } }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }));
  }
  return TOOL_WIRE_DRIVERS[wire].streamingToolCall?.(wireName, JSON.stringify(args));
}

async function restoredBufferedInput(adapterId: string, wire: AdapterWire): Promise<string | undefined> {
  const parsed = freeformParsed(wire);
  const adapter = createRegisteredAdapter(providerFixture(adapterId, wire));
  if (!adapter.parseResponse) return undefined;
  const driver = TOOL_WIRE_DRIVERS[wire];
  const outbound = await driver.observeOutbound(adapter, parsed);
  const wireName = driver.extractWireToolName?.(outbound, "apply_patch") ?? "apply_patch";
  const response = bufferedToolResponse(wire, wireName);
  if (!response) return undefined;
  const events = await adapter.parseResponse(response, createTestTranslatorBudget());
  const maps = buildToolBridgeMaps(parsed);
  const built = buildResponseJSON(events, parsed.modelId, {
    toolNsMap: maps.toolNsMap,
    declaredToolNames: maps.declaredToolNames,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
  });
  const output = built.output as Array<Record<string, unknown>>;
  const call = output.find(item => item.type === "custom_tool_call" && item.name === "apply_patch");
  return typeof call?.input === "string" ? call.input : undefined;
}

function writeExec(path: string, text: string) {
  return create(ExecServerMessageSchema, {
    id: 7,
    execId: "apply-patch-conformance",
    message: {
      case: "writeArgs",
      value: create(WriteArgsSchema, { path, fileText: text }),
    },
  });
}

function decodeCursorExec(bytes: Uint8Array) {
  const message = fromBinary(AgentClientMessageSchema, bytes);
  expect(message.message.case).toBe("execClientMessage");
  if (message.message.case !== "execClientMessage") throw new Error("Expected execClientMessage");
  return message.message.value;
}

test("global apply_patch precondition forces routed catalog rows to freeform", () => {
  const routed = normalizeRoutedCatalogEntry({
    slug: "xai/grok-4.6",
    tool_mode: "legacy",
    apply_patch_tool_type: "function",
    context_window: 128_000,
  });
  expect(routed.tool_mode).toBe("code_mode_only");
  expect(routed.apply_patch_tool_type).toBe("freeform");

  const native = ensureStrictCatalogFields({
    slug: "gpt-5.6-sol",
    apply_patch_tool_type: "function",
    context_window: 128_000,
  });
  expect(native.apply_patch_tool_type).toBe("function");
});

test("every registered adapter automatically inherits the mandatory routed tool contracts", () => {
  expect(adapterDefinitions().length).toBeGreaterThan(0);
  for (const [adapterId, definition] of adapterDefinitions()) {
    expect(definition.requiredToolContracts, adapterId).toEqual(REQUIRED_ROUTED_TOOL_CONTRACTS);
  }
});

test("wrapper inheritance is strict, acyclic, and resolves to a direct semantic contract", () => {
  for (const [adapterId, definition] of adapterDefinitions()) {
    if (definition.kind === "wrapper") {
      expect(ADAPTER_REGISTRY[definition.extends as keyof typeof ADAPTER_REGISTRY]).toBeTruthy();
      expect("wire" in definition).toBe(false);
      expect("mutation" in definition).toBe(false);
    }
    const effective = effectiveAdapterContract(adapterId);
    expect(effective.kind).toBe("direct");
    expect(effective.requiredToolContracts).toEqual(REQUIRED_ROUTED_TOOL_CONTRACTS);
  }
});

test("all configured adapter ids are members of the authoritative adapter registry", () => {
  for (const provider of PROVIDER_REGISTRY) {
    expect(ADAPTER_REGISTRY[provider.adapter as keyof typeof ADAPTER_REGISTRY], provider.id).toBeTruthy();
    for (const value of Object.values(provider.modelWireDefaults ?? {})) {
      const wire = typeof value === "string" ? value : value.wire;
      expect(ADAPTER_REGISTRY[wire as keyof typeof ADAPTER_REGISTRY], `${provider.id}:${wire}`).toBeTruthy();
    }
  }
  for (const adapterId of MODEL_ADAPTER_OVERRIDE_ALLOWED) {
    expect(ADAPTER_REGISTRY[adapterId as keyof typeof ADAPTER_REGISTRY], adapterId).toBeTruthy();
  }
});

test("every registered adapter keeps the nested apply_patch helper in its final request", async () => {
  for (const [adapterId] of adapterDefinitions()) {
    const contract = effectiveAdapterContract(adapterId);
    const parsed = codeModeParsed(contract.wire);
    const adapter = createRegisteredAdapter(providerFixture(adapterId, contract.wire));
    const body = await TOOL_WIRE_DRIVERS[contract.wire].observeOutbound(adapter, parsed);
    const normalized = body.replace(/\\n/g, " ").replace(/\s+/g, " ");
    expect(applyPatchContractFailures({ finalAdvertisement: normalized }), adapterId).toEqual([]);
  }
});

test("tool_choice:none removes the final advertised tool catalog for every registered adapter", async () => {
  for (const [adapterId] of adapterDefinitions()) {
    const contract = effectiveAdapterContract(adapterId);
    const parsed = toolChoiceNoneParsed(contract.wire);
    const adapter = createRegisteredAdapter(providerFixture(adapterId, contract.wire));
    const body = await TOOL_WIRE_DRIVERS[contract.wire].observeOutbound(adapter, parsed);
    const names = advertisedToolNames(contract.wire, body);
    expect(names, adapterId).toEqual([]);
    expect(applyPatchContractFailures({
      expectedPatchAdvertised: false,
      actualPatchAdvertised: names.some(name => name.includes("apply_patch")),
    }), adapterId).toEqual([]);
  }
});

test("every parsed response wire restores the hostile freeform apply_patch input exactly", async () => {
  for (const [adapterId] of adapterDefinitions()) {
    const contract = effectiveAdapterContract(adapterId);
    if (!TOOL_WIRE_DRIVERS[contract.wire].streamingToolCall) continue;
    const restoredInput = await restoredFreeformInput(adapterId, contract.wire);
    expect(restoredInput, adapterId).toBe(APPLY_PATCH_FIXTURE);
    expect(applyPatchContractFailures({ restoredInput }), adapterId).toEqual([]);
  }
});

test("every buffered parser restores the hostile freeform apply_patch input exactly", async () => {
  for (const [adapterId] of adapterDefinitions()) {
    const contract = effectiveAdapterContract(adapterId);
    const adapter = createRegisteredAdapter(providerFixture(adapterId, contract.wire));
    if (!adapter.parseResponse) continue;
    const restoredInput = await restoredBufferedInput(adapterId, contract.wire);
    if (restoredInput === undefined && !bufferedToolResponse(contract.wire, "apply_patch")) continue;
    expect(restoredInput, adapterId).toBe(APPLY_PATCH_FIXTURE);
  }
});

test("every registered adapter replays the exact apply_patch input on continuation", async () => {
  for (const [adapterId] of adapterDefinitions()) {
    const contract = effectiveAdapterContract(adapterId);
    const parsed = continuationParsed(contract.wire);
    const adapter = createRegisteredAdapter(providerFixture(adapterId, contract.wire));
    const body = await TOOL_WIRE_DRIVERS[contract.wire].observeOutbound(adapter, parsed);
    const replayed = continuationInput(contract.wire, body);
    expect(replayed, adapterId).toBe(APPLY_PATCH_FIXTURE);
    expect(applyPatchContractFailures({ continuationInput: replayed }), adapterId).toEqual([]);
  }
});

test("Cursor mutation ownership follows the registry contract and the final tool catalog", async () => {
  const contract = effectiveAdapterContract("cursor");
  expect(contract.mutation).toBe("mutation.codex-owned-with-gated-native-fallback");

  const parsed: OcxParsedRequest = {
    modelId: "cursor/auto",
    context: {
      messages: [{ role: "user", content: "Edit the requested file.", timestamp: 0 }],
      tools: [
        { name: "exec", description: "Run JavaScript", parameters: {} },
        { name: "apply_patch", description: "Apply a Codex patch", parameters: {}, freeform: true },
      ],
    },
    stream: false,
    options: {},
  };

  const advertised = createCursorRequest(parsed);
  const rejectNativeFileMutations = cursorRequestAdvertisesApplyPatch(advertised.tools, advertised.toolChoice);
  const structuredEditAvailable = advertised.tools?.some(isCursorSyntheticStructuredEditTool) ?? false;
  expect(rejectNativeFileMutations).toBe(true);

  const blockedDir = mkdtempSync(join(tmpdir(), "ocx-cursor-cplus-blocked-"));
  const allowedDir = mkdtempSync(join(tmpdir(), "ocx-cursor-cplus-allowed-"));
  try {
    const blockedPath = join(blockedDir, "blocked.txt");
    const blocked = decodeCursorExec((await handleCursorNativeExec(writeExec(blockedPath, "blocked"), {
      unsafeAllowNativeLocalExec: true,
      rejectNativeFileMutations,
      structuredEditAvailable,
    }))[0]!);
    expect(blocked.message.case).toBe("writeResult");
    expect(blocked.message.value.result.case).toBe("rejected");
    expect(existsSync(blockedPath)).toBe(false);

    const fallback = createCursorRequest({ ...parsed, options: { toolChoice: { name: "exec" } } });
    const fallbackRejects = cursorRequestAdvertisesApplyPatch(fallback.tools, fallback.toolChoice);
    expect(fallback.tools?.map(tool => tool.name)).toEqual(["exec"]);
    expect(fallbackRejects).toBe(false);

    const allowedPath = join(allowedDir, "allowed.txt");
    const allowed = decodeCursorExec((await handleCursorNativeExec(writeExec(allowedPath, "native fallback"), {
      unsafeAllowNativeLocalExec: true,
      rejectNativeFileMutations: fallbackRejects,
    }))[0]!);
    expect(allowed.message.case).toBe("writeResult");
    expect(allowed.message.value.result.case).toBe("success");
    expect(readFileSync(allowedPath, "utf8")).toBe("native fallback");
  } finally {
    rmSync(blockedDir, { recursive: true, force: true });
    rmSync(allowedDir, { recursive: true, force: true });
  }
});

test("the conformance oracle catches representative broken implementations", () => {
  const truncated = APPLY_PATCH_FIXTURE.slice(0, -1);
  const cases: Array<{
    name: string;
    observation: ApplyPatchObservation;
    contract: ApplyPatchContractId;
  }> = [
    {
      name: "drops patch declaration",
      observation: { finalAdvertisement: "declare const tools: {};" },
      contract: "tools.code-mode-nested-helper",
    },
    {
      name: "forbids advertised patch helper",
      observation: { finalAdvertisement: `${execDescription} Never use apply_patch.` },
      contract: "tools.code-mode-nested-helper",
    },
    {
      name: "truncates freeform input",
      observation: { restoredInput: truncated },
      contract: "tools.freeform-exact-roundtrip",
    },
    {
      name: "ignores tool choice filtering",
      observation: { expectedPatchAdvertised: false, actualPatchAdvertised: true },
      contract: "tools.tool-choice-final-catalog",
    },
    {
      name: "drops continuation input",
      observation: { continuationInput: truncated },
      contract: "tools.continuation-replay",
    },
    {
      name: "allows alternate mutation while Codex owns it",
      observation: { codexOwnsMutation: true, alternateMutationAllowed: true },
      contract: "mutation.codex-owned",
    },
  ];
  for (const fault of cases) {
    expect(applyPatchContractFailures(fault.observation), fault.name).toContain(fault.contract);
  }
});

test("production server routing cannot bypass the adapter registry", async () => {
  const resolver = await readFile(adapterResolvePath, "utf8");
  expect(resolver).toContain("createRegisteredAdapter");
  expect(resolver).not.toMatch(/create(?:Anthropic|Azure|Cursor|Google|Kiro|MimoFree|OpenAIChat|CommandCode|ResponsesPassthrough)Adapter/);

  const files = [...await collectTypeScriptFiles(serverDir), routerPath];
  for (const path of files) {
    expect(await directAdapterFactoryImports(path), path).toEqual([]);
  }
});
