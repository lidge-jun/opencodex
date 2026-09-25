/**
 * Declared feature dispositions (src/protocols/features.ts).
 *
 * The current-code claims here are the ones a reader can check in the translators:
 * `src/chat/inbound.ts` builds its Responses body from an explicit field list that has no
 * `n`, `logprobs`, `logit_bias` or `seed`, and `src/claude/inbound.ts` documents that `top_k`
 * is accepted and dropped. If a translator learns one of these fields, the claim here must
 * change in the same commit.
 */
import { describe, expect, test } from "bun:test";
import {
  featureEffectsForPath,
  featureHopDisposition,
  featuresFromChatBody,
  featuresFromMessagesBody,
  featuresFromResponsesBody,
  FEATURE_SOURCES,
  PROTOCOL_FEATURES,
  unrepresentableFeatures,
} from "../../src/protocols/features";

describe("feature extraction", () => {
  test("Chat bodies report only structural features", () => {
    const features = featuresFromChatBody({
      model: "m",
      n: 2,
      logprobs: true,
      seed: 7,
      tools: [{ type: "function", function: { name: "f" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "secret" }, { type: "image_url", image_url: { url: "data:" } }] }],
    });
    expect([...features].sort()).toEqual([
      "request.images",
      "request.logprobs",
      "request.multiple_choices",
      "request.seed",
      "request.tools",
    ]);
  });

  test("n=1 is not multiple choices and a text response_format is not structured output", () => {
    const features = featuresFromChatBody({ n: 1, response_format: { type: "text" }, messages: [] });
    expect(features.size).toBe(0);
  });

  test("Messages bodies report top_k, thinking budget and cache_control", () => {
    const features = featuresFromMessagesBody({
      top_k: 5,
      thinking: { type: "enabled", budget_tokens: 2048 },
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "document", source: {} }] }],
    });
    expect([...features].sort()).toEqual([
      "request.cache_control",
      "request.documents",
      "request.reasoning",
      "request.thinking_budget",
      "request.top_k",
    ]);
  });

  test("Responses bodies separate hosted tools from function tools", () => {
    const features = featuresFromResponsesBody({
      tools: [{ type: "web_search" }],
      previous_response_id: "resp_1",
      store: true,
    });
    expect([...features].sort()).toEqual(["request.hosted_tools", "request.previous_response_id", "request.store"]);
  });

  test("non-object bodies report nothing", () => {
    expect(featuresFromChatBody(null).size).toBe(0);
    expect(featuresFromMessagesBody("x").size).toBe(0);
    expect(featuresFromResponsesBody([]).size).toBe(0);
  });
});

describe("hop dispositions", () => {
  test("same-wire hops are passthrough and hops into other are unknown", () => {
    for (const feature of PROTOCOL_FEATURES) {
      expect(featureHopDisposition(feature, "chat", "chat")).toBe("passthrough");
      expect(featureHopDisposition(feature, "chat", "other")).toBeUndefined();
    }
  });

  test("every feature declares a disposition for each cross-wire hop out of its sources", () => {
    const wires = ["responses", "chat", "messages"] as const;
    for (const feature of PROTOCOL_FEATURES) {
      for (const source of FEATURE_SOURCES[feature]) {
        for (const target of wires) {
          if (target === source) continue;
          expect(featureHopDisposition(feature, source, target)).toBeDefined();
        }
      }
    }
  });
});

describe("path effects", () => {
  test("Chat n=2 survives the native path and is unsupported through Responses", () => {
    const native = featureEffectsForPath("chat", ["chat", "chat"], ["request.multiple_choices"]);
    expect(native.effects).toEqual([{ feature: "request.multiple_choices", disposition: "passthrough" }]);
    expect(native.fidelity).toBe("preserved");

    const bridged = featureEffectsForPath("chat", ["chat", "responses-internal", "ir", "chat"], ["request.multiple_choices"]);
    expect(bridged.effects).toEqual([{ feature: "request.multiple_choices", disposition: "unsupported" }]);
    expect(bridged.fidelity).toBe("degraded");
    expect(unrepresentableFeatures(bridged.effects)).toEqual(["request.multiple_choices"]);
  });

  test("a feature the inbound protocol cannot express is ignored", () => {
    const effects = featureEffectsForPath("messages", ["messages", "messages"], ["request.multiple_choices"]);
    expect(effects.effects).toEqual([]);
    expect(effects.fidelity).toBe("preserved");
  });

  test("an unknown adapter makes an otherwise lossless feature unknown, not preserved", () => {
    const effects = featureEffectsForPath("chat", ["chat", "responses-internal", "ir", "other"], ["request.tools"]);
    expect(effects.effects).toEqual([]);
    expect(effects.unknown).toEqual(["request.tools"]);
    expect(effects.fidelity).toBe("unknown");
  });

  test("a loss declared before an unknown hop is still reported", () => {
    const effects = featureEffectsForPath("messages", ["messages", "responses-internal", "ir", "other"], ["request.top_k"]);
    expect(effects.effects).toEqual([{ feature: "request.top_k", disposition: "unsupported" }]);
    expect(effects.fidelity).toBe("degraded");
  });
});
