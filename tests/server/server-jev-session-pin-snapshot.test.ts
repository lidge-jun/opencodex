import { linkAdvisorPlanConfig } from "../../src/server/responses/advisor-plan-slot";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { RequestLogContext } from "../../src/server/request-log";
import { afterCapabilityGate, LUNA, SOL, modelProvider, perTurnConfig, resetState, turn } from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(() => { mock.restore(); resetState(); });

test.each(["metered consent", "roster during capability refresh"] as const)(
  "revalidates %s before dispatching a paid pinned decision",
  async (change) => {
    const payloads: Record<string, unknown>[] = [];
    const config = perTurnConfig(["sol/gpt-5.6-sol:high", "sol/gpt-5.6-sol:low"], payloads);
    const combo = config.combos!.auto!;
    combo.capabilityPolicy = "union";
    combo.allowMeteredTargets = true;
    expect((await turn(config)).status).toBe(200);

    const fetchDecision = config.providers.jev!.fetch!;
    config.providers.jev!.fetch = (async (input, init) => {
      if (change === "metered consent") {
        config.providers.replacement = modelProvider(SOL.model);
        config.combos!.auto = {
          ...combo, allowMeteredTargets: false,
          targets: [{ ...SOL, provider: "replacement", metered: true }, LUNA],
        };
      }
      return fetchDecision(input, init);
    }) as typeof fetch;

    if (change === "roster during capability refresh") {
      afterCapabilityGate(() => {
        if (payloads.length === 2) config.combos!.auto = { ...combo, targets: [LUNA] };
      });
    }
    const models: string[] = [];
    const log: RequestLogContext = { model: "", provider: "" };
    expect((await turn(config, { models, log })).status).toBe(200);
    expect(models).toEqual([`${LUNA.provider}/${LUNA.model}`]);
    expect(payloads).toHaveLength(2);
    expect(log.jevDecision).toMatchObject({
      gate: "invalid", usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
  },
);

test("intersection dispatches a replacement added during the paid decision", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high", "sol/gpt-5.6-sol:low"], payloads);
  expect((await turn(config)).status).toBe(200);

  const fetchDecision = config.providers.jev!.fetch!;
  config.providers.jev!.fetch = (async (input, init) => {
    config.providers.replacement = modelProvider(LUNA.model);
    config.combos!.auto = { ...config.combos!.auto!, targets: [{ ...LUNA, provider: "replacement" }] };
    return fetchDecision(input, init);
  }) as typeof fetch;

  const models: string[] = [];
  expect((await turn(config, { models })).status).toBe(200);
  expect(models).toEqual([`replacement/${LUNA.model}`]);
  expect(payloads).toHaveLength(2);
});

test.each([true, false])("first dispatch rechecks metered consent with unmetered sibling=%s", async sibling => {
  const config = perTurnConfig([], []);
  const combo = config.combos!.auto!;
  combo.strategy = "failover";
  combo.capabilityPolicy = "union";
  combo.allowMeteredTargets = true;
  combo.targets = [{ ...SOL, metered: true }, ...(sibling ? [LUNA] : [])];
  afterCapabilityGate(() => { config.combos = { auto: { ...combo, allowMeteredTargets: false } }; });
  const replay = linkAdvisorPlanConfig(config, { ...config });
  const models: string[] = [];
  const response = await turn(replay, { models });
  expect(models).toEqual(sibling ? [`${LUNA.provider}/${LUNA.model}`] : []);
  expect(response.status).toBe(sibling ? 200 : 503);
});

test("readmission applies a narrower configured-key scope after the decision", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high"], payloads);
  const key = {
    id: "scoped", name: "Scope fixture", key: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    allowedModels: ["jev/jev-latest", SOL.model, LUNA.model] as string[],
  };
  config.apiKeys = [key];
  const decide = config.providers.jev!.fetch!;
  config.providers.jev!.fetch = (async (input, init) => {
    const result = await decide(input, init);
    key.allowedModels = ["jev/jev-latest", LUNA.model];
    return result;
  }) as typeof fetch;
  const models: string[] = [];
  const response = await turn(config, {
    models,
    admission: { kind: "configured", source: "bearer", keyId: key.id, contextPrincipalId: "scope-fixture" },
  });
  expect(response.status).toBe(200);
  expect(payloads).toHaveLength(1);
  expect(models).toEqual([`${LUNA.provider}/${LUNA.model}`]);
});

test("scope narrowed during capability admission blocks the paid JEV decision", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high"], payloads);
  config.combos!.auto!.capabilityPolicy = "union";
  const key = {
    id: "scoped", name: "Scope fixture", key: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    allowedModels: ["jev/jev-latest", SOL.model, LUNA.model],
  };
  config.apiKeys = [key];
  afterCapabilityGate(() => { key.allowedModels = [LUNA.model]; });
  const models: string[] = [];
  const log: RequestLogContext = { model: "", provider: "" };
  const response = await turn(config, {
    models, log,
    admission: { kind: "configured", source: "bearer", keyId: key.id, contextPrincipalId: "scope-fixture" },
  });
  expect(payloads).toHaveLength(0);
  expect(log.jevDecision?.usage).toBeUndefined();
  expect(response.status).toBe(200);
  expect(models).toEqual([`${LUNA.provider}/${LUNA.model}`]);
});
