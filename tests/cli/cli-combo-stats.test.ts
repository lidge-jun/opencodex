import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleComboStatsCommand } from "../../src/cli/combo-stats";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createJevStatsAccumulator } from "../../src/usage/jev-stats";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let token: string | undefined;
let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
let network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-combo-stats-");
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
function statistics(id = "stored", range = "30d", observed = true) {
  const accumulator = createJevStatsAccumulator({ comboId: id, since: range === "all" ? null : 100 });
  if (observed) accumulator.add({
    requestId: "fixture-request", timestamp: 200, provider: "combo", model: `combo/${id}`, status: 200,
    durationMs: 80, usageStatus: "reported",
    jevDecision: { version: 1, comboId: id, backend: "model", selected: { provider: "fixture", model: "org/model", effort: "high" }, gate: "apply", latencyMs: 12,
      confidence: 0.75, chosenProbability: 0.5, usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
    attempts: [{ ordinal: 1, provider: "fixture", model: "org/model", adapter: "test", status: 200, durationMs: 20, sendCount: 1, recoveryKinds: [],
      usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 5 }, totalTokens: 15 }],
  });
  return { ...accumulator.summarize(range, 300), historyTruncated: false, truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0 };
}
function fixture(reply: unknown = statistics(), status = 200) {
  const calls: Array<{ url: string; method: string }> = [];
  let resolutions = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => ({ pid: null, port: 15000 + ++resolutions, source: "runtime" }),
    fetchImpl: (async (input, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).has("X-OpenCodex-API-Key")).toBe(false);
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return Response.json(reply, { status });
    }) as typeof fetch,
  };
  return { deps, calls, resolutions: () => resolutions };
}
function json() { return JSON.parse(String(output.mock.calls[0]?.[0])); }

