import { describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import { antigravitySessionId, isLikelyRealThoughtSignature } from "../src/adapters/google-antigravity-wire";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_MODEL_EFFORTS, canonicalAntigravityUsageModel, parseAntigravityAvailableModels, registerAntigravityDiscoveredWireModels, resolveAntigravityEffortWireModel, resolveAntigravityWireModelId } from "../src/providers/antigravity-models";
import { MODEL_DISCOVERY_MAX_MODEL_ID_LENGTH, MODEL_DISCOVERY_MAX_MODELS } from "../src/providers/model-discovery";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

function parsed(text = "hello world", stream = false, modelId = "gemini-3-pro"): OcxParsedRequest {
  return {
    modelId,
    stream,
    context: { messages: [{ role: "user", content: text }], systemPrompt: [], tools: [] },
    options: {},
  } as unknown as OcxParsedRequest;
}

function parsedWithEffort(modelId: string, effort?: string): OcxParsedRequest {
  return {
    modelId,
    stream: false,
    context: { messages: [{ role: "user", content: "test" }], systemPrompt: [], tools: [] },
    options: effort ? { reasoning: effort } : {},
  } as unknown as OcxParsedRequest;
}

const provider = {
  adapter: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  googleMode: "cloud-code-assist",
  project: "proj-123",
  apiKey: "ya29.token",
} as OcxProviderConfig;

const effortProvider = {
  ...provider,
  modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS,
} as OcxProviderConfig;

