import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comboConfigIssues, getCombo } from "../../src/combos";
import {
  buildJevRouteQuestion,
  JEV_API_URL,
  resolveJevDecision,
  type JevCandidate,
  type ResolveJevDecisionOptions,
} from "../../src/combos/jev";
import {
  JEV_QUOTA_INSTRUCTION_DESCRIPTIVE,
  JEV_QUOTA_INSTRUCTION_STRUCTURED,
  JEV_QUOTA_SIGNAL_MAX_AGE_MS,
  jevQuotaClause,
  jevQuotaDecisionSummary,
  jevQuotaSignalForTarget,
  jevQuotaSignalFromQuota,
  jevQuotaTier,
  type JevQuotaSignal,
} from "../../src/combos/jev-quota";
import { getConfigPath, saveConfig } from "../../src/config";
import { clearCachedProviderQuotas, setCachedProviderQuotaForTests } from "../../src/providers/quota-routing-cache";
import type { ProviderQuota } from "../../src/providers/quota-types";
import { handleManagementAPI } from "../../src/server/management-api";
import { normalizePersistedJevDecision } from "../../src/usage/jev-stats";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const NOW = Date.UTC(2026, 8, 30, 12);
const HOUR = 3_600_000;
type JevPost = NonNullable<ResolveJevDecisionOptions["post"]>;

afterEach(() => clearCachedProviderQuotas());

function quota(fields: Partial<ProviderQuota>, updatedAt = NOW - 60_000): ProviderQuota {
  return { updatedAt, ...fields };
}

const healthy: JevQuotaSignal = { tier: "healthy", usedPercent: 19, window: "5h", resetsInSeconds: 3 * 3600 };
const limited: JevQuotaSignal = { tier: "limited", usedPercent: 78, window: "weekly", resetsInSeconds: 2 * 3600 };
const exhausted: JevQuotaSignal = { tier: "nearly_exhausted", usedPercent: 98, window: "weekly", resetsInSeconds: 3 * 86_400 };

const candidates: JevCandidate[] = [
  { key: "openai/gpt-6-astra", provider: "openai", model: "gpt-6-astra", reasoningEfforts: ["medium", "xhigh"] },
  { key: "cursor/claude-sonnet-5-5", provider: "cursor", model: "claude-sonnet-5-5", reasoningEfforts: ["xhigh"] },
];
const fallback = { targetKey: candidates[0]!.key, effort: "medium" as const };
const decisionBody = { input: "Refactor the scheduler and prove the race is gone." };

function decisionConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
      jev: { adapter: "jev-decision", baseUrl: JEV_API_URL, authMode: "key", apiKey: "typesafe-key", liveModels: false },
      "ollama-tev1": {
        adapter: "jev-decision",
        baseUrl: "http://127.0.0.1:11434/v1/systemone",
        allowPrivateNetwork: true,
        defaultModel: "tev1:4b",
        liveModels: false,
      },
    },
  };
}

function recordingPost(bodies: string[], choice = "cursor/claude-sonnet-5-5:xhigh"): JevPost {
  return (async (_name, _provider, _url, init) => {
    bodies.push(String(init.body));
    return Response.json({ answers: { route: { choice, confidence: 0.7 } } });
  }) as JevPost;
}

type RouteQuestion = { route: { instructions: Record<string, unknown>; criteria: Record<string, unknown> } };

