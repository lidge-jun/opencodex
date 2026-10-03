import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comboConfigIssues, getCombo } from "../../src/combos";
import { JEV_LEVEL_DEFAULT_DESCRIPTIONS, JEV_LEVEL_IDS } from "../../src/combos/jev-decision-contract";
import { JEV_API_URL, type JevCandidate, type ResolveJevDecisionOptions } from "../../src/combos/jev";
import {
  buildJevLevelQuestion,
  JEV_LEVEL_INSTRUCTIONS,
  parseJevLevelDecision,
  resolveJevLevelDecision,
  selectJevLevelCandidate,
  type ResolveJevLevelDecisionOptions,
} from "../../src/combos/jev-level";
import type { NormalizedJevLevels } from "../../src/combos/jev-level-config";
import type { JevQuotaSignal } from "../../src/combos/jev-quota";
import { getConfigPath, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { normalizePersistedJevDecision } from "../../src/usage/jev-stats";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type JevPost = NonNullable<ResolveJevDecisionOptions["post"]>;

const LUNA = "openai/gpt-6-luna";
const SOL = "openai/gpt-6.1-sol";
const ASTRA = "openai/gpt-6-astra";
const SONNET = "cursor/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";

function candidate(key: string, reasoningEfforts: JevCandidate["reasoningEfforts"], extra: Partial<JevCandidate> = {}): JevCandidate {
  const [provider, model] = key.split("/") as [string, string];
  return { key, provider, model, reasoningEfforts, ...extra };
}

const eligible: JevCandidate[] = [
  candidate(LUNA, ["low", "max"]),
  candidate(SOL, ["low", "xhigh"]),
  candidate(ASTRA, ["low", "xhigh"]),
  candidate(SONNET, ["low", "xhigh"]),
  candidate(OPUS, ["low", "xhigh"]),
];

function level(...entries: string[]): NormalizedJevLevels[keyof NormalizedJevLevels] {
  return {
    candidates: entries.map(entry => {
      const [key, effort] = entry.split(":") as [string, string | undefined];
      const [provider, model] = key.split("/") as [string, string];
      return { provider, model, ...(effort ? { effort: effort as "low" } : {}) };
    }),
  };
}

const levels: NormalizedJevLevels = {
  trivial: level(`${LUNA}:low`, `${SOL}:low`),
  routine: level(`${SOL}:low`, `${LUNA}:max`, `${ASTRA}:low`, `${OPUS}:low`),
  hard: level(`${SOL}:xhigh`, `${SONNET}:xhigh`, `${OPUS}:xhigh`, `${ASTRA}:xhigh`),
  deep: level(`${ASTRA}:xhigh`, `${OPUS}:xhigh`, `${SOL}:xhigh`),
  agentic_heavy: level(`${SOL}:xhigh`, `${SONNET}:xhigh`, `${OPUS}:xhigh`, `${ASTRA}:xhigh`),
  agentic_light: level(`${LUNA}:low`, `${LUNA}:max`, `${SOL}:low`),
};

const selfHostedRow: OcxProviderConfig = {
  adapter: "jev-decision",
  baseUrl: "http://127.0.0.1:11434/v1/systemone",
  allowPrivateNetwork: true,
  defaultModel: "tev1:4b",
  liveModels: false,
};

function decisionConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
      jev: { adapter: "jev-decision", baseUrl: JEV_API_URL, authMode: "key", apiKey: "typesafe-key", liveModels: false },
      "ollama-tev1": { ...selfHostedRow },
    },
  };
}

const fallback = { targetKey: LUNA, effort: "low" as const };
const body = { input: "Fix the data race in the scheduler and prove it is gone." };

function answering(answer: unknown, bodies: string[] = []): JevPost {
  return (async (_name, _provider, _url, init) => {
    bodies.push(String(init.body));
    return Response.json(answer);
  }) as JevPost;
}

function levelAnswer(choice: string, extra: Record<string, unknown> = {}) {
  return { answers: { level: { choice, confidence: 0.8, ...extra } }, usage: { input_tokens: 460, output_tokens: 3 } };
}

