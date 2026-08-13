import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const adaptersDir = fileURLToPath(new URL("../src/adapters/", import.meta.url));
const regressionTestPath = fileURLToPath(new URL("./apply-patch-adapter-nudge-regression.test.ts", import.meta.url));
const nudgeImport = /(?:from\s+|import\s*\()\s*["'][^"']*tool-catalog-nudge(?:\.[cm]?[jt]s)?["']/;

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

test("every tool-catalog-nudge adapter has outbound apply_patch coverage", async () => {
  expect(await discoverNudgeCallSites()).toEqual(await discoverCoveredAdapterModules());
});
