import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget } from "../../src/combos";
import { clearGatherRoutedModelsInflight } from "../../src/codex/catalog";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import type { ResponsesDispatchers } from "../../src/server/responses/core-options";
import type { RequestLogContext } from "../../src/server/request-log";
import { clearCachedProviderQuotas, setCachedProviderQuotaForTests } from "../../src/providers/quota-routing-cache";
import type { OcxComboConfig, OcxConfig, OcxProviderConfig } from "../../src/types";

const targetRows = [
  { provider: "astra", model: "gpt-6-astra" },
  { provider: "sol", model: "gpt-5.6-sol" },
  { provider: "luna", model: "gpt-5.6-luna" },
] as const;

const decisionLevels: NonNullable<OcxComboConfig["decisionLevels"]> = {
  trivial: { candidates: [{ provider: "luna", model: "gpt-5.6-luna", effort: "low" }] },
  routine: { candidates: [{ provider: "sol", model: "gpt-5.6-sol", effort: "low" }, { provider: "luna", model: "gpt-5.6-luna" }] },
  hard: { candidates: [{ provider: "sol", model: "gpt-5.6-sol", effort: "xhigh" }, { provider: "astra", model: "gpt-6-astra", effort: "xhigh" }] },
  deep: { candidates: [{ provider: "astra", model: "gpt-6-astra", effort: "max" }] },
};

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearGatherRoutedModelsInflight();
});

afterEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearGatherRoutedModelsInflight();
  clearCachedProviderQuotas();
});

function modelProvider(model: string, efforts: string[]): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: `https://${model}.example.test/v1`,
    authMode: "key",
    apiKey: `key-${model}`,
    liveModels: false,
    models: [model],
    modelContextWindows: { [model]: 258_400 },
    modelMaxInputTokens: { [model]: 219_640 },
    modelInputModalities: { [model]: ["text", "image"] },
    modelReasoningEfforts: { [model]: efforts },
  };
}

function makeConfig(jevFetch: typeof fetch, providerOverrides: Partial<Record<"astra" | "sol" | "luna", Partial<OcxProviderConfig>>> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "astra",
    providers: {
      "tev1-local": {
        adapter: "jev-decision",
        baseUrl: "http://127.0.0.1:11434/v1/systemone",
        allowPrivateNetwork: true,
        defaultModel: "tev1:4b",
        liveModels: false,
        fetch: jevFetch,
      } as OcxProviderConfig,
      astra: { ...modelProvider("gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]), ...providerOverrides.astra },
      sol: { ...modelProvider("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max"]), ...providerOverrides.sol },
      luna: { ...modelProvider("gpt-5.6-luna", ["low", "medium", "high"]), ...providerOverrides.luna },
    },
    combos: {
      auto: {
        alias: "jev-auto",
        strategy: "jev",
        reasoningEffortMode: "adaptive",
        decisionProvider: "tev1-local",
        decisionMode: "level",
        decisionLevels,
        targets: targetRows.map(target => ({ ...target })),
      },
    },
  };
}

function levelFetch(choice: string, seen: Array<Record<string, unknown>> = []): typeof fetch {
  return (async (_input, init) => {
    seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ answers: { level: { choice, probabilities: { trivial: 0.05, routine: 0.05, hard: 0.05, deep: 0.05, [choice]: 0.85 } } } });
  }) as typeof fetch;
}

function dispatchers(childBodies: Array<Record<string, unknown>>): ResponsesDispatchers {
  return {
    async handleResponses(request) {
      const body = await request.json() as Record<string, unknown>;
      childBodies.push(body);
      return Response.json({ id: "resp", object: "response", status: "completed", model: body.model, output: [] });
    },
    async handleComboResponses() {
      throw new Error("nested combo dispatch is not expected");
    },
  };
}

async function execute(config: OcxConfig, raw: Record<string, unknown> = {}) {
  const body = { model: "jev-auto", input: "Fix the race in the job scheduler.", stream: false, ...raw };
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const childBodies: Array<Record<string, unknown>> = [];
  const budget = createTranslatorBudget();
  try {
    const response = await executeComboResponses(request, body, "auto", config, logCtx, { translatorBudget: budget }, dispatchers(childBodies));
    return { response, logCtx, childBodies };
  } finally {
    budget.dispose();
  }
}

