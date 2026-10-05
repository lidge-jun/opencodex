import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { handleProviderPacingCommand, takeProviderEditSettings } from "../../src/cli/provider-settings";
import { handleProviderRuntimeCommand } from "../../src/cli/provider-runtime";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";

type Call = { url: string; method: string; body?: unknown };
let home: TempHome;
let token: string | undefined;
let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
let network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-provider-settings-");
  token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  output.mockRestore(); errors.mockRestore(); network.mockRestore();
  if (token === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = token;
  home.remove();
});

const status = { provider: "fixture", enabled: false, queued: 0, nextSlotInMs: 0 };
function fixture(options: { rules?: unknown; config?: unknown; status?: unknown; receipt?: unknown; http?: number; failure?: boolean } = {}) {
  const calls: Call[] = [];
  let resolutions = 0;
  const provider = Object.hasOwn(options, "rules") ? { requestPacing: options.rules } : {};
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => ({ pid: null, port: 14000 + ++resolutions, source: "runtime" }),
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).has("X-OpenCodex-API-Key")).toBe(false);
      calls.push({ url: String(input), method: init?.method ?? "GET",
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
      if (options.failure) throw new Error("private opaque transport content");
      if (options.http) return Response.json({ error: { message: "private opaque server content", code: "private-code" } }, { status: options.http });
      if (url.pathname === "/api/config") return Response.json(Object.hasOwn(options, "config") ? options.config : { providers: { fixture: provider } });
      if (url.pathname === "/api/provider-request-pacing") return Response.json(Object.hasOwn(options, "status") ? options.status : status);
      if (url.pathname === "/api/providers" && init?.method === "PATCH") return Response.json(options.receipt ?? { success: true });
      throw new Error("Unexpected fixture request");
    }) as typeof fetch,
  };
  return { calls, deps, resolutions: () => resolutions };
}
function parsedOutput(): unknown { return JSON.parse(String(output.mock.calls[0]?.[0])); }
function inputFile(value: unknown): string {
  const path = home.path("pacing.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("provider edit settings", () => {
  test("edit redacts unsupported credential options before target discovery", async () => {
    const secret = "synthetic-private-value";
    const f = fixture();
    for (const option of ["--api-key", "--key", "--secret", "--password", "--admin-token"]) {
      for (const args of [[`${option}=${secret}`], [option, secret], [option, `--${secret}`], [option, "--", secret]]) {
        errors.mockClear();
        expect(await handleProviderRuntimeCommand("edit", ["fixture", ...args, "--json"], f.deps)).toBe(2);
        const printed = JSON.stringify(errors.mock.calls);
        expect(printed).toContain(option);
        expect(printed).toContain("<redacted>");
        expect(printed).not.toContain(secret);
      }
    }
    expect(f.calls).toEqual([]);
    expect(f.resolutions()).toBe(0);
  });

  test("preserves unrelated options and exact null/false fields", () => {
    const args = ["--note", "kept", "--upstream-http-version", "-", "--fast", "off", "--context-window=-", "--json"];
    expect(takeProviderEditSettings(args)).toEqual({ upstreamHttpVersion: null, fastEnabled: false, contextWindow: null });
    expect(args).toEqual(["--note", "kept", "--json"]);
    expect(takeProviderEditSettings([])).toEqual({});
  });
  test("accepts set values", () => {
    expect(takeProviderEditSettings(["--upstream-http-version=http1.1", "--fast=on", "--context-window", "131072"]))
      .toEqual({ upstreamHttpVersion: "http1.1", fastEnabled: true, contextWindow: 131072 });
  });
  for (const args of [
    ["--context-window", "0"], ["--context-window", "1.5"], ["--context-window", "9007199254740992"],
    ["--context-window", "Infinity"], ["--context-window"], ["--context-window=1", "--context-window", "2"],
    ["--fast", "false"], ["--fast=on", "--fast=off"], ["--upstream-http-version", "http2"],
  ]) test(`rejects invalid edit options ${args.join(" ")}`, () => {
    expect(() => takeProviderEditSettings(args)).toThrow();
  });
});