describe("JEV quota signal accessor", () => {
  test("tiers the worst relevant window at the 70% and 90% boundaries", () => {
    expect([0, 69, 69.99, 70, 89, 89.99, 90, 100].map(jevQuotaTier)).toEqual([
      "healthy", "healthy", "healthy", "limited", "limited", "limited", "nearly_exhausted", "nearly_exhausted",
    ]);
    for (const [percent, tier] of [[69, "healthy"], [70, "limited"], [89, "limited"], [90, "nearly_exhausted"]] as const) {
      expect(jevQuotaSignalFromQuota(quota({ weeklyPercent: percent }), "gpt-6-astra", NOW)).toEqual({
        tier, usedPercent: percent, window: "weekly",
      });
    }
    // The shown number never crosses the tier boundary its tier came from.
    expect(jevQuotaSignalFromQuota(quota({ weeklyPercent: 89.9 }), "m", NOW)).toMatchObject({ tier: "limited", usedPercent: 89 });
  });

  test("picks the most-used window and reports when it resets", () => {
    const signal = jevQuotaSignalFromQuota(quota({
      fiveHourPercent: 19,
      fiveHourResetAt: NOW + 2 * HOUR,
      weeklyPercent: 58.75,
      weeklyResetAt: NOW + 72 * HOUR,
      monthlyPercent: 4.06,
    }), "gpt-6-astra", NOW);
    expect(signal).toEqual({ tier: "healthy", usedPercent: 58, window: "weekly", resetsInSeconds: 72 * 3600 });
  });

  test("a model-family window counts only for that family; unscoped custom windows never count", () => {
    const anthropic = quota({
      fiveHourPercent: 19,
      weeklyPercent: 13,
      customWindows: [
        { label: "Fable", scope: "model", percent: 95, resetAt: NOW + 50 * HOUR },
        { label: "Prepaid credits", percent: 100 },
      ],
    });
    expect(jevQuotaSignalFromQuota(anthropic, "claude-fable-5", NOW)).toEqual({
      tier: "nearly_exhausted", usedPercent: 95, window: "Fable weekly", resetsInSeconds: 50 * 3600,
    });
    expect(jevQuotaSignalFromQuota(anthropic, "claude-sonnet-5-5", NOW)).toEqual({
      tier: "healthy", usedPercent: 19, window: "5h",
    });
    // A provider-wide label that merely looks like a family (antigravity passes labels through).
    const unscoped = quota({ weeklyPercent: 10, customWindows: [{ label: "Fable", percent: 99 }] });
    expect(jevQuotaSignalFromQuota(unscoped, "claude-fable-5", NOW)).toMatchObject({ usedPercent: 10 });
    const cursor = quota({ monthlyPercent: 4, customWindows: [{ label: "API usage", percent: 97 }] });
    expect(jevQuotaSignalFromQuota(cursor, "claude-sonnet-5-5", NOW)).toMatchObject({ tier: "healthy", usedPercent: 4 });
  });

  test("stale, future-stamped, missing, rolled-over or empty rows are unknown", () => {
    const model = "gpt-6-astra";
    expect(jevQuotaSignalFromQuota(null, model, NOW)).toBeUndefined();
    expect(jevQuotaSignalFromQuota(quota({ weeklyPercent: 98 }, NOW - JEV_QUOTA_SIGNAL_MAX_AGE_MS - 1), model, NOW)).toBeUndefined();
    expect(jevQuotaSignalFromQuota(quota({ weeklyPercent: 98 }, NOW - JEV_QUOTA_SIGNAL_MAX_AGE_MS), model, NOW)).toBeDefined();
    expect(jevQuotaSignalFromQuota(quota({ weeklyPercent: 98 }, NOW + 1_000), model, NOW)).toBeUndefined();
    expect(jevQuotaSignalFromQuota(quota({ weeklyPercent: 98, weeklyResetAt: NOW - 1 }), model, NOW)).toBeUndefined();
    expect(jevQuotaSignalFromQuota(quota({ weeklyPercent: Number.NaN }), model, NOW)).toBeUndefined();
    expect(jevQuotaSignalFromQuota(quota({}), model, NOW)).toBeUndefined();
  });

  test("reads the cached provider quota rows synchronously and ignores rows past the bound", () => {
    setCachedProviderQuotaForTests("openai", quota({ weeklyPercent: 98, weeklyResetAt: NOW + 72 * HOUR }));
    expect(jevQuotaSignalForTarget("openai", "gpt-6-astra", NOW)).toEqual({
      tier: "nearly_exhausted", usedPercent: 98, window: "weekly", resetsInSeconds: 72 * 3600,
    });
    expect(jevQuotaSignalForTarget("cursor", "claude-sonnet-5-5", NOW)).toBeUndefined();
    expect(jevQuotaSignalForTarget("openai", "gpt-6-astra", NOW + JEV_QUOTA_SIGNAL_MAX_AGE_MS)).toBeUndefined();
    // An injected reader replaces the cache entirely.
    expect(jevQuotaSignalForTarget("x", "m", NOW, () => quota({ fiveHourPercent: 75 }))).toMatchObject({ tier: "limited" });
  });

  test("renders one short tier clause per option", () => {
    expect(jevQuotaClause(healthy)).toBe(" Quota healthy (19% of 5h used).");
    expect(jevQuotaClause(limited)).toBe(" Quota limited (78% of weekly used, resets in 2h).");
    expect(jevQuotaClause(exhausted))
      .toBe(" QUOTA NEARLY EXHAUSTED (98% of weekly used, resets in 3d): choose only if no alternative is adequate.");
    expect(jevQuotaClause({ ...limited, resetsInSeconds: 90 })).toBe(" Quota limited (78% of weekly used, resets in 2m).");
    expect(jevQuotaClause({ ...limited, resetsInSeconds: undefined })).toBe(" Quota limited (78% of weekly used).");
  });

  test("summarizes tiers per target and the picked target's tier", () => {
    expect(jevQuotaDecisionSummary(candidates, candidates[0]!.key)).toBeUndefined();
    expect(jevQuotaDecisionSummary([
      { ...candidates[0]!, quota: exhausted },
      { ...candidates[1]!, quota: healthy },
      { key: "x/y" },
    ], "cursor/claude-sonnet-5-5")).toEqual({ healthy: 1, limited: 0, nearly_exhausted: 1, selected: "healthy" });
  });
});