function resolve(overrides: Partial<ResolveJevLevelDecisionOptions> & { post: JevPost }) {
  return resolveJevLevelDecision({
    body,
    candidates: eligible,
    fallback,
    config: decisionConfig(),
    decisionProvider: "ollama-tev1",
    levels,
    ...overrides,
  });
}

const healthy: JevQuotaSignal = { tier: "healthy", usedPercent: 20, window: "5h" };
const limited: JevQuotaSignal = { tier: "limited", usedPercent: 80, window: "weekly" };
const exhausted: JevQuotaSignal = { tier: "nearly_exhausted", usedPercent: 97, window: "weekly" };

describe("JEV level question", () => {
  test("within-level selector validates level prerequisites and normalizes sparsely", () => {
    const providers = { ...decisionConfig().providers, cursor: { adapter: "openai-chat" }, anthropic: { adapter: "anthropic" } } as OcxConfig["providers"];
    const raw = { strategy: "jev", targets: eligible.map(({ provider, model, reasoningEfforts }) => ({ provider, model, reasoningEfforts })), decisionMode: "level", decisionLevels: levels };
    for (const value of [undefined, null, "order", "route"]) {
      expect(comboConfigIssues("auto", { ...raw, decisionLevelSelect: value }, providers)).toEqual([]);
      const cfg = { ...decisionConfig(), providers, combos: { auto: { ...raw, decisionLevelSelect: value } } } as unknown as OcxConfig;
      const normalized = getCombo(cfg, "auto")!;
      if (value === "route") expect(normalized.decisionLevelSelect).toBe("route");
      else expect(normalized).not.toHaveProperty("decisionLevelSelect");
    }
    for (const value of [true, false, "", "auto", {}]) expect(comboConfigIssues("auto", { ...raw, decisionLevelSelect: value }, providers).some(i => i.path[0] === "decisionLevelSelect")).toBeTrue();
    const prerequisite = 'decisionLevelSelect requires decisionMode "level" and valid decisionLevels';
    for (const [patch, message] of [
      [{ strategy: "failover" }, 'decisionLevelSelect is only valid with strategy "jev"'],
      [{ decisionMode: "route" }, prerequisite],
      [{ decisionLevels: null }, prerequisite],
    ] as const) {
      const issues = comboConfigIssues("auto", { ...raw, ...patch, decisionLevelSelect: "route" }, providers);
      expect(issues.filter(i => i.path[0] === "decisionLevelSelect").map(i => i.message)).toEqual([message]);
    }
  });
  test("offers the configured levels in canonical order with the built-in descriptions", () => {
    const shuffled: NormalizedJevLevels = { deep: levels.deep, trivial: levels.trivial, hard: levels.hard };
    expect(buildJevLevelQuestion(shuffled)).toEqual({
      level: {
        type: "choice",
        instructions: "Classify how demanding the work for the next model call is. Judge from the task and any tool evidence.",
        criteria: {
          trivial: JEV_LEVEL_DEFAULT_DESCRIPTIONS.trivial,
          hard: JEV_LEVEL_DEFAULT_DESCRIPTIONS.hard,
          deep: JEV_LEVEL_DEFAULT_DESCRIPTIONS.deep,
        },
      },
    });
    expect(Object.keys((buildJevLevelQuestion(shuffled).level as { criteria: object }).criteria)).toEqual(["trivial", "hard", "deep"]);
  });

  test("keeps the validated default descriptions verbatim and lets a level override its own", () => {
    expect(JEV_LEVEL_DEFAULT_DESCRIPTIONS).toEqual({
      trivial: "A quick lookup, one-line answer, tiny mechanical edit, or reporting a simple tool result.",
      routine: "An ordinary, well-scoped coding or writing task: one function or file, small feature, tests, config, a review of a small diff.",
      hard: "A hard engineering problem: concurrency bugs, races, leaks, crashes, performance, security fixes, large refactors or migrations that must stay correct.",
      deep: "Deep design or analysis with no code yet: architecture, distributed-systems protocols, proofs, threat models, long careful reports.",
      agentic_heavy: "A long multi-step job in a terminal: set up, upgrade, build, run, debug and iterate many times until everything passes.",
      agentic_light: "A short command run: run tests or a script once, start a server, check status, and report the output.",
    });
    const question = buildJevLevelQuestion({ ...levels, hard: { ...levels.hard!, description: "Custom hard." } });
    expect((question.level as { criteria: Record<string, string> }).criteria.hard).toBe("Custom hard.");
    expect(Object.keys((question.level as { criteria: object }).criteria)).toEqual([...JEV_LEVEL_IDS]);
  });

  test("posts only model, target-free state and the level question, to TypeSafe and self-hosted alike", async () => {
    const withNotes = eligible.map(item => ({ ...item, modelProfile: "Operator note.", quota: exhausted }));
    for (const decisionProvider of ["ollama-tev1", "jev"]) {
      const bodies: string[] = [];
      const decision = await resolve({ decisionProvider, candidates: withNotes, post: answering(levelAnswer("hard"), bodies) });
      expect(decision.gate).toBe("apply");
      const posted = JSON.parse(bodies[0]!) as Record<string, unknown>;
      expect(Object.keys(posted)).toEqual(["model", "state", "questions"]);
      expect(posted.model).toBe(decisionProvider === "jev" ? "jev-latest" : "tev1:4b");
      expect(posted.questions).toEqual(buildJevLevelQuestion(levels));
      expect(posted.state).not.toHaveProperty("operator_notes");
      expect(bodies[0]).not.toContain("uota");
      expect(bodies[0]).not.toContain("gpt-6");
      expect(posted.state).toMatchObject({ task: body.input, step: { type: "user_turn" } });
    }
  });
});