describe("combo stats read-only observations", () => {
  test("pins once and sends only the exact stored ID, JEV selector and default range", async () => {
    const f = fixture();
    expect(await handleComboStatsCommand(["stored", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ url: "http://127.0.0.1:15001/api/usage?jev=1&comboId=stored&range=30d", method: "GET" }]);
    expect(f.resolutions()).toBe(1);
    expect(json()).toEqual(statistics());
    expect(json().summary).toMatchObject({ decisions: 1, appliedDecisions: 1, successfulRequests: 1,
      modelAttempts: 1, measuredModelAttempts: 1, modelInputTokens: 10, modelOutputTokens: 5, modelTotalTokens: 15,
      decisionUsageReported: 1, decisionTotalTokens: 4, averageLatencyMs: 12, averageConfidence: 0.75, averageChosenProbability: 0.5 });
    expect(json()).not.toHaveProperty("savings");
    expect(json()).not.toHaveProperty("cost");
  });
  for (const range of ["7d", "30d", "all"]) test(`supports explicit ${range}`, async () => {
    const id = "raw/id+%name";
    const f = fixture(statistics(id, range));
    expect(await handleComboStatsCommand([id, `--range=${range}`, "--json"], f.deps)).toBe(0);
    const query = new URL(f.calls[0]!.url).searchParams;
    expect([...query.keys()]).toEqual(["jev", "comboId", "range"]);
    expect(query.get("comboId")).toBe(id);
    expect(json().comboId).toBe(id);
  });
  test("retains measured zero versus nullable averages and does not invent missing measurements", async () => {
    const f = fixture(statistics("stored", "30d", false));
    expect(await handleComboStatsCommand(["stored", "--json"], f.deps)).toBe(0);
    expect(json().summary).toMatchObject({ decisions: 0, modelAttempts: 0, modelTotalTokens: 0,
      averageLatencyMs: null, averageConfidence: null, averageChosenProbability: null });
    expect(json().snapshotWindowStart).toBeNull();
    expect(json()).not.toHaveProperty("usageIncomplete");
  });
  test("human empty output explains unavailable averages", async () => {
    expect(await handleComboStatsCommand(["stored"], fixture(statistics("stored", "30d", false)).deps)).toBe(0);
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("No recorded JEV decisions");
    expect(text).toContain("unavailable");
    expect(text).toContain("measured attempts: 0/0");
  });
  test("incomplete observations remain visible and return a successful read", async () => {
    const reply = { ...statistics(), usageIncomplete: true, usageIncompleteReason: "oversized_rows", entriesTruncated: true, entriesDropped: 3 };
    expect(await handleComboStatsCommand(["stored", "--json"], fixture(reply).deps)).toBe(0);
    expect(json()).toMatchObject({ usageIncomplete: true, usageIncompleteReason: "oversized_rows", entriesTruncated: true, entriesDropped: 3 });
    output.mockClear();
    expect(await handleComboStatsCommand(["stored"], fixture(reply).deps)).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("History is incomplete");
  });
  test("drops undeclared body fields including invented savings or arbitrary payload", async () => {
    const reply = { ...statistics(), savings: 123, private: "opaque", summary: { ...statistics().summary, cost: 999, private: "opaque" } };
    expect(await handleComboStatsCommand(["stored", "--json"], fixture(reply).deps)).toBe(0);
    expect(json()).toEqual(statistics());
  });
  test("retains overflow model bucket and nullable effort", async () => {
    const reply = statistics();
    reply.models[0] = { ...reply.models[0]!, provider: "", model: "", overflow: true, efforts: [{ effort: null, picks: 1 }] };
    expect(await handleComboStatsCommand(["stored", "--json"], fixture(reply).deps)).toBe(0);
    expect(json().models[0]).toMatchObject({ provider: "", model: "", overflow: true, efforts: [{ effort: null, picks: 1 }] });
  });
  for (const args of [[], [" "], [" stored"], ["stored "], ["x".repeat(129)], ["bad\nname"],
    ["stored", "--range", "24h"], ["stored", "--range"], ["stored", "--range=7d", "--range=all"],
    ["stored", "--json", "--json"], ["stored", "extra"], ["stored", "--range="], ["--json"],
  ]) test(`invalid syntax refuses before target discovery: ${JSON.stringify(args).slice(0, 70)}`, async () => {
    const f = fixture();
    expect(await handleComboStatsCommand(args, f.deps)).toBe(2);
    expect(f.resolutions()).toBe(0);
    expect(f.calls).toEqual([]);
    expect(output).not.toHaveBeenCalled();
  });
  const malformed: Array<[string, (reply: Record<string, unknown>) => void]> = [
    ["wrong identity", reply => { reply.comboId = "another"; }],
    ["wrong range", reply => { reply.range = "all"; }],
    ["missing summary", reply => { delete reply.summary; }],
    ["missing count", reply => { delete (reply.summary as Record<string, unknown>).modelTotalTokens; }],
    ["negative count", reply => { (reply.summary as Record<string, unknown>).decisions = -1; }],
    ["nullable count", reply => { (reply.summary as Record<string, unknown>).decisions = null; }],
    ["missing average", reply => { delete (reply.summary as Record<string, unknown>).averageLatencyMs; }],
    ["invalid probability", reply => { (reply.summary as Record<string, unknown>).averageConfidence = 1.5; }],
    ["invalid model", reply => { reply.models = [{ provider: "private" }]; }],
    ["invalid gate", reply => { reply.gates = [{ gate: "private", decisions: 1 }]; }],
    ["invalid backend", reply => { reply.backends = [{ backend: "private", decisions: 1, applied: 1, averageLatencyMs: 0 }]; }],
    ["missing coverage", reply => { delete reply.snapshotWindowStart; }],
    ["invalid truncation", reply => { reply.historyTruncated = "false"; }],
    ["invalid incomplete", reply => { reply.usageIncomplete = "true"; }],
    ["missing reason", reply => { reply.usageIncomplete = true; }],
    ["unknown reason", reply => { reply.usageIncomplete = true; reply.usageIncompleteReason = "private"; }],
  ];
  for (const [label, mutate] of malformed) test(`refuses malformed DTO: ${label}`, async () => {
    const reply: Record<string, unknown> = statistics();
    mutate(reply);
    expect(await handleComboStatsCommand(["stored", "--json"], fixture(reply).deps)).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join("\n")).not.toContain("private");
  });
  for (const [status, exit] of [[404, 4], [409, 5], [503, 1], [500, 1], [401, 1]]) test(`HTTP ${status} has safe numeric outcome`, async () => {
    expect(await handleComboStatsCommand(["stored", "--json"], fixture({ error: { message: "private payload" }, hint: "private hint" }, status).deps)).toBe(exit);
    expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join("\n")).not.toContain("private");
  });
});
