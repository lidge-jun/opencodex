import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../../src/adapters/openai-responses";
import { parseRequest } from "../../../src/responses/parser";
import { XAI_GROK_CLI_BASE_URL } from "../../../src/providers/xai-transport";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import { shouldExposeProviderModel } from "../../../src/codex/catalog/model-visibility";
import { providerConfigSeed } from "../../../src/providers/derive";
import {
  createAdapterTierMetadata,
  decideTier,
  emittedFastWire,
  fastWireDeclarationError,
  tierObservationContext,
} from "../../../src/providers/fastwire";
import { getProviderRegistryEntry } from "../../../src/providers/registry";
import { fastPolicyForModel } from "../../../src/providers/service-tier";
import {
  applyXaiOauthFastModel,
  XAI_OAUTH_FAST_MODELS,
  XAI_OAUTH_FAST_VARIANT_IDS,
  xaiOauthFastModel,
} from "../../../src/providers/xai-fast-model";
import type { OcxParsedRequest, OcxProviderConfig, TierDecision, TierObservationContext } from "../../../src/types";
import { estimateAttemptCost } from "../../../src/usage/cost";
import { normalizePersistedUsageRow, type PersistedUsageEntry } from "../../../src/usage/log";

const BASE = "grok-4.7";
const VARIANT = "grok-4.7-build-fast";
const SET: TierDecision = { kind: "set", value: "priority" };
const VARIANT_WIRE = {
  kind: "model-variant" as const,
  canonicalToWire: { priority: VARIANT },
  foreignCallerTiers: "drop" as const,
};
type Route = Parameters<typeof applyXaiOauthFastModel>[1];

function oauthRoute(modelId = BASE): Route {
  return { providerName: "xai", provider: { authMode: "oauth" }, modelId };
}

function observation(): TierObservationContext {
  return {
    capability: true,
    eligibility: "eligible",
    fastWire: {
      kind: "service-tier",
      canonicalToWire: { priority: "priority" },
      foreignCallerTiers: "verbatim",
    },
    demandDecision: "inherit",
    callerTier: "priority",
    responseTierAuthoritative: true,
  };
}

function parsedFor(
  decision: TierDecision | undefined = SET,
  modelId = BASE,
): OcxParsedRequest & { _rawBody: Record<string, unknown> } {
  return {
    modelId,
    stream: true,
    context: { systemPrompt: [], messages: [{ role: "user", content: "hello" }] },
    options: {
      serviceTier: "priority",
      ...(decision ? { tierDecision: decision } : {}),
      tierObservation: observation(),
    },
    _rawBody: { model: modelId, service_tier: "priority", input: "hello" },
  };
}

function decisionChain(fastMode?: boolean, callerTier?: string) {
  const entry = getProviderRegistryEntry("xai");
  if (!entry) throw new Error("xai registry entry missing");
  const provider = { ...providerConfigSeed(entry), authMode: "oauth" as const };
  const route = { providerName: "xai", provider, modelId: BASE };
  const policy = fastPolicyForModel(provider, BASE, "xai", "responses");
  const decision = decideTier(policy, fastMode, callerTier);
  const obs = tierObservationContext(policy, fastMode, callerTier, true);
  const parsed = parsedFor(decision);
  parsed.options.serviceTier = callerTier;
  parsed.options.tierObservation = obs;
  if (callerTier === undefined) delete parsed._rawBody.service_tier;
  else parsed._rawBody.service_tier = callerTier;
  const logCtx: { wireModel?: string } = {};
  applyXaiOauthFastModel(parsed, route, logCtx);
  return { parsed, route, policy, decision, obs, logCtx };
}

function fastMetadata(fastMode?: boolean, callerTier?: string) {
  const chain = decisionChain(fastMode, callerTier);
  const tracker = createAdapterTierMetadata(
    chain.parsed.options.tierObservation,
    chain.parsed.options.tierDecision,
    ...emittedFastWire(chain.parsed, { model: VARIANT }),
  );
  if (!tracker) throw new Error("Fast observation metadata missing");
  return { ...chain, tracker };
}

