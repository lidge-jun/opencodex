import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  ComboVisionDescriptionUnavailableError,
  policyCandidateRefusalResponse,
} from "../../src/server/responses/policy-request-scope";
import { perTurnConfig, resetState, served, turn } from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(resetState);

test("a failed required description follows the refreshed rejection policy", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high"], payloads);
  const combo = config.combos!.auto!;
  config.port = 9876;
  combo.targets = combo.targets.filter(target => target.provider === "sol");
  combo.capabilityPolicy = "union";
  combo.onUnservable = "degrade";
  config.providers.sol!.inputModalities = ["text"];
  config.providers.helper = {
    adapter: "openai-chat", baseUrl: "https://vision.example.test/v1", models: ["vlm"],
    inputModalities: ["text", "image"], authMode: "local",
  };
  config.visionSidecar = { enabled: true, backend: "routed", model: "helper/vlm" };
  const decide = config.providers.jev!.fetch!;
  config.providers.jev!.fetch = (async (input, init) => {
    config.combos!.auto = { ...combo, onUnservable: "reject" };
    return decide(input, init);
  }) as typeof fetch;

  const modes: string[] = [];
  const response = await turn(config, {
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
    child(body, complete, options) {
      if (options?.comboRequiresVisionPlan) {
        modes.push("description");
        return policyCandidateRefusalResponse(new ComboVisionDescriptionUnavailableError())!;
      }
      modes.push("dispatch");
      return served(body, complete, options);
    },
  });
  expect(payloads).toHaveLength(1);
  expect(response.status).toBe(400);
  expect(modes).toEqual(["description"]);
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