describe("JEV quota signals in the decision request", () => {
  test("without signals the question is unchanged in both shapes", () => {
    const withUndefined = candidates.map(candidate => ({ ...candidate, quota: undefined }));
    for (const descriptiveCriteria of [false, true]) {
      const plain = JSON.stringify(buildJevRouteQuestion(candidates, { descriptiveCriteria }));
      expect(JSON.stringify(buildJevRouteQuestion(withUndefined, { descriptiveCriteria }))).toBe(plain);
      expect(plain).not.toContain("uota");
    }
  });

  test("self-hosted criteria carry the tier clause inside each option string, plus one instruction", () => {
    const question = buildJevRouteQuestion([
      { ...candidates[0]!, quota: exhausted },
      { ...candidates[1]!, quota: healthy },
    ], { descriptiveCriteria: true }) as RouteQuestion;
    expect(question.route.criteria).toEqual({
      "openai/gpt-6-astra:medium": "Target openai/gpt-6-astra (provider openai, model gpt-6-astra) with medium reasoning effort. QUOTA NEARLY EXHAUSTED (98% of weekly used, resets in 3d): choose only if no alternative is adequate.",
      "openai/gpt-6-astra:xhigh": "Target openai/gpt-6-astra (provider openai, model gpt-6-astra) with xhigh reasoning effort. QUOTA NEARLY EXHAUSTED (98% of weekly used, resets in 3d): choose only if no alternative is adequate.",
      "cursor/claude-sonnet-5-5:xhigh": "Target cursor/claude-sonnet-5-5 (provider cursor, model claude-sonnet-5-5) with xhigh reasoning effort. Quota healthy (19% of 5h used).",
    });
    expect(question.route.instructions.quota).toBe(JEV_QUOTA_INSTRUCTION_DESCRIPTIVE);
    // Everything else in the instructions stays exactly as without quota.
    const { quota: _instruction, ...rest } = question.route.instructions;
    expect(rest).toEqual((buildJevRouteQuestion(candidates, { descriptiveCriteria: true }) as RouteQuestion).route.instructions);
  });

  test("an option without fresh quota gets no clause", () => {
    const question = buildJevRouteQuestion([
      { ...candidates[0]!, quota: limited },
      candidates[1]!,
    ], { descriptiveCriteria: true }) as RouteQuestion;
    expect(question.route.criteria["cursor/claude-sonnet-5-5:xhigh"])
      .toBe("Target cursor/claude-sonnet-5-5 (provider cursor, model claude-sonnet-5-5) with xhigh reasoning effort.");
    expect(question.route.instructions.quota).toBe(JEV_QUOTA_INSTRUCTION_DESCRIPTIVE);
  });

  test("structured TypeSafe criteria carry a quota object on each criterion", () => {
    const question = buildJevRouteQuestion([
      { ...candidates[0]!, quota: exhausted },
      { ...candidates[1]!, quota: { tier: "healthy", usedPercent: 4, window: "monthly" } },
    ]) as RouteQuestion;
    expect(question.route.criteria["openai/gpt-6-astra:xhigh"]).toEqual({
      target: "openai/gpt-6-astra",
      provider: "openai",
      model: "gpt-6-astra",
      reasoning_effort: "xhigh",
      quota: { tier: "nearly_exhausted", used_percent: 98, window: "weekly", resets_in_seconds: 259_200 },
    });
    expect(question.route.criteria["cursor/claude-sonnet-5-5:xhigh"]).toMatchObject({
      quota: { tier: "healthy", used_percent: 4, window: "monthly" },
    });
    expect(question.route.instructions.quota).toBe(JEV_QUOTA_INSTRUCTION_STRUCTURED);
  });

  test("resolveJevDecision posts the clauses and reports that quota was sent", async () => {
    const bodies: string[] = [];
    const quotaCandidates = [{ ...candidates[0]!, quota: exhausted }, { ...candidates[1]!, quota: healthy }];
    const decision = await resolveJevDecision({
      body: decisionBody, candidates: quotaCandidates, fallback, config: decisionConfig(),
      decisionProvider: "ollama-tev1", post: recordingPost(bodies),
    });
    expect(decision).toMatchObject({ gate: "apply", targetKey: "cursor/claude-sonnet-5-5", quotaSent: true });
    const sent = JSON.parse(bodies[0]!) as { questions: RouteQuestion };
    expect(sent.questions).toEqual(buildJevRouteQuestion(quotaCandidates, { descriptiveCriteria: true }));

    const plain = await resolveJevDecision({
      body: decisionBody, candidates, fallback, config: decisionConfig(),
      decisionProvider: "ollama-tev1", post: recordingPost(bodies),
    });
    expect(plain).not.toHaveProperty("quotaSent");
    expect(bodies[1]).not.toContain("uota");
  });

  test("64 quota-aware targets stay inside the request cap; an overflow only drops the quota", async () => {
    const many = (efforts: JevCandidate["reasoningEfforts"]): JevCandidate[] => Array.from({ length: 64 }, (_, index) => ({
      key: `provider-${index}/model-name-${index}`,
      provider: `provider-${index}`,
      model: `model-name-${index}`,
      reasoningEfforts: efforts,
      quota: exhausted,
    }));
    const bodies: string[] = [];
    const two = many(["low", "high"]);
    const fitted = await resolveJevDecision({
      body: decisionBody, candidates: two, fallback: { targetKey: two[0]!.key, effort: "low" }, config: decisionConfig(),
      post: recordingPost(bodies, "provider-3/model-name-3:high"),
    });
    expect(fitted).toMatchObject({ gate: "apply", quotaSent: true });
    expect(new TextEncoder().encode(bodies[0]!).byteLength).toBeLessThanOrEqual(65_536);
    expect(bodies[0]).toContain("nearly_exhausted");

    // Four efforts x 64 targets fits without quota but not with it: decide without the evidence.
    const four = many(["low", "medium", "high", "xhigh"]);
    const dropped = await resolveJevDecision({
      body: decisionBody, candidates: four, fallback: { targetKey: four[0]!.key, effort: "low" }, config: decisionConfig(),
      post: recordingPost(bodies, "provider-3/model-name-3:high"),
    });
    expect(dropped).toMatchObject({ gate: "apply" });
    expect(dropped).not.toHaveProperty("quotaSent");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toContain("uota");
  });

  test("the self-hosted maximum of 26 options keeps each clause compact", () => {
    const options = Array.from({ length: 13 }, (_, index): JevCandidate => ({
      key: `openai/gpt-6-astra-${index}`,
      provider: "openai",
      model: `gpt-6-astra-${index}`,
      reasoningEfforts: ["high", "xhigh"],
      quota: exhausted,
    }));
    const withQuota = JSON.stringify(buildJevRouteQuestion(options, { descriptiveCriteria: true }));
    const without = JSON.stringify(buildJevRouteQuestion(options.map(({ quota: _q, ...rest }) => rest), { descriptiveCriteria: true }));
    // Worst case (every option nearly exhausted): about 105 characters per option plus one instruction.
    expect(withQuota.length - without.length).toBeLessThanOrEqual(26 * 110 + JEV_QUOTA_INSTRUCTION_DESCRIPTIVE.length + 16);
  });
});