describe("xAI OAuth Grok 4.7 serialized Fast model", () => {
  test("OAuth set swaps only the serialized model and preserves caller intent", () => {
    const parsed = parsedFor();
    const route = oauthRoute();
    const originalRoute = structuredClone(route);
    const originalObservation = structuredClone(parsed.options.tierObservation);
    const logCtx: { wireModel?: string } = {};

    applyXaiOauthFastModel(parsed, route, logCtx);

    expect(parsed._rawBody).toEqual({ model: VARIANT, service_tier: "priority", input: "hello" });
    expect(parsed.modelId).toBe(BASE);
    expect(route).toEqual(originalRoute);
    expect(parsed._wireModelOverride).toBe(VARIANT);
    expect(parsed.options.serviceTier).toBe("priority");
    expect(parsed.options.tierDecision).toEqual({ kind: "drop" });
    expect(parsed.options.tierObservation).toEqual({
      ...originalObservation,
      fastWire: VARIANT_WIRE,
      responseTierAuthoritative: false,
    });
    expect(logCtx.wireModel).toBe(VARIANT);
  });

  const unchangedCases: { label: string; decision?: TierDecision; route: Route }[] = [
    { label: "no decision", route: oauthRoute() },
    { label: "forward-caller decision", decision: { kind: "forward-caller" }, route: oauthRoute() },
    { label: "drop decision", decision: { kind: "drop" }, route: oauthRoute() },
    { label: "key auth", decision: SET, route: { ...oauthRoute(), provider: { authMode: "key" } } },
    { label: "implicit key auth", decision: SET, route: { ...oauthRoute(), provider: {} } },
    { label: "another provider", decision: SET, route: { ...oauthRoute(), providerName: "cursor" } },
    { label: "Grok 4.6", decision: SET, route: oauthRoute("grok-4.6") },
    { label: "explicit build-fast route", decision: SET, route: oauthRoute(VARIANT) },
    {
      label: "operator-declared FastWire",
      decision: { kind: "set", value: "custom-priority" },
      route: {
        ...oauthRoute(),
        provider: {
          authMode: "oauth",
          fastWire: { kind: "service-tier", canonicalToWire: { priority: "custom-priority" }, foreignCallerTiers: "verbatim" },
        },
      },
    },
  ];
  for (const { label, decision, route } of unchangedCases) {
    test(`${label} leaves request and log unchanged`, () => {
      const parsed = parsedFor(decision, route.modelId);
      // parsedFor's default is a set decision; the absent-decision case must really be absent.
      if (decision === undefined) delete parsed.options.tierDecision;
      const before = structuredClone(parsed);
      const routeBefore = structuredClone(route);
      const logCtx = { wireModel: "another-normalizer-model" };
      applyXaiOauthFastModel(parsed, route, logCtx);
      expect(parsed).toEqual(before);
      expect(route).toEqual(routeBefore);
      expect(logCtx).toEqual({ wireModel: "another-normalizer-model" });
    });
  }

  test("same-id key-auth re-normalization restores the model and removes its log annotation", () => {
    const parsed = parsedFor();
    const logCtx: { wireModel?: string } = {};
    applyXaiOauthFastModel(parsed, oauthRoute(), logCtx);
    expect(parsed._rawBody.model).toBe(VARIANT);
    expect(logCtx.wireModel).toBe(VARIANT);
    // A fresh final-route decision can still request priority on the key-auth fallback.
    parsed.options.tierDecision = SET;
    applyXaiOauthFastModel(parsed, { ...oauthRoute(), provider: { authMode: "key" } }, logCtx);
    expect(parsed._rawBody.model).toBe(BASE);
    expect(parsed.modelId).toBe(BASE);
    expect(Object.hasOwn(parsed, "_wireModelOverride")).toBe(false);
    expect(Object.hasOwn(logCtx, "wireModel")).toBe(false);
    expect(parsed.options.tierDecision).toEqual(SET);
    expect(parsed._rawBody.service_tier).toBe("priority");
  });

  test("re-normalization preserves a wireModel installed by another normalizer", () => {
    const parsed = parsedFor();
    const logCtx: { wireModel?: string } = {};
    applyXaiOauthFastModel(parsed, oauthRoute(), logCtx);
    logCtx.wireModel = "another-normalizer-model";
    applyXaiOauthFastModel(parsed, { ...oauthRoute(), provider: { authMode: "key" } }, logCtx);
    expect(parsed._rawBody.model).toBe(BASE);
    expect(parsed._wireModelOverride).toBeUndefined();
    expect(logCtx.wireModel).toBe("another-normalizer-model");
  });
});

