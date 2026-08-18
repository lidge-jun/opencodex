/**
 * The compatibility behavior report is documented as "authoritative effective values
 * emitted by the production route/model/adapter resolver", and its hash keys Lab
 * evidence. These cases hold it to that: for one routed model they assert the wire the
 * adapter actually builds, then assert the report describes that same wire.
 */
import { describe, expect, test } from "bun:test";
import { resolveProductionBehaviorValues } from "../src/routing/compatibility/behavior";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

// ollama-cloud ships `gpt-oss:120b` verbatim (src/providers/registry.ts) and the same
// registry row lists the bare `gpt-oss` in noVisionModels, i.e. the bare-prefix form is
// the documented, intended way to write these lists.
const MODEL = "gpt-oss:120b";

const effective: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://ollama.com/v1",
  apiKey: "sk-test",
  authMode: "key",
  noTemperatureModels: ["gpt-oss"],
  noTopPModels: ["gpt-oss"],
  noPenaltyModels: ["gpt-oss"],
  thinkingBudgetModels: ["gpt-oss"],
  autoToolChoiceOnlyModels: ["gpt-oss"],
};

const config = { providers: { "ollama-cloud": effective } } as unknown as OcxConfig;

const values = () =>
  resolveProductionBehaviorValues(config, "ollama-cloud", MODEL, effective, "salt")!;

function wire(): Record<string, unknown> {
  const parsed: OcxParsedRequest = {
    modelId: MODEL,
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    stream: false,
    options: { temperature: 0.5, topP: 0.9, presencePenalty: 0.2, frequencyPenalty: 0.2 },
  };
  return JSON.parse(createOpenAIChatAdapter(effective).buildRequest(parsed).body as string);
}

describe("behavior report must agree with the wire the adapter actually builds", () => {
  test("adapter really does omit these for the :tag model (ground truth)", () => {
    const body = wire();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
    expect(body.frequency_penalty).toBeUndefined();
  });

  test("report agrees: sampling.omitTemperature", () => {
    expect(values()["sampling.omitTemperature"]!.value).toBe(true);
  });
  test("report agrees: sampling.omitTopP", () => {
    expect(values()["sampling.omitTopP"]!.value).toBe(true);
  });
  test("report agrees: sampling.omitPenalties", () => {
    expect(values()["sampling.omitPenalties"]!.value).toBe(true);
  });
  test("report agrees: reasoning.budgetMode", () => {
    expect(values()["reasoning.budgetMode"]!.value).toBe(true);
  });
  test("report agrees: tools.choiceRestrictions", () => {
    expect(values()["tools.choiceRestrictions"]!.value).toEqual(["auto"]);
  });

  test("an unlisted model reports false (control)", () => {
    const v = resolveProductionBehaviorValues(config, "ollama-cloud", "glm-5.3", effective, "salt")!;
    expect(v["sampling.omitTemperature"]!.value).toBe(false);
    expect(v["reasoning.budgetMode"]!.value).toBe(false);
  });
});
