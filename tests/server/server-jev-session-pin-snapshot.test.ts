import { linkAdvisorPlanConfig } from "../../src/server/responses/advisor-plan-slot";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { RequestLogContext } from "../../src/server/request-log";
import { afterCapabilityGate, duringDecision, LUNA, SOL, modelProvider, offered, perTurnConfig, resetState, turn, unionConfig } from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(() => { mock.restore(); resetState(); });

test("metered consent revoked during the paid pinned effort call moves the send to a sibling", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high", "sol/gpt-5.6-sol:low"], payloads);
  const combo = config.combos!.auto!;
  combo.capabilityPolicy = "union";
  combo.allowMeteredTargets = true;
  combo.targets = [LUNA, { ...SOL, metered: true }];
  expect((await turn(config)).status).toBe(200);

  duringDecision(config, () => { config.combos!.auto = { ...combo, allowMeteredTargets: false }; });
  const models: string[] = [];
  const log: RequestLogContext = { model: "", provider: "" };
  expect((await turn(config, { models, log })).status).toBe(200);
  expect(models).toEqual([`${LUNA.provider}/${LUNA.model}`]);
  expect(payloads).toHaveLength(2);
  expect(log.jevDecision).toMatchObject({
    selected: { provider: LUNA.provider }, gate: "invalid", usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
  });
});

test("a roster replaced during the paid decision applies to the next request", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = unionConfig(["sol/gpt-5.6-sol:high", "replacement/gpt-5.6-luna:low"], payloads);
  config.combos!.auto!.capabilityPolicy = undefined;
  duringDecision(config, () => {
    config.providers.replacement = modelProvider(LUNA.model);
    config.combos!.auto = { ...config.combos!.auto!, targets: [{ ...LUNA, provider: "replacement" }] };
  });

  const models: string[] = [];
  expect((await turn(config, { models })).status).toBe(200);
  expect((await turn(config, { models })).status).toBe(200);
  expect(models).toEqual([`${SOL.provider}/${SOL.model}`, `replacement/${LUNA.model}`]);
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

test("a key scope narrowed during the paid decision moves the send to an in-scope sibling", async () => {
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

test.each(["scope", "consent"] as const)("%s narrowed during capability admission blocks the paid JEV decision", async change => {
  const payloads: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high"], payloads);
  config.combos!.auto!.capabilityPolicy = "union";
  if (change === "consent") config.combos!.auto!.targets = [LUNA, { ...SOL, metered: true }];
  const key: NonNullable<typeof config.apiKeys>[number] = {
    id: "scoped", name: "Scope fixture", key: "fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    allowedModels: ["jev/jev-latest", SOL.model, LUNA.model],
    allowMeteredComboTargets: true,
  };
  config.apiKeys = [key];
  afterCapabilityGate(() => {
    if (change === "scope") key.allowedModels = [LUNA.model];
    else key.allowMeteredComboTargets = false;
  });
  const models: string[] = [];
  const log: RequestLogContext = { model: "", provider: "" };
  const response = await turn(config, {
    models, log,
    admission: { kind: "configured", source: "bearer", keyId: key.id, contextPrincipalId: "scope-fixture" },
  });
  // Narrowed scope also excludes the decision destination; revoked consent leaves only the sibling to offer.
  if (change === "scope") {
    expect(payloads).toHaveLength(0);
    expect(log.jevDecision?.usage).toBeUndefined();
  } else expect(payloads.map(offered)).toEqual([[`${LUNA.provider}/${LUNA.model}`]]);
  expect(response.status).toBe(200);
  expect(models).toEqual([`${LUNA.provider}/${LUNA.model}`]);
});
