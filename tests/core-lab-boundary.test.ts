import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The proxy core must not reach Compatibility Lab.
 *
 * A user who configures one provider and one model -- no routing profile, no Lab -- must
 * execute no Lab code. These files carry every such user's request path, so an optional
 * subsystem may only reach them through a core-owned slot it registers into at activation.
 *
 * `src/server/index.ts` is deliberately NOT in this set: it is the composition root, whose
 * job is to know which optional subsystems exist. It is covered by a behavioral assertion
 * instead (see below).
 *
 * Design and rationale: devlog/_plan/260814_lab_core_decoupling/
 */
const PROTECTED = [
  "src/router.ts",
  "src/server/lifecycle.ts",
  "src/server/responses/core.ts",
] as const;

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** Runtime imports only: `import type` is erased and costs nothing at runtime. */
const IMPORT_RE = /^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;

function resolveSpec(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), `${base}.mts`, `${base}.mjs`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Walk the runtime import graph and return the first path that reaches `src/lab/`. */
function firstLabPath(entry: string): string[] | null {
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
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      const next = resolveSpec(spec, current);
      if (!next || previous.has(next)) continue;
      previous.set(next, current);
      if (next.includes("/src/lab/")) {
        const chain: string[] = [];
        let node: string | null = next;
        while (node) {
          chain.push(node.slice(repoRoot.length + 1));
          node = previous.get(node) ?? null;
        }
        return chain.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

describe("core / Compatibility Lab boundary", () => {
  // Guard 1: the obvious case, a direct import.
  test.each(PROTECTED)("%s has no direct src/lab import", file => {
    const source = readFileSync(resolve(repoRoot, file), "utf8");
    const direct = /^\s*(?:import|export)\s+(?!type\b)[^;]*?["'][^"']*\/lab\//m.test(source)
      || /^\s*import\s+["'][^"']*\/lab\//m.test(source);
    expect(direct).toBe(false);
  });

  // Guard 2: the case that actually caused this work. The original defect reached Lab
  // through assemble -> quota -> auth-api -> native-main-admission -> lifecycle -> Lab,
  // where no single file looked wrong. Text matching alone would have missed it.
  test.each(PROTECTED)("%s reaches no src/lab module transitively", file => {
    const chain = firstLabPath(file);
    // Print the full chain on failure: a bare verdict would send the next maintainer on
    // the same multi-hour hunt this unit required.
    expect(chain === null ? "clean" : chain.join(" -> ")).toBe("clean");
  });
});