describe("JEV level answer parsing", () => {
  const offered = [...JEV_LEVEL_IDS];

  test("accepts an offered level with a consistent distribution", () => {
    const probabilities = { trivial: 0.02, routine: 0.08, hard: 0.8, deep: 0.05, agentic_heavy: 0.03, agentic_light: 0.02 };
    expect(parseJevLevelDecision(levelAnswer("hard", { probabilities }), offered)).toEqual({
      level: "hard", confidence: 0.8, chosenProbability: 0.8, usage: { input_tokens: 460, output_tokens: 3 },
    });
  });

  test("refuses anything outside the offered levels or an inconsistent distribution", () => {
    const three = ["trivial", "routine", "hard"] as const;
    for (const payload of [
      {},
      { answers: {} },
      { answers: { route: { choice: "hard" } } },
      levelAnswer("deep"),
      levelAnswer("expert"),
      levelAnswer("hard", { probabilities: { trivial: 0.1, routine: 0.1, hard: 0.8, deep: 0 } }),
      levelAnswer("hard", { probabilities: { trivial: 0.1, hard: 0.9 } }),
      levelAnswer("hard", { probabilities: { trivial: 0.6, routine: 0.1, hard: 0.3 } }),
      levelAnswer("hard", { probabilities: { trivial: 0.1, routine: 0.1, hard: "0.8" } }),
    ]) {
      expect(() => parseJevLevelDecision(payload, three)).toThrow();
    }
  });
});

