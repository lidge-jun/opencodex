import { describe, expect, test } from "bun:test";
import {
  modelOptionsForProvider,
  newRoutingProfileDraft,
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
      {
        provider: "openai",
        model: "gpt-5.6",
        taskTiers: [],
        key: expect.stringMatching(/^candidate-\d+$/),
      },
    ]);
    // Keys are unique per created candidate.
    expect(newRoutingProfileDraft("openai", "gpt-5.6").candidates[0]!.key)
      .not.toBe(draft.candidates[0]!.key);
    expect(draft.optimize).toEqual({ latency: "0.55", health: "0.25", cost: "0.1", quota: "0.1" });
    expect(draft.unknownEvidence.capability).toBe("exclude");
    expect(draft.promptRoutingEnabled).toBe(false);
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

  test("round-trips prompt routing and candidate task tiers", () => {
    const smartProfile: RoutingProfileDto = {
      ...profile,
      id: "smart",
      alias: "ocx/auto",
      promptRouting: { enabled: true },
      candidates: [
        { provider: "anthropic", model: "claude-sonnet-5", taskTiers: ["fast", "balanced"] },
        { provider: "openai", model: "gpt-5.6", taskTiers: ["powerful"] },
      ],
    };
    const draft = routingProfileDraftFromDto(smartProfile);
    expect(draft.promptRoutingEnabled).toBe(true);
    expect(draft.candidates.map(candidate => candidate.taskTiers)).toEqual([
      ["fast", "balanced"],
      ["powerful"],
    ]);
    expect(routingProfilePutBody(draft, "update", smartProfile.revision).profile).toMatchObject({
      alias: "ocx/auto",
      promptRouting: { enabled: true },
      candidates: smartProfile.candidates,
    });
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
});
