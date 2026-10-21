/**
 * OCX-11 at the routing-profile candidate fallback (src/server/responses/policy-fallback.ts):
 * refused, the next candidate never runs and the failure status is kept; allowed, the next
 * candidate runs as before.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { OcxConfig } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";
import type { RouteDecisionTraceV1 } from "../../src/routing/trace";
import { handleResponsesWithPolicyFallback } from "../../src/server/responses/policy-fallback";
import { clearFallbackEventsForTests, recentFallbackEvents } from "../../src/routing/fallback-policy";
import type { OcxFallbackConfig } from "../../src/types/fallback";

function config(fallback?: OcxFallbackConfig): OcxConfig {
  return {
    port: 0, defaultProvider: "provider-a",
    providers: Object.fromEntries(["a", "b"].map(id => ["provider-" + id, {
      adapter: "openai-chat", baseUrl: "https://" + id + ".example/v1", authMode: "key", apiKey: "fixture-key", models: ["model-" + id],
    }])),
    ...(fallback ? { fallback } : {}),
  } as OcxConfig;
}

function trace(): RouteDecisionTraceV1 {
  return {
    version: 1, decisionId: "decision-1", createdAt: 1, requestedModel: "policy/daily", routeKind: "policy",
    profile: { id: "daily", revision: "rev-1" }, requirements: [],
    candidates: [
      { provider: "provider-a", model: "model-a", eligible: true, exclusions: [], score: { total: 0.9, components: {} } },
      { provider: "provider-b", model: "model-b", eligible: true, exclusions: [], score: { total: 0.8, components: {} } },
    ],
    selected: { candidateIndex: 0, provider: "provider-a", model: "model-a", reason: "highest-score" },
  };
}

async function run(fallback?: OcxFallbackConfig): Promise<{ response: Response; calls: number }> {
  let calls = 0;
  const response = await handleResponsesWithPolicyFallback(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "policy/daily", input: "hello", stream: false }),
  }), config(fallback), {} as RequestLogContext, {}, {
    runCore: async (req, _config, context, options) => {
      calls++;
      options.onRequestBodyParsed?.(await req.json());
      context.routeDecision = trace();
      return calls === 1
        ? Response.json({ error: { message: "overloaded", type: "server_error" } }, { status: 503, headers: { "retry-after": "5" } })
        : Response.json({ status: "completed" });
    },
  });
  return { response, calls };
}

describe("routing-profile fallback off", () => {
  beforeEach(() => clearFallbackEventsForTests());

  test("absent policy: the next candidate runs as before", async () => {
    const { response, calls } = await run();
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(recentFallbackEvents()).toMatchObject([{ site: "routing-profile", route: "policy/daily", outcome: "taken", trigger: "upstream_5xx" }]);
  });

  test("route off: refused with the failure status, and the next candidate never runs", async () => {
    const { response, calls } = await run({ routes: { "policy/daily": { provider: false } } });
    expect(calls).toBe(1);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    const body = await response.json() as { error: { code: string; fallback: Record<string, string> } };
    expect(body.error.code).toBe("fallback_refused");
    expect(body.error.fallback).toMatchObject({ scope: "route", scopeKey: "policy/daily", from: "provider-a/model-a", to: "provider-b/model-b" });
  });

  test("provider-scoped on beats global off", async () => {
    const { response, calls } = await run({ provider: false, providers: { "provider-a": { provider: true } } });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });
});
