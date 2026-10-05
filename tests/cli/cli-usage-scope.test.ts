import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleObserveCommand } from "../../src/cli/observe";
import { ManagementRequest } from "../helpers/management-auth";
import { handleManagementAPI } from "../../src/server/management-api";
import { resetUsageAggregateCacheForTests } from "../../src/server/management/usage-aggregate-cache";
import { resetUsageReadCacheForTests } from "../../src/usage/log";
import * as serviceSecrets from "../../src/lib/service-secrets";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

let home: string;
let prior: string | undefined;
let out: ReturnType<typeof spyOn<typeof console, "log">>;
let err: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  prior = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-usage-scope-")); process.env.OPENCODEX_HOME = home;
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai", runtimeRole: "hub" }));
  out = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
  resetUsageAggregateCacheForTests(); resetUsageReadCacheForTests();
});
afterEach(() => {
  out.mockRestore(); err.mockRestore(); resetUsageAggregateCacheForTests(); resetUsageReadCacheForTests();
  if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
  removeTreeWithRetry(home);
});
const report = (apiKeyId: string | null = "Key-A") => ({
  range: "all", surface: "all", since: null, summary: { requests: 0, totalTokens: 0 },
  filter: { apiKeyId, provider: null, model: null, matched: false, comboOverlap: false },
});

test("exact trimmed key scope is encoded alongside existing filters and acknowledged unchanged", async () => {
  const body = { ...report(), customWindow: true, since: 10, until: 20, usageIncomplete: true };
  expect(await handleObserveCommand(["usage", "--api-key-id= Key-A ", "--range", "all", "--surface", "codex", "--provider", "fixture", "--model", "model/one", "--since", "10", "--until", "20", "--json"], {
    baseUrl: "http://fixture.test",
    fetchImpl: (async (input, init) => {
      expect(Object.fromEntries(new URL(String(input)).searchParams)).toEqual({ range: "all", surface: "codex", provider: "fixture", model: "model/one", apiKeyId: "Key-A", since: "10", until: "20" });
      expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
      return Response.json(body);
    }) as typeof fetch,
  })).toBe(0);
  expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(body);
});

for (const body of [null, {}, { ...report(), filter: undefined }, report(null), report("key-a"), report("Key-B"), { ...report(), filter: { apiKeyId: ["Key-A"] } }]) {
  test(`missing or wrong acknowledgment cannot become a selected-key success: ${JSON.stringify(body)}`, async () => {
    expect(await handleObserveCommand(["usage", "--api-key-id", "Key-A", "--json"], { baseUrl: "http://fixture.test",
      fetchImpl: (async () => Response.json(body)) as typeof fetch })).toBe(1);
    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join("\n")).toContain("did not confirm");
  });
}

for (const flags of [["--api-key-id", " "], ["--api-key-id="], ["--api-key-id", "x", "--api-key-id", "y"]]) {
  test(`invalid key-scope input stops before transport: ${flags.join(" ")}`, async () => {
    let calls = 0;
    expect(await handleObserveCommand(["usage", ...flags], { fetchImpl: (async () => { calls++; return Response.json(report()); }) as typeof fetch })).toBe(2);
    expect(calls).toBe(0); expect(out).not.toHaveBeenCalled();
  });
}

test("connected clients reject scope before token read, discovery and transport", async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai", runtimeRole: "client", client: {
    serverUrl: "https://hub.example.test", managementUrl: "https://manage.example.test", managementTransport: "direct", selectedClients: ["claude"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "own", tokenFingerprint: "a".repeat(64), protocolVersion: 1, connectedAt: "2026-09-01T00:00:00.000Z",
  } }));
  const token = spyOn(serviceSecrets, "readServiceApiTokenState").mockImplementation(() => { throw new Error("MUST NOT READ"); });
  let requests = 0, discoveries = 0;
  try {
    expect(await handleObserveCommand(["usage", "--api-key-id", "other", "--json"], {
      findLiveProxy: async () => { discoveries++; return null; },
      fetchImpl: (async () => { requests++; return Response.json(report()); }) as typeof fetch,
    })).toBe(2);
    expect(token).not.toHaveBeenCalled(); expect(requests).toBe(0); expect(discoveries).toBe(0);
    expect(out).not.toHaveBeenCalled(); expect(err.mock.calls.flat().join("\n")).toContain("unavailable on connected clients");
  } finally { token.mockRestore(); }
});

