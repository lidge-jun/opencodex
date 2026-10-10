import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { jevQuotaTier, jevQuotaRank, normalizeJevQuotaTiers, normalizeJevQuotaSummary } from "../../src/combos/jev-quota-config";
import { jevQuotaSignalFromWindows, jevQuotaSignalForTarget, jevQuotaPoolSignal, JEV_QUOTA_SIGNAL_MAX_AGE_MS, JEV_QUOTA_INSTRUCTION } from "../../src/combos/jev-quota";
import { providerDecisionWindows, publishCodexDecisionQuota } from "../../src/providers/quota-decision-publication";
import { publishDecisionAccountQuota, publishDecisionQuotaRoster, publishDecisionKeyQuota, invalidateDecisionKeyQuotas, setDecisionAccountUsable, type DecisionQuotaWindow } from "../../src/providers/quota-decision-snapshot";
import { boundedJevQuotaPayload } from "../../src/combos/jev-quota-route";
import { buildJevState, buildJevRouteQuestion, JEV_API_URL, resolveJevDecision, type JevCandidate } from "../../src/combos/jev";
import { resolveJevComboDecision } from "../../src/combos/jev-dispatch";
import { buildJevModelPrompt, JEV_MODEL_INSTRUCTIONS } from "../../src/combos/jev-model-backend";
import { normalizePersistedJevDecision } from "../../src/usage/jev-stats";
import * as auth from "../../src/oauth/store";
import * as disk from "../../src/codex/quota";
import * as keys from "../../src/providers/api-key-resolve";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { OcxConfig } from "../../src/types";

const now = 2_000_000_000_000;
/** Build a weekly decision window with the given percentage. */
const window = (percent: number, extra: Partial<DecisionQuotaWindow> = {}): DecisionQuotaWindow => ({ window: "weekly", percent, observedAt: now, ...extra });
const candidates: JevCandidate[] = [{ key: "p/a", provider: "p", model: "a", reasoningEfforts: ["low"] }, { key: "p/b", provider: "p", model: "b", reasoningEfforts: ["low"] }];
const fallback = { targetKey: "p/a", effort: "low" as const };
let home: TempHome;
let config: OcxConfig;
beforeEach(() => {
  home = createTempHome("ocx-jq-");
  invalidateDecisionKeyQuotas();
  publishDecisionQuotaRoster("anthropic", []); publishDecisionQuotaRoster("codex", []); publishDecisionQuotaRoster("codex-main", []);
  config = { port: 0, defaultProvider: "p", providers: { p: { adapter: "openai-chat", baseUrl: "https://p.example.test/v1", apiKey: "fixture-key" }, jev: { adapter: "jev-decision", baseUrl: JEV_API_URL, apiKey: "fixture-judge" } } };
});
afterEach(() => { invalidateDecisionKeyQuotas(); home.remove(); });