describe("JEV level selection", () => {
  test("walks the level's candidates in order and applies the named effort", () => {
    expect(selectJevLevelCandidate(levels.hard, eligible)).toMatchObject({ targetKey: SOL, effort: "xhigh" });
    expect(selectJevLevelCandidate(levels.deep, eligible)).toMatchObject({ targetKey: ASTRA, effort: "xhigh" });
  });

  test("skips targets that are not currently eligible or no longer allow the effort", () => {
    const withoutSol = eligible.filter(item => item.key !== SOL);
    expect(selectJevLevelCandidate(levels.hard, withoutSol)).toMatchObject({ targetKey: SONNET, effort: "xhigh" });
    const sonnetLowOnly = withoutSol.map(item => item.key === SONNET ? { ...item, reasoningEfforts: ["low" as const] } : item);
    expect(selectJevLevelCandidate(levels.hard, sonnetLowOnly)).toMatchObject({ targetKey: OPUS, effort: "xhigh" });
    expect(selectJevLevelCandidate(levels.trivial, eligible.filter(item => item.key === ASTRA))).toBeUndefined();
  });

  test("an effort-less candidate takes medium, else the next lower allowed effort, else none", () => {
    const plain = { candidates: [{ provider: "openai", model: "gpt-6-luna" }] };
    expect(selectJevLevelCandidate(plain, [candidate(LUNA, ["low", "medium", "max"])])?.effort).toBe("medium");
    expect(selectJevLevelCandidate(plain, [candidate(LUNA, ["low", "max"])])?.effort).toBe("low");
    expect(selectJevLevelCandidate(plain, [candidate(LUNA, [])])?.effort).toBeNull();
  });

  test("quota-aware selection prefers healthy or unknown, then limited, then nearly exhausted, stably", () => {
    const withQuota = (tiers: Record<string, JevQuotaSignal | undefined>) =>
      eligible.map(item => tiers[item.key] ? { ...item, quota: tiers[item.key] } : item);
    const hard = (tiers: Record<string, JevQuotaSignal | undefined>) =>
      selectJevLevelCandidate(levels.hard, withQuota(tiers), true)?.targetKey;

    expect(hard({ [SOL]: healthy, [SONNET]: healthy })).toBe(SOL);
    // Unknown quota counts as healthy and keeps list order.
    expect(hard({ [SOL]: limited })).toBe(SONNET);
    expect(hard({ [SOL]: exhausted, [SONNET]: limited, [OPUS]: limited, [ASTRA]: exhausted })).toBe(SONNET);
    expect(hard({ [SOL]: exhausted, [SONNET]: exhausted, [OPUS]: limited, [ASTRA]: limited })).toBe(OPUS);
    expect(hard({ [SOL]: exhausted, [SONNET]: exhausted, [OPUS]: exhausted, [ASTRA]: exhausted })).toBe(SOL);
    // Only quota-aware selection looks at tiers.
    expect(selectJevLevelCandidate(levels.hard, withQuota({ [SOL]: exhausted }), false)?.targetKey).toBe(SOL);
  });

  test("reports the usable candidates it weighed, once per target", () => {
    const picked = selectJevLevelCandidate(levels.agentic_light, eligible);
    expect(picked?.considered.map(item => item.key)).toEqual([LUNA, SOL]);
  });
});

