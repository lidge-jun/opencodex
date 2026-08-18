import { describe, expect, test } from "bun:test";
import type { AdapterRequest } from "../src/adapters/base";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import { buildBehaviorFingerprintV1 } from "../src/lab/subject/behavior-fingerprint";
import { sanitizeLogMetadataString } from "../src/lib/redact";
import {
  createAdapterTierMetadata,
  type ResolvedFastPolicy,
} from "../src/providers/fastwire";
import { resolveProductionBehaviorValues } from "../src/routing/compatibility/behavior";
import {
  addFinalRequestLog,
  applyResponseLogMetadata,
  beginRequestAttempt,
  inspectResponseLogJson,
  inspectResponseLogSsePayloadParsed,
  recordAdapterTier,
  type RequestLogContext,
  type RequestLogEntry,
} from "../src/server/request-log";
import { applyServiceTierGate } from "../src/server/responses/core";
import type { OcxConfig, OcxParsedRequest, TierObservationContext } from "../src/types";
import { estimateComboCost, serviceTierContextFromOutcome } from "../src/usage/cost";
import type { ExpectedPriceOverlay } from "../src/usage/expected-prices";
import { normalizeUsageEntryForTest } from "../src/usage/log";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const SERVICE_WIRE = {
  kind: "service-tier" as const,
  canonicalToWire: { priority: "priority" },
  foreignCallerTiers: "verbatim" as const,
};

function observation(
  overrides: Partial<TierObservationContext> = {},
): TierObservationContext {
  return {
    capability: true,
    eligibility: "eligible",
    fastWire: SERVICE_WIRE,
    demandDecision: "force-fast",
    ...overrides,
  };
}

describe("FastWire attempt outcomes", () => {
  test("force-default suppresses caller Fast without classifying a downgrade", () => {
    const tracker = createAdapterTierMetadata(
      observation({ demandDecision: "force-default", callerTier: "priority" }),
      { kind: "drop" },
      null,
      null,
    );
    expect(tracker?.outcome).toEqual({
      wireKind: null,
      wireValue: null,
      fastOutcome: "not-requested",
      callerFastSuppressedByConfig: true,
      confirmation: "unknown",
    });
  });

  test("unclassified passthrough stays unknown and ignores Fast config", () => {
    const tracker = createAdapterTierMetadata(
      observation({
        capability: undefined,
        eligibility: "unclassified",
        demandDecision: "force-default",
        callerTier: "priority",
      }),
      { kind: "forward-caller" },
      "service-tier",
      "priority",
    );
    expect(tracker?.outcome).toEqual({
      wireKind: "service-tier",
      wireValue: "priority",
      fastOutcome: "unknown",
      confirmation: "unknown",
    });
  });

  test.each([
    {
      label: "route unsupported",
      context: observation({ capability: false, eligibility: "capability-unsupported" }),
      reason: "route-unsupported",
    },
    {
      label: "wire unavailable",
      context: observation({ fastWire: null, eligibility: "wire-unavailable" }),
      reason: "wire-unavailable",
    },
  ] as const)("Fast demand records $label downgrade", ({ context, reason }) => {
    const tracker = createAdapterTierMetadata(context, { kind: "drop" }, null, null);
    expect(tracker?.outcome).toEqual({
      wireKind: null,
      wireValue: null,
      fastOutcome: "downgraded",
      fastDowngradeReason: reason,
      confirmation: "downgraded",
    });
  });

  test("foreign-tier drop records only callerTierDropped", () => {
    const tracker = createAdapterTierMetadata(
      observation({ demandDecision: "inherit", callerTier: "flex" }),
      { kind: "drop" },
      null,
      null,
    );
    expect(tracker?.outcome).toEqual({
      wireKind: null,
      wireValue: null,
      fastOutcome: "not-requested",
      callerTierDropped: true,
      confirmation: "unknown",
    });
  });

  test("confirmation covers assumed, confirmed, downgraded, and unknown", () => {
    const assumed = createAdapterTierMetadata(
      observation(),
      { kind: "set", value: "priority" },
      "service-tier",
      "priority",
    )!;
    expect(assumed.outcome).toMatchObject({
      canonical: "priority",
      fastOutcome: "applied",
      confirmation: "assumed",
    });

    const confirmed = createAdapterTierMetadata(
      observation({
        fastWire: { ...SERVICE_WIRE, canonicalToWire: { priority: "performance" } },
      }),
      { kind: "set", value: "performance" },
      "service-tier",
      "performance",
    )!;
    confirmed.observeResponseServiceTier("performance");
    expect(confirmed.outcome).toMatchObject({
      canonical: "priority",
      fastOutcome: "applied",
      confirmation: "confirmed",
      responseServiceTier: "performance",
    });
    expect(serviceTierContextFromOutcome(confirmed.outcome)).toEqual({
      responseServiceTier: "priority",
    });

    const declined = createAdapterTierMetadata(
      observation(),
      { kind: "set", value: "priority" },
      "service-tier",
      "priority",
    )!;
    declined.observeResponseServiceTier("default");
    expect(declined.outcome).toMatchObject({
      fastOutcome: "downgraded",
      fastDowngradeReason: "response-declined",
      confirmation: "downgraded",
      responseServiceTier: "default",
    });
    expect(declined.outcome.canonical).toBeUndefined();

    const unknown = createAdapterTierMetadata(
      observation(),
      { kind: "set", value: "priority" },
      "service-tier",
      "priority",
    )!;
    unknown.markResponseUnparseable();
    expect(unknown.outcome).toMatchObject({ fastOutcome: "unknown", confirmation: "unknown" });
    expect(unknown.outcome.canonical).toBeUndefined();
  });
});

