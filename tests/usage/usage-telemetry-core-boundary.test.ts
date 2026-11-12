import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

const PROTECTED = [
  "src/router.ts",
  "src/server/lifecycle.ts",
  "src/server/responses/core.ts",
  "src/server/management-api.ts",
] as const;

const repoRoot = resolveRepoRoot();

const STATIC_IMPORT_RE =
  /^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;

function resolveSpec(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), `${base}.mts`, `${base}.mjs`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function firstTelemetryPath(entry: string): string[] | null {
  const start = resolve(repoRoot, entry);
  const previous = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!existsSync(current)) continue;
    const source = readFileSync(current, "utf8");
    STATIC_IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STATIC_IMPORT_RE.exec(source)) !== null) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      const next = resolveSpec(spec, current);
      if (!next || previous.has(next)) continue;
      previous.set(next, current);
      if (next.replaceAll("\\", "/").includes("/src/telemetry/")) {
        const chain: string[] = [];
        let node: string | null = next;
        while (node) {
          chain.push(node.slice(repoRoot.length + 1).replaceAll("\\", "/"));
          node = previous.get(node) ?? null;
        }
        return chain.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

describe("telemetry core load-time boundary", () => {
  test.each(PROTECTED)("%s has no load-time import path to src/telemetry/", entry => {
    expect(firstTelemetryPath(entry)).toBeNull();
  });
});
