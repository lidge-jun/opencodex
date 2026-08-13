import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const adaptersDir = fileURLToPath(new URL("../src/adapters/", import.meta.url));
const regressionTestPath = fileURLToPath(new URL("./apply-patch-adapter-nudge-regression.test.ts", import.meta.url));
const adapterResolvePath = fileURLToPath(new URL("../src/server/adapter-resolve.ts", import.meta.url));
const nudgeImport = /(?:from\s+|import\s*\()\s*["'][^"']*tool-catalog-nudge(?:\.[cm]?[jt]s)?["']/;

type ApplyPatchAdapterStrategy =
  | "nudge-routed"
  | "responses-native"
  | "responses-native-wrapper"
  | "cursor-special"
  | "openai-chat-wrapper";

const APPLY_PATCH_ADAPTER_STRATEGIES: Record<string, ApplyPatchAdapterStrategy> = {
  "command-code": "nudge-routed",
  "openai-chat": "nudge-routed",
  anthropic: "nudge-routed",
  "openai-responses": "responses-native",
  google: "nudge-routed",
  kiro: "nudge-routed",
  azure: "responses-native-wrapper",
  "azure-openai": "responses-native-wrapper",
  cursor: "cursor-special",
  "mimo-free": "openai-chat-wrapper",
};

async function discoverNudgeCallSites(dir = adaptersDir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await discoverNudgeCallSites(fullPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;

    const source = await readFile(fullPath, "utf8");
    if (!nudgeImport.test(source)) continue;

    const relativePath = relative(adaptersDir, fullPath).split(sep).join("/");
    found.push(`src/adapters/${relativePath}`);
  }

  return found.sort();
}

async function discoverCoveredAdapterModules(): Promise<string[]> {
  const source = await readFile(regressionTestPath, "utf8");
  const imports = source.matchAll(/from\s+["']\.\.\/src\/adapters\/([^"']+)["']/g);
  return [...imports]
    .map(match => `src/adapters/${match[1]}.ts`)
    .sort();
}

async function discoverResolvedAdapterModules(): Promise<Map<string, string>> {
  const source = await readFile(adapterResolvePath, "utf8");
  const resolverStart = source.indexOf("export function resolveAdapter");
  expect(resolverStart).toBeGreaterThanOrEqual(0);
  const resolverSource = source.slice(resolverStart);

  const factoryModules = new Map<string, string>();
  for (const match of source.matchAll(
    /import\s+\{\s*(create\w+Adapter)\s*\}\s+from\s+["']\.\.\/adapters\/([^"']+)["']/g,
  )) {
    factoryModules.set(match[1]!, match[2]!);
  }

  const resolved = new Map<string, string>();
  let pendingCases: string[] = [];
  for (const line of resolverSource.split("\n")) {
    const caseMatch = line.match(/case\s+["']([^"']+)["']\s*:/);
    if (caseMatch) {
      pendingCases.push(caseMatch[1]!);
      continue;
    }

    const returnMatch = line.match(/return\s+(create\w+Adapter)\s*\(/);
    if (!returnMatch || pendingCases.length === 0) continue;
    const moduleName = factoryModules.get(returnMatch[1]!);
    expect(moduleName, `resolver factory ${returnMatch[1]} should have an adapter import`).toBeTruthy();
    for (const adapterName of pendingCases) resolved.set(adapterName, moduleName!);
    pendingCases = [];
  }
  return resolved;
}

async function readAdapterModuleSource(moduleName: string): Promise<string> {
  const candidates = [
    join(adaptersDir, `${moduleName}.ts`),
    join(adaptersDir, moduleName, "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Unable to locate adapter module ${moduleName}`);
}

async function inferApplyPatchStrategy(moduleName: string): Promise<ApplyPatchAdapterStrategy> {
  const source = await readAdapterModuleSource(moduleName);
  if (nudgeImport.test(source)) return "nudge-routed";
  if (moduleName === "openai-responses") return "responses-native";
  if (moduleName === "cursor") return "cursor-special";
  if (
    /createResponsesPassthroughAdapter/.test(source)
    && /from\s+["']\.\/openai-responses["']/.test(source)
  ) return "responses-native-wrapper";
  if (
    /createOpenAIChatAdapter/.test(source)
    && /from\s+["']\.\/openai-chat["']/.test(source)
  ) return "openai-chat-wrapper";
  throw new Error(`Adapter module ${moduleName} has no recognized apply_patch strategy`);
}

test("every tool-catalog-nudge adapter has outbound apply_patch coverage", async () => {
  expect(await discoverNudgeCallSites()).toEqual(await discoverCoveredAdapterModules());
});

test("every resolved adapter has the apply_patch strategy its implementation actually uses", async () => {
  const resolved = await discoverResolvedAdapterModules();
  expect([...resolved.keys()].sort()).toEqual(Object.keys(APPLY_PATCH_ADAPTER_STRATEGIES).sort());

  for (const [adapterName, moduleName] of resolved) {
    expect(
      APPLY_PATCH_ADAPTER_STRATEGIES[adapterName],
      `${adapterName} should match the apply_patch behavior of ${moduleName}`,
    ).toBe(await inferApplyPatchStrategy(moduleName));
  }
});
