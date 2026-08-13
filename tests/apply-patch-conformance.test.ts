import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
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
import { bridgeToResponsesSSE } from "../src/bridge";
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
    options: { toolChoice: { name: "exec" } },
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
      tool_choice: { type: "custom", name: "exec" },
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

async function restoredFreeformInput(adapterId: string, wire: AdapterWire): Promise<string | undefined> {
  const driver = TOOL_WIRE_DRIVERS[wire];
  if (!driver.streamingToolCall) return undefined;

  const parsed = freeformParsed(wire);
  const adapter = createRegisteredAdapter(providerFixture(adapterId, wire));
  const outbound = await driver.observeOutbound(adapter, parsed);
  const wireToolName = driver.extractWireToolName?.(outbound, "apply_patch") ?? "apply_patch";
  const upstream = driver.streamingToolCall(
    wireToolName,
    JSON.stringify({ input: APPLY_PATCH_FIXTURE }),
  );
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
    expect(
      definition.requiredToolContracts,
      `${adapterId} must inherit every mandatory routed tool contract`,
    ).toEqual(REQUIRED_ROUTED_TOOL_CONTRACTS);
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

test("every registered adapter keeps the nested apply_patch helper in its final post-tool_choice request", async () => {
  for (const [adapterId] of adapterDefinitions()) {
    const contract = effectiveAdapterContract(adapterId);
    const parsed = codeModeParsed(contract.wire);
    const adapter = createRegisteredAdapter(providerFixture(adapterId, contract.wire));
    const body = await TOOL_WIRE_DRIVERS[contract.wire].observeOutbound(adapter, parsed);
    const normalized = body.replace(/\\n/g, " ").replace(/\s+/g, " ");

    expect(applyPatchContractFailures({ finalAdvertisement: normalized }), adapterId).toEqual([]);
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