test("human heading and empty/incomplete messages identify the scoped key safely", async () => {
  const key = "Key-\u001b[31mA";
  expect(await handleObserveCommand(["usage", "--api-key-id", key], { baseUrl: "http://fixture.test",
    fetchImpl: (async () => Response.json({ ...report(key), usageIncomplete: true })) as typeof fetch })).toBe(0);
  const text = out.mock.calls.flat().join("\n");
  expect(text).toContain("api-key-id=Key-\\x1b[31mA");
  expect(text).toContain('API key "Key-\\x1b[31mA"'); expect(text).toContain("skipped records may contain matches");
  expect(text).not.toContain("\u001b");
});

test("unknown acknowledged key remains an empty success, not a missing-resource error", async () => {
  expect(await handleObserveCommand(["usage", "--api-key-id", "Key-A"], { baseUrl: "http://fixture.test",
    fetchImpl: (async () => Response.json(report())) as typeof fetch })).toBe(0);
  expect(out.mock.calls.flat().join("\n")).toContain('No usage recorded for API key "Key-A"');
});

test("key-scoped server errors and fetch exceptions never echo raw bodies", async () => {
  for (const throws of [false, true]) {
    err.mockClear();
    expect(await handleObserveCommand(["usage", "--api-key-id", "Key-A", "--json"], { baseUrl: "http://fixture.test",
      fetchImpl: (async () => { if (throws) throw new Error("CANARY"); return Response.json({ error: "CANARY" }, { status: 500 }); }) as typeof fetch })).toBe(1);
    expect(err.mock.calls.flat().join("\n")).not.toContain("CANARY"); expect(out).not.toHaveBeenCalled();
  }
});

test("key scope refuses redirects before any destination request", async () => {
  let requests = 0;
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { requests++; return Response.json(report()); } });
  const source = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.redirect(`${target.url}steal`, 302) });
  try {
    expect(await handleObserveCommand(["usage", "--api-key-id", "Key-A"], { baseUrl: source.url.origin })).toBe(1);
    expect(requests).toBe(0); expect(out).not.toHaveBeenCalled();
  } finally { await source.stop(true); await target.stop(true); }
});

test("real management usage owner preserves exact-key projection and unknown-key acknowledgement", async () => {
  const now = Date.now();
  const entries = [
    { requestId: "one", timestamp: now, apiKeyId: "Key-A", provider: "fixture", model: "m", status: 200, durationMs: 1, totalTokens: 7, usageStatus: "reported", usage: { inputTokens: 4, outputTokens: 3 } },
    { requestId: "two", timestamp: now, apiKeyId: "key-a", provider: "fixture", model: "m", status: 200, durationMs: 1, totalTokens: 99, usageStatus: "reported", usage: { inputTokens: 90, outputTokens: 9 } },
  ];
  writeFileSync(join(home, "usage.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const config: OcxConfig = { providers: {}, defaultProvider: "fixture", runtimeRole: "hub", port: 0 };
  for (const [key, requests, tokens, matched] of [["Key-A", 1, 7, true], ["key-a", 1, 99, true], ["unknown", 0, 0, false]] as const) {
    out.mockClear();
    expect(await handleObserveCommand(["usage", "--range", "all", "--api-key-id", key, "--json"], {
      baseUrl: "http://localhost",
      fetchImpl: (async (input, init) => {
        const url = new URL(String(input));
        const response = await handleManagementAPI(new ManagementRequest(url, init), url, config);
        expect(response?.status).toBe(200);
        return response!;
      }) as typeof fetch,
    })).toBe(0);
    const body = JSON.parse(String(out.mock.calls[0]![0]));
    expect(body.summary.requests).toBe(requests); expect(body.summary.totalTokens).toBe(tokens);
    expect(body.filter.apiKeyId).toBe(key); expect(body.filter.matched).toBe(matched);
  }
});


test("key-scoped usage preserves the stopped-proxy prerequisite before transport", async () => {
  let requests = 0;
  expect(await handleObserveCommand(["usage", "--api-key-id", "Key-A", "--json"], {
    findLiveProxy: async () => null,
    fetchImpl: async () => { requests++; throw new Error("must not send"); },
  })).toBe(1);
  expect(requests).toBe(0); expect(out).not.toHaveBeenCalled();
  expect(err.mock.calls.flat().join("\n")).toBe("Error: Proxy is not running. Start the intended proxy with: ocx start. No request was sent.");
});
