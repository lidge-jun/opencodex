import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { isAnthropicFastRefusal } from "../../../src/providers/anthropic-fast";
import { enrichProviderFromRegistry } from "../../../src/providers/derive";
import { getProviderRegistryEntry } from "../../../src/providers/registry";
import { fastPolicyForModel } from "../../../src/providers/service-tier";
import { tierObservationContext } from "../../../src/providers/fastwire";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";

const FAST_BETA = "fast-mode-2026-02-01";

function provider(authMode: "key" | "oauth" = "key", overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  const result: OcxProviderConfig = {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "test-token",
    authMode,
    // Anthropic Fast is opt-in (anthropic-fast-opt-in.test.ts); these cases exercise the enabled lane.
    fastEnabled: true,
    ...overrides,
  };
  enrichProviderFromRegistry(authMode === "oauth" ? "anthropic" : "anthropic-apikey", result);
  return result;
}

function parsed(configured: OcxProviderConfig, decision: "set" | "drop" | "none" = "set"): OcxParsedRequest {
  const policy = fastPolicyForModel(configured, "claude-opus-5-5", configured.authMode === "oauth" ? "anthropic" : "anthropic-apikey");
  return {
    modelId: "claude-opus-5-5",
    stream: false,
    context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    options: {
      tierObservation: tierObservationContext(policy, true, undefined),
      ...(decision === "none" ? {} : { tierDecision: decision === "set" ? { kind: "set", value: "fast" } : { kind: "drop" } }),
    },
  } as OcxParsedRequest;
}

function betaHeaders(headers: Record<string, string>): string[] {
  return Object.keys(headers).filter(name => name.toLowerCase() === "anthropic-beta");
}

describe("Anthropic fast speed wire", () => {
  test("set emits speed and one fast beta while preserving OAuth betas", async () => {
    const configured = provider("oauth");
    const request = await withTestTranslatorBudget(createAnthropicAdapter(configured)).buildRequest(parsed(configured));
    expect(JSON.parse(String(request.body)).speed).toBe("fast");
    expect(betaHeaders(request.headers)).toEqual(["anthropic-beta"]);
    expect(request.headers["anthropic-beta"]).toContain(FAST_BETA);
    expect(request.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(request.tierLog?.outcome).toMatchObject({
      wireKind: "anthropic-speed", wireValue: "fast", fastOutcome: "applied", confirmation: "assumed",
    });
  });

  test.each(["drop", "none"] as const)("%s sends no speed or fast beta", async decision => {
    const configured = provider();
    const request = await withTestTranslatorBudget(createAnthropicAdapter(configured)).buildRequest(parsed(configured, decision));
    expect(JSON.parse(String(request.body)).speed).toBeUndefined();
    expect(request.headers["anthropic-beta"] ?? "").not.toContain(FAST_BETA);
  });

  test("case-insensitive override collapses beta headers and deduplicates tokens", async () => {
    const configured = provider("oauth", { headers: { "Anthropic-Beta": `x-custom,${FAST_BETA},x-custom` } });
    const request = await withTestTranslatorBudget(createAnthropicAdapter(configured)).buildRequest(parsed(configured));
    expect(betaHeaders(request.headers)).toEqual(["anthropic-beta"]);
    const betas = request.headers["anthropic-beta"]!.split(",");
    expect(betas.filter(beta => beta === FAST_BETA)).toHaveLength(1);
    expect(betas.filter(beta => beta === "x-custom")).toHaveLength(1);
    expect(betas.some(beta => beta.includes("oauth"))).toBe(true);
  });

  test.each([
    ["fast", "applied", "confirmed", undefined],
    ["standard", "downgraded", "downgraded", "response-declined"],
    [undefined, "applied", "assumed", undefined],
  ] as const)("stream usage.speed %s updates tier outcome", async (speed, fastOutcome, confirmation, reason) => {
    const configured = provider();
    const adapter = createAnthropicAdapter(configured);
    const request = await withTestTranslatorBudget(adapter).buildRequest(parsed(configured));
    const sse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0, ...(speed ? { speed } : {}) } } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
    for await (const _event of adapter.parseStream(new Response(sse), createTestTranslatorBudget(), request.tierLog)) { /* drain */ }
    expect(request.tierLog?.outcome).toMatchObject({ fastOutcome, confirmation });
    expect(request.tierLog?.outcome.fastDowngradeReason).toBe(reason);
  });

  test.each([
    ["fast", "applied", "confirmed", undefined],
    ["standard", "downgraded", "downgraded", "response-declined"],
    [undefined, "applied", "assumed", undefined],
  ] as const)("buffered usage.speed %s updates tier outcome", async (speed, fastOutcome, confirmation, reason) => {
    const configured = provider();
    const adapter = createAnthropicAdapter(configured);
    const request = await withTestTranslatorBudget(adapter).buildRequest(parsed(configured));
    await adapter.parseResponse!(Response.json({ content: [], usage: { input_tokens: 1, output_tokens: 1, ...(speed ? { speed } : {}) } }), createTestTranslatorBudget(), request.tierLog);
    expect(request.tierLog?.outcome).toMatchObject({ fastOutcome, confirmation });
    expect(request.tierLog?.outcome.fastDowngradeReason).toBe(reason);
  });

  test("declined fast wire records standard resend as response-declined", async () => {
    const configured = provider();
    const input = parsed(configured, "drop");
    input.options.tierObservation = { ...input.options.tierObservation!, upstreamDeclinedFast: true };
    const request = await withTestTranslatorBudget(createAnthropicAdapter(configured)).buildRequest(input);
    expect(request.tierLog?.outcome).toMatchObject({ wireValue: null, fastOutcome: "downgraded", fastDowngradeReason: "response-declined" });
  });
});