describe("Grok 4.7 Fast policy and adapter observation contract", () => {
  test.each([
    { label: "caller priority", fastMode: undefined, callerTier: "priority" },
    { label: "global fastMode", fastMode: true, callerTier: undefined },
  ])("$label reaches an applied, assumed model variant through the real decision chain", ({ fastMode, callerTier }) => {
    const { parsed, route, policy, decision, logCtx, tracker } = fastMetadata(fastMode, callerTier);
    expect(policy.capability).toBe(true);
    expect(policy.eligibility).toBe("eligible");
    expect(decision).toEqual({ kind: "set", value: "priority" });
    expect(parsed.options.tierDecision).toEqual({ kind: "drop" });
    expect(parsed._rawBody.model).toBe(VARIANT);
    expect(parsed.modelId).toBe(BASE);
    expect(route.modelId).toBe(BASE);
    expect(logCtx.wireModel).toBe(VARIANT);
    expect(emittedFastWire(parsed, { model: VARIANT })).toEqual(["model-variant", VARIANT]);
    expect(tracker.outcome).toEqual({
      canonical: "priority",
      wireKind: "model-variant",
      wireValue: VARIANT,
      fastOutcome: "applied",
      confirmation: "assumed",
      responseTierAuthoritative: false,
    });
    const beforeEcho = structuredClone(tracker.outcome);
    for (const echo of ["priority", "default"]) {
      tracker.observeResponseServiceTier(echo);
      expect(tracker.outcome).toEqual({ ...beforeEcho, responseServiceTier: echo });
    }
  });

  test("fastMode false drops caller priority without swapping the model", () => {
    const { parsed, decision, logCtx } = decisionChain(false, "priority");
    expect(decision).toEqual({ kind: "drop" });
    expect(parsed.options.tierDecision).toEqual({ kind: "drop" });
    expect(parsed._rawBody.model).toBe(BASE);
    expect(parsed._wireModelOverride).toBeUndefined();
    expect(logCtx.wireModel).toBeUndefined();
    expect(emittedFastWire(parsed, { model: BASE })).toEqual([null, null]);
  });

  test.each([
    { label: "priority tier", body: { model: BASE, service_tier: "priority" }, expected: ["service-tier", "priority"] },
    { label: "foreign tier", body: { model: BASE, service_tier: "flex" }, expected: ["service-tier", "flex"] },
    { label: "absent tier", body: { model: BASE }, expected: [null, null] },
  ])("without an override emittedFastWire reads $label", ({ body, expected }) => {
    expect(emittedFastWire(parsedFor(), body)).toEqual(expected);
  });

  test("an override with a different serialized model falls back to the actual tier", () => {
    const { parsed } = decisionChain(undefined, "priority");
    expect(parsed._wireModelOverride).toBe(VARIANT);
    expect(emittedFastWire(parsed, { model: BASE, service_tier: "flex" })).toEqual(["service-tier", "flex"]);
    expect(emittedFastWire(parsed, { model: BASE })).toEqual([null, null]);
  });

  test("an override alone cannot claim a model-variant wire without its observation", () => {
    const parsed = parsedFor();
    parsed._wireModelOverride = VARIANT;
    expect(emittedFastWire(parsed, { model: VARIANT, service_tier: "priority" }))
      .toEqual(["service-tier", "priority"]);
  });
});

