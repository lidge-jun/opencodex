import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  ComboVisionDescriptionUnavailableError,
  policyCandidateRefusalResponse,
} from "../../src/server/responses/policy-request-scope";
import { duringDecision, IMAGE_INPUT, perTurnConfig, resetState, served, turn, unionConfig, type Child } from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(resetState);

test("an onUnservable change during the paid decision applies to the next request", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = unionConfig(["sol/gpt-5.6-sol:high", "sol/gpt-5.6-sol:high"], payloads);
  const combo = config.combos!.auto!;
  config.port = 9876;
  combo.targets = combo.targets.filter(target => target.provider === "sol");
  combo.onUnservable = "degrade";
  config.providers.sol!.inputModalities = ["text"];
  config.providers.helper = {
    adapter: "openai-chat", baseUrl: "https://vision.example.test/v1", models: ["vlm"],
    inputModalities: ["text", "image"], authMode: "local",
  };
  config.visionSidecar = { enabled: true, backend: "routed", model: "helper/vlm" };
  duringDecision(config, () => { config.combos!.auto = { ...combo, onUnservable: "reject" }; });

  const modes: string[] = [];
  const child: Child = (body, complete, options) => {
    if (options?.comboRequiresVisionPlan) {
      modes.push("description");
      return policyCandidateRefusalResponse(new ComboVisionDescriptionUnavailableError())!;
    }
    modes.push(options?.comboOmitImages ? "omission" : "dispatch");
    return served(body, complete, options);
  };
  // The in-flight request keeps the degrade policy it was admitted with.
  expect((await turn(config, { input: IMAGE_INPUT, child })).status).toBe(200);
  expect(modes).toEqual(["description", "omission"]);
  // The next request is admitted under reject.
  expect((await turn(config, { input: IMAGE_INPUT, child })).status).toBe(400);
  expect(modes).toEqual(["description", "omission", "description"]);
  expect(payloads).toHaveLength(2);
});

test("post-decision admission never reads unused provider or caller credentials", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high", "sol/gpt-5.6-sol:low"], payloads);
  const decisionProvider = config.providers.jev!;
  const decisionKey = decisionProvider.apiKey;
  const decide = decisionProvider.fetch!;
  let decisionKeyReads = 0;
  const installDecisionGetter = () => Object.defineProperty(decisionProvider, "apiKey", {
    configurable: true, enumerable: true,
    get() { decisionKeyReads++; return decisionKey; },
  });
  installDecisionGetter();
  decisionProvider.fetch = (async (input, init) => {
    installDecisionGetter();
    return decide(input, init);
  }) as typeof fetch;

  let reads = 0;
  const countRead = () => { reads++; return undefined; };
  Object.defineProperty(config.providers.luna!, "apiKey", { enumerable: true, get: countRead });
  config.providers.luna!.apiKeyPool = [{ id: "unused-pool-entry", get key() { countRead(); return ""; } }];
  config.combos!.auto!.targets = config.combos!.auto!.targets.filter(target => target.provider === "sol");
  config.apiKeys = [{
    id: "unused", name: "unused", createdAt: "2026-01-01",
    get key() { countRead(); return ""; },
    pendingRotation: {
      id: "rotation", createdAt: "2026-01-01", expiresAt: "2026-12-31",
      get key() { countRead(); return ""; },
    },
  }];

  expect((await turn(config)).status).toBe(200);
  expect((await turn(config)).status).toBe(200);
  expect(payloads).toHaveLength(2);
  expect(reads).toBe(0);
  expect(decisionKeyReads).toBe(2);
});
