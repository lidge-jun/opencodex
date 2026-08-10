import { describe, expect, test } from "bun:test";
import {
  modelOptionsForProvider,
  newRoutingProfileDraft,
  normalizeCompatibilityDto,
  normalizeCompatibilitySuites,
  routingProfileDraftFromDto,
  routingProfilePutBody,
  routingProfileResponseError,
  routingProfileResponseSucceeded,
  type RoutingProfileDto,
} from "../gui/src/routing-profile-editor-data";

const profile: RoutingProfileDto = {
  id: "fast",
  alias: "ocx/fast",
  model: "ocx/fast",
  revision: "abc123",
  candidates: [
    { provider: "anthropic", model: "claude-sonnet-5" },
    { provider: "openai", model: "gpt-5.6" },
  ],
  require: {
    minContextWindow: 128000,
    minQuotaHeadroom: 0.2,
    tools: true,
    imageInput: false,
    reasoningEffort: "high",
  },
  optimize: { latency: 0.55, health: 0.25, cost: 0.1, quota: 0.1 },
  limits: { maxEstimatedCostUsd: 0.5 },
  unknownEvidence: {
    capability: "exclude",
    health: "penalize",
    quota: "allow",
    cost: "penalize",
  },
};

describe("routing profile editor data", () => {
  test("creates a usable draft with one candidate and stable defaults", () => {
    const draft = newRoutingProfileDraft("openai", "gpt-5.6");
    expect(draft.candidates).toEqual([
      { provider: "openai", model: "gpt-5.6", key: expect.stringMatching(/^candidate-\d+$/) },
    ]);
    // Keys are unique per created candidate.
    expect(newRoutingProfileDraft("openai", "gpt-5.6").candidates[0]!.key)
      .not.toBe(draft.candidates[0]!.key);
    expect(draft.optimize).toEqual({ latency: "0.55", health: "0.25", cost: "0.1", quota: "0.1" });
    expect(draft.unknownEvidence.capability).toBe("exclude");
  });

  test("round-trips normalized DTO values into a PUT payload", () => {
    const draft = routingProfileDraftFromDto(profile);
    const body = routingProfilePutBody(draft, "update", profile.revision);

    expect(body).toEqual({
      mode: "update",
      id: "fast",
      expectedRevision: "abc123",
      profile: {
        alias: "ocx/fast",
        candidates: profile.candidates,
        require: {
          minContextWindow: 128000,
          minQuotaHeadroom: 0.2,
          tools: true,
          imageInput: false,
          reasoningEffort: "high",
        },
        optimize: profile.optimize,
        limits: { maxEstimatedCostUsd: 0.5 },
        unknownEvidence: profile.unknownEvidence,
      },
    });
  });

  test("carries expectedRevision on update and omits it on create", () => {
    const draft = newRoutingProfileDraft("openai", "gpt-5.6");
    const updateBody = routingProfilePutBody(draft, "update", "rev-1");
    expect(updateBody).toMatchObject({ mode: "update", expectedRevision: "rev-1" });
    const createBody = routingProfilePutBody(draft, "create");
    expect(createBody).toMatchObject({ mode: "create" });
    expect(createBody).not.toHaveProperty("expectedRevision");
  });

  test("omits blank optional fields while retaining explicit false", () => {
    const draft = newRoutingProfileDraft("openai", "gpt-5.6");
    draft.id = "  balanced  ";
    draft.require.tools = "false";
    draft.require.serviceTier = "  ";
    draft.limits.maxEstimatedCostUsd = "";

    expect(routingProfilePutBody(draft, "create")).toMatchObject({
      mode: "create",
      id: "balanced",
      profile: {
        candidates: [{ provider: "openai", model: "gpt-5.6" }],
        require: { tools: false },
      },
    });
    expect(routingProfilePutBody(draft, "create").profile).not.toHaveProperty("limits");
    expect(routingProfilePutBody(draft, "create").profile).not.toHaveProperty("alias");
  });

  test("extracts both string and structured management errors", () => {
    expect(routingProfileResponseError({ error: "plain failure" })).toBe("plain failure");
    expect(routingProfileResponseError({ error: { message: "validation failure" } })).toBe("validation failure");
    expect(routingProfileResponseError({ success: true })).toBeUndefined();
    expect(routingProfileResponseSucceeded({ success: true })).toBe(true);
    expect(routingProfileResponseSucceeded({ success: false })).toBe(false);
  });

  test("filters model suggestions by provider", () => {
    expect(modelOptionsForProvider([
      { provider: "openai", id: "gpt-5.6" },
      { provider: "anthropic", id: "claude-sonnet-5" },
    ], "anthropic")).toEqual([{ provider: "anthropic", id: "claude-sonnet-5" }]);
  });

  test("round-trips compatibility controls into a PUT payload", () => {
    const withCompatibility: RoutingProfileDto = {
      ...profile,
      compatibility: {
        requiredSuites: [
          { suiteId: "responses-core", evidenceLayer: "live_route_compatibility" },
        ],
        minStatus: "VERIFIED",
        maxEvidenceAgeMs: 86_400_000,
        unknownEvidence: "penalize",
        degradedEvidence: "exclude",
      },
    };
    const draft = routingProfileDraftFromDto(withCompatibility);
    expect(draft.compatibility.enabled).toBe(true);
    expect(draft.compatibility.requiredSuites).toEqual(withCompatibility.compatibility!.requiredSuites);
    expect(routingProfilePutBody(draft, "update", profile.revision)).toMatchObject({
      profile: {
        compatibility: {
          requiredSuites: withCompatibility.compatibility!.requiredSuites,
          minStatus: "VERIFIED",
          maxEvidenceAgeMs: 86_400_000,
          unknownEvidence: "penalize",
          degradedEvidence: "exclude",
        },
      },
    });
  });

  test("omits compatibility from PUT payload when editor compatibility is disabled", () => {
    const withCompatibility: RoutingProfileDto = {
      ...profile,
      compatibility: {
        requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }],
        minStatus: "PROBED",
      },
    };
    const draft = routingProfileDraftFromDto(withCompatibility);
    draft.compatibility.enabled = false;
    const body = routingProfilePutBody(draft, "create");
    expect(body.profile).not.toHaveProperty("compatibility");
  });

  test("hydrates maxEvidenceAgeMs zero without dropping or blanking the field", () => {
    expect(normalizeCompatibilityDto({
      requiredSuites: [],
      maxEvidenceAgeMs: 0,
    })).toEqual({ requiredSuites: [], maxEvidenceAgeMs: 0 });

    const draft = routingProfileDraftFromDto({
      ...profile,
      compatibility: {
        requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }],
        maxEvidenceAgeMs: 0,
      },
    });
    expect(draft.compatibility.maxEvidenceAgeMs).toBe("0");
    expect(routingProfilePutBody(draft, "update", profile.revision)).toMatchObject({
      profile: {
        compatibility: {
          requiredSuites: [{ suiteId: "responses-core", evidenceLayer: "live_route_compatibility" }],
          maxEvidenceAgeMs: 0,
        },
      },
    });
  });

  test("normalizes malformed compatibility suites instead of crashing the editor draft", () => {
    expect(normalizeCompatibilitySuites("not-an-array")).toEqual([]);
    expect(normalizeCompatibilitySuites([
      { suiteId: "ok", evidenceLayer: "protocol_conformance" },
      { suiteId: "bad", evidenceLayer: "other" },
      { suiteId: "  ", evidenceLayer: "live_route_compatibility" },
      null,
      "skip",
    ])).toEqual([{ suiteId: "ok", evidenceLayer: "protocol_conformance" }]);

    expect(normalizeCompatibilityDto("broken")).toBeUndefined();
    expect(normalizeCompatibilityDto({
      requiredSuites: { suiteId: "object-not-array" },
      minStatus: "CLAIMED",
      unknownEvidence: "explode",
    })).toEqual({ requiredSuites: [] });

    const draft = routingProfileDraftFromDto({
      ...profile,
      compatibility: {
        requiredSuites: "responses-core",
      } as RoutingProfileDto["compatibility"],
    });
    expect(draft.compatibility.enabled).toBe(true);
    expect(draft.compatibility.requiredSuites).toEqual([]);
  });
});