describe("FastWire logging and persistence", () => {
  test("the serializing adapter returns metadata for the exact emitted tier", () => {
    const rawBody = { model: "gpt-5.6-sol", input: "ping", service_tier: "flex" };
    const parsed: OcxParsedRequest = {
      modelId: "gpt-5.6-sol",
      context: { messages: [] },
      stream: true,
      options: {
        serviceTier: "priority",
        tierDecision: { kind: "set", value: "priority" },
        tierObservation: observation({ callerTier: "flex" }),
      },
      _rawBody: rawBody,
    };
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://example.test/v1",
      authMode: "key",
      apiKey: "sk-test",
    }));
    const request = adapter.buildRequest(parsed) as AdapterRequest;

    expect(JSON.parse(request.body).service_tier).toBe("priority");
    expect(request.tierLog?.outcome).toMatchObject({
      canonical: "priority",
      wireKind: "service-tier",
      wireValue: "priority",
      fastOutcome: "applied",
      confirmation: "assumed",
    });
    expect(parsed._rawBody).toBe(rawBody);
    expect(rawBody.service_tier).toBe("flex");
  });

  test("adapter metadata lands on its attempt and final-attempt summary", () => {
    const tracker = createAdapterTierMetadata(
      observation(),
      { kind: "set", value: "priority" },
      "service-tier",
      "priority",
    )!;
    const attempt = beginRequestAttempt(1, "openai", "gpt-5.6-sol", "openai-responses");
    const logCtx: RequestLogContext = {
      model: "gpt-5.6-sol",
      provider: "openai",
      activeAttempt: attempt,
      activeAttemptStartedAt: Date.now(),
      attempts: [attempt],
    };
    recordAdapterTier(logCtx, {
      url: "https://example.test/v1/responses",
      method: "POST",
      headers: {},
      body: "{}",
      tierLog: tracker,
    } satisfies AdapterRequest);
    applyResponseLogMetadata(logCtx, { response: { service_tier: "priority" } });

    let logged: RequestLogEntry | undefined;
    addFinalRequestLog("ocx-tier", Date.now(), logCtx, 200, undefined, entry => {
      logged = entry;
    });
    expect(logged?.attempts?.[0]?.tierOutcome).toMatchObject({
      fastOutcome: "applied",
      confirmation: "confirmed",
      responseServiceTier: "priority",
    });
    expect(logged?.tierOutcome).toEqual(logged?.attempts?.[0]?.tierOutcome);
  });

  test.each([
    {
      label: "JSON",
      inspect: (logCtx: RequestLogContext) => inspectResponseLogJson(logCtx, "not-json"),
    },
    {
      label: "SSE",
      inspect: (logCtx: RequestLogContext) => {
        inspectResponseLogSsePayloadParsed(logCtx, "not-json", undefined);
      },
    },
  ])("$label inspection marks an unparseable response outcome unknown", ({ inspect }) => {
    const tracker = createAdapterTierMetadata(
      observation(),
      { kind: "set", value: "priority" },
      "service-tier",
      "priority",
    )!;
    const attempt = beginRequestAttempt(1, "openai", "gpt-5.6-sol", "openai-responses");
    const logCtx: RequestLogContext = {
      model: "gpt-5.6-sol",
      provider: "openai",
      activeAttempt: attempt,
      activeAttemptStartedAt: Date.now(),
      attempts: [attempt],
    };
    recordAdapterTier(logCtx, {
      url: "https://example.test/v1/responses",
      method: "POST",
      headers: {},
      body: "{}",
      tierLog: tracker,
    } satisfies AdapterRequest);
    expect(attempt.tierOutcome).toMatchObject({
      canonical: "priority",
      fastOutcome: "applied",
      confirmation: "assumed",
    });

    inspect(logCtx);

    expect(attempt.tierOutcome).toMatchObject({
      fastOutcome: "unknown",
      confirmation: "unknown",
    });
    expect(attempt.tierOutcome).not.toHaveProperty("canonical");
  });

  test("old attempts remain valid and new outcomes survive normalization", () => {
    const oldAttempt = {
      ordinal: 1,
      provider: "openai",
      model: "gpt-5.6-sol",
      adapter: "openai-responses",
      status: 200,
      durationMs: 1,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "reported" as const,
      usage: { inputTokens: 10, outputTokens: 1 },
    };
    const normalized = normalizeUsageEntryForTest({
      requestId: "ocx-old",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.6-sol",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      attempts: [oldAttempt, {
        ...oldAttempt,
        ordinal: 2,
        tierOutcome: {
          canonical: "priority",
          wireKind: "service-tier",
          wireValue: "priority",
          fastOutcome: "applied",
          confirmation: "assumed",
        },
      }],
    });
    expect(normalized.attempts?.[0]).not.toHaveProperty("tierOutcome");
    expect(normalized.attempts?.[1]?.tierOutcome).toMatchObject({
      canonical: "priority",
      fastOutcome: "applied",
      confirmation: "assumed",
    });
  });

  test("callerServiceTier is trimmed, control-filtered, redacted, and capped", () => {
    const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    const sanitized = sanitizeLogMetadataString(
      ` \u0000authorization: Bearer ${secret}\n\u0085\u2028\u2029${"x".repeat(80)} `,
    );
    expect(sanitized).not.toContain(secret);
    expect(sanitized).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(sanitized?.length).toBeLessThanOrEqual(64);

    const normalized = normalizeUsageEntryForTest({
      requestId: "ocx-caller-tier",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.6-sol",
      callerServiceTier: `  priority\n${"y".repeat(100)}  `,
      status: 200,
      durationMs: 1,
      usageStatus: "unreported",
    });
    expect(normalized.callerServiceTier).toBe(`priority${"y".repeat(56)}`);
  });

  test("upstream service tiers are sanitized before live and durable logging", () => {
    const secret = ["sk", "proj", "upstream", "A".repeat(40)].join("-");
    const rawTier = ` authorization: Bearer ${secret}\n\u0085\u2028\u2029${"x".repeat(80)} `;
    const expected = sanitizeLogMetadataString(rawTier)!;
    const tracker = createAdapterTierMetadata(
      observation({ capability: undefined, eligibility: "unclassified" }),
      { kind: "forward-caller" },
      "service-tier",
      "priority",
    )!;
    const attempt = beginRequestAttempt(1, "openai", "gpt-5.6-sol", "openai-responses");
    const logCtx: RequestLogContext = {
      model: "gpt-5.6-sol",
      provider: "openai",
      activeAttempt: attempt,
      activeAttemptStartedAt: Date.now(),
      attempts: [attempt],
    };
    recordAdapterTier(logCtx, {
      url: "https://example.test/v1/responses",
      method: "POST",
      headers: {},
      body: "{}",
      tierLog: tracker,
    } satisfies AdapterRequest);

    applyResponseLogMetadata(logCtx, { response: { service_tier: rawTier } });
    expect(logCtx.responseServiceTier).toBe(expected);
    expect(attempt.tierOutcome?.responseServiceTier).toBe(expected);

    const normalized = normalizeUsageEntryForTest({
      requestId: "ocx-upstream-tier",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.6-sol",
      responseServiceTier: rawTier,
      tierOutcome: {
        wireKind: "service-tier",
        wireValue: "priority",
        fastOutcome: "unknown",
        confirmation: "unknown",
        responseServiceTier: rawTier,
      },
      status: 200,
      durationMs: 1,
      usageStatus: "unreported",
    });
    expect(normalized.responseServiceTier).toBe(expected);
    expect(normalized.tierOutcome?.responseServiceTier).toBe(expected);
  });
});

