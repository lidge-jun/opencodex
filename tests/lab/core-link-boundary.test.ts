import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";
import { linkRouteAllowed } from "../../src/server/index/link-listener";

/** The optional hub-link listener must stay out of the always-on request graph. */
const repoRoot = resolveRepoRoot();
const PROTECTED = [
  "src/router.ts",
  "src/server/lifecycle.ts",
  "src/server/responses/core.ts",
] as const;
const IMPORT_RE = /^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;

function resolveSpec(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), `${base}.mts`, `${base}.mjs`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function firstLinkPath(entry: string): string[] | null {
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
      if (match[4] !== undefined) continue;
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      const next = resolveSpec(spec, current);
      if (!next || previous.has(next)) continue;
      previous.set(next, current);
      const normalized = next.replaceAll("\\", "/");
      if (normalized.includes("/src/link/") || normalized.endsWith("/src/server/index/link-listener.ts")) {
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

describe("core / hub-link boundary", () => {
  test("always-on core modules cannot reach link state or listener code", () => {
    for (const entry of PROTECTED) expect(firstLinkPath(entry), entry).toBeNull();
  });

  test("the composition root is the only server index owner of the optional listener", () => {
    const source = readFileSync(resolve(repoRoot, "src/server/index.ts"), "utf8");
    expect(source).toContain("./index/optional-listeners");
    expect(readFileSync(resolve(repoRoot, "src/server/index/serve-options.ts"), "utf8"))
      .not.toContain("link-listener");
  });

  test("link routing is HTTP-only and default-deny", () => {
    const request = (path: string, method = "GET", headers?: HeadersInit) =>
      new Request(`http://127.0.0.1${path}`, { method, headers });
    expect(linkRouteAllowed(new URL("http://127.0.0.1/v1/catalog"), request("/v1/catalog"))).toBe(true);
    expect(linkRouteAllowed(new URL("http://127.0.0.1/readyz"), request("/readyz"))).toBe(true);
    expect(linkRouteAllowed(new URL("http://127.0.0.1/readyz"), request("/readyz", "HEAD"))).toBe(false);
    expect(linkRouteAllowed(new URL("http://127.0.0.1/v1/catalog"), request("/v1/catalog", "GET", { upgrade: "h2c" }))).toBe(false);
    expect(linkRouteAllowed(new URL("http://127.0.0.1/api/config"), request("/api/config"))).toBe(false);
    expect(linkRouteAllowed(new URL("http://127.0.0.1/v1/unknown"), request("/v1/unknown"))).toBe(false);
  });
});
