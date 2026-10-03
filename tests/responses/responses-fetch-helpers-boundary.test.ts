import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { fetchWithHeaderTimeout, providerFetch, sendWithConnectionPolicy, storedPoolReplayDispatchNotifier } from "../../src/server/responses/fetch-helpers";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

const repoRoot = resolveRepoRoot();
const helperPath = resolve(repoRoot, "src/server/responses/fetch-helpers.ts");

describe("native Codex HTTP upload representation", () => {
  const endpoint = "https://chatgpt.com/backend-api/codex/responses";

  function captureFetch() {
    const calls: { input: Parameters<typeof fetch>[0]; init?: RequestInit }[] = [];
    const execute = (async (input, init) => {
      calls.push({ input, init });
      return new Response("ok");
    }) as typeof fetch;
    return { calls, execute };
  }

  test("sends large Unicode JSON as identical UTF-8 bytes without changing request metadata", async () => {
    // Fewer than 1 MiB of JS code units, but over 1 MiB on the wire.
    const body = JSON.stringify({ input: "é🦊".repeat(200_000) });
    const signal = new AbortController().signal;
    const headers = { "content-type": "application/json", "x-request-test": "preserved" };
    const init: RequestInit = { method: "POST", body, headers, signal };
    const capture = captureFetch();

    await sendWithConnectionPolicy(capture.execute, endpoint, init);

    expect(capture.calls).toHaveLength(1);
    const sent = capture.calls[0]!;
    expect(sent.input).toBe(endpoint);
    expect(sent.init?.body instanceof Uint8Array).toBe(true);
    expect(Buffer.from(sent.init!.body as Uint8Array).equals(Buffer.from(body, "utf8"))).toBe(true);
    expect(sent.init?.method).toBe("POST");
    expect(sent.init?.signal).toBe(signal);
    expect(Object.fromEntries(new Headers(sent.init?.headers))).toEqual(headers);
    expect(sent.init?.redirect).toBe("manual");
    expect(init.body).toBe(body);
  });

  test("covers compact and rebuilt destinations at the final HTTP dispatch", async () => {
    const body = JSON.stringify({ input: "x".repeat(1024 * 1024) });
    const capture = captureFetch();
    const send = providerFetch({ adapter: "openai-responses", baseUrl: "https://gateway.example/v1", fetch: capture.execute }, undefined, {
      httpOnly: true,
      dispatchOverride: (_input, init, execute) => execute(new URL(`${endpoint}/compact`), init),
    });

    await send("https://gateway.example/v1/responses", { method: "POST", body });

    expect(capture.calls).toHaveLength(1);
    expect(String(capture.calls[0]!.input)).toBe(`${endpoint}/compact`);
    const sent = capture.calls[0]!.init?.body;
    expect(sent instanceof Uint8Array).toBe(true);
    expect(Buffer.from(sent as Uint8Array).equals(Buffer.from(body, "utf8"))).toBe(true);
  });

  test("preserves small strings and already encoded bodies by identity", async () => {
    const capture = captureFetch();
    const bodies: BodyInit[] = ["{}", Buffer.alloc(1024 * 1024, 120), new Blob(["unchanged"]), new ReadableStream()];
    for (const body of bodies) {
      await sendWithConnectionPolicy(capture.execute, new Request(endpoint), { method: "POST", body });
      expect(capture.calls.at(-1)!.init?.body).toBe(body);
    }
    expect(capture.calls).toHaveLength(bodies.length);
  });

  test("leaves other hosts, schemes, ports and endpoint paths unchanged", async () => {
    const body = "x".repeat(1024 * 1024);
    const capture = captureFetch();
    for (const target of ["https://api.openai.com/v1/responses", "https://gateway.example/v1/responses",
      "http://chatgpt.com/backend-api/codex/responses", "https://chatgpt.com:8443/backend-api/codex/responses",
      "https://chatgpt.com/backend-api/codex/models", "https://chatgpt.com/backend-api/codex/responses/other"]) {
      await sendWithConnectionPolicy(capture.execute, target, { method: "POST", body });
      expect(capture.calls.at(-1)!.init?.body).toBe(body);
    }
  });

  test("nested dispatch preserves the encoded buffer and propagates failure without retry", async () => {
    const body = "x".repeat(1024 * 1024);
    const failure = Object.assign(new TypeError("test connection reset"), { code: "ECONNRESET" });
    let calls = 0;
    let encoded: BodyInit | null | undefined;
    const physical = (async (_input, init) => {
      calls += 1;
      expect(init?.body).toBe(encoded);
      throw failure;
    }) as typeof fetch;
    const nested = ((input, init) => {
      encoded = init?.body;
      expect(encoded instanceof Uint8Array).toBe(true);
      return sendWithConnectionPolicy(physical, input, init);
    }) as typeof fetch;

    await expect(sendWithConnectionPolicy(nested, endpoint, { method: "POST", body })).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});

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
      "../../lib/provider-egress",
      "../../lib/provider-tls-profile",
      "../../lib/proxy-env",
      "../../lib/redact",
      "../../lib/upstream-http-version",
      // Import-free plugin rewrite slot (src/plugins/upstream-hooks.ts).
      "../../plugins/upstream-hooks",
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
