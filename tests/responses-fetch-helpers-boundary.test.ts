import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = resolve(repoRoot, "src/server/responses/fetch-helpers.ts");

const RUNTIME_IMPORT_RE = /^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;

function runtimeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  RUNTIME_IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RUNTIME_IMPORT_RE.exec(source)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier) specifiers.push(specifier);
  }
  return [...new Set(specifiers)].sort();
}

describe("Responses fetch-helper import boundary", () => {
  test("loads only transport-owned runtime dependencies", () => {
    expect(runtimeImportSpecifiers(readFileSync(helperPath, "utf8"))).toEqual([
      "../../lib/upstream-http-version",
      "../../providers/request-pacing",
      "./ws-upstream",
    ]);
  });

  test("the guard recognizes runtime edges and ignores type-only imports", () => {
    expect(runtimeImportSpecifiers([
      'import type { T } from "./types";',
      'export type { U } from "./other-types";',
      'import { a } from "./static";',
      'import "./side-effect";',
      'export { b } from "./re-export";',
      'const c = import("./dynamic");',
    ].join("\n"))).toEqual([
      "./dynamic",
      "./re-export",
      "./side-effect",
      "./static",
    ]);
  });
});