describe("JEV quota policy", () => {
  test("inclusive raw boundaries and optional moderate", () => {
    const four = normalizeJevQuotaTiers({ moderate: 40 })!;
    expect(four).toEqual({ moderate: 40, limited: 70, nearlyExhausted: 90 });
    expect([39.99, 40, 69.99, 70, 89.99, 90].map(n => jevQuotaTier(n, four))).toEqual(["healthy", "moderate", "moderate", "limited", "limited", "nearly_exhausted"]);
    expect(jevQuotaTier(40)).toBe("healthy");
    expect(jevQuotaTier(79.99, normalizeJevQuotaTiers({ limited: 80 })!)).toBe("healthy");
    expect(jevQuotaTier(80, normalizeJevQuotaTiers({ limited: 80 })!)).toBe("limited");
    for (const invalid of [null, [], { limited: NaN }, { nearlyExhausted: Infinity }, { moderate: -1 }, { limited: 101 }, { limited: 90 }, { moderate: 70 }, { moderate: 60, limited: 50 }, { private: 40 }, { limited: undefined }]) expect(normalizeJevQuotaTiers(invalid)).toBeUndefined();
    expect(jevQuotaRank("unknown")).toBe(jevQuotaRank("healthy"));
  });
  test("worst relevant window preserves raw percentage and producer scope", () => {
    const windows = providerDecisionWindows({ updatedAt: now, fiveHourPercent: 40, weeklyPercent: 69.99, monthlyPercent: 50, creditsUsd: { used: 100, limit: 100, remaining: 0, percent: 100 }, customWindows: [
      { label: "Opus", percent: 100 }, { label: "Spark", percent: 100 }, { label: "API usage", percent: 100 }, { label: "Opus", scope: "model", percent: 90 }, { label: "Sonnet", scope: "model", percent: 80 },
    ] });
    expect(jevQuotaSignalFromWindows(windows, "claude-opus-4", now)).toMatchObject({ tier: "nearly_exhausted", usedPercent: 90, window: "opus" });
    expect(jevQuotaSignalFromWindows(windows, "claude-sonnet-4", now)).toMatchObject({ tier: "limited", usedPercent: 80 });
    expect(jevQuotaSignalFromWindows(windows, "other", now)).toMatchObject({ tier: "healthy", usedPercent: 69.99, window: "weekly" });
  });
  test("freshness, invalid numbers and reset expiry are excluded", () => {
    for (const row of [window(90, { observedAt: -1 }), window(90, { observedAt: Infinity }), window(90, { observedAt: now + 1 }), window(90, { observedAt: now - JEV_QUOTA_SIGNAL_MAX_AGE_MS - 1 }), window(NaN), window(-1), window(101), window(90, { resetAt: now }), window(90, { resetAt: NaN })]) expect(jevQuotaSignalFromWindows([row], "a", now).tier).toBe("unknown");
    expect(jevQuotaSignalFromWindows([window(90, { observedAt: now - JEV_QUOTA_SIGNAL_MAX_AGE_MS, resetAt: now + 1001 })], "a", now)).toMatchObject({ tier: "nearly_exhausted", resetsInSeconds: 2 });
    expect(jevQuotaSignalFromWindows([window(90, { resetAt: now }), window(30)], "a", now).usedPercent).toBe(30);
  });
  test("pool uses best usable tier, unknown healthy rank and stable ties", () => {
    const high = { tier: "nearly_exhausted" as const, usedPercent: 95 };
    const healthy = { tier: "healthy" as const, usedPercent: 30 };
    expect(jevQuotaPoolSignal([high, { tier: "unknown" }]).tier).toBe("unknown");
    expect(jevQuotaPoolSignal([high, high]).tier).toBe("nearly_exhausted");
    expect(jevQuotaPoolSignal([healthy, { tier: "unknown" }])).toBe(healthy);
    expect(jevQuotaPoolSignal([]).tier).toBe("unknown");
  });
});