describe("JEV Combo level mode", () => {
  test("classifies the level, dispatches the level's pick with its effort, and logs level and path", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    try {
      const { response, logCtx, childBodies } = await execute(makeConfig(levelFetch("hard", seen)), {
        reasoning: { effort: "low", summary: "auto" },
        service_tier: "priority",
      });
      expect(response.status).toBe(200);
      expect(Object.keys((seen[0]!.questions as { level: { criteria: object } }).level.criteria)).toEqual(["trivial", "routine", "hard", "deep"]);
      expect(childBodies).toEqual([expect.objectContaining({ model: "sol/gpt-5.6-sol", reasoning: { effort: "xhigh", summary: "auto" } })]);
      expect(childBodies[0]).not.toHaveProperty("service_tier");
      expect(logCtx.jevDecision).toMatchObject({
        selected: { provider: "sol", model: "gpt-5.6-sol", effort: "xhigh" },
        gate: "apply",
        level: "hard",
        levelPath: "chosen",
        chosenProbability: 0.85,
      });
      expect(debug).toHaveBeenCalledWith("[combo] JEV decision", expect.objectContaining({ level: "hard", levelPath: "chosen", chosenProbability: 0.85 }));
    } finally {
      debug.mockRestore();
    }
  });

  test("skips a cooling target and an effort the target no longer offers", async () => {
    const config = makeConfig(levelFetch("hard"));
    coolComboTarget("auto", targetRows[1], { cooldownMs: 60_000 });
    const cooled = await execute(config);
    expect(cooled.childBodies[0]).toMatchObject({ model: "astra/gpt-6-astra", reasoning: { effort: "xhigh" } });

    clearComboTargetCooldowns();
    const noXhigh = makeConfig(levelFetch("hard"), { sol: { modelReasoningEfforts: { "gpt-5.6-sol": ["low", "medium"] } } });
    const skipped = await execute(noXhigh);
    expect(skipped.childBodies[0]).toMatchObject({ model: "astra/gpt-6-astra", reasoning: { effort: "xhigh" } });
  });

  test("an effort-less candidate uses medium or the next lower allowed effort", async () => {
    const config = makeConfig(levelFetch("routine"));
    coolComboTarget("auto", targetRows[1], { cooldownMs: 60_000 });
    const { childBodies, logCtx } = await execute(config);
    expect(childBodies[0]).toMatchObject({ model: "luna/gpt-5.6-luna", reasoning: { effort: "medium" } });
    expect(logCtx.jevDecision).toMatchObject({ level: "routine", levelPath: "chosen" });
  });

  test("falls back to the fallback level, then fails open, and records the path", async () => {
    const disabledAstra = makeConfig(levelFetch("deep"), { astra: { disabled: true } });
    const viaRoutine = await execute(disabledAstra);
    expect(viaRoutine.childBodies[0]).toMatchObject({ model: "sol/gpt-5.6-sol", reasoning: { effort: "low" } });
    expect(viaRoutine.logCtx.jevDecision).toMatchObject({ level: "deep", levelPath: "fallback_level" });

    const explicit = makeConfig(levelFetch("deep"), { astra: { disabled: true } });
    explicit.combos!.auto!.decisionFallbackLevel = "deep";
    const failOpen = await execute(explicit);
    // First eligible target at the fail-open effort.
    expect(failOpen.childBodies[0]).toMatchObject({ model: "sol/gpt-5.6-sol", reasoning: { effort: "medium" } });
    expect(failOpen.logCtx.jevDecision).toMatchObject({ gate: "apply", level: "deep", levelPath: "fail_open" });
  });

  test("a failed decision fails open exactly like route mode, without a level", async () => {
    const broken = makeConfig((async () => new Response("busy", { status: 503 })) as typeof fetch);
    const { childBodies, logCtx } = await execute(broken);
    expect(childBodies[0]).toMatchObject({ model: "astra/gpt-6-astra", reasoning: { effort: "medium" } });
    expect(logCtx.jevDecision).toMatchObject({ gate: "http", levelPath: "fail_open" });
    expect(logCtx.jevDecision).not.toHaveProperty("level");
  });

  test("quota-aware selection moves off a nearly exhausted target and logs the tier summary", async () => {
    const now = Date.now();
    setCachedProviderQuotaForTests("sol", { weeklyPercent: 97, weeklyResetAt: now + 86_400_000, updatedAt: now - 60_000 });
    setCachedProviderQuotaForTests("astra", { fiveHourPercent: 12, updatedAt: now - 60_000 });
    const seen: Array<Record<string, unknown>> = [];
    const config = makeConfig(levelFetch("hard", seen));
    const unaware = await execute(config);
    expect(unaware.childBodies[0]).toMatchObject({ model: "sol/gpt-5.6-sol" });
    expect(unaware.logCtx.jevDecision).not.toHaveProperty("quota");

    config.combos!.auto!.decisionQuotaSignals = true;
    const aware = await execute(config);
    expect(aware.childBodies[0]).toMatchObject({ model: "astra/gpt-6-astra", reasoning: { effort: "xhigh" } });
    expect(aware.logCtx.jevDecision).toMatchObject({
      levelPath: "chosen",
      quota: { healthy: 1, limited: 0, nearly_exhausted: 1, selected: "healthy" },
    });
    // Quota never enters a level-mode decision request.
    expect(JSON.stringify(seen[1])).toBe(JSON.stringify(seen[0]));
  });

  test("decisionLevels without level mode leave route mode byte-identical", async () => {
    const routeSeen: Array<Record<string, unknown>> = [];
    const routeFetch = (async (_input, init) => {
      routeSeen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ answers: { route: { choice: "sol/gpt-5.6-sol:high" } } });
    }) as typeof fetch;
    const withLevels = makeConfig(routeFetch);
    delete withLevels.combos!.auto!.decisionMode;
    const without = makeConfig(routeFetch);
    delete without.combos!.auto!.decisionMode;
    delete without.combos!.auto!.decisionLevels;

    const first = await execute(withLevels);
    const second = await execute(without);
    expect(first.childBodies[0]).toMatchObject({ model: "sol/gpt-5.6-sol", reasoning: { effort: "high" } });
    expect(second.childBodies[0]).toEqual(first.childBodies[0]!);
    expect(JSON.stringify(routeSeen[1])).toBe(JSON.stringify(routeSeen[0]));
    expect(routeSeen[0]!.questions).toHaveProperty("route");
    expect(first.logCtx.jevDecision).not.toHaveProperty("levelPath");
  });
});