describe("Grok 4.7 Fast usage contracts", () => {
  test("JSON log round trip preserves model-variant outcomes on the row and its attempt", () => {
    const { tracker, logCtx } = fastMetadata(undefined, "priority");
    tracker.observeResponseServiceTier("priority");
    const outcome = structuredClone(tracker.outcome);
    const entry: PersistedUsageEntry = {
      requestId: "test-grok47-fast",
      timestamp: 1_800_000_000_000,
      provider: "xai",
      model: BASE,
      wireModel: logCtx.wireModel,
      status: 200,
      durationMs: 10,
      usageStatus: "reported",
      tierOutcome: outcome,
      attempts: [{
        ordinal: 1,
        provider: "xai",
        model: BASE,
        adapter: "openai-responses",
        credentialSource: "grok-oauth",
        status: 200,
        durationMs: 10,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "reported",
        usage: { inputTokens: 1_000, outputTokens: 100 },
        tierOutcome: outcome,
      }],
    };
    const normalized = normalizePersistedUsageRow(JSON.parse(JSON.stringify(entry)));
    expect(normalized).toBeDefined();
    expect(normalized?.model).toBe(BASE);
    expect(normalized?.wireModel).toBe(VARIANT);
    expect(normalized?.tierOutcome).toEqual(outcome);
    expect(normalized?.attempts).toHaveLength(1);
    expect(normalized?.attempts?.[0]?.model).toBe(BASE);
    expect(normalized?.attempts?.[0]?.tierOutcome).toEqual(outcome);
  });

  test("non-authoritative model-variant priority echo keeps base pricing while confirmed priority costs more", () => {
    const { tracker, obs, decision } = fastMetadata(undefined, "priority");
    tracker.observeResponseServiceTier("priority");
    expect(tracker.outcome).toMatchObject({
      canonical: "priority",
      wireKind: "model-variant",
      fastOutcome: "applied",
      confirmation: "assumed",
      responseTierAuthoritative: false,
      responseServiceTier: "priority",
    });
    const confirmed = createAdapterTierMetadata(obs, decision, "service-tier", "priority");
    if (!confirmed) throw new Error("service-tier control metadata missing");
    confirmed.observeResponseServiceTier("priority");
    expect(confirmed.outcome.confirmation).toBe("confirmed");
    const attempt = {
      ordinal: 1,
      provider: "xai",
      model: BASE,
      usageStatus: "reported" as const,
      usage: { inputTokens: 10_000, outputTokens: 1_000 },
    };
    // Disable user overlays explicitly so local operator pricing cannot alter the oracle.
    const base = estimateAttemptCost(attempt, undefined, undefined, []);
    const variant = estimateAttemptCost({ ...attempt, tierOutcome: tracker.outcome }, undefined, undefined, []);
    const priority = estimateAttemptCost({ ...attempt, tierOutcome: confirmed.outcome }, undefined, undefined, []);
    expect(base).not.toBeNull();
    expect(variant).not.toBeNull();
    expect(priority).not.toBeNull();
    if (!base || !variant || !priority) throw new Error("xAI Grok 4.7 price missing");
    expect(base.cost.total).toBeGreaterThan(0);
    expect(variant.cost).toEqual(base.cost);
    expect(variant.priorityMultiplier).toBeUndefined();
    expect(priority.cost.total).toBeGreaterThan(base.cost.total);
    expect(priority.priorityMultiplier).toBeGreaterThan(1);
  });
});