describe("JEV decision log quota summary", () => {
  const base = {
    version: 1,
    comboId: "auto",
    selected: { provider: "cursor", model: "claude-sonnet-5-5", effort: "xhigh" },
    gate: "apply",
    latencyMs: 12,
  };

  test("keeps a bounded tier summary and drops anything malformed", () => {
    expect(normalizePersistedJevDecision({
      ...base, quota: { healthy: 3, limited: 1, nearly_exhausted: 1, selected: "healthy", account: "a@b" },
    })?.quota).toEqual({ healthy: 3, limited: 1, nearly_exhausted: 1, selected: "healthy" });
    expect(normalizePersistedJevDecision(base)).not.toHaveProperty("quota");
    for (const quota of [
      { healthy: 1, limited: 0 },
      { healthy: -1, limited: 0, nearly_exhausted: 1 },
      { healthy: 1.5, limited: 0, nearly_exhausted: 0 },
      { healthy: 0, limited: 0, nearly_exhausted: 0 },
      { healthy: 65, limited: 0, nearly_exhausted: 0 },
      "healthy",
    ]) {
      const normalized = normalizePersistedJevDecision({ ...base, quota });
      expect(normalized).toBeDefined();
      expect(normalized).not.toHaveProperty("quota");
    }
    expect(normalizePersistedJevDecision({
      ...base, quota: { healthy: 1, limited: 0, nearly_exhausted: 0, selected: "unknown" },
    })?.quota).toEqual({ healthy: 1, limited: 0, nearly_exhausted: 0 });
  });
});

