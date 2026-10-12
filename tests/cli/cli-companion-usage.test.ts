import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCompanionUsageCommand } from "../../src/cli/companion-usage";
import { handleCompanionCommand } from "../../src/cli/companion";
import type { ObserveStreamDeps } from "../../src/cli/observe-stream";
import { DEFAULT_COMPANION_SETTINGS, loadCompanionSettings } from "../../src/companion/settings";
import { summarizeUsage } from "../../src/usage/summary";
import { filterUsage, measuredTotals, type TrayUsage } from "../../gui/src/pages/tray-data";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string, prior: string | undefined;
let out: ReturnType<typeof spyOn<typeof console, "log">>;
let err: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  prior = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-companion-usage-"));
  process.env.OPENCODEX_HOME = home;
  writeFileSync(join(home, "admin-api-token"), "synthetic-admin");
  out = spyOn(console, "log").mockImplementation(() => {});
  err = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  out.mockRestore(); err.mockRestore();
  if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
  removeTreeWithRetry(home);
});
const settings = { settings: { models: null, hiddenProviders: [] }, updatedAt: 100 };
const usage: TrayUsage = { summary: { requests: 8, totalTokens: 80, estimatedCostUsd: 8 }, models: [
  { provider: "a", model: "alpha", requests: 2, totalTokens: 20, estimatedCostUsd: 2, measuredRequests: 2, pricedRequests: 2 },
  { provider: "b", model: "beta", requests: 6, totalTokens: 60, estimatedCostUsd: 6, measuredRequests: 6, pricedRequests: 6 },
], customWindow: false, since: 10, until: 20, historyTruncated: true, entriesTruncated: false };
function output() { return JSON.parse(String(out.mock.calls[0]?.[0])); }
async function run(bodies: unknown[] = [settings, usage, usage], flags = ["--json"], extra: ObserveStreamDeps = {}) {
  const paths: string[] = [];
  const code = await handleCompanionUsageCommand(flags, { baseUrl: "http://fixture.test", ...extra, fetchImpl: (async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname + url.search);
    expect(init?.method).toBe("GET"); expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error");
    const body = bodies.shift();
    if (body instanceof Error) throw body;
    return Response.json(body);
  }) as typeof fetch });
  return { code, paths };
}

test("fixed sequential reads project safe DTO fields and preserve window/completeness metadata", async () => {
  const result = await run([settings, { ...usage, secret: "not-public", models: usage.models.map(row => ({ ...row, secret: "not-public" })) }, usage]);
  expect(result).toEqual({ code: 0, paths: ["/api/companion/settings", "/api/usage?range=today", "/api/usage?range=30d"] });
  expect(output()).toEqual({ schemaVersion: 1, filters: settings.settings, settingsUpdatedAt: 100, settingsCorrupt: false, settingsFallback: false,
    ranges: { today: { status: "available", data: usage }, "30d": { status: "available", data: usage } }, partial: false });
  expect(JSON.stringify(output())).not.toContain("not-public");
});

for (const filters of [
  { models: null, hiddenProviders: ["b"] }, { models: ["a/alpha"], hiddenProviders: [] },
  { models: ["alpha"], hiddenProviders: [] }, { models: [], hiddenProviders: [] },
  { models: ["A/alpha"], hiddenProviders: [] },
]) test(`saved filter parity ${JSON.stringify(filters)}`, async () => {
  expect((await run([{ settings: filters, updatedAt: 50 }, usage, usage])).code).toBe(0);
  const projected = output().ranges.today.data;
  const expected = filterUsage(usage, { ...DEFAULT_COMPANION_SETTINGS, ...filters });
  expect(projected).toEqual({ ...expected, summary: measuredTotals(expected.summary), models: expected.models.map(measuredTotals) });
  expect(projected.models.map((row: { provider: string }) => row.provider)).toEqual(filters.models?.length === 0 || filters.models?.[0] === "A/alpha" ? [] : ["a"]);
  expect(projected.summary).toEqual(projected.models.length ? { requests: 2, totalTokens: 20, estimatedCostUsd: 2, measuredRequests: 2, pricedRequests: 2 } : {});
});

test("unknown folded attribution remains incomplete; explicit empty selection has no invented zero", async () => {
  const data = { ...usage, models: [...usage.models, { provider: "other", model: "other", requests: 1 }] };
  expect((await run([{ settings: { models: null, hiddenProviders: ["b"] }, updatedAt: 5 }, data, data])).code).toBe(0);
  expect(output().ranges.today.data.summary).toEqual({});
  expect(output().ranges.today.data.usageIncomplete).toBe(true);
  expect(output().ranges.today.data.models.map((row: { provider: string }) => row.provider)).toEqual(["a"]);
});

test("unmeasured/unpriced and missing fields stay unknown on both summary and rows", async () => {
  const totals = { requests: 3, totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0, measuredRequests: 0, pricedRequests: 0, coverageRatio: 0 };
  const data = { summary: totals, models: [{ ...totals, provider: "a", model: "alpha" }, { provider: "b", model: "beta", requests: 0 }] };
  expect((await run([settings, data, data])).code).toBe(0);
  const actual = output().ranges.today.data;
  expect(actual.summary).toEqual({ requests: 3, measuredRequests: 0, pricedRequests: 0, coverageRatio: 0 });
  expect(actual.summary).toEqual(measuredTotals(totals));
  expect(actual.models[0]).toEqual({ ...actual.summary, provider: "a", model: "alpha" });
  expect(actual.models[1]).toEqual({ provider: "b", model: "beta", requests: 0 });
});