for (const valid of [true, false]) test(`hierarchical dispatch ${valid ? "applies" : "retains"} target and effort with bounded telemetry`, async () => {
  let calls = 0;
  const fetchDecision = (async () => {
    if (++calls === 1) return Response.json({ answers: { level: { choice: "hard" } }, usage: { input_tokens: 10, output_tokens: 1 } });
    return Response.json(valid ? { answers: { route: { choice: "astra/gpt-6-astra:xhigh" } }, usage: { inputTokens: 20, outputTokens: 2 } } : {});
  }) as typeof fetch;
  const config = makeConfig(fetchDecision);
  config.combos!.auto!.decisionLevelSelect = "route";
  const { response, logCtx, childBodies } = await execute(config);
  expect(response.status).toBe(200);
  expect(calls).toBe(2);
  expect(childBodies[0]).toMatchObject({ model: valid ? "astra/gpt-6-astra" : "sol/gpt-5.6-sol", reasoning: { effort: "xhigh" } });
  expect(logCtx.jevDecision).toMatchObject({ gate: "apply", level: "hard", levelPath: "chosen", levelSelectPath: valid ? "route" : "order_fallback", levelSelectGate: valid ? "apply" : "invalid", usage: valid ? { inputTokens: 30, outputTokens: 3, totalTokens: 33 } : { inputTokens: 10, outputTokens: 1, totalTokens: 11 } });
});