describe("loaded quota evidence", () => {
  test("cold path does not call credential, auth, disk or network readers", () => {
    const spies = [spyOn(auth, "getAccountSet"), spyOn(auth, "getAccountCredential"), spyOn(auth, "loadAuthStore"), spyOn(disk, "getAccountQuota"), spyOn(keys, "resolveProviderApiKey"), spyOn(globalThis, "fetch").mockImplementation((() => { throw new Error("forbidden reader"); }) as unknown as typeof fetch)];
    try {
      for (const spy of spies.slice(0, -1)) spy.mockImplementation((() => { throw new Error("forbidden reader"); }) as never);
      config.providers.anthropic = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" };
      config.anthropicAccountPool = { enabled: true };
      config.providers.openai = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" };
      for (const provider of ["p", "anthropic", "openai"]) expect(jevQuotaSignalForTarget(config, provider, "a", now).tier).toBe("unknown");
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });
  test("sole-key publication invalidates on config, key epoch and multi-key changes", () => {
    const provider = config.providers.p!;
    publishDecisionKeyQuota("p", provider, [window(90)]);
    expect(jevQuotaSignalForTarget(config, "p", "a", now).tier).toBe("nearly_exhausted");
    provider.apiKey = "rotated-key";
    expect(jevQuotaSignalForTarget(config, "p", "a", now).tier).toBe("unknown");
    publishDecisionKeyQuota("p", provider, [window(90)]);
    keys.invalidateResolvedProviderKeyCache();
    expect(jevQuotaSignalForTarget(config, "p", "a", now).tier).toBe("unknown");
    provider.apiKeyPool = [{ id: "a", key: "a" }, { id: "b", key: "b" }];
    publishDecisionKeyQuota("p", provider, [window(90)]);
    expect(jevQuotaSignalForTarget(config, "p", "a", now).tier).toBe("unknown");
  });
  test("Anthropic roster usability, model allowlist and credential-generation fence", () => {
    config.providers.anthropic = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" };
    config.anthropicAccountPool = { enabled: true };
    publishDecisionQuotaRoster("anthropic", [{ id: "a", generation: "g1", usable: true }, { id: "b", generation: "g2", usable: false }]);
    publishDecisionAccountQuota("anthropic", "a", "g1", [window(90)]);
    publishDecisionAccountQuota("anthropic", "b", "g2", [window(10)]);
    expect(jevQuotaSignalForTarget(config, "anthropic", "claude-sonnet-4", now).tier).toBe("nearly_exhausted");
    publishDecisionQuotaRoster("anthropic", [{ id: "a", generation: "g1", usable: true }, { id: "b", generation: "g2", usable: true }]);
    expect(jevQuotaSignalForTarget(config, "anthropic", "claude-sonnet-4", now).tier).toBe("healthy");
    config.anthropicAccountPool.routes = [{ name: "sonnet", match: "claude-sonnet-4", accounts: ["a"] }];
    expect(jevQuotaSignalForTarget(config, "anthropic", "claude-sonnet-4", now).tier).toBe("nearly_exhausted");
    publishDecisionQuotaRoster("anthropic", [{ id: "a", generation: "g3", usable: true }]);
    publishDecisionAccountQuota("anthropic", "a", "g1", [window(90)]);
    expect(jevQuotaSignalForTarget(config, "anthropic", "claude-sonnet-4", now).tier).toBe("unknown");
    config.anthropicAccountPool.enabled = false;
    expect(jevQuotaSignalForTarget(config, "anthropic", "claude-sonnet-4", now).tier).toBe("unknown");
  });
  test("Codex raw windows, pause, reauth and reserve unknown", () => {
    config.providers.openai = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" };
    config.codexAccounts = [{ id: "a", isMain: false, email: "fixture@example.test" }, { id: "b", isMain: false, email: "fixture@example.test" }];
    config.pausedCodexAccountIds = ["__main__", "b"];
    publishDecisionQuotaRoster("codex", [{ id: "a", generation: 1, usable: true }, { id: "b", generation: 1, usable: true }]);
    publishCodexDecisionQuota("a", 1, { weeklyPercent: 70, shortPercent: 90, shortResetAt: (now + 1000) / 1000, credits: { unlimited: true, observedAt: now } }, now);
    publishCodexDecisionQuota("b", 1, { weeklyPercent: 10 }, now);
    expect(jevQuotaSignalForTarget(config, "openai", "gpt-6-astra", now).tier).toBe("nearly_exhausted");
    expect(jevQuotaSignalForTarget(config, "openai", "gpt-reserve", now).tier).toBe("unknown");
    config.pausedCodexAccountIds = ["__main__"];
    expect(jevQuotaSignalForTarget(config, "openai", "gpt-6-astra", now).tier).toBe("healthy");
    setDecisionAccountUsable("codex", "b", false, 1);
    publishDecisionQuotaRoster("codex", [{ id: "a", generation: 1, usable: true }, { id: "b", generation: 1, usable: true }]);
    expect(jevQuotaSignalForTarget(config, "openai", "gpt-6-astra", now).tier).toBe("nearly_exhausted");
    publishCodexDecisionQuota("a", 1, { credits: { unlimited: true, observedAt: now } }, now + 1);
    expect(jevQuotaSignalForTarget(config, "openai", "gpt-6-astra", now + 1).tier).toBe("nearly_exhausted");
    expect(jevQuotaSignalForTarget(config, "openai", "gpt-6-astra", now + JEV_QUOTA_SIGNAL_MAX_AGE_MS + 1).tier).toBe("unknown");
  });
});

describe("quota route payload and bounded telemetry", () => {
  test("off preserves question bytes and service destination denial precedes evidence", async () => {
    const base = JSON.stringify(buildJevRouteQuestion(candidates));
    expect(JSON.stringify(buildJevRouteQuestion(candidates))).toBe(base);
    let posted = "";
    const options = { body: { input: "Fixture task" }, config, candidates, fallback, now: () => now, post: async (_name: string, _provider: unknown, _url: string, init: RequestInit) => { posted = String(init.body); return Response.json({ answers: { route: { choice: "p/a:low" } } }); } };
    const off = await resolveJevDecision(options);
    const offBytes = posted;
    const falseDecision = await resolveJevDecision({ ...options, decisionQuotaSignals: false });
    expect(posted).toBe(offBytes); expect(off.quota).toBeUndefined(); expect(falseDecision.quota).toBeUndefined();
    publishDecisionKeyQuota("p", config.providers.p!, [window(90)]);
    const on = await resolveJevDecision({ ...options, decisionQuotaSignals: true });
    expect(JSON.parse(posted).questions.route.criteria["p/a:low"].quota).toMatchObject({ tier: "nearly_exhausted", used_percent: 90 });
    expect(on.quota).toMatchObject({ nearly_exhausted: 2, selected: "nearly_exhausted" });
    posted = "";
    const denied = await resolveJevDecision({ ...options, decisionQuotaSignals: true, isDestinationAllowed: () => false });
    expect(posted).toBe(""); expect(denied.quota).toBeUndefined();
  });
  test("model backend adds quota only with opt-in and keeps configured target order", async () => {
    publishDecisionKeyQuota("p", config.providers.p!, [window(90)]);
    const seen: { instructions: string; input: string }[] = [];
    const base = { body: { input: "Fixture task" }, config, candidates, fallback, now: () => now, decisionModel: "p/router", invokeModel: async (request: { instructions: string; input: string }) => { seen.push(request); return { text: '{"choice":"p/b:low"}' }; } };
    const off = await resolveJevComboDecision(base);
    const on = await resolveJevComboDecision({ ...base, decisionQuotaSignals: true });
    expect(seen[0]!.instructions).toBe(JEV_MODEL_INSTRUCTIONS);
    expect(seen[0]!.input).not.toContain("Quota"); expect(off.quota).toBeUndefined();
    expect(seen[1]!.input).toContain("Quota nearly_exhausted");
    expect(Object.keys(JSON.parse(seen[1]!.input).options)).toEqual(["p/a:low", "p/b:low"]);
    expect(on.quota?.selected).toBe("nearly_exhausted");
  });
  test("overflow retries without quota before ordinary invalid gate", () => {
    const quotaRows = candidates.map(row => ({ ...row, quota: { tier: "limited" as const } }));
    const attempts: boolean[] = [];
    const result = boundedJevQuotaPayload(quotaRows, rows => { attempts.push(rows.some(row => row.quota)); return "x".repeat(rows.some(row => row.quota) ? 65_537 : 10); }, 65_536);
    expect(attempts).toEqual([true, false]); expect(result.body).toBe("x".repeat(10)); expect(result.candidates.some(row => row.quota)).toBe(false);
  });
  test("telemetry accepts only bounded enums/counts and drops account/evidence fields", () => {
    const quota = { unknown: 1, healthy: 1, moderate: 0, limited: 0, nearly_exhausted: 0, selected: "unknown" as const };
    expect(normalizeJevQuotaSummary({ ...quota, accounts: ["private"], windows: ["private"] })).toEqual(quota);
    for (const invalid of [{ ...quota, healthy: 64 }, { ...quota, limited: -1 }, { ...quota, limited: NaN }]) expect(normalizeJevQuotaSummary(invalid)).toBeUndefined();
    const row = normalizePersistedJevDecision({ version: 1, comboId: "auto", selected: { provider: "p", model: "a", effort: "low" }, gate: "apply", latencyMs: 1, quota: { ...quota, accountId: "private" } });
    expect(row?.quota).toEqual(quota); expect(JSON.stringify(row)).not.toContain("private");
  });
});

test("System One quota descriptions stay scalar and denied destinations never read quota", async () => {
  config.providers.local = { adapter: "jev-decision", baseUrl: "http://127.0.0.1:11434/v1/systemone", allowPrivateNetwork: true, defaultModel: "fixture-judge" };
  publishDecisionQuotaRoster("anthropic", [{ id: "private-account-fixture", generation: "private-generation-fixture", usable: true }]);
  config.providers.anthropic = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" };
  config.anthropicAccountPool = { enabled: true };
  publishDecisionAccountQuota("anthropic", "private-account-fixture", "private-generation-fixture", [window(90)]);
  const rows = candidates.map((row, i) => ({ ...row, key: `anthropic/${i}`, provider: "anthropic", model: `claude-sonnet-${i}` }));
  let posted = "";
  const options = { body: { input: "Fixture task" }, config, candidates: rows, fallback: { targetKey: rows[0]!.key, effort: "low" as const }, decisionProvider: "local", decisionQuotaSignals: true, now: () => now,
    post: async (_name: string, _provider: unknown, _url: string, init: RequestInit) => { posted = String(init.body); return Response.json({ answers: { route: { choice: `${rows[0]!.key}:low` } } }); } };
  expect((await resolveJevDecision(options)).gate).toBe("apply");
  const criteria = JSON.parse(posted).questions.route.criteria;
  expect(typeof criteria[`${rows[0]!.key}:low`]).toBe("string");
  expect(posted).toContain("Quota nearly_exhausted");
  expect(posted).not.toContain("private-account-fixture"); expect(posted).not.toContain("private-generation-fixture");
  let reads = 0;
  Object.defineProperty(config, "anthropicAccountPool", {
    /** Count and reject any quota-pool read made before the destination is authorized. */
    get() { reads++; throw new Error("quota read before destination authorization"); },
    configurable: true,
  });
  posted = "";
  const denied = await resolveJevDecision({ ...options, isDestinationAllowed: () => false });
  expect(denied.gate).toBe("invalid"); expect(reads).toBe(0); expect(posted).toBe("");
});

test("real service and model serializers remove quota at byte cap and retain ordinary refusal", async () => {
  const rows = Array.from({ length: 42 }, (_, i) => ({ key: `p/${i}`, provider: "p", model: "界".repeat(180) + i, reasoningEfforts: ["low" as const] }));
  const input = { input: "Fixture task" };
  const fallback = { targetKey: rows[0]!.key, effort: "low" as const };
  const encoder = new TextEncoder();
  // Find a valid ordinary payload just below the cap; quota must be the only overflow cause.
  let serviceRows = rows;
  for (let count = 2; count <= 42; count++) {
    const candidates = rows.slice(0, count);
    const bytes = encoder.encode(JSON.stringify({ model: "jev-latest", state: buildJevState(input, candidates), questions: buildJevRouteQuestion(candidates) })).byteLength;
    if (bytes < 65_536 && bytes > 62_000) { serviceRows = candidates; break; }
  }
  // Tune profile size to approach 64 KiB without touching production limits.
  let tuned = serviceRows;
  for (let size = 0; size <= 512; size++) {
    const next = serviceRows.map(row => ({ ...row, modelProfile: "界".repeat(size) }));
    const state = buildJevState(input, next);
    const ordinary = encoder.encode(JSON.stringify({ model: "jev-latest", state, questions: buildJevRouteQuestion(next) })).byteLength;
    const enriched = encoder.encode(JSON.stringify({ model: "jev-latest", state, questions: buildJevRouteQuestion(next.map(row => ({ ...row, quota: { tier: "nearly_exhausted" as const, usedPercent: 90, window: "weekly" as const } }))) })).byteLength;
    if (ordinary <= 65_536 && enriched > 65_536) { tuned = next; break; }
  }
  publishDecisionKeyQuota("p", config.providers.p!, [window(90)]);
  let sent = "";
  const result = await resolveJevDecision({ body: input, config, candidates: tuned, fallback, decisionQuotaSignals: true, now: () => now,
    post: async (_name: string, _provider: unknown, _url: string, init: RequestInit) => { sent = String(init.body); return Response.json({ answers: { route: { choice: `${tuned[0]!.key}:low` } } }); } });
  expect(result.gate).toBe("apply"); expect(encoder.encode(sent).byteLength).toBeLessThanOrEqual(65_536);
  expect(sent).not.toContain('"quota"'); expect(result.quota).toBeUndefined();
  const excessive = rows.map(row => ({ ...row, modelProfile: "界".repeat(512) }));
  sent = "";
  expect((await resolveJevDecision({ body: input, config, candidates: excessive, fallback, decisionQuotaSignals: true, now: () => now, post: async () => { sent = "unexpected"; return Response.json({}); } })).gate).toBe("invalid");
  expect(sent).toBe("");
  let modelRequest = "";
  let modelRows = rows;
  for (let size = 100; size <= 510; size++) {
    const next = rows.map((row, i) => ({ ...row, model: "界".repeat(size) + i }));
    const state = buildJevState(input, next);
    const ordinary = encoder.encode(JEV_MODEL_INSTRUCTIONS + buildJevModelPrompt(state, next)).byteLength;
    const enriched = encoder.encode(JEV_MODEL_INSTRUCTIONS + " " + JEV_QUOTA_INSTRUCTION + buildJevModelPrompt(state, next.map(row => ({ ...row, quota: { tier: "nearly_exhausted" as const, usedPercent: 90, window: "weekly" as const } })))).byteLength;
    if (ordinary <= 65_536 && enriched > 65_536) { modelRows = next; break; }
  }
  const model = await resolveJevComboDecision({ body: input, config, candidates: modelRows, fallback, decisionModel: "p/judge", decisionQuotaSignals: true, now: () => now,
    invokeModel: async request => { modelRequest = request.instructions + request.input; return { text: `{"choice":"${modelRows[0]!.key}:low"}` }; } });
  expect(model.gate).toBe("apply"); expect(encoder.encode(modelRequest).byteLength).toBeLessThanOrEqual(65_536);
  expect(modelRequest).not.toContain("Quota nearly_exhausted"); expect(model.quota).toBeUndefined();
});
