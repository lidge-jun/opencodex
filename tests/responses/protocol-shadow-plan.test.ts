/**
 * Shadow plan comparison (PF-12, `protocols.rollout.shadowPlan`): the dispatch-basis plan is
 * compared with the observed trace at finalize, and only a disagreement marks the trace.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState } from "../../src/combos";
import { isProtocolTraceV1, parseProtocolTraceV1, type ProtocolPlanV1, type ProtocolTraceV1 } from "../../src/protocols/dto";
import { planProtocol, type ProtocolPlanInput } from "../../src/protocols/plan";
import { shadowPlanMismatch } from "../../src/protocols/shadow";
import { recordProtocolShadowPlan } from "../../src/protocols/shadow-plan";
import {
  markProtocolBlocked,
  markProtocolEntry,
  markProtocolShadowPlanInput,
  protocolTraceForRequest,
} from "../../src/protocols/trace";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-shadow-plan-"));
  process.env.OPENCODEX_HOME = testDir;
  clearComboSelectionState();
});

afterEach(() => {
  clearComboSelectionState();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

const attempt = (ordinal: number, adapter: string) => ({ ordinal, adapter });

function planInput(overrides: Partial<ProtocolPlanInput> = {}): ProtocolPlanInput {
  return {
    inbound: "chat",
    requestedModel: "m1",
    routeKind: "direct",
    candidates: [{ provider: "a", model: "m1", adapter: "openai-chat", nativeEligible: true, declineReasons: [] }],
    features: [],
    surfaces: { responses: { enabled: true }, chat: { enabled: true }, messages: { enabled: true } },
    settings: { unrepresentable: "legacy" },
    policyRevision: "p1-test",
    basis: "dispatch",
    ...overrides,
  };
}

function config(shadowPlan: boolean | undefined): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
    },
    ...(shadowPlan === undefined ? {} : { protocols: { rollout: { shadowPlan } } }),
  } as OcxConfig;
}

function trace(overrides: Partial<ProtocolTraceV1> = {}): ProtocolTraceV1 {
  return {
    v: 1,
    inbound: "chat",
    mode: "native",
    upstream: "chat",
    requestPath: ["chat", "chat"],
    responsePath: ["chat", "chat"],
    reasonCodes: ["same-wire-native"],
    contractVersion: "test",
    ...overrides,
  };
}

describe("shadowPlanMismatch", () => {
  const nativePlan: ProtocolPlanV1 = planProtocol(planInput());

  test("agrees when the settled candidate's mode, upstream and request path match", () => {
    expect(shadowPlanMismatch(nativePlan, trace(), { provider: "a", model: "m1" })).toBe(false);
  });

  test("disagrees when the request took a different lane than the plan predicted", () => {
    const bridged = trace({
      mode: "legacy-bridge",
      requestPath: ["chat", "responses-internal", "ir", "chat"],
      responsePath: ["chat", "ir", "responses-internal", "chat"],
    });
    expect(shadowPlanMismatch(nativePlan, bridged, { provider: "a", model: "m1" })).toBe(true);
  });

  test("the response path is not compared, so direct encoders do not read as a mismatch", () => {
    const plan = planProtocol(planInput({
      candidates: [{ provider: "c", model: "m9", adapter: "anthropic", nativeEligible: false, declineReasons: [] }],
    }));
    const encoded = trace({
      mode: "legacy-bridge",
      upstream: "messages",
      requestPath: ["chat", "responses-internal", "ir", "messages"],
      responsePath: ["messages", "ir", "chat"],
    });
    expect(shadowPlanMismatch(plan, encoded, { provider: "c", model: "m9" })).toBe(false);
  });

  test("a combo is compared against the target that answered, not the first one listed", () => {
    const plan = planProtocol(planInput({
      routeKind: "combo",
      candidates: [
        { provider: "a", model: "m1", adapter: "openai-chat", nativeEligible: false, declineReasons: ["combo-or-policy-route"] },
        { provider: "r", model: "m3", adapter: "openai-responses", nativeEligible: false, declineReasons: [] },
      ],
    }));
    const failedOver = trace({
      mode: "translated",
      upstream: "responses",
      requestPath: ["chat", "responses"],
      responsePath: ["responses", "chat"],
    });
    expect(shadowPlanMismatch(plan, failedOver, { provider: "r", model: "m3" })).toBe(false);
    expect(shadowPlanMismatch(plan, failedOver, {})).toBe(true);
  });

  test("a blocked trace agrees only with a blocked plan; a compatibility reject is not compared", () => {
    const blocked = trace({ mode: "blocked", requestPath: [], responsePath: [], reasonCodes: ["feature-unrepresentable"] });
    delete blocked.upstream;
    const rejectPlan = planProtocol(planInput({ features: ["request.multiple_choices"], settings: { unrepresentable: "reject" }, candidates: [
      { provider: "r", model: "m3", adapter: "openai-responses", nativeEligible: false, declineReasons: [] },
    ] }));
    expect(rejectPlan.mode).toBe("blocked");
    expect(shadowPlanMismatch(rejectPlan, blocked)).toBe(false);
    expect(shadowPlanMismatch(nativePlan, blocked)).toBe(true);
    expect(shadowPlanMismatch(nativePlan, { ...blocked, reasonCodes: ["compatibility-reject"] })).toBe(false);
  });

  test("caller-forward Messages passthrough is the caller's choice, which the plan never predicts", () => {
    const plan = planProtocol(planInput({
      inbound: "messages",
      reasonCodes: ["caller-credential-required"],
      candidates: [{ provider: "anthropic", model: "claude-x", adapter: "anthropic", nativeEligible: false, declineReasons: [] }],
    }));
    const passthrough = trace({
      inbound: "messages",
      upstream: "messages",
      requestPath: ["messages", "messages"],
      responsePath: ["messages", "messages"],
    });
    expect(shadowPlanMismatch(plan, passthrough)).toBe(false);
  });
});

describe("protocolTraceForRequest with a shadow plan input", () => {
  test("no recorded input leaves the trace without planMismatch", () => {
    const ctx = { provider: "a", model: "m1" };
    markProtocolEntry(ctx, { inbound: "chat", lane: "bridge" });
    const observed = protocolTraceForRequest(ctx, [attempt(1, "openai-chat")]);
    expect(observed).toBeDefined();
    expect("planMismatch" in observed!).toBe(false);
  });

  test("an agreeing plan adds nothing and a disagreeing plan sets planMismatch: true", () => {
    const agreeing = { provider: "a", model: "m1" };
    markProtocolEntry(agreeing, { inbound: "chat", lane: "native" });
    markProtocolShadowPlanInput(agreeing, planInput());
    const matched = protocolTraceForRequest(agreeing, [attempt(1, "openai-chat")]);
    expect(matched?.mode).toBe("native");
    expect("planMismatch" in matched!).toBe(false);

    const disagreeing = { provider: "a", model: "m1" };
    markProtocolEntry(disagreeing, { inbound: "chat", lane: "bridge" });
    markProtocolShadowPlanInput(disagreeing, planInput());
    const mismatched = protocolTraceForRequest(disagreeing, [attempt(1, "openai-chat")]);
    expect(mismatched?.planMismatch).toBe(true);
    expect(isProtocolTraceV1(mismatched)).toBe(true);
    expect(parseProtocolTraceV1(mismatched)?.planMismatch).toBe(true);
  });

  test("a blocked request is compared too", () => {
    const ctx = {};
    markProtocolBlocked(ctx, { inbound: "chat", reasonCodes: ["feature-unrepresentable"] });
    markProtocolShadowPlanInput(ctx, planInput());
    expect(protocolTraceForRequest(ctx, undefined)?.planMismatch).toBe(true);
  });

  test("a comparison that throws leaves the observed trace exactly as it was", () => {
    const plain = { provider: "a", model: "m1" };
    markProtocolEntry(plain, { inbound: "chat", lane: "bridge" });
    const expected = protocolTraceForRequest(plain, [attempt(1, "openai-chat")]);

    const broken = { provider: "a", model: "m1" };
    markProtocolEntry(broken, { inbound: "chat", lane: "bridge" });
    // `surfaces` without the inbound makes the planner throw on its first read.
    markProtocolShadowPlanInput(broken, { ...planInput(), surfaces: {} } as unknown as ProtocolPlanInput);
    expect(protocolTraceForRequest(broken, [attempt(1, "openai-chat")])).toEqual(expected);
  });
});

describe("recordProtocolShadowPlan", () => {
  test("with the switch off or absent nothing is recorded and no field appears", () => {
    for (const shadowPlan of [undefined, false]) {
      const ctx = { provider: "a", model: "m1" };
      markProtocolEntry(ctx, { inbound: "chat", lane: "bridge" });
      recordProtocolShadowPlan(ctx, config(shadowPlan), { inbound: "chat", model: "m1" });
      const observed = protocolTraceForRequest(ctx, [attempt(1, "openai-chat")]);
      expect(observed?.mode).toBe("legacy-bridge");
      expect("planMismatch" in observed!).toBe(false);
    }
  });

  test("with the switch on the dispatch plan is compared at finalize", () => {
    const matching = { provider: "a", model: "m1" };
    markProtocolEntry(matching, { inbound: "chat", lane: "native" });
    recordProtocolShadowPlan(matching, config(true), { inbound: "chat", model: "m1" });
    expect("planMismatch" in protocolTraceForRequest(matching, [attempt(1, "openai-chat")])!).toBe(false);

    const diverging = { provider: "a", model: "m1" };
    markProtocolEntry(diverging, { inbound: "chat", lane: "bridge" });
    recordProtocolShadowPlan(diverging, config(true), { inbound: "chat", model: "m1" });
    expect(protocolTraceForRequest(diverging, [attempt(1, "openai-chat")])?.planMismatch).toBe(true);
  });

  test("never throws into the request, whatever it is handed", () => {
    const hostile = { get protocols(): never { throw new Error("config read failed"); } } as unknown as OcxConfig;
    expect(() => recordProtocolShadowPlan({}, hostile, { inbound: "chat", model: "m1" })).not.toThrow();
    expect(() => recordProtocolShadowPlan({}, config(true), { inbound: "chat", model: 42 })).not.toThrow();
    expect(() => recordProtocolShadowPlan({}, config(true), { inbound: "chat", model: "no-such-model" })).not.toThrow();
  });
});

describe("ProtocolTraceV1 planMismatch field", () => {
  test("old rows without the field stay valid, and only `true` is accepted", () => {
    expect(isProtocolTraceV1(trace())).toBe(true);
    expect(isProtocolTraceV1({ ...trace(), planMismatch: true })).toBe(true);
    expect(isProtocolTraceV1({ ...trace(), planMismatch: false })).toBe(false);
    expect(isProtocolTraceV1({ ...trace(), planMismatch: "yes" })).toBe(false);
  });
});