describe("resolveJevLevelDecision", () => {
  test("applies the classified level's pick and records the path", async () => {
    const decision = await resolve({ post: answering(levelAnswer("deep", { probabilities: {
      trivial: 0, routine: 0.1, hard: 0.2, deep: 0.7, agentic_heavy: 0, agentic_light: 0,
    } })) });
    expect(decision).toMatchObject({
      gate: "apply", level: "deep", levelPath: "chosen", targetKey: ASTRA, effort: "xhigh",
      confidence: 0.8, chosenProbability: 0.7, usage: { input_tokens: 460, output_tokens: 3 },
    });
  });

  test("a level without usable candidates falls back to the fallback level, then fails open", async () => {
    const onlyLunaSol = eligible.filter(item => item.key === LUNA || item.key === SOL);
    const noAstra = { ...levels, deep: level(`${ASTRA}:xhigh`, `${OPUS}:xhigh`) };
    const viaDefault = await resolve({ levels: noAstra, candidates: onlyLunaSol, post: answering(levelAnswer("deep")) });
    expect(viaDefault).toMatchObject({ gate: "apply", level: "deep", levelPath: "fallback_level", targetKey: SOL, effort: "low" });

    const viaExplicit = await resolve({
      levels: noAstra, candidates: onlyLunaSol, fallbackLevel: "hard", post: answering(levelAnswer("deep")),
    });
    expect(viaExplicit).toMatchObject({ levelPath: "fallback_level", targetKey: SOL, effort: "xhigh" });

    const nothing = await resolve({
      levels: noAstra, candidates: onlyLunaSol, fallbackLevel: "deep", post: answering(levelAnswer("deep")),
    });
    expect(nothing).toMatchObject({ gate: "apply", level: "deep", levelPath: "fail_open", ...fallback });
  });

  test("decision failures fail open to the supplied fallback without a level", async () => {
    const cases: Array<[JevPost, string]> = [
      [(async () => new Response("down", { status: 503 })) as JevPost, "http"],
      [answering(levelAnswer("expert")), "invalid"],
      [answering({ answers: { route: { choice: "x" } } }), "invalid"],
      [(async () => new Response("not json")) as JevPost, "malformed"],
      [(async () => { throw new Error("connect refused"); }) as JevPost, "network"],
    ];
    for (const [post, gate] of cases) {
      const decision = await resolve({ post });
      expect(decision).toEqual({ backend: "systemone", ...fallback, gate, latencyMs: expect.any(Number), levelPath: "fail_open" } as never);
    }
    expect(await resolve({ config: { ...decisionConfig(), providers: {} }, post: answering(levelAnswer("hard")) }))
      .toMatchObject({ gate: "missing_key", levelPath: "fail_open" });
    expect(await resolve({ body: { input: "   " }, post: answering(levelAnswer("hard")) }))
      .toMatchObject({ gate: "no_state", levelPath: "fail_open" });
    expect(await resolve({ candidates: [], post: answering(levelAnswer("hard")) }))
      .toMatchObject({ gate: "no_choices", levelPath: "fail_open" });
    expect(await resolve({ levels: { hard: levels.hard }, post: answering(levelAnswer("hard")) }))
      .toMatchObject({ gate: "no_choices", levelPath: "fail_open" });
  });

  test("a caller abort stays cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("client left");
    const post = (async () => {
      controller.abort(reason);
      return Response.json(levelAnswer("hard"));
    }) as JevPost;
    await expect(resolve({ post, signal: controller.signal })).rejects.toBe(reason);
  });

  test("quota-aware resolution moves hard work off a nearly exhausted provider", async () => {
    const openaiExhausted = eligible.map(item => item.provider === "openai" ? { ...item, quota: exhausted } : { ...item, quota: healthy });
    const hard = await resolve({ candidates: openaiExhausted, quotaAware: true, post: answering(levelAnswer("hard")) });
    expect(hard).toMatchObject({ levelPath: "chosen", targetKey: SONNET, effort: "xhigh" });
    const deep = await resolve({ candidates: openaiExhausted, quotaAware: true, post: answering(levelAnswer("deep")) });
    expect(deep).toMatchObject({ targetKey: OPUS, effort: "xhigh" });
    const trivial = await resolve({ candidates: openaiExhausted, quotaAware: true, post: answering(levelAnswer("trivial")) });
    // Every trivial candidate is on the exhausted provider: the list order still decides.
    expect(trivial).toMatchObject({ targetKey: LUNA, effort: "low" });
  });

  test("the instructions string is the one validated in the eval", () => {
    expect(JEV_LEVEL_INSTRUCTIONS).toBe("Classify how demanding the work for the next model call is. Judge from the task and any tool evidence.");
  });
});

const targets = [
  { provider: "a", model: "m1", reasoningEfforts: ["low", "high"] },
  { provider: "b", model: "m2" },
];
const twoLevels = {
  trivial: { candidates: [{ provider: "a", model: "m1", effort: "low" }] },
  hard: { candidates: [{ provider: "b", model: "m2", effort: "xhigh" }, { provider: "a", model: "m1", effort: "high" }] },
};

function comboConfig(combos: OcxConfig["combos"] = undefined): OcxConfig {
  const providers: Record<string, OcxProviderConfig> = {
    a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
    b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
  };
  return { port: 10100, defaultProvider: "a", providers, ...(combos ? { combos } : {}) };
}

