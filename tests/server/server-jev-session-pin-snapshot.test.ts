import { afterEach, beforeEach, expect, test } from "bun:test";
import type { RequestLogContext } from "../../src/server/request-log";
import { LUNA, SOL, modelProvider, perTurnConfig, resetState, turn } from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(resetState);

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
      } else {
        // The text capability gate reads the provider and returns a promise.
        // Queue the edit before its awaiting caller resumes.
        Object.defineProperty(config.providers.sol!, "contextWindow", {
          configurable: true,
          enumerable: true,
          get() {
            Object.defineProperty(config.providers.sol!, "contextWindow", { value: 100_000 });
            queueMicrotask(() => { config.combos!.auto = { ...combo, targets: [LUNA] }; });
            return 100_000;
          },
        });
      }
      return fetchDecision(input, init);
    }) as typeof fetch;

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
  Object.defineProperty(config.providers.sol!, "contextWindow", {
    configurable: true,
    enumerable: true,
    get() {
      queueMicrotask(() => { combo.allowMeteredTargets = false; });
      return 100_000;
    },
  });
  const models: string[] = [];
  const response = await turn(config, { models });
  expect(models).toEqual(sibling ? [`${LUNA.provider}/${LUNA.model}`] : []);
  expect(response.status).toBe(sibling ? 200 : 503);
});
