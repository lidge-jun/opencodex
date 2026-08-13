import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_REGISTRY,
  adapterDefinitions,
  effectiveAdapterContract,
} from "../src/adapters/registry";
import { REQUIRED_ROUTED_TOOL_CONTRACTS } from "../src/adapters/contracts";
import { ensureStrictCatalogFields, normalizeRoutedCatalogEntry } from "../src/codex/catalog/parsing";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED } from "../src/types";

const serverDir = fileURLToPath(new URL("../src/server/", import.meta.url));
const adapterResolvePath = fileURLToPath(new URL("../src/server/adapter-resolve.ts", import.meta.url));
const routerPath = fileURLToPath(new URL("../src/router.ts", import.meta.url));

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
    /from\s+["'][^"']*adapters\/(?!registry(?:["']))[^"']+["']/g,
  )].map(match => match[0]!);
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

test("production server routing cannot bypass the adapter registry", async () => {
  const resolver = await readFile(adapterResolvePath, "utf8");
  expect(resolver).toContain("createRegisteredAdapter");
  expect(resolver).not.toMatch(/create(?:Anthropic|Azure|Cursor|Google|Kiro|MimoFree|OpenAIChat|CommandCode|ResponsesPassthrough)Adapter/);

  const files = [...await collectTypeScriptFiles(serverDir), routerPath];
  for (const path of files) {
    expect(await directAdapterFactoryImports(path), path).toEqual([]);
  }
});
