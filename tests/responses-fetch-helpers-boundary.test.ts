import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { fetchWithHeaderTimeout, storedPoolReplayDispatchNotifier } from "../src/server/responses/fetch-helpers";

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

describe("storedPoolReplayDispatchNotifier", () => {
  function pacedExecutor(options: { pacing: () => Promise<void> }) {
    const sends: string[] = [];
    const unpaced = Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        sends.push(String(input));
        return new Response("ok");
      },
      { preconnect: () => {} },
    );
    const wrapped = Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        await options.pacing();
        return unpaced(input, init);
      },
      { preconnect: () => {}, waitForPacing: options.pacing, unpacedFetch: unpaced },
    );
    return { wrapped, sends };
  }

  test("does not signal a dispatch when pacing admission rejects", async () => {
    // The signal bounds later account/model/combo recovery, so it has to describe a send that
    // actually happened. fetchWithHeaderTimeout awaits pacing BEFORE calling the executor, so a
    // caller signalling at its own call site would spend the budget for a request that never
    // reached the network.
    let dispatched = 0;
    const executor = pacedExecutor({ pacing: () => Promise.reject(new Error("pacing closed")) });
    const notifier = storedPoolReplayDispatchNotifier(executor.wrapped, () => { dispatched += 1; });

    await expect(fetchWithHeaderTimeout(
      "https://example.test/v1/responses",
      { method: "POST" },
      new AbortController().signal,
      1_000,
      false,
      notifier,
    )).rejects.toThrow("pacing closed");

    expect(executor.sends).toEqual([]);
    expect(dispatched).toBe(0);
  });

  test("signals after pacing admission, once per notifier, and preserves pacing", async () => {
    let dispatched = 0;
    let paced = 0;
    const order: string[] = [];
    const executor = pacedExecutor({
      pacing: async () => { paced += 1; order.push("pacing"); },
    });
    const notifier = storedPoolReplayDispatchNotifier(executor.wrapped, () => {
      dispatched += 1;
      order.push("dispatch");
    });

    const response = await fetchWithHeaderTimeout(
      "https://example.test/v1/responses",
      { method: "POST" },
      new AbortController().signal,
      1_000,
      false,
      notifier,
    );

    expect(response.status).toBe(200);
    expect(dispatched).toBe(1);
    // Pacing is still applied exactly once — a plain function wrapper would drop waitForPacing
    // and unpacedFetch, which fetchWithHeaderTimeout reads off the executor.
    expect(paced).toBe(1);
    expect(order).toEqual(["pacing", "dispatch"]);

    // A second send through the SAME notifier must not signal again. One replay is one dispatch,
    // and without the internal guard a retry inside the helper would report two.
    await fetchWithHeaderTimeout(
      "https://example.test/v1/responses",
      { method: "POST" },
      new AbortController().signal,
      1_000,
      false,
      notifier,
    );
    expect(dispatched).toBe(1);
    expect(paced).toBe(2);
  });

  test("returns the executor untouched when there is nothing to notify", () => {
    const executor = pacedExecutor({ pacing: async () => {} });
    expect(storedPoolReplayDispatchNotifier(executor.wrapped, undefined)).toBe(executor.wrapped);
  });
});
