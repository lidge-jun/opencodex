import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RequestLogContext } from "../../src/server/request-log";
import { LUNA, SOL, modelProvider, resetState, served, turn, perTurnConfig, offered, effortOf, type Child } from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(resetState);

describe("JEV session pin post-decision eligibility", () => {
  // The pinned effort call is paid. A capability or roster edit made while it is in flight
  // leaves the in-flight dispatch alone and applies to the next request.
  test.each(["context", "targets"] as const)("a %s change during the paid effort call applies to the next request", async (changed) => {
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
    else {
      config.providers.replacement = modelProvider(LUNA.model);
      config.combos!.auto = { ...config.combos!.auto!, targets: [{ ...LUNA, provider: "replacement" }] };
    }
    resumeDecision.resolve();

    expect((await pending).status).toBe(200);
    expect(payloads).toHaveLength(2);
    expect(offered(payloads[1])).toEqual(["sol/gpt-5.6-sol"]);
    expect(bodies.map(body => [body.model, effortOf(body)])).toEqual([[`${SOL.provider}/${SOL.model}`, "low"]]);
    expect(log.jevDecision).toMatchObject({
      selected: { provider: SOL.provider, model: SOL.model, effort: "low" },
      gate: "apply",
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });

    expect((await turn(config, { child })).status).toBe(200);
    const next = changed === "context" ? LUNA.provider : "replacement";
    expect(bodies.at(-1)?.model).toBe(`${next}/${LUNA.model}`);
  });
});
