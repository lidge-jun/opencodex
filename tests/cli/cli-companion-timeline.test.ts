import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { handleCompanionCommand } from "../../src/cli/companion";
import { handleCompanionTimelineCommand } from "../../src/cli/companion-timeline";
import { handleUsageTimelineRoutes } from "../../src/server/management/usage-timeline-routes";
import { createTimelineAccumulator, parseTimelineQuery, type UsageTimeline } from "../../src/usage/timeline";
import type { PersistedUsageEntry } from "../../src/usage/log";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const realFetch = globalThis.fetch;
let home: TempHome, out: ReturnType<typeof spyOn>, err: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let admin: string | undefined;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
beforeEach(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_700_006_399_000);
  home = createTempHome("ocx-cli-timeline-"); admin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "synthetic-timeline-admin";
  out = spyOn(console, "log").mockImplementation(() => {}); err = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Unowned network forbidden"); });
});
afterEach(() => {
  clock.mockRestore();
  expect(network).not.toHaveBeenCalled(); network.mockRestore(); out.mockRestore(); err.mockRestore();
  if (admin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = admin;
  home.remove();
});
const stdout = () => out.mock.calls.flat().join("\n");
const stderr = () => err.mock.calls.flat().join("\n");
function timeline(): UsageTimeline {
  return { appliedFilters: { models: null, hiddenProviders: [] }, start: 1_699_920_000, end: 1_700_006_400,
    bucketSeconds: 3600, buckets: 24, metric: "total", aggregation: "sum", grouping: "model", series: [],
    availableModels: [], missingMeasurements: 0, truncated: false };
}
function fixture(reply: unknown = timeline()) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const deps: RuntimeApiDeps = { baseUrl: "http://fixture.invalid", fetchImpl: async (input, init) => {
    calls.push({ url: new URL(String(input)), init }); return reply instanceof Response ? reply : Response.json(reply);
  } };
  return { calls, deps };
}
function generatedFixture(entries: PersistedUsageEntry[] = []) {
  const calls: URL[] = [];
  const deps: RuntimeApiDeps = { baseUrl: "http://fixture.invalid", fetchImpl: async (input, init) => {
    const url = new URL(String(input)); calls.push(url); expect(init?.redirect).toBe("error");
    const query = parseTimelineQuery(url.searchParams, Date.now());
    if ("error" in query) return Response.json(query, { status: 400 });
    const acc = createTimelineAccumulator(query); for (const entry of entries) acc.add(entry);
    return Response.json(acc.finish());
  } };
  return { deps, calls };
}
function entry(overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
  return { requestId: "fixture-request", timestamp: Date.now() - 1000, provider: "fixture", model: "model", status: 200,
    durationMs: 1, usageStatus: "reported", totalTokens: 7, ...overrides };
}
describe("companion timeline", () => {
  test.each([-3600, -7200, -86400, 7200])("rejects aligned but stale or future end offset %i", async offset => {
    const raw = timeline(); raw.start += offset; raw.end += offset;
    expect(await handleCompanionTimelineCommand(["--json"], fixture(raw).deps)).toBe(1);
    expect(stdout()).toBe("");
  });
  test.each([false, true])("adjacent bucket requires a real request-time rollover: %s", async rollover => {
    const raw = timeline(); raw.start += 3600; raw.end += 3600;
    const deps: RuntimeApiDeps = { baseUrl: "http://fixture.invalid", fetchImpl: async () => {
      if (rollover) clock.mockReturnValue(1_700_006_401_000);
      return Response.json(raw);
    } };
    expect(await handleCompanionTimelineCommand(["--json"], deps)).toBe(rollover ? 0 : 1);
    if (!rollover) expect(stdout()).toBe("");
  });
  test("public companion entry returns numeric result and empty metadata remains intact", async () => {
    const f = fixture({ ...timeline(), private: "private-canary" });
    expect(await handleCompanionCommand(["timeline", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(stdout())).toEqual(timeline()); expect(f.calls).toHaveLength(1);
    expect(String(f.calls[0]!.url)).toBe("http://fixture.invalid/api/usage/timeline");
    expect(f.calls[0]!.init).toMatchObject({ method: "GET", redirect: "error" }); expect(f.calls[0]!.init?.body).toBeUndefined();
    expect(new Headers(f.calls[0]!.init?.headers).get("x-opencodex-api-key")).toBe("synthetic-timeline-admin"); expect(stderr()).toBe("");
    out.mockClear(); expect(await handleCompanionTimelineCommand([], f.deps)).toBe(0);
    expect(stdout()).toContain("No matching series"); expect(stdout()).toContain("24 × 3600 seconds"); expect(stdout()).toContain("Missing measurements: 0; truncated: false");
  });
  test("flags map to actual parser with nested IDs and repeated exclusions in both option spellings", async () => {
    const f = generatedFixture([entry({ provider: "github-models", model: "openai/model", usage: { inputTokens: 2, outputTokens: 3 } })]);
    expect(await handleCompanionTimelineCommand(["--hours=6", "--bucket-minutes", "15", "--metric=input", "--aggregation", "average",
      "--grouping=modelAccount", "--model", "github-models/openai/model", "--model=fixture/model", "--hide-provider", "z", "--hide-provider=a", "--json"], f.deps)).toBe(0);
    expect(Object.fromEntries(f.calls[0]!.searchParams)).toEqual({ hours: "6", bucketMinutes: "15", metric: "input", aggregation: "average", grouping: "modelAccount",
      models: "github-models/openai/model,fixture/model", hiddenProvider: "a" });
    expect(f.calls[0]!.searchParams.getAll("hiddenProvider")).toEqual(["z", "a"]);
    const result = JSON.parse(stdout());
    expect(result.appliedFilters).toEqual({ models: ["fixture/model", "github-models/openai/model"], hiddenProviders: ["a", "z"] });
    expect(result.series[0]).toMatchObject({ id: "github-models/openai/model · unknown", total: 2, accountLogLabel: "unknown" });
    expect(result.series[0].points).toHaveLength(24);
  });
  test.each(["total", "input", "output", "cached"] as const)("all metric enums reach actual accumulator: %s", async metric => {
    const f = generatedFixture([entry({ totalTokens: 9, usage: { inputTokens: 5, outputTokens: 4, cachedInputTokens: 2 } })]);
    expect(await handleCompanionTimelineCommand(["--metric", metric, "--json"], f.deps)).toBe(0);
    expect(JSON.parse(stdout()).series[0].total).toBe({ total: 9, input: 5, output: 4, cached: 2 }[metric]);
  });
  test.each(["sum", "average", "max"] as const)("aggregation survives real accumulator: %s", async aggregation => {
    const f = generatedFixture([entry({ requestId: "one", totalTokens: 2 }), entry({ requestId: "two", totalTokens: 4 })]);
    expect(await handleCompanionTimelineCommand(["--aggregation", aggregation, "--json"], f.deps)).toBe(0);
    expect(JSON.parse(stdout()).series[0].total).toBe({ sum: 6, average: 3, max: 4 }[aggregation]);
  });
  test("pool aliases retain exact applied filter while actual series uses its normalized provider", async () => {
    const f = generatedFixture([entry({ provider: "openai-pabcdef", model: "model" })]);
    expect(await handleCompanionTimelineCommand(["--model", "openai-pabcdef/model", "--json"], f.deps)).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ appliedFilters: { models: ["openai-pabcdef/model"] }, series: [{ id: "openai/model", total: 7 }] });
  });
  test("missing measurements and truncated evidence never become complete-zero claims", async () => {
    const raw = timeline(); raw.missingMeasurements = 2; raw.truncated = true;
    raw.series = [{ id: "fixture/model", provider: "fixture", model: "model", total: 0, points: Array(24).fill(0) }];
    raw.availableModels = ["fixture/model"];
    expect(await handleCompanionTimelineCommand([], fixture(raw).deps)).toBe(0);
    expect(stdout()).toContain("Missing measurements: 2; truncated: true"); expect(stdout()).toContain("zeros do not establish zero usage");
    out.mockClear(); expect(await handleCompanionTimelineCommand(["--json"], fixture(raw).deps)).toBe(0); expect(JSON.parse(stdout())).toEqual(raw);
  });
  test("model-account and folded other rows match actual producer", async () => {
    const f = generatedFixture(Array.from({ length: 25 }, (_, i) => entry({ model: `model${i}`, accountLogLabel: `account${i}`, totalTokens: i + 1 })));
    expect(await handleCompanionTimelineCommand(["--grouping", "modelAccount", "--json"], f.deps)).toBe(0);
    const result = JSON.parse(stdout()); expect(result.series).toHaveLength(24); expect(result.series.at(-1)).toMatchObject({ id: "other", provider: "", model: "other", total: 3 });
  });
  test.each([
    ["--provider", "private-canary"], ["--hours", "12"], ["--bucket-minutes", "0"], ["--bucket-minutes", "1441"], ["--bucket-minutes", "1.5"],
    ["--hours", "168", "--bucket-minutes", "1"], ["--metric", "invalid"], ["--aggregation", "invalid"], ["--grouping", "invalid"],
    ["--model", "no-slash"], ["--model", "fixture/model,other/model"], ["--model", ""], ["--hide-provider", "two words"], ["--hide-provider="],
    ["--hours=6", "--hours", "24"], ["--json", "--json"], ["--json=true"], ["--unknown=private-canary"],
  ].map(args => [args]))("invalid options fail before transport %#", async args => {
    const f = fixture(); expect(await handleCompanionCommand(["timeline", ...args], f.deps)).toBe(2);
    expect(f.calls).toHaveLength(0); expect(stdout()).toBe(""); expect(stderr()).not.toContain("private-canary");
  });
  test.each(["--model", "--hide-provider"])("100-item limit counts repeated input before dedup: %s", async flag => {
    const value = flag === "--model" ? "fixture/model" : "fixture";
    const accepted = generatedFixture();
    expect(await handleCompanionTimelineCommand([...Array.from({ length: 100 }, () => [flag, value]).flat(), "--json"], accepted.deps)).toBe(0);
    out.mockClear(); const refused = fixture();
    expect(await handleCompanionTimelineCommand(Array.from({ length: 101 }, () => [flag, value]).flat(), refused.deps)).toBe(2);
    expect(refused.calls).toHaveLength(0); expect(stdout()).toBe("");
  });
  test("bucket boundary accepts 168 hours / 6 minutes and rejects / 5 minutes", async () => {
    const good = generatedFixture(); expect(await handleCompanionTimelineCommand(["--hours", "168", "--bucket-minutes", "6", "--json"], good.deps)).toBe(0);
    expect(JSON.parse(stdout()).buckets).toBe(1680); out.mockClear(); const bad = fixture();
    expect(await handleCompanionTimelineCommand(["--hours", "168", "--bucket-minutes", "5"], bad.deps)).toBe(2); expect(bad.calls).toHaveLength(0);
  });
  test.each([
    null, {}, [], { ...timeline(), start: 1 }, { ...timeline(), end: timeline().end * 1000 }, { ...timeline(), bucketSeconds: 60 },
    { ...timeline(), buckets: 23 }, { ...timeline(), metric: ["total"] }, { ...timeline(), aggregation: "max" }, { ...timeline(), grouping: "modelAccount" },
    { ...timeline(), missingMeasurements: -1 }, { ...timeline(), truncated: 0 }, { ...timeline(), availableModels: ["no-slash"] },
    { ...timeline(), appliedFilters: { models: [], hiddenProviders: [] } },
    { ...timeline(), appliedFilters: { models: null, hiddenProviders: ["unexpected"] } },
    { ...timeline(), series: [{ id: "fixture/model", provider: "fixture", model: "model", total: 1, points: Array(24).fill(0) }] },
    { ...timeline(), series: [{ id: "fixture/model", provider: "fixture", model: "model", total: 0, points: Array(23).fill(0) }] },
    { ...timeline(), series: [{ id: "wrong-id", provider: "fixture", model: "model", total: 0, points: Array(24).fill(0) }] },
  ].map(raw => [raw]))("reject malformed metadata or unacknowledged filters %#", async raw => {
    expect(await handleCompanionTimelineCommand(["--json"], fixture(raw).deps)).toBe(1); expect(stdout()).toBe("");
  });
  test("acknowledged filters cannot hide out-of-scope series or a mismatched available-model roster", async () => {
    const raw = timeline(); raw.appliedFilters.models = ["fixture/selected"];
    raw.availableModels = ["fixture/other"]; raw.series = [{ id: "fixture/other", provider: "fixture", model: "other", total: 0, points: Array(24).fill(0) }];
    expect(await handleCompanionTimelineCommand(["--model=fixture/selected", "--json"], fixture(raw).deps)).toBe(1); expect(stdout()).toBe("");
    raw.appliedFilters.models = null; raw.availableModels = [];
    expect(await handleCompanionTimelineCommand(["--json"], fixture(raw).deps)).toBe(1); expect(stdout()).toBe("");
  });
  test("projected series preserve human-safe labels and strip unknown properties", async () => {
    const raw = timeline(); raw.grouping = "modelAccount"; raw.availableModels = ["fixture/model"];
    raw.series = [{ id: "fixture/model · account\u001b[31m", provider: "fixture", model: "model", accountLogLabel: "account\u001b[31m", total: 0, points: Array(24).fill(0) }];
    const body = { ...raw, series: raw.series.map(row => ({ ...row, private: "private-canary" })) };
    expect(await handleCompanionTimelineCommand(["--grouping=modelAccount"], fixture(body).deps)).toBe(0);
    expect(stdout()).not.toContain("\u001b"); expect(stdout()).toContain("\\x1b[31m"); expect(stdout()).not.toContain("private-canary");
    out.mockClear(); expect(await handleCompanionTimelineCommand(["--grouping=modelAccount", "--json"], fixture(body).deps)).toBe(0);
    expect(JSON.parse(stdout())).toEqual(raw);
  });
  test("selected filters must be acknowledged before output", async () => {
    const f = fixture(); expect(await handleCompanionTimelineCommand(["--model=fixture/model", "--json"], f.deps)).toBe(1); expect(stdout()).toBe("");
  });
  test.each([401, 403, 404, 409, 500, 503])("safe HTTP %i refusal preserves numeric exit", async status => {
    expect(await handleCompanionCommand(["timeline", "--json"], fixture(Response.json({ error: "private-canary\u001b[31m" }, { status })).deps))
      .toBe(status === 404 ? 4 : status === 409 ? 5 : 1);
    expect(stdout()).toBe(""); expect(stderr()).not.toContain("private-canary");
  });
  test.each([301, 302, 303, 307, 308])("real redirect %i reaches no second endpoint", async status => {
    let first = 0, second = 0;
    const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { second++; return Response.json(timeline()); } });
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
      first++; expect(req.headers.get("x-opencodex-api-key")).toBe("synthetic-timeline-admin");
      return new Response(null, { status, headers: { Location: String(destination.url) } });
    } });
    try {
      expect(await handleCompanionCommand(["timeline", "--json"], { baseUrl: String(origin.url), fetchImpl: realFetch })).toBe(1);
      expect(first).toBe(1); expect(second).toBe(0); expect(stdout()).toBe("");
    } finally { await origin.stop(true); await destination.stop(true); }
  });
  test("real timeline route reads synthetic usage, excludes providers and preserves missing evidence", async () => {
    writeFileSync(home.path("usage.jsonl"), [entry({ provider: "wp7-timeline-real", totalTokens: 7 }),
      entry({ provider: "wp7-timeline-real", requestId: "missing", totalTokens: undefined, usageStatus: "unreported" }),
      entry({ provider: "wp7-hidden", totalTokens: 900 })].map(row => JSON.stringify(row)).join("\n") + "\n");
    const deps: RuntimeApiDeps = { baseUrl: "http://fixture.invalid", fetchImpl: async (input, init) => {
      const req = new Request(input, init);
      const result = await handleUsageTimelineRoutes({ req, url: new URL(req.url), config: { port: 0, defaultProvider: "fixture", providers: {} },
        deps: {}, version: "fixture", trustedLoopbackIngress: true, guiSessionIssuance: null,
        convergeCodexCatalog: async () => { throw new Error("No convergence allowed"); }, syncClaudeAgentDefsBestEffort: async () => { throw new Error("No sync allowed"); } });
      if (!result) throw new Error("Owner did not handle route"); return result;
    } };
    expect(await handleCompanionCommand(["timeline", "--hours=6", "--hide-provider=wp7-hidden", "--model=wp7-timeline-real/model", "--json"], deps)).toBe(0);
    const result = JSON.parse(stdout()); expect(result.series).toHaveLength(1); expect(result.series[0].total).toBe(7);
    expect(result.missingMeasurements).toBe(1); expect(result.truncated).toBe(false);
    expect(result.availableModels).toEqual(["wp7-timeline-real/model"]); expect(result.bucketSeconds).toBe(3600); expect(result.buckets).toBe(6);
  });
});
