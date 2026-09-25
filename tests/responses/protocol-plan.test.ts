/**
 * The pure protocol planner (src/protocols/plan.ts): paths come from the lane rule, feature
 * effects from the declared dispositions, and eligibility from the unrepresentable policy.
 */
import { describe, expect, test } from "bun:test";
import { isProtocolPlanV1 } from "../../src/protocols/dto";
import { planProtocol, type ProtocolPlanCandidateInput, type ProtocolPlanInput } from "../../src/protocols/plan";

const OPEN = { responses: { enabled: true }, chat: { enabled: true }, messages: { enabled: true } } as const;

function candidate(adapter: string, overrides: Partial<ProtocolPlanCandidateInput> = {}): ProtocolPlanCandidateInput {
  return { provider: `p-${adapter}`, model: "m", adapter, nativeEligible: false, declineReasons: [], ...overrides };
}

function input(overrides: Partial<ProtocolPlanInput> = {}): ProtocolPlanInput {
  return {
    inbound: "chat",
    requestedModel: "some-model",
    routeKind: "direct",
    candidates: [candidate("openai-chat", { nativeEligible: true })],
    features: [],
    surfaces: OPEN,
    settings: { unrepresentable: "legacy" },
    policyRevision: "p1-00000000",
    basis: "preview",
    ...overrides,
  };
}

describe("planProtocol", () => {
  test("an eligible native Chat route is native and preserves every Chat feature", () => {
    const plan = planProtocol(input({ features: ["request.multiple_choices", "request.tools"] }));
    expect(isProtocolPlanV1(plan)).toBe(true);
    expect(plan.mode).toBe("native");
    expect(plan.candidates[0]).toMatchObject({
      upstream: "chat",
      requestPath: ["chat", "chat"],
      responsePath: ["chat", "chat"],
      fidelity: "preserved",
      eligible: true,
      reasonCodes: ["same-wire-native"],
    });
    expect(plan.guaranteedFeatures).toEqual(["request.tools", "request.multiple_choices"]);
    expect(plan.partialFeatures).toEqual([]);
  });

  test("a declined Chat lane bridges and carries the decline reason", () => {
    const plan = planProtocol(input({
      candidates: [candidate("openai-chat", { declineReasons: ["vision-preprocessing"] })],
    }));
    expect(plan.mode).toBe("legacy-bridge");
    expect(plan.candidates[0]!.requestPath).toEqual(["chat", "responses-internal", "ir", "chat"]);
    expect(plan.candidates[0]!.reasonCodes).toEqual(["not-migrated", "vision-preprocessing"]);
  });

  test("n=2 on Chat to a Responses upstream is refused under reject and kept under legacy", () => {
    const features = ["request.multiple_choices"] as const;
    const legacy = planProtocol(input({ candidates: [candidate("openai-responses")], features: [...features] }));
    expect(legacy.mode).toBe("translated");
    expect(legacy.candidates[0]!.requestPath).toEqual(["chat", "responses"]);
    expect(legacy.candidates[0]!.reasonCodes).toEqual(["cross-wire-codec"]);
    expect(legacy.candidates[0]!.eligible).toBe(true);
    expect(legacy.candidates[0]!.fidelity).toBe("degraded");
    expect(legacy.guaranteedFeatures).toEqual([]);

    const reject = planProtocol(input({
      candidates: [candidate("openai-responses")],
      features: [...features],
      settings: { unrepresentable: "reject" },
    }));
    expect(isProtocolPlanV1(reject)).toBe(true);
    expect(reject.mode).toBe("blocked");
    expect(reject.candidates[0]!.eligible).toBe(false);
    expect(reject.candidates[0]!.reasonCodes).toContain("feature-unrepresentable");
    expect(reject.reasonCodes).toContain("feature-unrepresentable");
    expect(reject.candidates[0]!.featureEffects).toEqual([{ feature: "request.multiple_choices", disposition: "unsupported" }]);
  });

  test("a disabled surface blocks every candidate with surface-disabled", () => {
    const plan = planProtocol(input({
      inbound: "messages",
      candidates: [candidate("anthropic")],
      surfaces: { ...OPEN, messages: { enabled: false } },
    }));
    expect(isProtocolPlanV1(plan)).toBe(true);
    expect(plan.mode).toBe("blocked");
    expect(plan.reasonCodes).toEqual(["surface-disabled"]);
    expect(plan.candidates[0]).toMatchObject({ mode: "blocked", eligible: false, requestPath: [], reasonCodes: ["surface-disabled"] });
  });

  test("an unknown model yields no candidates and unknown-model", () => {
    const plan = planProtocol(input({ routeKind: "unknown", candidates: [] }));
    expect(isProtocolPlanV1(plan)).toBe(true);
    expect(plan).toMatchObject({ routeKind: "unknown", mode: "blocked", candidates: [], reasonCodes: ["unknown-model"] });
  });

  test("a combo splits guaranteed from partial features across eligible candidates", () => {
    const plan = planProtocol(input({
      inbound: "responses",
      routeKind: "combo",
      candidates: [candidate("openai-responses"), candidate("openai-chat")],
      features: ["request.tools", "request.background", "request.store"],
    }));
    expect(isProtocolPlanV1(plan)).toBe(true);
    expect(plan.candidates.map(c => c.mode)).toEqual(["native", "translated"]);
    expect(plan.candidates[1]!.requestPath).toEqual(["responses", "ir", "chat"]);
    expect(plan.guaranteedFeatures).toEqual(["request.tools"]);
    // Responses keeps both; Chat drops background and degrades store.
    expect(plan.partialFeatures).toEqual(["request.store", "request.background"]);
    expect(plan.reasonCodes[0]).toBe("combo-or-policy-route");
  });

  test("under reject only eligible candidates count toward the guarantee", () => {
    const plan = planProtocol(input({
      inbound: "responses",
      routeKind: "combo",
      candidates: [candidate("openai-chat"), candidate("openai-responses")],
      features: ["request.tools", "request.background"],
      settings: { unrepresentable: "reject" },
    }));
    expect(plan.candidates.map(c => c.eligible)).toEqual([false, true]);
    expect(plan.mode).toBe("native");
    expect(plan.guaranteedFeatures).toEqual(["request.tools", "request.background"]);
    expect(plan.partialFeatures).toEqual([]);
  });

  test("an adapter outside the three protocols is upstream-other with unknown fidelity", () => {
    const plan = planProtocol(input({ inbound: "responses", candidates: [candidate("gemini")], features: ["request.tools"] }));
    expect(plan.candidates[0]).toMatchObject({ upstream: "other", mode: "translated", fidelity: "unknown", unknownFeatures: ["request.tools"] });
    expect(plan.candidates[0]!.reasonCodes).toEqual(["cross-wire-ir", "upstream-other"]);
  });

  test("a native flag toward a different wire never yields a native path", () => {
    const plan = planProtocol(input({ candidates: [candidate("anthropic", { nativeEligible: true })] }));
    expect(plan.candidates[0]!.mode).toBe("legacy-bridge");
  });

  test("snapshot reason codes lead the plan reasons", () => {
    const plan = planProtocol(input({
      inbound: "messages",
      candidates: [candidate("anthropic")],
      reasonCodes: ["caller-credential-required"],
    }));
    expect(plan.reasonCodes).toEqual(["caller-credential-required", "not-migrated"]);
  });
});
