import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IMPORT_RE = /^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gatewayNeedle = join("integrations", "replit-gateway");

const PROTECTED_ENTRIES = [
  "src/index.ts",
  "src/router.ts",
  "src/server/index.ts",
  "src/server/lifecycle.ts",
  "src/server/responses/core.ts",
  "src/server/management-api.ts",
] as const;

function resolveSpec(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), `${base}.mts`, `${base}.mjs`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "lab") continue;
      files.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function directDynamicGatewayImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  IMPORT_RE.lastIndex = 0;
  const hits: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const spec = match[4];
    if (spec && spec.includes("replit-gateway")) {
      hits.push(spec);
    }
  }
  return hits;
}

function reachesGateway(entry: string, followDynamic = false): string[] | null {
  const start = resolve(repoRoot, entry);
  const previous = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!existsSync(current)) continue;
    const source = readFileSync(current, "utf8");
    IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(source)) !== null) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!spec) continue;
      if (match[4] !== undefined && !followDynamic) continue;
      if (spec.includes("replit-gateway")) {
        const chain: string[] = [current.slice(repoRoot.length + 1)];
        let cursor: string | null = previous.get(current) ?? null;
        while (cursor) {
          chain.unshift(cursor.slice(repoRoot.length + 1));
          cursor = previous.get(cursor) ?? null;
        }
        return chain;
      }
      const next = resolveSpec(spec, current);
      if (!next || previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  return null;
}

describe("core import boundary", () => {
  test("protected runtime entry points do not reach integrations/replit-gateway", () => {
    const offenders = PROTECTED_ENTRIES
      .map((entry) => reachesGateway(entry))
      .filter((chain): chain is string[] => chain !== null);
    expect(offenders).toEqual([]);
  });

  test("no src/ file dynamically imports integrations/replit-gateway", () => {
    const srcRoot = join(repoRoot, "src");
    const offenders = listTsFiles(srcRoot)
      .flatMap((file) => directDynamicGatewayImports(file).map((spec) => ({
        file: file.slice(repoRoot.length + 1),
        spec,
      })));
    expect(offenders).toEqual([]);
  });
});
