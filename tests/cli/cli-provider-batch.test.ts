import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { handleProviderBatchCommand } from "../../src/cli/provider-batch";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { MANAGEMENT_JSON_BODY_MAX_BYTES } from "../../src/server/management/body";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { saveConfig, getConfigPath, loadConfig } from "../../src/config";
import { safeConfigDTO } from "../../src/server/auth-cors";
import { handleManagementAPI } from "../../src/server/management-api";
import * as destinationPolicy from "../../src/lib/destination-policy";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const sentinel = "synthetic-private-value-do-not-print";
const baseUrl = "http://127.0.0.1:19073";
let home: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
let stdout: string[];
let stderr: string[];
let calls: { url: string; init: RequestInit }[];
let response: unknown;
let status: number;
let probes: number;
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let networkSpy: ReturnType<typeof spyOn>;

function editor() {
  return { defaultProvider: "alpha", providers: {
    alpha: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", defaultModel: "alpha-1" },
  } };
}
function input(value: unknown, name = "input.json"): string {
  const path = join(home, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}
function applyArgs(baseline: unknown = editor(), next: unknown = baseline): string[] {
  return ["--baseline", input(baseline, "baseline.json"), "--file", input(next, "next.json"), "--json"];
}
function deps(): RuntimeApiDeps {
  return {
    findLiveProxy: async () => {
      probes++;
      return { pid: 123, port: probes === 1 ? 19073 : 19074, hostname: "127.0.0.1", source: "runtime" };
    },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json(response, { status });
    }) as typeof fetch,
  };
}
function noEcho() {
  expect(stdout.join("\n") + stderr.join("\n")).not.toContain(sentinel);
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-cli-provider-batch-"));
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-cli-provider-batch-codex-");
  stdout = []; stderr = []; calls = []; probes = 0; status = 200;
  response = { success: true, catalogRefresh: null };
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => { stdout.push(args.join(" ")); });
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { stderr.push(args.join(" ")); });
  networkSpy = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network denied by batch test"); });
});
afterEach(() => {
  logSpy.mockRestore(); errorSpy.mockRestore(); networkSpy.mockRestore();
  codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("provider snapshot", () => {
  test("projects the two editor roots and strips only four GUI decorations", async () => {
    const expected = editor();
    response = { ...expected, port: 10100, unexportedRoot: sentinel, providers: { alpha: {
      ...expected.providers.alpha, hasApiKey: true, hasHeaders: true,
      xaiResponsesOptInState: "mixed", initialModelSelection: { status: "pending" },
    } } };
    expect(await handleProviderBatchCommand("snapshot", ["--json"], deps())).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toEqual(expected);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${baseUrl}/api/config`);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(probes).toBe(1);
    noEcho();
  });
  for (const field of ["apiKey", "headers", "apiKeyPool", "mcpServers", "desktopExecutor", "unexpectedPrivateField"]) {
    test(`fails closed before output on fetched ${field}`, async () => {
      response = { ...editor(), providers: { alpha: { ...editor().providers.alpha, [field]: sentinel } } };
      expect(await handleProviderBatchCommand("snapshot", ["--json"], deps())).toBe(1);
      expect(stdout).toEqual([]); noEcho();
    });
  }
  for (const malformed of [null, [], {}, { defaultProvider: "alpha", providers: [] }, { defaultProvider: "alpha", providers: { alpha: null } }]) {
    test(`refuses malformed snapshot ${JSON.stringify(malformed)}`, async () => {
      response = malformed;
      expect(await handleProviderBatchCommand("snapshot", [], deps())).toBe(1);
      expect(stdout).toEqual([]);
    });
  }
  test("rejects unknown or repeated options before liveness", async () => {
    for (const args of [["--json", "--json"], ["--file", sentinel], [sentinel]]) {
      expect(await handleProviderBatchCommand("snapshot", args, deps())).toBe(2);
    }
    expect(probes).toBe(0); expect(calls).toEqual([]); noEcho();
  });
});

describe("provider apply", () => {
  test("preserves exact public values in one pinned PUT and prints the receipt", async () => {
    const baseline = { defaultProvider: "alpha", providers: { alpha: {
      ...editor().providers.alpha, note: " keep spacing ", fastEnabled: false,
      baseUrl: "https://alpha.example.test/v1?tenant=%5Bredacted%5D",
      modelContextWindows: { "alpha-1": 131072 }, selectedModels: [],
    } } };
    expect(await handleProviderBatchCommand("apply", applyArgs(baseline), deps())).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${baseUrl}/api/providers`);
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ baseline, next: baseline });
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(probes).toBe(1);
    expect(JSON.parse(stdout.join("\n"))).toEqual(response);
  });
  for (const side of ["baseline", "next"]) {
    for (const field of ["apiKey", "headers", "apiKeyPool", "mcpServers", "desktopExecutor", "hasApiKey", "hasHeaders", "xaiResponsesOptInState", "initialModelSelection", "unknownField"]) {
      test(`rejects ${field} in ${side} as-is without leaking values`, async () => {
        const bad = { ...editor(), providers: { [sentinel]: { ...editor().providers.alpha, [field]: sentinel } } };
        const args = side === "baseline" ? applyArgs(bad, editor()) : applyArgs(editor(), bad);
        expect(await handleProviderBatchCommand("apply", args, deps())).toBe(2);
        expect(probes).toBe(0); expect(calls).toEqual([]); expect(stdout).toEqual([]); noEcho();
      });
    }
    test(`rejects extra root fields in ${side}`, async () => {
      const bad = { ...editor(), port: 10100 };
      expect(await handleProviderBatchCommand("apply", side === "baseline" ? applyArgs(bad) : applyArgs(editor(), bad), deps())).toBe(2);
      expect(calls).toEqual([]);
    });
  }
  test("rejects option and stdin conflicts before touching stdin or liveness", async () => {
    const stream = new Readable({ read() { throw new Error("Must not read stdin"); } });
    const cases = [
      [], ["--baseline", "-", "--file", "-"],
      ["--baseline", "-", "--baseline=x", "--file", "x"],
      ["--baseline", "-", "--file=x", "--file=y"],
      ["--baseline", "-", "--file"], ["--baseline", "--file", "x"],
      ["--baseline", "-", "--file=x", "--yes", "--yes"],
      ["--baseline", "-", "--file=x", "--json", "--json"],
      ["--baseline", "-", "--file=x", sentinel],
    ];
    for (const args of cases) {
      expect(await handleProviderBatchCommand("apply", args, { ...deps(), stdinImpl: stream })).toBe(2);
    }
    expect(probes).toBe(0); expect(calls).toEqual([]); expect(stream.listenerCount("data")).toBe(0); noEcho();
    stream.destroy();
  });
  test("accepts one explicit stdin document with an explicit file baseline", async () => {
    const baseline = editor();
    const stream = Readable.from([JSON.stringify(baseline)]);
    expect(await handleProviderBatchCommand("apply", ["--baseline", input(baseline), "--file", "-", "--json"], { ...deps(), stdinImpl: stream })).toBe(0);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ baseline, next: baseline });
    expect(stream.listenerCount("data")).toBe(0);
  });
  test("requires confirmation for removals and renames, including prototype-shaped names", async () => {
    for (const removed of ["beta", "toString", "__proto__", "constructor"]) {
      const baseline = { ...editor(), providers: Object.fromEntries([["alpha", editor().providers.alpha], [removed, editor().providers.alpha]]) };
      const args = applyArgs(baseline, editor());
      expect(await handleProviderBatchCommand("apply", args, deps())).toBe(2);
      expect(calls).toEqual([]);
      expect(await handleProviderBatchCommand("apply", [...args, "--yes"], deps())).toBe(0);
      expect(calls).toHaveLength(1);
      expect(Object.hasOwn(JSON.parse(String(calls[0]?.init.body)).baseline.providers, removed)).toBe(true);
      calls = [];
    }
  });
  test("preserves prototype-shaped keys instead of silently renaming or dropping them", async () => {
    const baseline = { defaultProvider: "__proto__", providers: Object.fromEntries([["__proto__", editor().providers.alpha]]) };
    expect(await handleProviderBatchCommand("apply", applyArgs(baseline), deps())).toBe(0);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ baseline, next: baseline });
  });
  test("returns stale 409 as exit 5 without a refresh or retry or error-body echo", async () => {
    status = 409; response = { code: "stale_provider_editor_baseline", error: { message: sentinel, details: sentinel } };
    expect(await handleProviderBatchCommand("apply", applyArgs(), deps())).toBe(5);
    expect(calls).toHaveLength(1); expect(probes).toBe(1); expect(stdout).toEqual([]); noEcho();
  });
  test("propagates not-found numeric exit", async () => {
    status = 404; response = { error: sentinel };
    expect(await handleProviderBatchCommand("apply", applyArgs(), deps())).toBe(4);
    expect(calls).toHaveLength(1); noEcho();
  });
  test("does not retry an unknown transport outcome or leak the transport exception", async () => {
    let attempts = 0;
    expect(await handleProviderBatchCommand("apply", applyArgs(), { ...deps(), fetchImpl: (async () => {
      attempts++; throw new Error(sentinel);
    }) as typeof fetch })).toBe(1);
    expect(attempts).toBe(1); expect(stdout).toEqual([]); noEcho();
  });
  test("rejects composite UTF-8 size even when each input fits", async () => {
    const large = { ...editor(), providers: { alpha: { ...editor().providers.alpha, note: "한".repeat(750000) } } };
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(MANAGEMENT_JSON_BODY_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ baseline: large, next: large }))).toBeGreaterThan(MANAGEMENT_JSON_BODY_MAX_BYTES);
    expect(await handleProviderBatchCommand("apply", applyArgs(large), deps())).toBe(2);
    expect(probes).toBe(0); expect(calls).toEqual([]); expect(stdout).toEqual([]);
  });
  test("retains safe saved-but-unconverged catalog disposition with numeric failure", async () => {
    response = { success: true, catalogRefresh: { status: "skipped", reason: "busy", retryable: true } };
    const code = await handleProviderBatchCommand("apply", applyArgs(), deps());
    expect(code).toBe(1);
    expect(JSON.parse(stdout.join("\n"))).toEqual(response); noEcho();
  });
});