for (const corrupt of [false, true]) test(`actual defaults DTO with null timestamp (corrupt=${corrupt})`, async () => {
  if (corrupt) writeFileSync(join(home, "companion.json"), "{");
  const observed = loadCompanionSettings();
  expect(observed.updatedAt).toBeNull();
  expect((await run([observed, summarizeUsage([], "today", 1_700_000_000_000), usage])).code).toBe(0);
  expect(output().settingsUpdatedAt).toBeNull();
  expect(output().settingsFallback).toBe(true);
  expect(output().settingsCorrupt).toBe(corrupt);
  out.mockClear();
  expect((await run([observed, usage, usage], [])).code).toBe(0);
  expect(out.mock.calls.flat().join("\n").includes("WARNING:")).toBe(corrupt);
});

for (const bad of [null, {}, { ...settings, updatedAt: "1" }, { ...settings, corrupt: "true" }, { ...settings, settings: { models: 1, hiddenProviders: [] } }, { ...settings, settings: { models: [], hiddenProviders: [null] } }]) {
  test(`malformed settings stop before usage ${JSON.stringify(bad)}`, async () => {
    expect(await run([bad, usage, usage])).toEqual({ code: 1, paths: ["/api/companion/settings"] });
    expect(out).not.toHaveBeenCalled();
  });
}

for (const failed of [[true, false], [false, true], [true, true]]) test(`range failure ${failed}`, async () => {
  const reports = failed.map(fail => fail ? new Error("PRIVATE_RESPONSE") : usage);
  expect((await run([settings, ...reports])).code).toBe(1);
  expect(output().partial).toBe(true);
  expect(output().ranges.today.status).toBe(failed[0] ? "unavailable" : "available");
  expect(output().ranges["30d"].status).toBe(failed[1] ? "unavailable" : "available");
  expect(err.mock.calls.flat().join(" ")).toContain("Some companion usage ranges are unavailable");
  expect(err.mock.calls.flat().join(" ")).not.toContain("PRIVATE_RESPONSE");
});

for (const bad of [{}, { summary: {}, models: [null] }, { summary: { requests: "1" }, models: [] }, { summary: {}, models: [], until: "bad" }]) test("malformed usage is unavailable, never empty success", async () => {
  expect((await run([settings, bad, usage])).code).toBe(1);
  expect(output().ranges.today).toEqual({ status: "unavailable" });
});

for (const flags of [["--json", "--json"], ["--range", "all"], ["--url", "http://fixture.test"], ["--follow"]]) test(`invalid flags before I/O ${flags}`, async () => {
  expect(await run([], flags)).toEqual({ code: 2, paths: [] });
  expect(out).not.toHaveBeenCalled();
});

test("interruption between ranges suppresses output, preserves exit130 and cleans listeners", async () => {
  const controller = new AbortController(); let calls = 0;
  const listeners = process.listenerCount("SIGINT");
  const code = await handleCompanionUsageCommand(["--json"], { baseUrl: "http://fixture.test", signal: controller.signal,
    fetchImpl: (async () => { calls++; if (calls === 2) controller.abort(); return Response.json(calls === 1 ? settings : usage); }) as typeof fetch });
  expect(code).toBe(130); expect(calls).toBe(2); expect(out).not.toHaveBeenCalled();
  expect(process.listenerCount("SIGINT")).toBe(listeners);
});

test("runtime replacement after settings cannot fetch the replacement or mix ranges", async () => {
  let discovers = 0, requests = 0;
  const code = await handleCompanionUsageCommand(["--json"], {
    findLiveProxy: async () => ({ pid: ++discovers === 1 ? 111 : 222, port: 10100, hostname: "127.0.0.1", source: "runtime" }),
    fetchImpl: (async () => { requests++; return Response.json(settings); }) as typeof fetch,
  });
  expect(code).toBe(1); expect(requests).toBe(1);
  expect(output().partial).toBe(true);
  expect(output().ranges.today.status).toBe("unavailable");
  expect(output().ranges["30d"].status).toBe("unavailable");
});

test("companion dispatch retains partial numeric result and human unknown metrics", async () => {
  let calls = 0;
  expect(await handleCompanionCommand(["usage"], { baseUrl: "http://fixture.test", fetchImpl: (async () => {
    calls++;
    if (calls === 1) return Response.json(settings);
    if (calls === 2) return Response.json({ summary: {}, models: [] });
    throw new Error("private");
  }) as typeof fetch })).toBe(1);
  const text = out.mock.calls.flat().join("\n");
  expect(text).toContain("Today: unknown requests; unknown tokens; cost unknown");
  expect(text).toContain("30 days: unavailable");
});

test("preabort and SIGTERM retain signal exits without late output", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const deps = { baseUrl: "http://fixture.test", fetchImpl: (async () => {
    calls++; process.emit("SIGTERM"); return Response.json(settings);
  }) as typeof fetch };
  expect(await handleCompanionCommand(["usage", "--json"], { ...deps, signal: controller.signal })).toBe(130);
  expect(calls).toBe(0);
  expect(await handleCompanionCommand(["usage", "--json"], deps)).toBe(143);
  expect(calls).toBe(1); expect(out).not.toHaveBeenCalled();
});

test("connected-client management refuses before any transport", async () => {
  let calls = 0;
  expect(await handleCompanionUsageCommand(["--json"], {
    findLiveProxy: async () => ({ pid: 111, port: 10100, source: "runtime", role: "client" }),
    fetchImpl: (async () => { calls++; return Response.json(settings); }) as typeof fetch,
  })).toBe(1);
  expect(calls).toBe(0); expect(out).not.toHaveBeenCalled();
});