describe("provider pacing", () => {
  test("read combines stored rules and runtime status on one pinned target", async () => {
    const rules = { enabled: false, requestsPerMinute: 0.5, models: { demo: { maxConcurrentRequests: 2 } } };
    const observed = { ...status, enabled: true, queued: 2, nextSlotInMs: 5, inFlight: 1, lastStartedAt: 100, lastModelId: "demo" };
    const f = fixture({ rules, status: observed });
    expect(await handleProviderPacingCommand(["fixture", "--json"], f.deps)).toBe(0);
    expect(parsedOutput()).toEqual({ provider: "fixture", rules, status: observed });
    expect(f.calls).toEqual([
      { url: "http://127.0.0.1:14001/api/config", method: "GET" },
      { url: "http://127.0.0.1:14001/api/provider-request-pacing?name=fixture", method: "GET" },
    ]);
    expect(f.resolutions()).toBe(1);
  });
  test("distinguishes absent from stored disabled rules", async () => {
    expect(await handleProviderPacingCommand(["fixture", "--json"], fixture().deps)).toBe(0);
    expect(parsedOutput()).toEqual({ provider: "fixture", rules: null, status });
    output.mockClear();
    expect(await handleProviderPacingCommand(["fixture"], fixture().deps)).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("no pacing rules configured");
    output.mockClear();
    expect(await handleProviderPacingCommand(["fixture", "--json"], fixture({ rules: { enabled: false } }).deps)).toBe(0);
    expect(parsedOutput()).toEqual({ provider: "fixture", rules: { enabled: false }, status });
  });
  test("scalar edits preserve observed models and do not implicitly enable", async () => {
    const f = fixture({ rules: { enabled: false, minIntervalMs: 250, models: { demo: { requestsPerMinute: 0.25 } } } });
    expect(await handleProviderPacingCommand(["fixture", "--rpm", "0.5", "--max-concurrent=3", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([
      { url: "http://127.0.0.1:14001/api/config", method: "GET" },
      { url: "http://127.0.0.1:14001/api/providers?name=fixture", method: "PATCH", body: {
        requestPacing: { enabled: false, minIntervalMs: 250, requestsPerMinute: 0.5, maxConcurrentRequests: 3, models: { demo: { requestsPerMinute: 0.25 } } },
      } },
    ]);
    expect(f.resolutions()).toBe(1);
  });
  test("missing rules start disabled; explicit enabled off remains false", async () => {
    const f = fixture();
    expect(await handleProviderPacingCommand(["fixture", "--min-interval-ms", "1"], f.deps)).toBe(0);
    expect(f.calls[1]?.body).toEqual({ requestPacing: { enabled: false, minIntervalMs: 1 } });
    const active = fixture({ rules: { enabled: true, requestsPerMinute: 10 } });
    expect(await handleProviderPacingCommand(["fixture", "--enabled", "off"], active.deps)).toBe(0);
    expect(active.calls[1]?.body).toEqual({ requestPacing: { enabled: false, requestsPerMinute: 10 } });
  });
  test("enable alone requires observed provider or model rules", async () => {
    const f = fixture();
    expect(await handleProviderPacingCommand(["fixture", "--enabled", "on"], f.deps)).toBe(2);
    expect(f.calls.map(call => call.method)).toEqual(["GET"]);
    const models = fixture({ rules: { enabled: false, models: { demo: { minIntervalMs: 2 } } } });
    expect(await handleProviderPacingCommand(["fixture", "--enabled", "on"], models.deps)).toBe(0);
    expect(models.calls[1]?.body).toEqual({ requestPacing: { enabled: true, models: { demo: { minIntervalMs: 2 } } } });
  });
  test("file is an exact replacement with zero reads", async () => {
    const rules = { enabled: false, models: { only: { maxConcurrentRequests: 1 } } };
    const f = fixture();
    expect(await handleProviderPacingCommand(["fixture", "--file", inputFile(rules), "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ url: "http://127.0.0.1:14001/api/providers?name=fixture", method: "PATCH", body: { requestPacing: rules } }]);
    expect(f.resolutions()).toBe(1);
  });
  test("explicit stdin uses the shared JSON reader", async () => {
    const f = fixture();
    const deps = { ...f.deps, stdinImpl: Readable.from(['{"enabled":false,"requestsPerMinute":0.5}']) };
    expect(await handleProviderPacingCommand(["fixture", "--file", "-", "--json"], deps)).toBe(0);
    expect(f.calls[0]?.body).toEqual({ requestPacing: { enabled: false, requestsPerMinute: 0.5 } });
  });
  for (const options of [
    ["--rpm", "0"], ["--rpm", "0.001"], ["--rpm", "60001"], ["--rpm", "Infinity"],
    ["--min-interval-ms", "0"], ["--min-interval-ms", "1.1"], ["--min-interval-ms", "3600001"],
    ["--max-concurrent", "0"], ["--max-concurrent", "9007199254740992"], ["--enabled", "false"],
    ["--rpm=1", "--rpm", "2"], ["--file"], ["--json", "--json"], ["--private=opaque-secret"],
    ["--file", "private-missing-file", "--rpm", "1"], ["--file", "private-missing-file", "--file=other"],
  ]) test(`invalid pacing options refuse before discovery: ${options[0]}`, async () => {
    const f = fixture();
    expect(await handleProviderPacingCommand(["fixture", ...options], f.deps)).toBe(2);
    expect(f.calls).toEqual([]); expect(f.resolutions()).toBe(0);
    expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(" ")).not.toContain("private-");
  });
  for (const rules of [null, false, [], {}, { enabled: true }, { enabled: false, requestsPerMinute: 0 }, { enabled: false, models: { demo: { maxConcurrentRequests: 0 } } }, { enabled: false, credential: "opaque-secret" }]) {
    test(`invalid complete rules refuse before discovery: ${JSON.stringify(rules)}`, async () => {
      const f = fixture();
      expect(await handleProviderPacingCommand(["fixture", "--file", inputFile(rules)], f.deps)).toBe(2);
      expect(f.calls).toEqual([]); expect(f.resolutions()).toBe(0);
      expect(errors.mock.calls.flat().join(" ")).not.toContain("opaque-secret");
    });
  }
  test("malformed JSON does not write or echo its contents", async () => {
    const path = home.path("bad.json"); writeFileSync(path, "opaque-secret{");
    const f = fixture();
    expect(await handleProviderPacingCommand(["fixture", "--file", path], f.deps)).toBe(2);
    expect(f.calls).toEqual([]); expect(f.resolutions()).toBe(0);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("opaque-secret");
  });
  for (const options of [
    { config: null }, { config: { providers: [] } }, { config: { providers: { fixture: false } } },
    { rules: null }, { rules: { enabled: false, models: { demo: {} } } },
    { status: { ...status, queued: -1 } }, { status: { ...status, provider: "other" } },
    { status: { ...status, extra: "opaque-secret" } }, { status: { ...status, enabled: 0 } },
  ]) test(`rejects malformed read response ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    expect(await handleProviderPacingCommand(["fixture", "--json"], f.deps)).toBe(1);
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(" ")).not.toContain("opaque-secret");
  });
  test("invalid stored rules stop a scalar write", async () => {
    const f = fixture({ rules: { enabled: false, requestsPerMinute: 0 } });
    expect(await handleProviderPacingCommand(["fixture", "--rpm", "1"], f.deps)).toBe(1);
    expect(f.calls.map(call => call.method)).toEqual(["GET"]);
  });
  test("missing provider is exit 4 and inherited provider keys are not accepted", async () => {
    const f = fixture({ config: { providers: {} } });
    expect(await handleProviderPacingCommand(["fixture", "--rpm", "1"], f.deps)).toBe(4);
    expect(f.calls.map(call => call.method)).toEqual(["GET"]);
    const inherited = fixture();
    expect(await handleProviderPacingCommand(["constructor"], inherited.deps)).toBe(2);
    expect(inherited.resolutions()).toBe(0);
  });
  test("partial saved receipt propagates exit 1 and retains safe output", async () => {
    const receipt = { success: true, catalogRefresh: { status: "skipped", reason: "busy", retryable: true } };
    const f = fixture({ receipt });
    expect(await handleProviderPacingCommand(["fixture", "--file", inputFile({ enabled: false }), "--json"], f.deps)).toBe(1);
    expect(parsedOutput()).toEqual(receipt);
    expect(f.calls).toHaveLength(1);
  });
  for (const http of [404, 409, 403, 500]) test(`HTTP ${http} does not retry or echo server content`, async () => {
    const f = fixture({ http });
    expect(await handleProviderPacingCommand(["fixture", "--file", inputFile({ enabled: false })], f.deps)).toBe(http === 404 ? 4 : http === 409 ? 5 : 1);
    expect(f.calls).toHaveLength(1); expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(" ")).not.toContain("private");
  });
  test("transport rejection is an unknown outcome, not a retry", async () => {
    const f = fixture({ failure: true });
    expect(await handleProviderPacingCommand(["fixture", "--file", inputFile({ enabled: false })], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(1); expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(" ")).not.toContain("private opaque");
  });
});