describe("FastWire per-attempt cost", () => {
  const overlays: ExpectedPriceOverlay[] = [{
    provider: "openai",
    modelId: "gpt-5.6-sol",
    cost4: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    source: "test",
    verifiedAt: "2026-08-17",
    status: "verified",
  }];
  const usage = { inputTokens: 200_000, outputTokens: 20_000 };

  test("an unknown unclassified outcome prices from the serialized caller tier", () => {
    const outcome = {
      wireKind: "service-tier" as const,
      wireValue: "priority",
      fastOutcome: "unknown" as const,
      confirmation: "unknown" as const,
    };
    expect(serviceTierContextFromOutcome(outcome)).toEqual({
      requestedServiceTier: "priority",
    });

    const estimate = estimateComboCost([
      {
        ordinal: 1,
        provider: "openai",
        model: "gpt-5.6-sol",
        usageStatus: "reported",
        usage,
        tierOutcome: outcome,
      },
    ], overlays, { requestedServiceTier: "priority" })!;
    expect(estimate.priorityMultiplier).toBe(2);
    expect(estimate.cost.total).toBeCloseTo(3.2, 9);
  });

  test("combo prices each attempt from its own outcome before the top-level tier", () => {
    const attempts = [
      {
        ordinal: 1,
        provider: "openai",
        model: "gpt-5.6-sol",
        usageStatus: "reported" as const,
        usage,
        tierOutcome: {
          canonical: "priority" as const,
          wireKind: "service-tier" as const,
          wireValue: "priority",
          fastOutcome: "applied" as const,
          confirmation: "confirmed" as const,
          responseServiceTier: "priority",
        },
      },
      {
        ordinal: 2,
        provider: "openai",
        model: "gpt-5.6-sol",
        usageStatus: "reported" as const,
        usage,
        tierOutcome: {
          wireKind: "service-tier" as const,
          wireValue: "priority",
          fastOutcome: "downgraded" as const,
          fastDowngradeReason: "response-declined" as const,
          confirmation: "downgraded" as const,
          responseServiceTier: "default",
        },
      },
    ];
    const estimate = estimateComboCost(
      attempts,
      overlays,
      { requestedServiceTier: "priority" },
    )!;
    expect(estimate.attempts?.[0]?.cost.total).toBeCloseTo(3.2, 9);
    expect(estimate.attempts?.[1]?.cost.total).toBeCloseTo(1.6, 9);
    expect(estimate.cost.total).toBeCloseTo(4.8, 9);
    expect(estimate.cost.total).not.toBeCloseTo(6.4, 9);
  });

  test("old attempts without outcomes retain the top-level fallback", () => {
    const estimate = estimateComboCost([
      { ordinal: 1, provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage },
      { ordinal: 2, provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported", usage },
    ], overlays, { requestedServiceTier: "priority" })!;
    expect(estimate.cost.total).toBeCloseTo(6.4, 9);
    expect(estimate.attempts?.every(attempt => attempt.priorityMultiplier === 2)).toBe(true);
  });
});

describe("FastWire gate and compatibility fingerprint", () => {
  test("foreignCallerTiers is value-aware while unclassified passthrough stays unchanged", () => {
    const dropPolicy: ResolvedFastPolicy = {
      capability: true,
      eligibility: "eligible",
      adapter: "openai-responses",
      fastWire: { ...SERVICE_WIRE, foreignCallerTiers: "drop" },
      forwardCallerTier: true,
    };
    const droppedBody: Record<string, unknown> = { service_tier: "flex" };
    const droppedOptions = { serviceTier: "flex" };
    applyServiceTierGate(
      { adapter: "openai-responses", baseUrl: "https://example.test", supportsServiceTier: true },
      droppedBody,
      droppedOptions,
      "model",
      "fixture",
      "responses",
      dropPolicy,
    );
    expect(droppedBody).not.toHaveProperty("service_tier");
    expect(droppedOptions.serviceTier).toBeUndefined();

    const unknownPolicy: ResolvedFastPolicy = { ...dropPolicy, capability: undefined, eligibility: "unclassified" };
    const passthroughBody = { service_tier: "flex" };
    const passthroughOptions = { serviceTier: "flex" };
    applyServiceTierGate(
      { adapter: "openai-responses", baseUrl: "https://example.test" },
      passthroughBody,
      passthroughOptions,
      "model",
      "fixture",
      "responses",
      unknownPolicy,
    );
    expect(passthroughBody.service_tier).toBe("flex");
    expect(passthroughOptions.serviceTier).toBe("flex");
  });

  test("Fast wire projections change the digest without changing serviceTier projection", () => {
    const config = {
      port: 10100,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://example.test/v1",
          supportsServiceTier: true,
        },
      },
    } as OcxConfig;
    const base = resolveProductionBehaviorValues(
      config,
      "fixture",
      "model",
      config.providers.fixture!,
      "salt",
    )!;
    const performanceProvider = {
      ...config.providers.fixture!,
      fastWire: { ...SERVICE_WIRE, canonicalToWire: { priority: "performance" } },
    };
    const performance = resolveProductionBehaviorValues(
      { ...config, providers: { fixture: performanceProvider } },
      "fixture",
      "model",
      performanceProvider,
      "salt",
    )!;

    expect(base["responses.serviceTier"]).toEqual(performance["responses.serviceTier"]);
    expect(base["responses.fastWireKind"]?.value).toBe("service-tier");
    expect(base["responses.fastWireValue"]?.value).toBe("priority");
    expect(performance["responses.fastWireValue"]?.value).toBe("performance");
    expect(buildBehaviorFingerprintV1(base)).not.toBe(buildBehaviorFingerprintV1(performance));
  });
});