const targets = [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }];

function comboConfig(combos: OcxConfig["combos"] = undefined): OcxConfig {
  const providers: Record<string, OcxProviderConfig> = {
    a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
    b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
  };
  return { port: 10100, defaultProvider: "a", providers, ...(combos ? { combos } : {}) };
}

describe("decisionQuotaSignals combo field", () => {
  const issuesFor = (combo: Record<string, unknown>) =>
    comboConfigIssues("auto", { targets, ...combo }, comboConfig().providers)
      .filter(issue => issue.path[0] === "decisionQuotaSignals");

  test("is a jev-only boolean; null or omission means off", () => {
    for (const value of [true, false, null, undefined]) expect(issuesFor({ strategy: "jev", decisionQuotaSignals: value })).toEqual([]);
    expect(issuesFor({ strategy: "failover", decisionQuotaSignals: null })).toEqual([]);
    for (const value of [true, false]) {
      expect(issuesFor({ strategy: "failover", decisionQuotaSignals: value })).toEqual([
        { path: ["decisionQuotaSignals"], message: 'decisionQuotaSignals is only valid with strategy "jev"' },
      ]);
    }
    for (const value of ["on", 1]) {
      expect(issuesFor({ strategy: "jev", decisionQuotaSignals: value })).toEqual([
        { path: ["decisionQuotaSignals"], message: "decisionQuotaSignals must be a boolean" },
      ]);
    }
  });

  test("normalizes sparsely: only true is kept", () => {
    const cfg = comboConfig({
      on: { strategy: "jev", targets, decisionQuotaSignals: true },
      off: { strategy: "jev", targets, decisionQuotaSignals: false },
      plain: { strategy: "jev", targets },
    });
    expect(getCombo(cfg, "on")?.decisionQuotaSignals).toBeTrue();
    expect(getCombo(cfg, "off")).not.toHaveProperty("decisionQuotaSignals");
    expect(getCombo(cfg, "off")).toEqual(getCombo(cfg, "plain"));
  });

  test("management round-trip keeps it while omitted, clears it with false or null, drops it off jev", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const dir = mkdtempSync(join(tmpdir(), "ocx-jev-quota-signals-"));
    process.env.OPENCODEX_HOME = dir;
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    const api = async (cfg: OcxConfig, method: string, body?: unknown): Promise<Response> => {
      const req = new ManagementRequest("http://localhost/api/combos", {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const response = await handleManagementAPI(req, new URL(req.url), cfg, {
        createManagementConvergeCodex: catalogConvergenceFactory(async () => {}),
      });
      return response!;
    };
    try {
      const cfg = comboConfig();
      saveConfig(cfg);
      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionQuotaSignals: true } })).status).toBe(200);
      expect(cfg.combos?.auto?.decisionQuotaSignals).toBeTrue();
      const disk = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      expect(disk.combos?.auto?.decisionQuotaSignals).toBeTrue();
      const listed = await (await api(cfg, "GET")).json() as { combos: unknown[] };
      expect(listed.combos).toEqual([expect.objectContaining({ id: "auto", decisionQuotaSignals: true })]);

      // A CLI/API round-trip that omits the field carries it forward.
      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionTimeoutMs: 30_000 } })).status).toBe(200);
      expect(cfg.combos?.auto).toMatchObject({ decisionQuotaSignals: true, decisionTimeoutMs: 30_000 });

      for (const off of [false, null]) {
        await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionQuotaSignals: true } });
        expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionQuotaSignals: off } })).status).toBe(200);
        expect(cfg.combos?.auto).not.toHaveProperty("decisionQuotaSignals");
      }

      await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionQuotaSignals: true } });
      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "failover", targets } })).status).toBe(200);
      expect(cfg.combos?.auto).not.toHaveProperty("decisionQuotaSignals");
      const rejected = await api(cfg, "PUT", { id: "auto", combo: { strategy: "failover", targets, decisionQuotaSignals: true } });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: 'decisionQuotaSignals is only valid with strategy "jev"' });
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      removeTreeWithRetry(dir);
    }
  });
});
