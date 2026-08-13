import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const adaptersDir = fileURLToPath(new URL("../src/adapters/", import.meta.url));
const regressionTestPath = fileURLToPath(new URL("./apply-patch-adapter-nudge-regression.test.ts", import.meta.url));
const adapterResolvePath = fileURLToPath(new URL("../src/server/adapter-resolve.ts", import.meta.url));
const nudgeImport = /(?:from\s+|import\s*\()\s*["'][^"']*tool-catalog-nudge(?:\.[cm]?[jt]s)?["']/;

const APPLY_PATCH_ADAPTER_STRATEGIES = {
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
} as const;

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

async function discoverResolvedAdapterNames(): Promise<string[]> {
  const source = await readFile(adapterResolvePath, "utf8");
  return [...source.matchAll(/case\s+["']([^"']+)["']\s*:/g)]
    .map(match => match[1]!)
    .sort();
}

test("every tool-catalog-nudge adapter has outbound apply_patch coverage", async () => {
  expect(await discoverNudgeCallSites()).toEqual(await discoverCoveredAdapterModules());
});

test("every resolved adapter has an explicit apply_patch strategy", async () => {
  expect(await discoverResolvedAdapterNames()).toEqual(
    Object.keys(APPLY_PATCH_ADAPTER_STRATEGIES).sort(),
  );
});