describe("Anthropic fast refusal recognition", () => {
  const error = (message: string) => JSON.stringify({ type: "error", error: { type: "rate_limit_error", message } });

  test.each([
    [429, "Usage credits are required for fast mode."],
    [400, "Fast mode is not enabled for your organization."],
    [400, "claude-sonnet-5 does not support the `speed` parameter."],
  ] as const)("recognizes %s %s", (status, message) => {
    expect(isAnthropicFastRefusal(status, new Headers(), error(message))).toBe(true);
  });

  test("fast output pool exhaustion is a refusal without body wording", () => {
    expect(isAnthropicFastRefusal(429, new Headers({ "anthropic-fast-output-tokens-remaining": "0" }), undefined)).toBe(true);
  });

  test.each([
    [429, "Number of request tokens has exceeded your per-minute rate limit"],
    [529, "Fast mode is overloaded"],
    [400, "Invalid model"],
  ] as const)("leaves unrelated %s error alone", (status, message) => {
    expect(isAnthropicFastRefusal(status, new Headers(), error(message))).toBe(false);
  });
});

describe("Anthropic fast registry", () => {
  test.each(["anthropic", "anthropic-apikey"])("%s declares only documented models", id => {
    const entry = getProviderRegistryEntry(id)!;
    expect(entry.fastWire).toMatchObject({ kind: "anthropic-speed", canonicalToWire: { priority: "fast" } });
    expect(entry.modelSupportsServiceTier).toEqual({
      "claude-opus-5-5": true, "claude-opus-5": true, "claude-opus-4-8": true,
    });
    const configured = provider(id === "anthropic" ? "oauth" : "key");
    expect(fastPolicyForModel(configured, "claude-opus-5-5", id)).toMatchObject({ capability: true, eligibility: "eligible" });
    for (const model of ["claude-opus-4-6", "claude-sonnet-5"]) {
      expect(fastPolicyForModel(configured, model, id)).toMatchObject({ eligibility: "unclassified" });
    }
  });
});