describe("Grok 4.7 Fast visibility and config boundaries", () => {
  test("the hidden variant set equals the OAuth model map values", () => {
    expect(XAI_OAUTH_FAST_MODELS).toEqual({ [BASE]: VARIANT });
    expect([...XAI_OAUTH_FAST_VARIANT_IDS].sort()).toEqual(Object.values(XAI_OAUTH_FAST_MODELS).sort());
    expect(xaiOauthFastModel("xai", { authMode: "oauth" }, BASE)).toBe(VARIANT);
    expect(xaiOauthFastModel("xai", { authMode: "key" }, BASE)).toBeUndefined();
    expect(xaiOauthFastModel("xai", {}, BASE)).toBeUndefined();
    expect(xaiOauthFastModel("cursor", { authMode: "oauth" }, BASE)).toBeUndefined();
    expect(xaiOauthFastModel("xai", { authMode: "oauth" }, VARIANT)).toBeUndefined();
    expect(xaiOauthFastModel("xai", { authMode: "oauth" }, "grok-4.6")).toBeUndefined();
  });

  test.each([
    { provider: "xai", model: VARIANT, visible: false },
    { provider: "xai", model: BASE, visible: true },
    { provider: "cursor", model: VARIANT, visible: true },
    { provider: "opencode-go", model: VARIANT, visible: true },
    { provider: "opencode-go", model: BASE, visible: true },
  ])("$provider/$model visibility is $visible", ({ provider, model, visible }) => {
    expect(shouldExposeProviderModel(provider, model)).toBe(visible);
  });

  test("user config rejects the internal-only model-variant FastWire kind", () => {
    const declaration = { canonicalToWire: { priority: "x" }, foreignCallerTiers: "drop" };
    expect(fastWireDeclarationError({ fastWire: { ...declaration, kind: "service-tier" } })).toBeNull();
    expect(fastWireDeclarationError({ fastWire: { ...declaration, kind: "model-variant" } }))
      .toBe("fastWire.kind must be service-tier, anthropic-speed, or cursor-variant");
  });
});


describe("adapters key policy on the logical id while serializing the lane id", () => {
  const oauthXai = (extra: Partial<OcxProviderConfig>): OcxProviderConfig => ({
    adapter: "openai-responses", baseUrl: XAI_GROK_CLI_BASE_URL, authMode: "oauth", ...extra,
  } as OcxProviderConfig);
  const fastParsed = (effort: string): OcxParsedRequest => {
    const parsed = parseRequest({ model: BASE, input: [{ role: "user", content: "OK" }], reasoning: { effort } });
    parsed.options.tierDecision = { kind: "drop" };
    parsed._wireModelOverride = VARIANT;
    (parsed._rawBody as Record<string, unknown>).model = VARIANT;
    return parsed;
  };
  const passthroughBody = (provider: OcxProviderConfig, parsed: OcxParsedRequest) =>
    JSON.parse(withTestTranslatorBudget(createResponsesPassthroughAdapter(provider)).buildRequest(parsed).body as string);
  const chatBody = async (provider: OcxProviderConfig, parsed: OcxParsedRequest) =>
    JSON.parse((await createOpenAIChatAdapter({ ...provider, adapter: "openai-chat", apiKey: "fake-oauth-access" }).buildRequest(parsed)).body as string);

  test("passthrough: a ladder declared only for grok-4.7 governs the Fast request", () => {
    const body = passthroughBody(oauthXai({ modelReasoningEfforts: { [BASE]: [] } }), fastParsed("high"));
    expect(body.model).toBe(VARIANT);
    expect(body).not.toHaveProperty("service_tier");
    expect(body.reasoning?.effort).toBeUndefined();
  });

  test("passthrough: a ladder declared only for the lane id is not consulted", () => {
    const body = passthroughBody(oauthXai({ modelReasoningEfforts: { [VARIANT]: [] } }), fastParsed("high"));
    expect(body.model).toBe(VARIANT);
    expect(body.reasoning?.effort).toBe("high");
  });

  test("openai-chat: an effort map keyed to grok-4.7 applies and the model line carries the lane id", async () => {
    const provider = oauthXai({
      modelReasoningEfforts: { [BASE]: ["low", "high"] },
      modelReasoningEffortMap: { [BASE]: { high: "low" } },
    });
    const body = await chatBody(provider, fastParsed("high"));
    expect(body.model).toBe(VARIANT);
    expect(body).not.toHaveProperty("service_tier");
    expect(body.reasoning_effort).toBe("low");
  });

  test("openai-chat: an effort map keyed only to the lane id is ignored", async () => {
    const provider = oauthXai({
      modelReasoningEfforts: { [BASE]: ["low", "high"] },
      modelReasoningEffortMap: { [VARIANT]: { high: "low" } },
    });
    const body = await chatBody(provider, fastParsed("high"));
    expect(body.model).toBe(VARIANT);
    expect(body.reasoning_effort).toBe("high");
  });
});
