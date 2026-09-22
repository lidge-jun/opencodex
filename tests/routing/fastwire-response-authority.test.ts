import { afterEach, describe, expect, test } from "bun:test";
import { modelTitle } from "../../gui/src/pages/logs-model-title";
import { validateConfigCandidate } from "../../src/config";
import { createAdapterTierMetadata } from "../../src/providers/fastwire";
import { responseTierAuthorityForProvider } from "../../src/providers/openai-tiers-destination";
import { parseProviderEditorConfigDTO, providerEditorConfigDTO } from "../../src/server/auth-cors";
import { addFinalRequestLog, type RequestLogContext, type RequestLogEntry } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { estimateComboCost, serviceTierContextFromOutcome } from "../../src/usage/cost";
import { normalizeUsageEntryForTest } from "../../src/usage/log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
});

const gateway: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://relay.example.test/v1",
  authMode: "key",
  apiKey: "sk-test",
  supportsServiceTier: true,
};

function config(provider: OcxProviderConfig): OcxConfig {
  return { port: 0, defaultProvider: "relay", providers: { relay: provider } };
}

async function drive(provider: OcxProviderConfig, stream: boolean, responseTier: unknown) {
  const sent: Record<string, unknown>[] = [];
  const upstream = {
    id: "resp_tier", object: "response", status: "completed", model: "gpt-5.6-sol",
    output: [], usage: { input_tokens: 10, output_tokens: 2 },
    ...(responseTier === undefined ? {} : { service_tier: responseTier }),
  };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(stream
      ? `data: ${JSON.stringify({ type: "response.completed", response: upstream })}\n\ndata: [DONE]\n\n`
      : JSON.stringify(upstream), {
      headers: { "content-type": stream ? "text/event-stream" : "application/json" },
    });
  }) as typeof fetch;
  releaseSpendHome = acquireOwnedSpendHome();
  const log: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "relay/gpt-5.6-sol", input: "ping", stream, service_tier: "priority",
    }),
  }), config(provider), log, {});
  const downstream = await response.text();
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.service_tier).toBe("priority");
  expect(sent[0]).not.toHaveProperty("responseTierAuthoritative");
  if (typeof responseTier === "string") {
    expect(downstream).toContain(`"service_tier":"${responseTier}"`);
  }
  return log;
}

describe("response-tier authority on the final Responses route", () => {
  const routes = [
    { name: "declared relay", provider: { ...gateway, responseTierAuthoritative: false }, authoritative: false },
    { name: "unconfigured relay", provider: gateway, authoritative: true },
    { name: "explicitly authoritative relay", provider: { ...gateway, responseTierAuthoritative: true }, authoritative: true },
    { name: "official API", provider: { ...gateway, baseUrl: "https://api.openai.com/v1" }, authoritative: true },
    { name: "direct Codex under a custom name", provider: {
      ...gateway, baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const,
    }, authoritative: false },
  ];
  for (const { name, provider, authoritative } of routes) {
    test.each([true, false])(`${name}, stream=%s preserves wire and distinguishes evidence`, async stream => {
      const log = await drive(provider, stream, "default");
      expect(log.responseServiceTier).toBe("default");
      expect(log.activeAttempt?.tierOutcome).toMatchObject({
        wireKind: "service-tier", wireValue: "priority", responseServiceTier: "default",
        fastOutcome: authoritative ? "downgraded" : "applied",
        confirmation: authoritative ? "downgraded" : "assumed",
      });
      if (authoritative) {
        expect(log.activeAttempt?.tierOutcome?.fastDowngradeReason).toBe("response-declined");
      } else {
        expect(log.activeAttempt?.tierOutcome?.fastDowngradeReason).toBeUndefined();
        expect(log.activeAttempt?.tierOutcome?.responseTierAuthoritative).toBe(false);
      }
    });
  }

  test.each(["priority", undefined, null])("non-authoritative echo %s cannot confirm Fast", async tier => {
    const log = await drive({ ...gateway, responseTierAuthoritative: false }, true, tier);
    expect(log.activeAttempt?.tierOutcome).toMatchObject({
      canonical: "priority", fastOutcome: "applied", confirmation: "assumed",
      responseTierAuthoritative: false,
    });
    expect(log.activeAttempt?.tierOutcome?.fastDowngradeReason).toBeUndefined();
  });

  test("official priority remains confirmed", async () => {
    const log = await drive({ ...gateway, baseUrl: "https://api.openai.com/v1" }, false, "priority");
    expect(log.activeAttempt?.tierOutcome?.confirmation).toBe("confirmed");
  });

  test("authority and raw echo survive live logs, persistence and tooltip rendering", async () => {
    const log = await drive({ ...gateway, responseTierAuthoritative: false }, false, "default");
    let entry: RequestLogEntry | undefined;
    addFinalRequestLog("ocx-tier-authority", Date.now(), log, 200, undefined, value => { entry = value; });
    const restored = normalizeUsageEntryForTest(JSON.parse(JSON.stringify(entry)));
    expect(restored.tierOutcome).toEqual(log.activeAttempt?.tierOutcome);
    expect(restored.attempts?.[0]?.tierOutcome).toEqual(restored.tierOutcome);
    expect(restored.tierOutcome?.responseTierAuthoritative).toBe(false);
    expect(restored.responseServiceTier).toBe("default");
    const title = modelTitle(restored, ((key: string) => key.split(".").pop()!) as never);
    expect(title).toContain("requestedTier=priority");
    expect(title).toContain("responseTier=default (assumed)");
    expect(title).not.toContain("confirmed");
    expect(title).not.toContain("downgraded");
  });
});