describe("level-mode combo fields", () => {
  const issuesFor = (combo: Record<string, unknown>) =>
    comboConfigIssues("auto", { targets, ...combo }, comboConfig().providers)
      .filter(issue => ["decisionMode", "decisionLevels", "decisionFallbackLevel"].includes(String(issue.path[0])))
      .map(issue => issue.message);

  test("accepts a level-mode JEV combo and route mode or omission alongside levels", () => {
    expect(issuesFor({ strategy: "jev", decisionMode: "level", decisionLevels: twoLevels })).toEqual([]);
    expect(issuesFor({ strategy: "jev", decisionMode: "route", decisionLevels: twoLevels, decisionFallbackLevel: "hard" })).toEqual([]);
    expect(issuesFor({ strategy: "jev", decisionMode: null, decisionLevels: null, decisionFallbackLevel: null })).toEqual([]);
    expect(issuesFor({ strategy: "failover", decisionMode: null, decisionLevels: null })).toEqual([]);
  });

  test("rejects every malformed level-mode shape with a specific message", () => {
    // A stale candidate is the one error a dashboard save can hit, so it names the way out.
    const fix = "; update the levels with `ocx combo set auto --decision-levels '<json>'` or clear them with `--decision-mode - --decision-levels -`";
    expect(issuesFor({ strategy: "jev", decisionMode: "auto" })).toEqual(['decisionMode must be "route" or "level"']);
    expect(issuesFor({ strategy: "jev", decisionMode: "level" })).toEqual(['decisionMode "level" requires decisionLevels']);
    expect(issuesFor({ strategy: "failover", decisionMode: "level", decisionLevels: twoLevels, decisionFallbackLevel: "hard" })).toEqual([
      'decisionMode is only valid with strategy "jev"',
      'decisionLevels is only valid with strategy "jev"',
      'decisionFallbackLevel is only valid with strategy "jev"',
    ]);
    expect(issuesFor({ strategy: "jev", decisionLevels: [] })).toEqual([
      "decisionLevels must be an object mapping level ids to { description?, candidates }",
    ]);
    expect(issuesFor({ strategy: "jev", decisionLevels: { ...twoLevels, expert: twoLevels.hard } })).toEqual([
      "decisionLevels.expert is not a level; use: trivial, routine, hard, deep, agentic_heavy, agentic_light",
    ]);
    expect(issuesFor({ strategy: "jev", decisionLevels: { hard: twoLevels.hard } })).toEqual([
      "decisionLevels must configure at least two levels",
    ]);
    expect(issuesFor({ strategy: "jev", decisionLevels: { ...twoLevels, deep: { candidates: [] } } })).toEqual([
      "decisionLevels.deep.candidates must be an array of 1 to 32 candidates",
    ]);
    expect(issuesFor({ strategy: "jev", decisionLevels: { ...twoLevels, deep: { candidates: [{ provider: "c", model: "m3" }] } } })).toEqual([
      `decisionLevels.deep.candidates[0] must name one of the combo targets by provider and model${fix}`,
    ]);
    expect(issuesFor({ strategy: "jev", decisionLevels: { ...twoLevels, deep: { candidates: [{ provider: "a", model: "m1", effort: "xhigh" }] } } })).toEqual([
      `decisionLevels.deep.candidates[0].effort "xhigh" is not in the reasoningEfforts of target "a/m1"${fix}`,
    ]);
    expect(issuesFor({ strategy: "jev", decisionLevels: { ...twoLevels, deep: { candidates: [{ provider: "b", model: "m2", effort: "huge" }] } } })).toEqual([
      "decisionLevels.deep.candidates[0].effort must be one of: low, medium, high, xhigh, max, ultra",
    ]);
    expect(issuesFor({ strategy: "jev", decisionLevels: { ...twoLevels, deep: { candidates: [{ provider: "b", model: "m2" }, { provider: " b ", model: "m2" }] } } })).toEqual([
      "decisionLevels.deep.candidates[1] duplicates an earlier candidate of this level",
    ]);
    const descriptionIssue = "decisionLevels.deep.description must be a non-empty string of at most 512 characters; only tab, line feed and carriage return are allowed among control and line-separator characters";
    for (const description of [" ", "bad\u0007bell", "line\u2028separator", "para\u2029separator"]) {
      expect(issuesFor({ strategy: "jev", decisionLevels: { ...twoLevels, deep: { description, candidates: [{ provider: "b", model: "m2" }] } } }))
        .toEqual([descriptionIssue]);
    }
    expect(issuesFor({ strategy: "jev", decisionLevels: { ...twoLevels, deep: { description: "tab\tand\nnewline\r", candidates: [{ provider: "b", model: "m2" }] } } })).toEqual([]);
    expect(issuesFor({ strategy: "jev", decisionLevels: twoLevels, decisionFallbackLevel: "expert" })).toEqual([
      "decisionFallbackLevel must be one of: trivial, routine, hard, deep, agentic_heavy, agentic_light",
    ]);
    expect(issuesFor({ strategy: "jev", decisionLevels: twoLevels, decisionFallbackLevel: "deep" })).toEqual([
      'decisionFallbackLevel "deep" is not configured in decisionLevels',
    ]);
    for (const decisionLevels of [undefined, null]) {
      expect(issuesFor({ strategy: "jev", decisionLevels, decisionFallbackLevel: "routine" })).toEqual([
        "decisionFallbackLevel requires decisionLevels",
      ]);
    }
  });

  test("normalizes sparsely: route is omission, levels keep canonical order and trimmed identity", () => {
    const cfg = comboConfig({
      level: {
        strategy: "jev",
        targets,
        decisionMode: "level",
        decisionLevels: {
          hard: { description: "  Hard work. ", candidates: [{ provider: " b ", model: "m2 ", effort: "xhigh" }] },
          trivial: { candidates: [{ provider: "a", model: "m1" }] },
        },
        decisionFallbackLevel: "trivial",
      },
      route: { strategy: "jev", targets, decisionMode: "route" },
      plain: { strategy: "jev", targets },
    } as unknown as OcxConfig["combos"]);
    const normalized = getCombo(cfg, "level")!;
    expect(normalized.decisionMode).toBe("level");
    expect(normalized.decisionFallbackLevel).toBe("trivial");
    expect(normalized.decisionLevels).toEqual({
      trivial: { candidates: [{ provider: "a", model: "m1" }] },
      hard: { description: "Hard work.", candidates: [{ provider: "b", model: "m2", effort: "xhigh" }] },
    });
    expect(Object.keys(normalized.decisionLevels!)).toEqual(["trivial", "hard"]);
    expect(getCombo(cfg, "route")).toEqual(getCombo(cfg, "plain"));
    expect(getCombo(cfg, "plain")).not.toHaveProperty("decisionMode");
    expect(getCombo(cfg, "plain")).not.toHaveProperty("decisionLevels");
  });

  test("management round-trip keeps level fields while omitted and drops them off jev", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const dir = mkdtempSync(join(tmpdir(), "ocx-jev-level-mode-"));
    process.env.OPENCODEX_HOME = dir;
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    const api = async (cfg: OcxConfig, method: string, requestBody?: unknown): Promise<Response> => {
      const req = new ManagementRequest("http://localhost/api/combos", {
        method,
        headers: requestBody === undefined ? undefined : { "content-type": "application/json" },
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      });
      return (await handleManagementAPI(req, new URL(req.url), cfg, {
        createManagementConvergeCodex: catalogConvergenceFactory(async () => {}),
      }))!;
    };
    try {
      const cfg = comboConfig();
      saveConfig(cfg);
      const saved = await api(cfg, "PUT", {
        id: "auto",
        combo: { strategy: "jev", targets, decisionMode: "level", decisionLevels: twoLevels, decisionFallbackLevel: "trivial", decisionPrompt: { levelInstructions: " Custom level. " } },
      });
      expect(saved.status).toBe(200);
      expect(cfg.combos?.auto).toMatchObject({ decisionMode: "level", decisionLevels: twoLevels, decisionFallbackLevel: "trivial" });
      const disk = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      expect(disk.combos?.auto?.decisionLevels).toEqual(twoLevels as never);
      // Decision wording has no typed slot yet; a stored value is carried through untouched.
      expect(disk.combos?.auto?.decisionPrompt).toEqual({ levelInstructions: " Custom level. " });
      const listed = await (await api(cfg, "GET")).json() as { combos: unknown[] };
      expect(listed.combos).toEqual([expect.objectContaining({ id: "auto", decisionMode: "level", decisionLevels: twoLevels })]);

      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionLevelSelect: "route" } })).status).toBe(200);
      expect(cfg.combos?.auto?.decisionLevelSelect).toBe("route");
      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets } })).status).toBe(200);
      expect(cfg.combos?.auto?.decisionLevelSelect).toBe("route");
      for (const clear of ["order", null]) {
        expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionLevelSelect: clear } })).status).toBe(200);
        expect(cfg.combos?.auto).not.toHaveProperty("decisionLevelSelect");
      }
      await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionLevelSelect: "route" } });
      // The dashboard shape: only decisionMode is sent; the levels ride along untouched.
      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionMode: null } })).status).toBe(200);
      expect(cfg.combos?.auto?.decisionPrompt).toEqual({ levelInstructions: " Custom level. " });
      expect(cfg.combos?.auto).not.toHaveProperty("decisionMode");
      expect(cfg.combos?.auto).not.toHaveProperty("decisionLevelSelect");
      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionLevelSelect: "route" } })).status).toBe(400);
      expect(cfg.combos?.auto).toMatchObject({ decisionLevels: twoLevels, decisionFallbackLevel: "trivial" });
      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionMode: "level" } })).status).toBe(200);
      expect(cfg.combos?.auto).toMatchObject({ decisionMode: "level", decisionLevels: twoLevels });

      const described = { ...twoLevels, trivial: { ...twoLevels.trivial, description: "Custom trivial." } };
      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionLevels: described } })).status).toBe(200);
      expect(cfg.combos?.auto?.decisionLevels?.trivial?.candidates).toEqual(twoLevels.trivial.candidates as never);
      expect(cfg.combos?.auto?.decisionLevels?.trivial?.description).toBe("Custom trivial.");
      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionPrompt: null } })).status).toBe(200);
      expect(cfg.combos?.auto).not.toHaveProperty("decisionPrompt");
      const cleared = await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionLevels: null } });
      expect(cleared.status).toBe(400);
      expect(await cleared.json()).toEqual({ error: 'decisionMode "level" requires decisionLevels' });

      // Removing a target that a level names is refused with the fix, not silently dropped.
      const stale = await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets: [targets[0]] } });
      expect(stale.status).toBe(400);
      expect((await stale.json() as { error: string }).error).toContain("ocx combo set auto --decision-levels");
      // Clearing the levels (and the mode) drops the stored fallback level with them.
      expect((await api(cfg, "PUT", {
        id: "auto", combo: { strategy: "jev", targets: [targets[0]], decisionMode: null, decisionLevels: null },
      })).status).toBe(200);
      for (const field of ["decisionMode", "decisionLevels", "decisionFallbackLevel"]) {
        expect(cfg.combos?.auto).not.toHaveProperty(field);
      }
      await api(cfg, "PUT", {
        id: "auto",
        combo: { strategy: "jev", targets, decisionMode: "level", decisionLevels: twoLevels, decisionFallbackLevel: "trivial" },
      });

      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionPrompt: { route: { speed: "Custom speed." } } } })).status).toBe(200);
      expect((await api(cfg, "PUT", { id: "auto", combo: { strategy: "failover", targets } })).status).toBe(200);
      expect(cfg.combos?.auto).not.toHaveProperty("decisionPrompt");
      for (const field of ["decisionMode", "decisionLevels", "decisionFallbackLevel"]) {
        expect(cfg.combos?.auto).not.toHaveProperty(field);
      }
      const rejected = await api(cfg, "PUT", { id: "auto", combo: { strategy: "jev", targets, decisionMode: "level" } });
      expect(rejected.status).toBe(400);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      removeTreeWithRetry(dir);
    }
  });
});

