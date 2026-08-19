/**
 * The compatibility behavior report is documented as "authoritative effective values
 * emitted by the production route/model/adapter resolver", and its hash keys Lab
 * evidence. These cases hold it to that: for one routed model they assert the wire the
 * adapter actually builds, then assert the report describes that same wire.
 */
import { describe, expect, test } from "bun:test";
import { resolveProductionBehaviorValues } from "../src/routing/compatibility/behavior";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { buildBehaviorFingerprintV1 } from "../src/lab/subject/behavior-fingerprint";
import { resolveOpenRouterRouting } from "../src/providers/openrouter-routing";
import { modelRecordValue } from "../src/reasoning-effort";
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

// The list-shaped options above are one half of the report. The other half is the
// per-model override maps, which the runtime reads through modelRecordValue: own
// properties, then the pre-colon family, then a case-folded key.

const OVERRIDES: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://ollama.com/v1",
  apiKey: "sk-test",
  authMode: "key",
  modelMaxOutputTokens: { "gpt-oss": 1234 },
  modelContextWindows: { "GPT-OSS": 55_555 },
};

const overrideConfig = { providers: { "ollama-cloud": OVERRIDES } } as unknown as OcxConfig;

const overrideValues = (modelId: string) =>
  resolveProductionBehaviorValues(overrideConfig, "ollama-cloud", modelId, OVERRIDES, "salt")!;

describe("behavior report reads per-model overrides the way the runtime does", () => {
  test("the adapter really applies the bare-family override to the :tag model (ground truth)", () => {
    const parsed: OcxParsedRequest = {
      modelId: MODEL,
      context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      stream: false,
      options: {},
    };
    const body = JSON.parse(createOpenAIChatAdapter(OVERRIDES).buildRequest(parsed).body as string);
    expect(body.max_tokens).toBe(1234);
  });

  test("report agrees: limits.maxOutputTokens for the :tag model", () => {
    expect(overrideValues(MODEL)["limits.maxOutputTokens"]!.value).toBe(1234);
  });

  test("a case-folded key still resolves", () => {
    expect(overrideValues("gpt-oss")["limits.contextWindow"]!.value).toBe(55_555);
  });

  test("an unrelated model gets no override (control)", () => {
    expect(overrideValues("glm-5.3")["limits.maxOutputTokens"]!.value).toBeNull();
  });
});

// Model ids are operator-controlled, so one can collide with Object.prototype.
// openai-responses.ts already guards modelPreferHostedTools for exactly this.
describe("a prototype-shaped model id resolves to no override", () => {
  test.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "%s yields null rather than an inherited function",
    (modelId) => {
      const v = overrideValues(modelId);
      expect(v["limits.contextWindow"]!.value).toBeNull();
      expect(v["limits.maxOutputTokens"]!.value).toBeNull();
      expect(typeof v["modalities.input"]!.value).not.toBe("function");
    },
  );

  test("so the behavior fingerprint stays computable", () => {
    // jcsStringify rejects a function, and resolvePassiveRouteSubjectId swallows the
    // throw -- the subject would silently never link.
    expect(() => buildBehaviorFingerprintV1(overrideValues("constructor"))).not.toThrow();
    expect(buildBehaviorFingerprintV1(overrideValues("constructor")))
      .toBe(buildBehaviorFingerprintV1(overrideValues("toString")));
  });
});

// Not every override map is family-aware, and the two that are not must stay that way.
// The adapter reads `modelPreferHostedTools` through `hasOwnProperty`
// (`src/adapters/openai-responses.ts:1001`) and `resolveOpenRouterRouting` reads
// `modelOpenRouterRouting` through `Object.hasOwn` (`src/providers/openrouter-routing.ts:89`);
// the type calls the first "Exact-model hosted tools" (`src/types.ts:1584`). Sending
// these through modelRecordValue would be the divergence above with the sign flipped:
// the report would claim an override applies that the adapter will never apply.
const EXACT_ONLY: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-test",
  authMode: "key",
  modelPreferHostedTools: { "gpt-oss": ["image_generation"] },
  modelOpenRouterRouting: { "gpt-oss": { order: ["fireworks"] } },
} as unknown as OcxProviderConfig;

const exactConfig = { providers: { "ollama-cloud": EXACT_ONLY } } as unknown as OcxConfig;

const exactValues = (modelId: string) =>
  resolveProductionBehaviorValues(exactConfig, "ollama-cloud", modelId, EXACT_ONLY, "salt")!;

describe("exact-own override maps must not spread to the family", () => {
  test("the runtime really does not apply the bare-family entry to the :tag model (ground truth)", () => {
    // openRouter routing is resolvable directly, so this half is executable rather than cited.
    expect(resolveOpenRouterRouting(EXACT_ONLY, "gpt-oss")).toEqual({ order: ["fireworks"] });
    expect(resolveOpenRouterRouting(EXACT_ONLY, MODEL)).toBeUndefined();

    // And the divergence is real rather than theoretical: the family-aware primitive
    // resolves the entry that the adapter's own-property guard does not see.
    expect(modelRecordValue(EXACT_ONLY.modelPreferHostedTools, MODEL)).toEqual(["image_generation"]);
    expect(Object.hasOwn(EXACT_ONLY.modelPreferHostedTools!, MODEL)).toBe(false);
  });

  test("report agrees: the :tag model gets no hosted-tool preference", () => {
    expect(exactValues(MODEL)["tools.hostedPreference"]!.value).toEqual({ tools: [] });
  });

  test("report agrees: the :tag model gets no openrouter routing", () => {
    expect(exactValues(MODEL)["openrouter.order"]!.value).toEqual([]);
  });

  test("an exact key still resolves on both maps (control)", () => {
    const v = exactValues("gpt-oss");
    expect(v["tools.hostedPreference"]!.value).toEqual({ tools: ["image_generation"] });
    expect(v["openrouter.order"]!.value).toEqual(["fireworks"]);
  });

  test("a prototype-shaped id resolves neither map", () => {
    // The bare index this replaced walked the prototype chain here too, so these two
    // maps had the original bug and must not simply inherit the family-aware fix.
    for (const modelId of ["constructor", "toString", "valueOf"]) {
      const v = exactValues(modelId);
      expect(v["tools.hostedPreference"]!.value).toEqual({ tools: [] });
      expect(v["openrouter.order"]!.value).toEqual([]);
    }
  });
});
