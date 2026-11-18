import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RequestLogContext } from "../../src/server/request-log";
import { LUNA, SOL, modelProvider, resetState, served, turn, perTurnConfig, offered, effortOf, type Child } from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(resetState);

describe("JEV session pin post-decision eligibility", () => {
  test.each(["context", "effort", "targets"] as const)("rechecks pinned %s after the paid effort call", async (changed) => {
    const payloads: Array<Record<string, unknown>> = [];
    const config = perTurnConfig(["sol/gpt-5.6-sol:high", "sol/gpt-5.6-sol:low"], payloads);
    config.combos!.auto!.capabilityPolicy = "union";
    config.providers.sol!.contextWindow = 100_000;
    expect((await turn(config)).status).toBe(200);

    const decisionStarted = Promise.withResolvers<void>();
    const resumeDecision = Promise.withResolvers<void>();
    const fetchDecision = config.providers.jev!.fetch!;
    config.providers.jev!.fetch = (async (input, init) => {
      decisionStarted.resolve();
      await resumeDecision.promise;
      return fetchDecision(input, init);
    }) as typeof fetch;
    const bodies: Record<string, unknown>[] = [];
    const child: Child = (body, complete) => { bodies.push(body); return served(body, complete); };
    const log: RequestLogContext = { model: "", provider: "" };
    const pending = turn(config, { child, log });
    await decisionStarted.promise;
    if (changed === "context") config.providers.sol!.contextWindow = 1;
    else if (changed === "effort") config.providers.sol!.modelReasoningEfforts![SOL.model] = [];
    else {
      config.providers.replacement = modelProvider(LUNA.model);
      config.combos!.auto = { ...config.combos!.auto!, targets: [{ ...LUNA, provider: "replacement" }] };
    }
    resumeDecision.resolve();

    expect((await pending).status).toBe(200);
    expect(payloads).toHaveLength(2);
    expect(offered(payloads[1])).toEqual(["sol/gpt-5.6-sol"]);
    const provider = changed === "targets" ? "replacement" : "luna";
    expect(bodies.map(body => [body.model, effortOf(body)])).toEqual([[`${provider}/${LUNA.model}`, "medium"]]);
    expect(log.jevDecision).toMatchObject({
      selected: { provider, model: LUNA.model, effort: "medium" },
      gate: "invalid",
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
    expect(log.jevDecision?.pinned).toBeUndefined();
    expect(log.jevDecision?.pinReason).toBeUndefined();
  });
});
