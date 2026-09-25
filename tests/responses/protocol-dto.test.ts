/**
 * Plan and trace wire shapes (src/protocols/dto.ts). A record that is not exactly v1 is
 * rejected whole: the dashboard renders "no path data" rather than a half-valid path.
 */
import { describe, expect, test } from "bun:test";
import {
  isProtocolPlanV1,
  isProtocolTraceV1,
  parseProtocolTraceV1,
  PROTOCOL_DTO_LIMITS,
  type ProtocolPlanV1,
  type ProtocolTraceV1,
} from "../../src/protocols/dto";
import { PROTOCOL_CONTRACT_VERSION } from "../../src/protocols/contract";

const trace: ProtocolTraceV1 = {
  v: 1,
  inbound: "chat",
  mode: "legacy-bridge",
  upstream: "chat",
  requestPath: ["chat", "responses-internal", "ir", "chat"],
  responsePath: ["chat", "ir", "responses-internal", "chat"],
  reasonCodes: ["combo-or-policy-route"],
  featureEffects: [{ feature: "request.multiple_choices", disposition: "unsupported" }],
  attempts: [{ ordinal: 1, upstream: "chat", mode: "legacy-bridge", requestPath: ["chat", "responses-internal", "ir", "chat"] }],
  contractVersion: PROTOCOL_CONTRACT_VERSION,
};

const plan: ProtocolPlanV1 = {
  schemaVersion: 1,
  basis: "preview",
  contractVersion: PROTOCOL_CONTRACT_VERSION,
  policyRevision: "p1-00000000",
  inbound: "chat",
  requestedModel: "demo",
  routeKind: "direct",
  mode: "native",
  reasonCodes: ["same-wire-native"],
  candidates: [{
    provider: "p",
    model: "m",
    adapter: "openai-chat",
    upstream: "chat",
    mode: "native",
    requestPath: ["chat", "chat"],
    responsePath: ["chat", "chat"],
    fidelity: "preserved",
    reasonCodes: ["same-wire-native"],
    featureEffects: [],
    unknownFeatures: [],
    eligible: true,
  }],
  guaranteedFeatures: [],
  partialFeatures: [],
};

describe("trace validation", () => {
  test("accepts a v1 trace and returns a detached copy", () => {
    expect(isProtocolTraceV1(trace)).toBe(true);
    const parsed = parseProtocolTraceV1(trace)!;
    expect(parsed).toEqual(trace);
    expect(parsed.requestPath).not.toBe(trace.requestPath);
  });

  test("a blocked trace has empty paths", () => {
    const blocked = { ...trace, mode: "blocked", upstream: undefined, requestPath: [], responsePath: [], attempts: undefined };
    expect(isProtocolTraceV1(blocked)).toBe(true);
    expect(isProtocolTraceV1({ ...blocked, requestPath: ["chat"] })).toBe(false);
  });

  test("rejects unknown vocabulary, free text, other versions and oversize arrays", () => {
    expect(isProtocolTraceV1({ ...trace, v: 2 })).toBe(false);
    expect(isProtocolTraceV1({ ...trace, mode: "fast" })).toBe(false);
    expect(isProtocolTraceV1({ ...trace, reasonCodes: ["prompt said so"] })).toBe(false);
    expect(isProtocolTraceV1({ ...trace, requestPath: Array(PROTOCOL_DTO_LIMITS.pathHops + 1).fill("chat") })).toBe(false);
    expect(parseProtocolTraceV1(undefined)).toBeUndefined();
  });
});

describe("plan validation", () => {
  test("accepts a v1 plan", () => {
    expect(isProtocolPlanV1(plan)).toBe(true);
  });

  test("rejects control characters in identifiers and unknown route kinds", () => {
    expect(isProtocolPlanV1({ ...plan, requestedModel: "a\nb" })).toBe(false);
    expect(isProtocolPlanV1({ ...plan, routeKind: "magic" })).toBe(false);
    expect(isProtocolPlanV1({ ...plan, candidates: [{ ...plan.candidates[0], eligible: "yes" }] })).toBe(false);
  });
});