describe("response-tier authority configuration", () => {
  test("canonical Codex stays non-authoritative, while an undeclared forward relay keeps legacy authority", () => {
    expect(responseTierAuthorityForProvider({ ...gateway, authMode: "forward" })).toBeUndefined();
    expect(responseTierAuthorityForProvider({
      ...gateway, authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex/",
      responseTierAuthoritative: true,
    })).toBe(false);
  });

  test.each([true, false])("retains boolean declaration %s", responseTierAuthoritative => {
    const result = validateConfigCandidate(config({ ...gateway, responseTierAuthoritative }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.providers.relay?.responseTierAuthoritative).toBe(responseTierAuthoritative);
  });

  test("the provider editor round-trips the declaration without exposing credentials", () => {
    const dto = providerEditorConfigDTO(config({ ...gateway, responseTierAuthoritative: false }));
    expect(dto.providers.relay?.responseTierAuthoritative).toBe(false);
    expect(dto.providers.relay).not.toHaveProperty("apiKey");
    expect(parseProviderEditorConfigDTO(dto)).toMatchObject({
      ok: true, value: { providers: { relay: { responseTierAuthoritative: false } } },
    });
  });

  test.each(["false", 0, null, {}])("rejects malformed declaration %j", value => {
    expect(validateConfigCandidate(config({ ...gateway, responseTierAuthoritative: value } as OcxProviderConfig)).ok)
      .toBe(false);
  });
});

describe("non-authoritative tier cost provenance", () => {
  test("the declaration cannot hide a local unsupported-route downgrade", () => {
    const tracker = createAdapterTierMetadata({
      capability: false, eligibility: "capability-unsupported", demandDecision: "inherit",
      callerTier: "priority", fastWire: null, responseTierAuthoritative: false,
    }, { kind: "drop" }, null, null)!;
    tracker.observeResponseServiceTier("priority");
    expect(tracker.outcome).toMatchObject({
      fastOutcome: "downgraded", confirmation: "downgraded", fastDowngradeReason: "route-unsupported",
      responseServiceTier: "priority", responseTierAuthoritative: false,
    });
    expect(serviceTierContextFromOutcome(tracker.outcome)).toEqual({});
  });

  test.each(["default", "priority"])("echo %s remains observational through pricing", responseTier => {
    const tracker = createAdapterTierMetadata({
      capability: true, eligibility: "eligible", demandDecision: "inherit", callerTier: "priority",
      fastWire: { kind: "service-tier", canonicalToWire: { priority: "priority" }, foreignCallerTiers: "verbatim" },
      responseTierAuthoritative: false,
    }, { kind: "set", value: "priority" }, "service-tier", "priority")!;
    tracker.observeResponseServiceTier(responseTier);
    expect(serviceTierContextFromOutcome(tracker.outcome)).toEqual({ requestedServiceTier: "priority" });
    const estimate = estimateComboCost([{
      ordinal: 1, provider: "openai", model: "gpt-5.6-sol", usageStatus: "reported",
      usage: { inputTokens: 200_000, outputTokens: 20_000 }, tierOutcome: tracker.outcome,
    }], [{
      provider: "openai", modelId: "gpt-5.6-sol",
      cost4: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      source: "test", verifiedAt: "2026-08-17", status: "verified",
    }])!;
    expect(estimate.priorityMultiplier).toBe(2);
    expect(estimate.cost.total).toBeCloseTo(3.2, 9);
    expect(tracker.outcome.confirmation).toBe("assumed");
    expect(tracker.outcome.responseServiceTier).toBe(responseTier);
  });
});
