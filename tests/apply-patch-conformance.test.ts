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
import { ensureStrictCatalogFields, normalizeRoutedCatalogEntry } from "../src/codex/catalog/parsing";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { AdapterWire } from "../src/adapters/contracts";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED } from "../src/types";
import {
  APPLY_PATCH_FIXTURE,
  applyPatchContractFailures,
  type ApplyPatchContractId,
  type ApplyPatchObservation,
} from "./helpers/apply-patch-conformance/contracts";
import { TOOL_WIRE_DRIVERS } from "./helpers/apply-patch-conformance/wire-drivers";

const serverDir = fileURLToPath(new URL("../src/server/", import.meta.url));
const adapterResolvePath = fileURLToPath(new URL("../src/server/adapter-resolve.ts", import.meta.url));
const routerPath = fileURLToPath(new URL("../src/router.ts", import.meta.url));
const execDescription =
  "Run JavaScript. declare const tools: { apply_patch(input: string): Promise<unknown>; };";

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
  return {
    adapter,
    baseUrl: wire === "cursor" ? "https://api2.cursor.sh" : "https://example.test/v1",
    authMode: wire === "anthropic" ? "oauth" : "key",
    apiKey: "test-key",
    defaultMaxOutputTokens: 64_000,
    googleMode: "ai-studio",
  } as OcxProviderConfig;
}

function codeModeParsed(wire: AdapterWire): OcxParsedRequest {
  const parsed: OcxParsedRequest = {
    modelId: "test-model",
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
      model: "test-model",
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
  };
  if (wire === "kiro") parsed._kiroAuthContext = { apiRegion: "us-east-1" };
  return parsed;
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
