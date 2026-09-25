import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearComboSelectionState,
  clearComboTargetCooldowns,
  coolComboTarget,
} from "../../src/combos";
import { catalogModelSlug, clearGatherRoutedModelsInflight, gatherRoutedModels } from "../../src/codex/catalog";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import type { ResponsesDispatchers } from "../../src/server/responses/core-options";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const targetRows = [
  { provider: "astra", model: "gpt-6-astra" },
  { provider: "sol", model: "gpt-5.6-sol" },
  { provider: "luna", model: "gpt-5.6-luna" },
] as const;

const previousTypesafeKey = process.env.TYPESAFE_API_KEY;
const previousJevKey = process.env.JEV_API_KEY;

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearGatherRoutedModelsInflight();
});

afterEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearGatherRoutedModelsInflight();
  if (previousTypesafeKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = previousTypesafeKey;
  if (previousJevKey === undefined) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = previousJevKey;
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

function makeConfig(options: {
  jevFetch?: typeof fetch;
  jevKey?: string | null;
  providerOverrides?: Partial<Record<"astra" | "sol" | "luna", Partial<OcxProviderConfig>>>;
} = {}): OcxConfig {
  const jev: OcxProviderConfig = {
    adapter: "jev-decision",
    baseUrl: JEV_URL,
    authMode: "key",
    liveModels: false,
    ...(options.jevKey === null ? {} : { apiKey: options.jevKey ?? "typesafe-test-key" }),
    ...(options.jevFetch ? { fetch: options.jevFetch } : {}),
  };
  const astra = { ...modelProvider("gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]), ...options.providerOverrides?.astra };
  const sol = { ...modelProvider("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max"]), ...options.providerOverrides?.sol };
  const luna = { ...modelProvider("gpt-5.6-luna", ["low", "medium", "high"]), ...options.providerOverrides?.luna };
  return {
    port: 0,
    defaultProvider: "astra",
    providers: { jev, astra, sol, luna },
    combos: {
      auto: {
        alias: "jev-auto",
        displayName: "JEV Auto",
        strategy: "jev",
        reasoningEffortMode: "adaptive",
        targets: targetRows.map(target => ({ ...target })),
      },
    },
  };
}

type ChildHandler = (
  body: Record<string, unknown>,
  logCtx: RequestLogContext,
  options?: Parameters<ResponsesDispatchers["handleResponses"]>[3],
) => Response | Promise<Response>;

function dispatchers(handler: ChildHandler): ResponsesDispatchers {
  return {
    async handleResponses(request, _config, logCtx, options) {
      return handler(await request.json() as Record<string, unknown>, logCtx, options);
    },
    async handleComboResponses() {
      throw new Error("nested combo dispatch is not expected");
    },
  };
}

async function execute(
  config: OcxConfig,
  handler: ChildHandler,
  raw: Record<string, unknown> = {},
  signal?: AbortSignal,
  parentLogCtx: RequestLogContext = { model: "", provider: "" },
): Promise<Response> {
  const body = {
    model: "jev-auto",
    input: "Implement the next step.",
    stream: false,
    ...raw,
  };
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const budget = createTranslatorBudget();
  try {
    return await executeComboResponses(
      request,
      body,
      "auto",
      config,
      parentLogCtx,
      { translatorBudget: budget, ...(signal ? { abortSignal: signal } : {}) },
      dispatchers(handler),
    );
  } finally {
    budget.dispose();
  }
}

function choiceFetch(
  choice: string,
  seen: Array<Record<string, unknown>> = [],
): typeof fetch {
  return (async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push(payload);
    return Response.json({ answers: { route: { choice, confidence: 0.8 } } });
  }) as typeof fetch;
}

function success(model: string): Response {
  return Response.json({ id: `resp-${model}`, object: "response", status: "completed", model, output: [] });
}

describe("JEV Combo runtime", () => {
  test("records the selected target and JEV usage on the parent request", async () => {
    const config = makeConfig({
      jevFetch: (async () => Response.json({
        answers: { route: { choice: "sol/gpt-5.6-sol:high", confidence: 0.8 } },
        usage: { input_tokens: 11, output_tokens: 2 },
      })) as typeof fetch,
    });
    const parentLogCtx: RequestLogContext = { model: "", provider: "" };

    const response = await execute(
      config,
      body => success(String(body.model)),
      {},
      undefined,
      parentLogCtx,
    );

    expect(response.status).toBe(200);
    expect(parentLogCtx.jevDecision).toEqual({
      version: 1,
      comboId: "auto",
      selected: { provider: "sol", model: "gpt-5.6-sol", effort: "high" },
      gate: "apply",
      latencyMs: expect.any(Number),
      confidence: 0.8,
      usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
    });
  });

  test("routes the initial call to JEV's allowlisted target and keeps direct/catalog rows", async () => {
    const jevRequests: Array<Record<string, unknown>> = [];
    const config = makeConfig({
      jevFetch: choiceFetch("sol/gpt-5.6-sol:high", jevRequests),
    });
    const childBodies: Record<string, unknown>[] = [];

    const response = await execute(config, body => {
      childBodies.push(body);
      return success(String(body.model));
    }, {
      reasoning: { effort: "low", summary: "auto" },
      reasoning_effort: "max",
      thinking_budget: 8_000,
      thinking: { type: "enabled", budget_tokens: 8_000 },
      service_tier: "priority",
    });

    expect(response.status).toBe(200);
    expect(childBodies).toEqual([expect.objectContaining({
      model: "sol/gpt-5.6-sol",
      reasoning: { effort: "high", summary: "auto" },
    })]);
    expect(childBodies[0]).not.toHaveProperty("service_tier");
    expect(childBodies[0]).not.toHaveProperty("reasoning_effort");
    expect(childBodies[0]).not.toHaveProperty("thinking_budget");
    expect(childBodies[0]).not.toHaveProperty("thinking");
    expect(jevRequests).toHaveLength(1);
    expect(jevRequests[0]).toMatchObject({ model: "jev-latest" });

    const catalogConfig = makeConfig();
    delete (catalogConfig.providers.jev as OcxProviderConfig & { fetch?: typeof fetch }).fetch;
    const models = await gatherRoutedModels(catalogConfig);
    expect(models.filter(model => model.provider === "combo").map(catalogModelSlug)).toEqual(["jev-auto"]);
    for (const target of targetRows) {
      expect(models.some(model => model.provider === target.provider && model.id === target.model)).toBeTrue();
    }
    expect(models.some(model => model.provider === "jev")).toBeFalse();
  });

  test("replaces caller sentinel efforts with JEV's selected effort", async () => {
    for (const sentinel of ["none", "minimal"]) {
      const config = makeConfig({ jevFetch: choiceFetch("sol/gpt-5.6-sol:high") });
      const childBodies: Record<string, unknown>[] = [];

      const response = await execute(config, body => {
        childBodies.push(body);
        return success(String(body.model));
      }, {
        reasoning: { effort: sentinel, summary: "auto" },
        reasoning_effort: sentinel,
        thinking_budget: 8_000,
        thinking: { type: "enabled", budget_tokens: 8_000 },
      });

      expect(response.status).toBe(200);
      expect(childBodies).toEqual([expect.objectContaining({
        model: "sol/gpt-5.6-sol",
        reasoning: { effort: "high", summary: "auto" },
      })]);
      expect(childBodies[0]).not.toHaveProperty("reasoning_effort");
      expect(childBodies[0]).not.toHaveProperty("thinking_budget");
      expect(childBodies[0]).not.toHaveProperty("thinking");
    }
  });

  test("fails open to the first eligible target at medium without requiring a Combo default", async () => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_API_KEY;
    let jevCalls = 0;
    const noKey = makeConfig({
      jevKey: null,
      jevFetch: (async () => {
        jevCalls += 1;
        return Response.json({});
      }) as typeof fetch,
    });
    const missingKeyBodies: Record<string, unknown>[] = [];
    const missingKey = await execute(noKey, body => {
      missingKeyBodies.push(body);
      return success(String(body.model));
    }, { reasoning: { effort: "max" }, service_tier: "priority" });

    expect(missingKey.status).toBe(200);
    expect(jevCalls).toBe(0);
    expect(missingKeyBodies[0]).toMatchObject({
      model: "astra/gpt-6-astra",
      reasoning: { effort: "medium" },
    });
    expect(missingKeyBodies[0]).not.toHaveProperty("service_tier");

    const invalidBodies: Record<string, unknown>[] = [];
    const invalid = makeConfig({ jevFetch: choiceFetch("attacker/model:max") });
    const invalidResponse = await execute(invalid, body => {
      invalidBodies.push(body);
      return success(String(body.model));
    });
    expect(invalidResponse.status).toBe(200);
    expect(invalidBodies[0]).toMatchObject({
      model: "astra/gpt-6-astra",
      reasoning: { effort: "medium" },
    });
  });

  test("uses ordinary Combo fallback once after a selected target fails", async () => {
    const jevRequests: Array<Record<string, unknown>> = [];
    const config = makeConfig({ jevFetch: choiceFetch("sol/gpt-5.6-sol:high", jevRequests) });
    const childBodies: Record<string, unknown>[] = [];

    const response = await execute(config, body => {
      childBodies.push(body);
      return String(body.model).startsWith("sol/")
        ? Response.json({ error: { message: "temporary outage" } }, { status: 503 })
        : success(String(body.model));
    }, {
      reasoning: { effort: "low", summary: "auto" },
      service_tier: "priority",
    });

    expect(response.status).toBe(200);
    expect(jevRequests).toHaveLength(1);
    expect(childBodies).toHaveLength(2);
    expect(childBodies[0]).toMatchObject({
      model: "sol/gpt-5.6-sol",
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(childBodies[0]).not.toHaveProperty("service_tier");
    expect(childBodies[1]).toMatchObject({
      model: "astra/gpt-6-astra",
      reasoning: { effort: "low", summary: "auto" },
      service_tier: "priority",
    });
  });

  test("defers reset-derived cooldown when an earlier same-provider target remains", async () => {
    const config = makeConfig({ jevFetch: choiceFetch("astra/gpt-5.6-sol:high") });
    config.providers.astra = {
      ...config.providers.astra!,
      models: ["gpt-6-astra", "gpt-5.6-sol"],
      modelContextWindows: {
        "gpt-6-astra": 258_400,
        "gpt-5.6-sol": 258_400,
      },
      modelMaxInputTokens: {
        "gpt-6-astra": 219_640,
        "gpt-5.6-sol": 219_640,
      },
      modelInputModalities: {
        "gpt-6-astra": ["text", "image"],
        "gpt-5.6-sol": ["text", "image"],
      },
      modelReasoningEfforts: {
        "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
        "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
      },
    };
    config.combos!.auto!.targets = [
      { provider: "astra", model: "gpt-6-astra" },
      { provider: "astra", model: "gpt-5.6-sol" },
      { provider: "luna", model: "gpt-5.6-luna" },
    ];
    const cooldownDeferrals: Array<boolean | undefined> = [];

    const response = await execute(config, (body, _logCtx, options) => {
      cooldownDeferrals.push(options?.deferCodexResetDerivedCooldown);
      return success(String(body.model));
    });

    expect(response.status).toBe(200);
    expect(cooldownDeferrals).toEqual([true]);
  });

  test("offers only currently eligible targets to JEV", async () => {
    const jevRequests: Array<Record<string, unknown>> = [];
    const config = makeConfig({
      jevFetch: choiceFetch("sol/gpt-5.6-sol:low", jevRequests),
      providerOverrides: { luna: { disabled: true } },
    });
    coolComboTarget("auto", targetRows[0], { cooldownMs: 60_000 });

    const response = await execute(config, body => success(String(body.model)));

    expect(response.status).toBe(200);
    const questions = jevRequests[0]?.questions as {
      route?: { criteria?: Record<string, unknown> };
    };
    expect(Object.keys(questions.route?.criteria ?? {})).toEqual([
      "sol/gpt-5.6-sol:low",
      "sol/gpt-5.6-sol:medium",
      "sol/gpt-5.6-sol:high",
      "sol/gpt-5.6-sol:xhigh",
      "sol/gpt-5.6-sol:max",
    ]);
  });

  test("withholds lastResort targets from JEV under before-last-resort only while a normal target is offered", async () => {
    const criteriaFor = async (disableNormal: boolean): Promise<string[]> => {
      const jevRequests: Array<Record<string, unknown>> = [];
      const config = makeConfig({
        jevFetch: choiceFetch("luna/gpt-5.6-luna:low", jevRequests),
        ...(disableNormal ? { providerOverrides: { astra: { disabled: true }, sol: { disabled: true } } } : {}),
      });
      config.combos!.auto!.cooldownWaitPolicy = "before-last-resort";
      config.combos!.auto!.targets = targetRows.map(target =>
        target.provider === "luna" ? { ...target, lastResort: true } : { ...target });
      expect((await execute(config, body => success(String(body.model)))).status).toBe(200);
      const questions = jevRequests[0]?.questions as { route?: { criteria?: Record<string, unknown> } };
      return Object.keys(questions.route?.criteria ?? {});
    };

    const withNormal = await criteriaFor(false);
    expect(withNormal.some(key => key.startsWith("astra/"))).toBe(true);
    expect(withNormal.some(key => key.startsWith("luna/"))).toBe(false);
    // With no normal target reachable, the emergency target is still offered.
    expect(await criteriaFor(true)).toEqual([
      "luna/gpt-5.6-luna:low",
      "luna/gpt-5.6-luna:medium",
      "luna/gpt-5.6-luna:high",
    ]);
  });

  test("offers only each target's configured reasoning efforts and skips stale empty intersections", async () => {
    const jevRequests: Array<Record<string, unknown>> = [];
    const config = makeConfig({
      jevFetch: choiceFetch("sol/gpt-5.6-sol:medium", jevRequests),
    });
    config.combos!.auto!.targets = [
      { ...targetRows[0], reasoningEfforts: ["low", "high", "ultra"] },
      { ...targetRows[1], reasoningEfforts: ["medium"] },
      { ...targetRows[2], reasoningEfforts: ["ultra"] },
    ];
    const childBodies: Record<string, unknown>[] = [];

    const response = await execute(config, body => {
      childBodies.push(body);
      return success(String(body.model));
    });

    expect(response.status).toBe(200);
    const criteria = (jevRequests[0]?.questions as {
      route: { criteria: Record<string, unknown> };
    }).route.criteria;
    expect(Object.keys(criteria)).toEqual([
      "astra/gpt-6-astra:low",
      "astra/gpt-6-astra:high",
      "sol/gpt-5.6-sol:medium",
    ]);
    expect(childBodies[0]).toMatchObject({
      model: "sol/gpt-5.6-sol",
      reasoning: { effort: "medium" },
    });
  });

  test("re-enumerates JEV choices after waiting for a cooldown to expire", async () => {
    const jevRequests: Array<Record<string, unknown>> = [];
    const config = makeConfig({
      jevFetch: choiceFetch("astra/gpt-6-astra:medium", jevRequests),
    });
    config.combos!.auto!.waitForCooldownMs = 1_000;
    const cooledAt = Date.now();
    for (const target of targetRows) {
      coolComboTarget("auto", target, { now: cooledAt, cooldownMs: 80 });
    }
    const childBodies: Record<string, unknown>[] = [];

    const response = await execute(config, body => {
      childBodies.push(body);
      return success(String(body.model));
    });

    expect(response.status).toBe(200);
    expect(jevRequests).toHaveLength(1);
    expect(childBodies[0]?.model).toBe("astra/gpt-6-astra");
    const criteria = (jevRequests[0]?.questions as {
      route: { criteria: Record<string, { target: string }> };
    }).route.criteria;
    expect([...new Set(Object.values(criteria).map(option => option.target))]).toEqual([
      "astra/gpt-6-astra",
      "sol/gpt-5.6-sol",
      "luna/gpt-5.6-luna",
    ]);
  });

  test("represents an empty effort ladder as none and strips every caller effort control", async () => {
    const jevRequests: Array<Record<string, unknown>> = [];
    const config = makeConfig({
      jevFetch: choiceFetch("sol/gpt-5.6-sol:none", jevRequests),
      providerOverrides: { sol: { modelReasoningEfforts: { "gpt-5.6-sol": [] } } },
    });
    const childBodies: Record<string, unknown>[] = [];

    const response = await execute(config, body => {
      childBodies.push(body);
      return success(String(body.model));
    }, {
      reasoning: { effort: "high", summary: "auto" },
      reasoning_effort: "xhigh",
      thinking_budget: 8_000,
      thinking: { type: "enabled", budget_tokens: 8_000 },
    });

    expect(response.status).toBe(200);
    expect(Object.keys((jevRequests[0]?.questions as { route: { criteria: Record<string, unknown> } }).route.criteria))
      .toContain("sol/gpt-5.6-sol:none");
    expect(childBodies[0]).toMatchObject({
      model: "sol/gpt-5.6-sol",
      reasoning: { summary: "auto" },
    });
    expect(childBodies[0]).not.toHaveProperty("reasoning_effort");
    expect(childBodies[0]).not.toHaveProperty("thinking_budget");
    expect(childBodies[0]).not.toHaveProperty("thinking");
  });

  test("returns 499 without dispatching a model when the caller aborts during JEV", async () => {
    const controller = new AbortController();
    const reason = new DOMException("caller stopped", "AbortError");
    const jevFetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      queueMicrotask(() => controller.abort(reason));
    })) as typeof fetch;
    const config = makeConfig({ jevFetch });
    let modelDispatches = 0;

    const response = await execute(config, body => {
      modelDispatches += 1;
      return success(String(body.model));
    }, {}, controller.signal);

    expect(response.status).toBe(499);
    expect(modelDispatches).toBe(0);
  });
});
