import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { repoRoot } from "../helpers/repo-root";

const root = repoRoot();
const snapshot = "src/providers/quota-decision-snapshot.ts";
const activation = "src/combos/jev-quota-activation.ts";
const forbidden = new Set([snapshot, activation]);
const protectedRoots = [
  "src/oauth/store.ts", "src/codex/account-store.ts", "src/codex/main-account-cache.ts",
  "src/providers/api-key-resolve.ts", "src/router.ts", "src/server/lifecycle.ts",
  "src/server/responses/core.ts", "src/config.ts",
];
type Edge = { spec: string; dynamic: boolean };

/** Bun's parser excludes erased types and includes runtime re-exports and literal dynamic imports. */
function runtimeEdges(source: string, loader: "ts" | "tsx" = "ts"): Edge[] {
  return new Bun.Transpiler({ loader, trimUnusedImports: false }).scanImports(source.replace(/^#![^\n]*(?:\n|$)/, "\n"))
    .filter(edge => edge.kind === "import-statement" || edge.kind === "dynamic-import")
    .map(edge => ({ spec: edge.path, dynamic: edge.kind === "dynamic-import" }));
}

const display = (file: string) => relative(root, file).replaceAll("\\", "/");
function resolveSpec(from: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(from), spec);
  const stem = base.replace(/\.(?:m?js|jsx)$/, "");
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, join(base, "index.ts"), join(base, "index.tsx")]
    .find(candidate => existsSync(candidate) && !/\.d\.[cm]?ts$/.test(candidate) && /\.(?:[cm]?[jt]sx?)$/.test(candidate));
}
const edgeCache = new Map<string, Edge[]>();
function edgesOf(file: string): Edge[] {
  let edges = edgeCache.get(file);
  if (!edges) { edges = runtimeEdges(readFileSync(file, "utf8"), file.endsWith(".tsx") ? "tsx" : "ts"); edgeCache.set(file, edges); }
  return edges;
}

/** Walk static edges, rejecting a forbidden static or dynamic edge anywhere in that graph. */
function forbiddenChain(entry: string): string[] | undefined {
  const start = resolve(root, entry);
  const previous = new Map<string, string | undefined>([[start, undefined]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const edge of edgesOf(current)) {
      const next = resolveSpec(current, edge.spec);
      if (!next) continue;
      if (forbidden.has(display(next))) {
        const chain = [`${display(next)}${edge.dynamic ? " (dynamic import)" : ""}`];
        let parent: string | undefined = current;
        while (parent) { chain.unshift(display(parent)); parent = previous.get(parent); }
        return chain;
      }
      if (!edge.dynamic && !previous.has(next)) { previous.set(next, current); queue.push(next); }
    }
  }
}
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:[cm]?[jt]sx?)$/.test(path) && !/\.d\.[cm]?ts$/.test(path) ? [path] : [];
  });
}

describe("JEV quota evidence stays off the core runtime graph", () => {
  for (const entry of protectedRoots) test(entry, () => {
    const chain = forbiddenChain(entry);
    expect(chain, chain ? `Forbidden runtime import chain:\n${chain.join(" -> ")}` : undefined).toBeUndefined();
  });

  test("only the activation owner runtime-imports the snapshot across src", () => {
    const importers = sourceFiles(resolve(root, "src")).flatMap(file => edgesOf(file)
      .filter(edge => resolveSpec(file, edge.spec) === resolve(root, snapshot))
      .map(edge => `${display(file)} -> ${snapshot}${edge.dynamic ? " (dynamic import)" : ""}`));
    expect(importers.sort(), `Snapshot runtime import chains:\n${importers.join("\n")}`).toEqual([`${activation} -> ${snapshot}`]);
  });

  test("edge parser includes runtime re-exports and dynamic imports but erases type-only syntax", () => {
    expect(runtimeEdges(`
      // import "./comment";
      const text = 'import("./string")';
      import type { A } from "./type";
      import { type B } from "./inline-type";
      export type { A } from "./type-export";
      export { type B } from "./inline-type-export";
      import "./side-effect";
      import { type A, b } from "./mixed";
      export * from "./re-export";
      export { b } from "./named-export";
      void import("./dynamic");
      void import(\`./template\`);
    `)).toEqual([
      { spec: "./side-effect", dynamic: false }, { spec: "./mixed", dynamic: false },
      { spec: "./re-export", dynamic: false }, { spec: "./named-export", dynamic: false },
      { spec: "./dynamic", dynamic: true }, { spec: "./template", dynamic: true },
    ]);
  });
});
