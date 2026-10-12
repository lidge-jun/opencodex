import { afterEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns, resolveJevDecision } from "../../src/combos";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { admissionModelScopeOf, routeAllowedByScope } from "../../src/server/admission-model-scope";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const admission: DataPlaneAdmission = { kind: "configured", keyId: "fixture-key", source: "bearer" };
afterEach(() => { clearComboSelectionState(); clearComboTargetCooldowns(); });

function fixture(scope: { allowedProviders?: string[]; allowedModels?: string[] }, decisionProvider = "decider") {
  let keyReads = 0;
  let sends = 0;
  const decision: OcxProviderConfig = {
    adapter: "jev-decision", baseUrl: "https://decider.example/v1/systemone", defaultModel: "tev1:4b", liveModels: false,
    get apiKey() { keyReads++; return "fixture-decision-key"; },
    fetch: (async () => {
      sends++;
      return Response.json({ answers: { route: { choice: "a/m2:low", confidence: 0.9 } } });
    }) as typeof fetch,
  };
  const config: OcxConfig = {
    port: 0, defaultProvider: "a",
    apiKeys: [{ id: "fixture-key", key: "fixture-admission-key", name: "fixture", createdAt: "2026-01-01T00:00:00.000Z", ...scope }],
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://inference.example/v1", apiKey: "fixture-inference-key", liveModels: false,
        models: ["m1", "m2"], modelReasoningEfforts: { m1: ["low"], m2: ["low"] } },
      [decisionProvider]: decision,
    },
    combos: { auto: { alias: "auto", strategy: "jev", decisionProvider, targets: [{ provider: "a", model: "m1" }, { provider: "a", model: "m2" }] } },
  };
  return { config, decision, keyReads: () => keyReads, sends: () => sends };
}

async function run(config: OcxConfig) {
  const body = { model: "auto", input: "Choose an appropriate model for this task.", stream: false };
  const budget = createTranslatorBudget();
  const children: string[] = [];
  try {
    const response = await executeComboResponses(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), body, "auto", config, { model: "", provider: "" }, { translatorBudget: budget, admission }, {
      async handleResponses(request, _config, _log, options) {
        expect(options?.admission).toEqual(admission);
        const child = await request.json() as { model: string };
        children.push(child.model);
        return Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [] });
      },
      async handleComboResponses() { throw new Error("unexpected nested combo"); },
    });
    expect(response.status).toBe(200);
    await response.text();
    return children;
  } finally { budget.dispose(); }
}

describe("JEV decision destination scope", () => {
  test("a denied provider performs no credential work or send and keeps the inference fallback", async () => {
    const f = fixture({ allowedProviders: ["a"], allowedModels: ["a/m1"] });
    expect(await run(f.config)).toEqual(["a/m1"]);
    expect(f.keyReads()).toBe(0);
    expect(f.sends()).toBe(0);
  });
  test("model-only restrictions also prevent a decision send", async () => {
    const f = fixture({ allowedModels: ["a/m1"] });
    expect(await run(f.config)).toEqual(["a/m1"]);
    expect(f.keyReads()).toBe(0);
    expect(f.sends()).toBe(0);
  });
  test("an allowed normalized provider/model still decides the inference target", async () => {
    const f = fixture({ allowedProviders: [" A ", " DECIDER "], allowedModels: ["a/m1", "a/m2", " DECIDER/TEV1:4B "] });
    expect(await run(f.config)).toEqual(["a/m2"]);
    expect(f.keyReads()).toBeGreaterThan(0);
    expect(f.sends()).toBe(1);
  });
  for (const decisionProvider of [undefined, "jev", "decider"]) {
    test(`${decisionProvider ?? "default jev"}: checks the concrete destination before credentials`, async () => {
      const name = decisionProvider ?? "jev";
      const f = fixture({}, name);
      if (name === "jev") f.decision.baseUrl = "https://api.typesafe.ai/v1/systemone";
      const seen: string[] = [];
      const result = await resolveJevDecision({
        config: f.config, decisionProvider,
        body: { input: "hello" },
        candidates: [{ key: "a/m1", provider: "a", model: "m1", reasoningEfforts: ["low"] },
          { key: "a/m2", provider: "a", model: "m2", reasoningEfforts: ["low"] }],
        fallback: { targetKey: "a/m1", effort: "low" },
        isDestinationAllowed(providerName, modelId) { seen.push(`${providerName}/${modelId}`); return false; },
      });
      expect(seen).toEqual([name === "jev" ? "jev/jev-latest" : "decider/tev1:4b"]);
      expect(result).toMatchObject({ targetKey: "a/m1", gate: "invalid" });
      expect(f.keyReads()).toBe(0);
      expect(f.sends()).toBe(0);
    });
  }
  test("bare model allowlists preserve their existing meaning", () => {
    expect(routeAllowedByScope(admissionModelScopeOf({ allowedModels: ["TEV1:4B"] }), { providerName: "decider", modelId: "tev1:4b" })).toBe(true);
  });
});
