import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const adaptersDir = join(repoRoot, "src", "adapters");
const serverDir = join(repoRoot, "src", "server");
const routerPath = join(repoRoot, "src", "router.ts");
const labExecutorPath = join(repoRoot, "src", "lab", "conformance", "executor.ts");
const importScanner = new Bun.Transpiler({ loader: "ts" });
const exportedAdapterFactory = /\bexport\s+(?:async\s+)?function\s+(create[A-Za-z0-9_$]*Adapter)\s*\(|\bexport\s+const\s+(create[A-Za-z0-9_$]*Adapter)\b/g;

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

function adapterModuleId(path: string): string {
  return relative(adaptersDir, path)
    .split(sep)
    .join("/")
    .replace(/\.ts$/, "");
}

async function discoverAdapterFactories(): Promise<Map<string, string[]>> {
  const factories = new Map<string, string[]>();
  for (const path of await collectTypeScriptFiles(adaptersDir)) {
    if (path === join(adaptersDir, "registry.ts")) continue;
    const source = await readFile(path, "utf8");
    const names = new Set<string>();
    for (const match of source.matchAll(exportedAdapterFactory)) {
      const name = match[1] ?? match[2];
      if (name) names.add(name);
    }
    if (names.size > 0) factories.set(adapterModuleId(path), [...names]);
  }
  return factories;
}

function importedAdapterModule(
  specifier: string,
  factories: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  const normalized = posix.normalize(specifier.replaceAll("\\", "/"));
  const parts = normalized.split("/");
  const adapterIndex = parts.lastIndexOf("adapters");
  if (adapterIndex < 0 || adapterIndex === parts.length - 1) return undefined;
  const moduleId = parts.slice(adapterIndex + 1).join("/").replace(/\.(?:[cm]?[jt]s)$/, "");
  return factories.has(moduleId) ? moduleId : undefined;
}

function containsIdentifier(source: string, target: string): boolean {
  const isStart = (code: number) =>
    (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 36
    || code === 95;
  const isContinue = (code: number) => isStart(code) || (code >= 48 && code <= 57);

  for (let i = 0; i < source.length;) {
    const code = source.charCodeAt(i);
    if (!isStart(code)) {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < source.length && isContinue(source.charCodeAt(end))) end += 1;
    if (source.slice(i, end) === target) return true;
    i = end;
  }
  return false;
}

async function directAdapterFactoryImports(
  path: string,
  factories: ReadonlyMap<string, readonly string[]>,
): Promise<string[]> {
  const source = await readFile(path, "utf8");
  const runtimeSource = importScanner.transformSync(source);
  const findings: string[] = [];

  for (const entry of importScanner.scan(source).imports) {
    const moduleId = importedAdapterModule(entry.path, factories);
    if (!moduleId) continue;
    if (entry.kind !== "import-statement") {
      findings.push(`${entry.kind} from ${entry.path}`);
      continue;
    }
    for (const factory of factories.get(moduleId) ?? []) {
      if (containsIdentifier(runtimeSource, factory)) {
        findings.push(`${factory} from ${entry.path}`);
      }
    }
  }
  return findings;
}

test("routing boundaries discover adapter factories instead of maintaining a second inventory", async () => {
  const factories = await discoverAdapterFactories();
  expect(factories.size).toBeGreaterThan(0);
  expect(factories.get("openai-chat")).toContain("createOpenAIChatAdapter");

  const files = [...await collectTypeScriptFiles(serverDir), routerPath, labExecutorPath];
  for (const path of files) {
    expect(await directAdapterFactoryImports(path, factories), path).toEqual([]);
  }
});