describe("provider batch through the isolated management handler", () => {
  test("snapshot/no-op apply preserves private disk values; stale baseline is not refreshed", async () => {
    const live: OcxConfig = { port: 10100, ...editor(), providers: { alpha: {
      adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", defaultModel: "alpha-1",
      apiKey: sentinel, headers: { "x-private": sentinel },
    } } };
    saveConfig(live);
    const before = readFileSync(getConfigPath(), "utf8");
    const destinationSpy = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    let mutations = 0;
    const transport: RuntimeApiDeps = { baseUrl, fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (new URL(String(url)).pathname === "/api/config") return Response.json(safeConfigDTO(live));
      mutations++;
      const request = new ManagementRequest(String(url), init);
      const result = await handleManagementAPI(request, new URL(request.url), live, {
        createManagementConvergeCodex: catalogConvergenceFactory(),
      });
      if (!result) throw new Error("Unmatched synthetic request");
      return result;
    }) as typeof fetch };
    try {
      expect(await handleProviderBatchCommand("snapshot", ["--json"], transport)).toBe(0);
      const publicBaseline = JSON.parse(stdout.join("\n"));
      stdout = [];
      const args = applyArgs(publicBaseline);
      expect(await handleProviderBatchCommand("apply", args, transport)).toBe(0);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
      expect(loadConfig().providers.alpha?.apiKey).toBe(sentinel);
      expect(loadConfig().providers.alpha?.headers).toEqual({ "x-private": sentinel });
      noEcho();
      const concurrent = loadConfig();
      concurrent.providers.alpha!.defaultModel = "concurrent-model";
      saveConfig(concurrent);
      stdout = [];
      expect(await handleProviderBatchCommand("apply", args, transport)).toBe(5);
      expect(mutations).toBe(2);
      expect(calls.map(call => call.init.method)).toEqual(["GET", "PUT", "PUT"]);
      expect(loadConfig().providers.alpha?.defaultModel).toBe("concurrent-model");
      expect(stdout).toEqual([]); noEcho();
    } finally { destinationSpy.mockRestore(); }
  });
});
