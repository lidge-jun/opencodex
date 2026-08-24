import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = resolve(repoRoot, "src/server/responses/fetch-helpers.ts");

interface RuntimeImportScan {
  specifiers: string[];
  nonLiteralDynamicImports: string[];
}

const importTranspiler = new Bun.Transpiler({ loader: "ts" });

function nonLiteralDynamicImports(source: string): string[] {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const imports: string[] = [];
  for (;;) {
    const token = scanner.scan();
    if (token === SyntaxKind.EndOfFile) return imports;
    if (token !== SyntaxKind.ImportKeyword) continue;
    if (scanner.scan() !== SyntaxKind.OpenParenToken) continue;
    const argument = scanner.scan();
    if (argument !== SyntaxKind.StringLiteral) imports.push(scanner.getTokenText());
  }
}

function runtimeImports(source: string): RuntimeImportScan {
  return {
    specifiers: [...new Set(importTranspiler.scanImports(source).map(item => item.path))].sort(),
    nonLiteralDynamicImports: nonLiteralDynamicImports(source),
  };
}

function expectRuntimeImportBoundary(source: string): string[] {
  const scan = runtimeImports(source);
  expect(scan.nonLiteralDynamicImports).toEqual([]);
  return scan.specifiers;
}

describe("Responses fetch-helper import boundary", () => {
  test("loads only transport-owned runtime dependencies", () => {
    expect(expectRuntimeImportBoundary(readFileSync(helperPath, "utf8"))).toEqual([
      "../../lib/provider-tls-profile",
      "../../lib/upstream-http-version",
      "../../providers/request-pacing",
      "./ws-upstream",
    ]);
  });

  test("the guard recognizes runtime edges and ignores type-only imports", () => {
    const scan = runtimeImports([
      'import type { T } from "./types";',
      'import { type T2 } from "./more-types";',
      'export type { U } from "./other-types";',
      'export { type U2 } from "./more-other-types";',
      'import { a } from "./static";',
      'import "./side-effect";',
      'export { b } from "./re-export";',
      'const c = import("./dynamic");',
      'const moduleName = "./hidden";',
      'const d = import(moduleName);',
      'const e = import(`./template`);',
    ].join("\n"));
    expect(scan.specifiers).toEqual([
      "./dynamic",
      "./re-export",
      "./side-effect",
      "./static",
      "./template",
    ]);
    expect(scan.nonLiteralDynamicImports).toEqual([
      "moduleName",
      "`./template`",
    ]);
  });
});