describe("JEV decision log level fields", () => {
  const base = {
    version: 1,
    comboId: "auto",
    selected: { provider: "cursor", model: "claude-sonnet-5-5", effort: "xhigh" },
    gate: "apply",
    latencyMs: 12,
  };

  test("keeps a known level and path, and old rows stay parseable", () => {
    expect(normalizePersistedJevDecision({ ...base, level: "hard", levelPath: "chosen" })).toMatchObject({ level: "hard", levelPath: "chosen" });
    expect(normalizePersistedJevDecision({ ...base, levelPath: "fail_open" })).toEqual({ ...base, levelPath: "fail_open" } as never);
    const old = normalizePersistedJevDecision(base);
    expect(old).toEqual(base as never);
  });

  test("drops unknown levels and paths, and a level without its path", () => {
    for (const extra of [
      { level: "expert", levelPath: "chosen" },
      { level: "hard", levelPath: "guessed" },
      { level: "hard" },
      { level: 3, levelPath: 1 },
    ]) {
      const normalized = normalizePersistedJevDecision({ ...base, ...extra });
      expect(normalized).toBeDefined();
      expect(normalized).not.toHaveProperty("level");
      if (extra.levelPath !== "chosen") expect(normalized).not.toHaveProperty("levelPath");
    }
  });
});