describe("antigravity CCA envelope", () => {
  test("wraps the gemini body in the CCA envelope with project/userAgent/requestType/requestId/sessionId", async () => {
    const req = await createGoogleAdapter(provider).buildRequest(parsed());
    const env = JSON.parse(req.body);
    expect(req.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(env.model).toBe("gemini-3-pro");
    // The envelope BODY userAgent is the protocol constant; the versioned CLI UA rides in the header.
    expect(env.userAgent).toBe("antigravity");
    expect(env.requestType).toBe("agent");
    expect(env.project).toBe("proj-123");
    expect(env.requestId).toMatch(/^agent-/);
    expect(env.request.contents).toBeDefined();
    expect(env.request.sessionId).toMatch(/^-/);
    expect(env.request.model).toBeUndefined();
    expect(env.request.safetySettings).toBeUndefined();
    expect(req.headers["Authorization"]).toBe("Bearer ya29.token");
    // The exact default must not drift: Google gates models by family AND version,
    // so any change to version/platform could silently re-lock gemini-3.7-flash.
    expect(req.headers["User-Agent"]).toBe(
      "antigravity/ide/2.5.5 (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)",
    );
    // The literal "antigravity" giveaway UA must no longer be sent.
    expect(req.headers["User-Agent"]).not.toBe("antigravity");
    // x-goog-api-client is never sent — not on runtime requests, and (since #1889) not on onboarding either.
    expect(req.headers["x-goog-api-client"]).toBeUndefined();
    // sessionId lives only at request.sessionId (no top-level / snake_case duplicate).
    expect(env.request.sessionId).toMatch(/^-/);
    expect(env.request.session_id).toBeUndefined();
    expect(env.sessionId).toBeUndefined();
  });

  test("stream uses :streamGenerateContent?alt=sse", async () => {
    const req = await createGoogleAdapter(provider).buildRequest(parsed("x", true));
    expect(req.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  });

  test("exposes Gemini 3.7 Flash while retired Flash ids resolve to it", async () => {
    // Collapsed picker: base models only.
    expect(ANTIGRAVITY_MODELS).toEqual([
      "gemini-3.7-flash",
      "gemini-3.1-pro",
      "gemini-3.1-flash-image",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    for (const hidden of [
      "gemini-3.6-flash",
      "gemini-3.6-flash-low",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-high",
      "gemini-3.1-pro-low",
      "gemini-pro-agent",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash-extra-low",
      "gemini-3.5-flash-low",
      "gemini-3.5-flash-mid",
      "gemini-3.5-flash-high",
      "gemini-3-flash-agent",
      "gemini-3.6-flash-tiered",
    ]) {
      expect(ANTIGRAVITY_MODELS).not.toContain(hidden);
    }

    for (const [alias, wire] of [
      // Google retires the previous Flash generation from CCA when the next ships, so
      // every retired id — 3.6 tiers included — now lands on 3.7.
      ["gemini-3.5-flash-extra-low", "gemini-3.7-flash-tiered"],
      ["gemini-3.5-flash-low", "gemini-3.7-flash-tiered"],
      ["gemini-3.5-flash-mid", "gemini-3.7-flash-tiered"],
      ["gemini-3.5-flash-high", "gemini-3.7-flash-tiered"],
      ["gemini-3-flash-agent", "gemini-3.7-flash-tiered"],
      ["gemini-3.1-pro-high", "gemini-pro-agent"],
      ["gemini-3.1-pro-preview", "gemini-pro-agent"],
    ]) {
      const req = await createGoogleAdapter(provider).buildRequest(parsed("x", false, alias));
      expect(JSON.parse(req.body).model).toBe(wire);
    }

    for (const modelId of ["gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high"]) {
      const req = await createGoogleAdapter(provider).buildRequest(parsed("x", false, modelId));
      // The retired tier ids no longer exist upstream; they route to the live model.
      expect(JSON.parse(req.body).model).toBe("gemini-3.7-flash-tiered");
    }
  });

  test("collapses a complete CCA Gemini tier set but retains partial sets as wire IDs", () => {
    const payload = (modelIds: string[]) => ({
      models: Object.fromEntries(modelIds.map(id => [id, { maxTokens: 1_048_576 }])),
      agentModelSorts: [{ groups: [{ modelIds }] }],
    });

    const rows = parseAntigravityAvailableModels(payload([
      "gemini-3.7-flash-low",
      "gemini-3.7-flash-medium",
      "gemini-3.7-flash-high",
    ]))!;
    expect(rows.map(model => model.id)).toEqual(["gemini-3.7-flash"]);
    expect(rows[0]?.wireModelId).toBe("gemini-3.7-flash-low");
    expect(rows[0]?.effortWireModelIds).toEqual({
      low: "gemini-3.7-flash-low",
      medium: "gemini-3.7-flash-medium",
      high: "gemini-3.7-flash-high",
    });
    const baseUrl = "https://cca-tiered-set.example";
    registerAntigravityDiscoveredWireModels(baseUrl, rows);
    for (const [effort, wireModelId] of [
      ["low", "gemini-3.7-flash-low"],
      ["medium", "gemini-3.7-flash-medium"],
      ["high", "gemini-3.7-flash-high"],
    ] as const) {
      expect(resolveAntigravityEffortWireModel("gemini-3.7-flash", effort, baseUrl))
        .toEqual({ wireModelId });
    }
    expect(parseAntigravityAvailableModels(payload([
      "future-flash-low",
      "future-flash-medium",
      "future-flash-high",
    ]))?.map(model => model.id)).toEqual([
      "future-flash-low",
      "future-flash-medium",
      "future-flash-high",
    ]);
    expect(parseAntigravityAvailableModels(payload([
      "future-flash-low",
      "future-flash-high",
    ]))?.map(model => model.id)).toEqual([
      "future-flash-low",
      "future-flash-high",
    ]);
    expect(parseAntigravityAvailableModels({
      models: {
        "future-flash-tiered": { maxTokens: 1_048_576 },
      },
      agentModelSorts: [{ groups: [{ modelIds: [] }] }],
      tieredModelIds: { flash: ["future-flash-tiered"] },
    })?.map(model => model.id)).toEqual(["future-flash-tiered"]);
    expect(parseAntigravityAvailableModels({
      models: {
        "gemini-3.7-flash-tiered": { maxTokens: 1_048_576 },
      },
      agentModelSorts: [{ groups: [{ modelIds: [] }] }],
      tieredModelIds: { flash: ["gemini-3.7-flash-tiered"] },
    })?.map(model => model.id)).toEqual(["gemini-3.7-flash"]);
    expect(parseAntigravityAvailableModels({
      models: {
        "gemini-3.7-flash-image": { maxTokens: 1_048_576 },
        "gemini-3.7-flash-tiered": { maxTokens: 1_048_576 },
      },
      agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.7-flash-image"] }] }],
      tieredModelIds: { flash: ["gemini-3.7-flash-tiered"] },
    })?.map(model => model.id)).toEqual([
      "gemini-3.7-flash-image",
      "gemini-3.7-flash",
    ]);
    expect(parseAntigravityAvailableModels({
      models: { "-tiered": { maxTokens: 1_048_576 } },
      agentModelSorts: [{ groups: [{ modelIds: ["-tiered"] }] }],
    })?.map(model => model.id)).toEqual(["-tiered"]);
    expect(parseAntigravityAvailableModels(payload([
      "-low",
      "-medium",
      "-high",
    ]))?.map(model => model.id)).toEqual(["-low", "-medium", "-high"]);
    expect(parseAntigravityAvailableModels(payload([
      "gemini-3.1-pro-low",
      "gemini-pro-agent",
    ]))?.map(model => model.id)).toEqual(["gemini-3.1-pro"]);
    expect(parseAntigravityAvailableModels(payload([
      "gemini-3.1-pro-low",
    ]))?.map(model => model.id)).toEqual([
      "gemini-3.1-pro-low",
    ]);
  });

  test("collapses live CCA tier labels instead of publishing one row per tier", async () => {
    const payload = {
      models: {
        "gemini-3.7-flash-low": { displayName: "Gemini 3.7 Flash (Low)", maxTokens: 1_048_576 },
        "gemini-3.7-flash-medium": { displayName: "Gemini 3.7 Flash (Medium)", maxTokens: 1_048_576 },
        "gemini-3.7-flash-high": { displayName: "Gemini 3.7 Flash (High)", maxTokens: 1_048_576 },
        "gemini-pro-agent": { displayName: "Gemini 3.1 Pro (High)", maxTokens: 1_048_576 },
        "gemini-3.1-pro-low": { displayName: "Gemini 3.1 Pro (Low)", maxTokens: 1_048_576 },
        "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6 (Thinking)", maxTokens: 250_000 },
        // Renamed on the wire, stable in public. Only THIS case may use the label.
        "internal-codename-x7": { displayName: "Gemini Nebula", maxTokens: 1_048_576 },
      },
      agentModelSorts: [{ groups: [{ modelIds: [
        "gemini-3.7-flash-low",
        "gemini-3.7-flash-medium",
        "gemini-3.7-flash-high",
        "gemini-pro-agent",
        "gemini-3.1-pro-low",
        "claude-sonnet-4-6",
        "internal-codename-x7",
      ] }] }],
    };
    const rows = parseAntigravityAvailableModels(payload)!;
    // Collapsed base models, NOT one row per reasoning tier: the effort ladder is
    // what the picker uses to offer low/medium/high, so a per-tier row destroys it.
    expect(rows.map(model => model.id)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.1-pro",
      "claude-sonnet-4-6",
      "gemini-nebula",
    ]);
    // The display label still resolves an id Google renamed on the wire.
    expect(rows.find(model => model.id === "gemini-nebula")?.wireModelId).toBe("internal-codename-x7");
    expect(rows.find(model => model.id === "gemini-3.1-pro")?.effortWireModelIds).toEqual({
      low: "gemini-3.1-pro-low",
      high: "gemini-pro-agent",
    });

    const baseUrl = "https://cca.example";
    registerAntigravityDiscoveredWireModels(baseUrl, rows);
    // A complete discovery preserves each discovered suffix for the requested effort.
    expect(resolveAntigravityEffortWireModel("gemini-3.1-pro", "low", baseUrl))
      .toEqual({ wireModelId: "gemini-3.1-pro-low" });
    expect(resolveAntigravityEffortWireModel("gemini-3.1-pro", "high", baseUrl))
      .toEqual({ wireModelId: "gemini-pro-agent" });
    expect(resolveAntigravityEffortWireModel("gemini-3.7-flash", "low", baseUrl))
      .toEqual({ wireModelId: "gemini-3.7-flash-low" });
    expect(resolveAntigravityEffortWireModel("gemini-3.7-flash", "medium", baseUrl))
      .toEqual({ wireModelId: "gemini-3.7-flash-medium" });
    expect(resolveAntigravityEffortWireModel("gemini-3.7-flash", "high", baseUrl))
      .toEqual({ wireModelId: "gemini-3.7-flash-high" });
    expect(resolveAntigravityEffortWireModel("gemini-nebula", undefined, baseUrl))
      .toEqual({ wireModelId: "internal-codename-x7" });
    expect(resolveAntigravityEffortWireModel("claude-sonnet-4-6", "high", baseUrl))
      .toEqual({ wireModelId: "claude-sonnet-4-6", thinkingLevel: "high" });

    const req = await createGoogleAdapter({ ...effortProvider, baseUrl }).buildRequest(
      parsedWithEffort("gemini-nebula"),
    );
    expect(JSON.parse(req.body).model).toBe("internal-codename-x7");
  });

  test("preserves thinkingLevel for a display-derived tiered Flash model", async () => {
    const payload = {
      models: {
        "gemini-3.7-flash-tiered": { displayName: "Gemini 3.7 Flash", maxTokens: 1_048_576 },
      },
      agentModelSorts: [{ groups: [{ modelIds: [] }] }],
      tieredModelIds: { flash: ["gemini-3.7-flash-tiered"] },
    };
    const rows = parseAntigravityAvailableModels(payload)!;
    expect(rows).toEqual([{
      id: "gemini-3.7-flash",
      wireModelId: "gemini-3.7-flash-tiered",
      contextWindow: 1_048_576,
    }]);

    const baseUrl = "https://cca-tiered-discovery.example";
    registerAntigravityDiscoveredWireModels(baseUrl, rows);
    expect(resolveAntigravityEffortWireModel("gemini-3.7-flash", "high", baseUrl))
      .toEqual({ wireModelId: "gemini-3.7-flash-tiered", thinkingLevel: "high" });

    const req = await createGoogleAdapter({ ...effortProvider, baseUrl }).buildRequest(
      parsedWithEffort("gemini-3.7-flash", "high"),
    );
    const envelope = JSON.parse(req.body);
    expect(envelope.model).toBe("gemini-3.7-flash-tiered");
    expect(envelope.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  test("keeps unknown discovered tier IDs directly routable", async () => {
    for (const modelId of ["future-flash-tiered", "future-flash-low"]) {
      const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort(modelId, "high"));
      const env = JSON.parse(req.body);
      expect(env.model).toBe(modelId);
      expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
    }
  });

  test("ignores inherited CCA model and alias properties", () => {
    const inheritedModels = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(inheritedModels, "__proto__", {
      value: { maxTokens: 1_048_576 },
      enumerable: true,
    });
    const models = Object.create(inheritedModels);

    expect(parseAntigravityAvailableModels({
      models,
      agentModelSorts: [{ groups: [{ modelIds: ["__proto__"] }] }],
    })).toBeNull();
    expect(resolveAntigravityWireModelId("__proto__")).toBe("__proto__");
    expect(resolveAntigravityEffortWireModel("__proto__", "high")).toEqual({
      wireModelId: "__proto__",
    });
  });

  test("rejects malformed and oversized CCA agent-model lists", () => {
    const payload = (modelIds: unknown[]) => ({
      models: Object.fromEntries(modelIds.map(id => [String(id), { maxTokens: 1_048_576 }])),
      agentModelSorts: [{ groups: [{ modelIds }] }],
    });

    for (const invalidId of [" ", "bad\u0000id", "x".repeat(MODEL_DISCOVERY_MAX_MODEL_ID_LENGTH + 1)]) {
      expect(parseAntigravityAvailableModels(payload([invalidId]))).toBeNull();
    }
    expect(parseAntigravityAvailableModels({
      models: {},
      agentModelSorts: [{ groups: [{
        modelIds: Array.from({ length: MODEL_DISCOVERY_MAX_MODELS + 1 }, (_, index) => `model-${index}`),
      }] }],
    })).toBeNull();
  });

  test("rejects malformed CCA agent-model containers and missing agent metadata", () => {
    expect(parseAntigravityAvailableModels({
      models: {},
      agentModelSorts: [{}],
    })).toBeNull();
    expect(parseAntigravityAvailableModels({
      models: {},
      agentModelSorts: [{ groups: {} }],
    })).toBeNull();
    expect(parseAntigravityAvailableModels({
      models: {},
      agentModelSorts: [{ groups: [{ modelIds: {} }] }],
    })).toBeNull();
    expect(parseAntigravityAvailableModels({
      models: {},
      agentModelSorts: [{ groups: [{ modelIds: ["agent-model"] }] }],
    })).toBeNull();
  });

  test("normalizes untrusted CCA model limits before publishing a catalog", () => {
    const oversized = Array.from(
      { length: MODEL_DISCOVERY_MAX_MODELS + 1 },
      (_, index) => `model-${index}`,
    );
    const payload = {
      models: Object.fromEntries(oversized.map(id => [id, { maxTokens: 1_048_576 }])),
      agentModelSorts: [{ groups: [{ modelIds: oversized }] }],
    };
    for (const limit of [Number.NaN, Infinity, MODEL_DISCOVERY_MAX_MODELS + 1]) {
      expect(parseAntigravityAvailableModels(payload, limit)).toBeNull();
    }
    expect(parseAntigravityAvailableModels({
      models: { "agent-model": { maxTokens: 1_048_576 } },
      agentModelSorts: [{ groups: [{ modelIds: ["agent-model"] }] }],
      imageGenerationModelIds: ["gemini-3.1-flash-image"],
    }, 1)?.map(model => model.id)).toEqual(["agent-model"]);
  });

  test("throws when no project id is available", async () => {
    const noProj = { ...provider, project: undefined } as OcxProviderConfig;
    await expect(createGoogleAdapter(noProj).buildRequest(parsed())).rejects.toThrow(/project id/);
  });

  test("sessionId is deterministic for the same first user text", () => {
    expect(antigravitySessionId(parsed("same"))).toBe(antigravitySessionId(parsed("same")));
    expect(antigravitySessionId(parsed("a"))).not.toBe(antigravitySessionId(parsed("b")));
  });

  // #1297. The id must be identical on consecutive turns or the replay cache stops
  // finding thought signatures. First-user text only holds while that message
  // survives verbatim, and Codex compacts long histories.
  function threaded(text: string, threadId?: string): OcxParsedRequest {
    const base = parsed(text) as OcxParsedRequest & { _clientThreadId?: string };
    if (threadId) base._clientThreadId = threadId;
    return base;
  }

  test("#1297: one thread keeps one session id after history compaction changes the first message", () => {
    // Turn N and turn N+1 of the same conversation, where the client has dropped
    // or summarised the earliest user message between them.
    expect(antigravitySessionId(threaded("original first message", "thread-a")))
      .toBe(antigravitySessionId(threaded("summary of earlier turns", "thread-a")));
  });

  test("#1297: distinct threads do not collide even with identical text", () => {
    expect(antigravitySessionId(threaded("hi", "thread-a")))
      .not.toBe(antigravitySessionId(threaded("hi", "thread-b")));
  });

  test("#1297: promptCacheKey does not influence the id", () => {
    // Deliberately not the anchor: it is arbitrary Responses input and is shared
    // across conversations for some clients, so it identifies a cache cohort.
    const withKey = threaded("same text", "thread-a") as OcxParsedRequest;
    (withKey.options as Record<string, unknown>).promptCacheKey = "cohort-1";
    const otherKey = threaded("same text", "thread-a") as OcxParsedRequest;
    (otherKey.options as Record<string, unknown>).promptCacheKey = "cohort-2";
    expect(antigravitySessionId(withKey)).toBe(antigravitySessionId(otherKey));
  });

  test("#1297: the prefix separates a thread id from the bare same text", () => {
    // Scope of the guarantee, stated exactly: prefixing stops the RAW-EQUAL case.
    expect(antigravitySessionId(threaded("thread-a", undefined)))
      .not.toBe(antigravitySessionId(threaded("anything", "thread-a")));
    // It is not full domain separation — a first message that is literally the
    // prefixed form still shares the preimage. Asserted rather than hidden,
    // because tagging the text anchor too would change every existing
    // Google-visible id for live conversations. Harmless here: signatures are
    // keyed on functionCall identity, so a shared id misattributes nothing.
    expect(antigravitySessionId(threaded("codex-thread:thread-a", undefined)))
      .toBe(antigravitySessionId(threaded("anything", "thread-a")));
  });

  test("#1297: clients without the thread header keep the text anchor", () => {
    // A scoped repair, not a universal one — this behaviour is unchanged.
    expect(antigravitySessionId(threaded("same", undefined)))
      .toBe(antigravitySessionId(threaded("same", undefined)));
    expect(antigravitySessionId(threaded("a", undefined)))
      .not.toBe(antigravitySessionId(threaded("b", undefined)));
  });

  test("#1297: the wire id shape is unchanged", () => {
    // It is sent to Google as `request.sessionId`, so the format must not move:
    // "-" followed by a masked uint63.
    for (const id of [
      antigravitySessionId(threaded("text only", undefined)),
      antigravitySessionId(threaded("text", "thread-a")),
    ]) {
      expect(id).toMatch(/^-\d+$/);
      expect(BigInt(id.slice(1))).toBeLessThanOrEqual(0x7fffffffffffffffn);
    }
  });

  test("#1297: the built CCA envelope carries the stable sessionId across turns", async () => {
    // The helper tests above prove the derivation; this one proves the value
    // actually reaches `request.sessionId` on the wire, which is what Google
    // sees and what the CCA replay path is keyed by.
    const adapter = createGoogleAdapter(provider);
    const turnOne = JSON.parse((await adapter.buildRequest(threaded("original first message", "thread-a"))).body);
    const turnTwo = JSON.parse((await adapter.buildRequest(threaded("summary of earlier turns", "thread-a"))).body);

    expect(turnOne.request.sessionId).toBe(antigravitySessionId(threaded("original first message", "thread-a")));
    expect(turnTwo.request.sessionId).toBe(turnOne.request.sessionId);

    // A different thread must still land on a different session.
    const other = JSON.parse((await adapter.buildRequest(threaded("original first message", "thread-b"))).body);
    expect(other.request.sessionId).not.toBe(turnOne.request.sessionId);
  });

  test("claude-on-antigravity forces toolConfig.functionCallingConfig.mode=VALIDATED", async () => {
    const claudeProvider = { ...provider } as OcxProviderConfig;
    const withTools = {
      modelId: "claude-opus-4-6",
      stream: false,
      context: {
        messages: [{ role: "user", content: "hi" }],
        systemPrompt: [],
        tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const req = await createGoogleAdapter(claudeProvider).buildRequest(withTools);
    const env = JSON.parse(req.body);
    expect(env.request.toolConfig.functionCallingConfig.mode).toBe("VALIDATED");
  });

  test("gemini-on-antigravity does NOT get the VALIDATED override", async () => {
    const withTools = {
      modelId: "gemini-3-pro",
      stream: false,
      context: {
        messages: [{ role: "user", content: "hi" }],
        systemPrompt: [],
        tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const req = await createGoogleAdapter(provider).buildRequest(withTools);
    const env = JSON.parse(req.body);
    expect(env.request.toolConfig?.functionCallingConfig?.mode).toBeUndefined();
  });

  // ── Effort routing: base model + effort → wire model ID + thinkingConfig ──

  // 3.7 Flash carries its tiers on thinkingLevel against ONE wire id, unlike the 3.6
  // generation which used suffixed wire ids.
  test("gemini-3.7-flash with effort=high keeps the wire id + thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.7-flash", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.7-flash-tiered");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("gemini-3.7-flash with effort=low keeps the wire id + thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.7-flash", "low"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.7-flash-tiered");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("low");
  });

  test("gemini-3.7-flash with no effort still sends the documented medium default", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.7-flash"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.7-flash-tiered");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("medium");
  });

  test("gemini-3.7-flash with effort=max clamps to high", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.7-flash", "max"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.7-flash-tiered");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("gemini-3.1-pro with effort=low routes to gemini-3.1-pro-low + thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.1-pro", "low"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.1-pro-low");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("low");
  });

  test("gemini-3.1-pro with effort=high routes to gemini-pro-agent + thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.1-pro", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-pro-agent");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("gemini-3.1-pro with no effort defaults to gemini-pro-agent (high)", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.1-pro"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-pro-agent");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });

  test("gemini-3.1-pro with effort=medium clamps to low", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.1-pro", "medium"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.1-pro-low");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("low");
  });

  // ── Suffix-ID precedence: suffix IS the effort, no thinkingConfig ──

  test("retired suffix id gemini-3.6-flash-low with effort=high routes to 3.7 at high", async () => {
    // A retired id must not keep its dead wire id, and an explicit effort still wins.
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.6-flash-low", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.7-flash-tiered");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("retired suffix id with no effort routes to 3.7 carrying the tier it encoded", async () => {
    // The suffix used to BE the effort. Now that the wire id is gone, the tier has to
    // survive as an explicit thinkingLevel or the user silently loses their choice.
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.6-flash-low"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.7-flash-tiered");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("low");
  });

  test("legacy 3.5 compat alias now resolves to 3.7 with an explicit effort", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.5-flash-high", "low"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.7-flash-tiered");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("low");
  });

  // ── Claude Opus effort via thinkingConfig (no suffix variants) ──

  test("claude-opus-4-6-thinking with effort=high sends thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-opus-4-6-thinking", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-opus-4-6-thinking");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("claude-opus-4-6-thinking with effort=max clamps CCA thinkingLevel to high", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-opus-4-6-thinking", "max"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-opus-4-6-thinking");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("claude-opus-4-6-thinking with effort=ultra clamps CCA thinkingLevel to high", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-opus-4-6-thinking", "ultra"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-opus-4-6-thinking");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("claude-opus-4-6-thinking with no effort sends no thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-opus-4-6-thinking"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-opus-4-6-thinking");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });

  // ── Non-effort models: no thinkingConfig regardless of effort ──

  test("claude-sonnet-4-6 with effort=high sends thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-sonnet-4-6", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-sonnet-4-6");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("claude-sonnet-4-6 with effort=max clamps CCA thinkingLevel to high", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-sonnet-4-6", "max"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-sonnet-4-6");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("claude-sonnet-4-6 with no effort sends no thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-sonnet-4-6"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-sonnet-4-6");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });

  test("gpt-oss-120b-medium with any effort sends no thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gpt-oss-120b-medium", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gpt-oss-120b-medium");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });
});

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n`).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("antigravity parseStream unwraps response", () => {
  test("reads response.candidates and response.usageMetadata", async () => {
    const adapter = createGoogleAdapter(provider);
    const chunks = [
      { response: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } },
      { response: { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, cachedContentTokenCount: 3 } } },
    ];
    const events: AdapterEvent[] = [];
    for await (const ev of adapter.parseStream(sseResponse(chunks))) events.push(ev);
    expect(events.some(e => e.type === "text_delta" && e.text === "hi")).toBe(true);
    const done = events.find(e => e.type === "done");
    expect((done as Extract<AdapterEvent, { type: "done" }>).usage?.inputTokens).toBe(4);
    expect((done as Extract<AdapterEvent, { type: "done" }>).usage?.cachedInputTokens).toBe(3);
  });
});

describe("antigravity parseResponse unwraps response (non-streaming)", () => {
  test("reads response.candidates + response.usageMetadata from the CCA envelope", async () => {
    const adapter = createGoogleAdapter(provider);
    const body = JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "hello" }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2, cachedContentTokenCount: 7 } } });
    const events = await adapter.parseResponse!(new Response(body, { status: 200 }));
    expect(events.some(e => e.type === "text_delta" && e.text === "hello")).toBe(true);
    const done = events.find(e => e.type === "done");
    expect((done as Extract<AdapterEvent, { type: "done" }>).usage?.inputTokens).toBe(9);
    expect((done as Extract<AdapterEvent, { type: "done" }>).usage?.cachedInputTokens).toBe(7);
  });

  test("non-streaming observes thoughtSignatures so the next turn can replay them", async () => {
    const { __resetAntigravityReplayCache, applyAntigravityReplay } = await import("../src/adapters/google-antigravity-replay");
    __resetAntigravityReplayCache();
    const adapter = createGoogleAdapter(provider);
    // buildRequest first to set the per-adapter model/session, then parseResponse to observe.
    await adapter.buildRequest(parsed("hello world"));
    const body = JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionCall: { name: "do_x", args: { a: 1 } }, thoughtSignature: "sig-nonstream0000000" } ] } }] } });
    await adapter.parseResponse!(new Response(body, { status: 200 }));
    // A follow-up request's history should now get the signature re-injected.
    const followup = parsed("hello world");
    const contents = [{ role: "model", parts: [{ functionCall: { name: "do_x", args: { a: 1 } } }] }];
    applyAntigravityReplay("gemini-3-pro", antigravitySessionId(followup), contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("sig-nonstream0000000");
  });

  // Guard for #1503: routing `thought: true` text to the reasoning channel must not disturb
  // signature observation. Gemini 3 rejects a follow-up turn whose first function-call part
  // lost its signature, so a classification change that also dropped replay would trade a
  // visible-text bug for a hard 400. Asserting the signature survives a payload that mixes a
  // thought part with a signed function call is the direct proof, rather than inferring it
  // from unrelated fixtures that happen to still pass.
  test("a thought part alongside a signed function call does not disturb replay", async () => {
    const { __resetAntigravityReplayCache, applyAntigravityReplay } = await import("../src/adapters/google-antigravity-replay");
    __resetAntigravityReplayCache();
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(parsed("hello world"));
    const body = JSON.stringify({
      response: {
        candidates: [{
          content: {
            parts: [
              { thought: true, text: "deciding which tool to call" },
              { functionCall: { name: "do_x", args: { a: 1 } }, thoughtSignature: "sig-withthought00000" },
            ],
          },
        }],
      },
    });
    const events = await adapter.parseResponse!(new Response(body, { status: 200 }));

    expect(events).not.toContainEqual({ type: "text_delta", text: "deciding which tool to call" });

    const followup = parsed("hello world");
    const contents = [{ role: "model", parts: [{ functionCall: { name: "do_x", args: { a: 1 } } }] }];
    applyAntigravityReplay("gemini-3-pro", antigravitySessionId(followup), contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("sig-withthought00000");
  });
});

describe("antigravity history preserves tool-call thoughtSignature", () => {
  test("a prior assistant toolCall with thoughtSignature carries it into the CCA request part", async () => {
    const p = {
      modelId: "gemini-3-pro",
      stream: false,
      context: {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "get_x", namespace: "mcp__t", arguments: { a: 1 }, thoughtSignature: "sig-abcdef0123456789" }] },
        ],
        systemPrompt: [], tools: [],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const req = await createGoogleAdapter(provider).buildRequest(p);
    const env = JSON.parse(req.body);
    const modelTurn = (env.request.contents as { role: string; parts: Record<string, unknown>[] }[]).find(c => c.role === "model");
    const fcPart = modelTurn?.parts.find(part => "functionCall" in part);
    expect(fcPart?.thoughtSignature).toBe("sig-abcdef0123456789");
  });

  test("a synthetic Responses item id (fc_...) is NOT forwarded as a thoughtSignature", async () => {
    const p = {
      modelId: "gemini-3-pro",
      stream: false,
      context: {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "get_x", namespace: "mcp__t", arguments: {}, thoughtSignature: "fc_d8df7548e31a4130b7624f3d27571cdd" }] },
        ],
        systemPrompt: [], tools: [],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const req = await createGoogleAdapter(provider).buildRequest(p);
    const env = JSON.parse(req.body);
    const modelTurn = (env.request.contents as { role: string; parts: Record<string, unknown>[] }[]).find(c => c.role === "model");
    const fcPart = modelTurn?.parts.find(part => "functionCall" in part);
    expect(fcPart?.thoughtSignature).toBeUndefined();
  });

  test("custom_tool_call item ids (ctc_...) from Claude/mixed history are NOT forwarded (issue #174)", async () => {
    const p = {
      modelId: "gemini-3-pro",
      stream: false,
      context: {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "get_x", namespace: "mcp__t", arguments: {}, thoughtSignature: "ctc_038f26d3f20962bc016a54f0fcfa208190a8ec0f289c2ba211" }] },
        ],
        systemPrompt: [], tools: [],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const req = await createGoogleAdapter(provider).buildRequest(p);
    const env = JSON.parse(req.body);
    const modelTurn = (env.request.contents as { role: string; parts: Record<string, unknown>[] }[]).find(c => c.role === "model");
    const fcPart = modelTurn?.parts.find(part => "functionCall" in part);
    expect(fcPart?.thoughtSignature).toBeUndefined();
  });
});

describe("isLikelyRealThoughtSignature", () => {
  test("rejects synthetic Responses/tool-call ids (underscore and hyphen variants)", () => {
    for (const id of [
      "fc_d8df7548e31a4130b7624f3d27571cdd",
      "ctc_038f26d3f20962bc016a54f0fcfa208190a8ec0f289c2ba211",
      "tsc_0123456789abcdef01234567",
      "call_1f57fdea0000",
      "function-call-1234567890",
      "tool-call-abcdef123456",
      "toolu_01AbCdEfGhIjKlMnOpQrStUv",
      "msg_0123456789abcdef",
      "rs_0123456789abcdef",
    ]) {
      expect(isLikelyRealThoughtSignature(id)).toBe(false);
    }
  });
  test("rejects too-short or non-base64 values", () => {
    expect(isLikelyRealThoughtSignature("short")).toBe(false);
    expect(isLikelyRealThoughtSignature("has spaces in it here")).toBe(false);
    expect(isLikelyRealThoughtSignature(undefined)).toBe(false);
  });
  test("accepts an opaque base64/base64url signature blob", () => {
    expect(isLikelyRealThoughtSignature("CisBVKhc7+abcDEF0123456789/xyz==")).toBe(true);
    expect(isLikelyRealThoughtSignature("abcd1234abcd1234abcd1234")).toBe(true);
    // `sig-…` shapes are used by replay fixtures / some upstream blobs — must NOT be deny-listed.
    expect(isLikelyRealThoughtSignature("sig-abcdef0123456789")).toBe(true);
  });
});


describe("canonicalAntigravityUsageModel", () => {
  test("maps wire/compat ids to picker bases", () => {
    // Retired ids keep their own identity here on purpose: a usage row records the model
    // that was actually called, so collapsing it into 3.7 would move historical spend.
    expect(canonicalAntigravityUsageModel("gemini-3.5-flash-mid")).toBe("gemini-3.5-flash-mid");
    expect(canonicalAntigravityUsageModel("gemini-3.6-flash-high")).toBe("gemini-3.6-flash-high");
    expect(canonicalAntigravityUsageModel("gemini-pro-agent")).toBe("gemini-3.1-pro");
    expect(canonicalAntigravityUsageModel("gemini-3.1-pro-low")).toBe("gemini-3.1-pro");
    expect(canonicalAntigravityUsageModel("claude-opus-4-6-thinking")).toBe("claude-opus-4-6-thinking");
    expect(canonicalAntigravityUsageModel("unknown-model")).toBe("unknown-model");
  });
});
