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
import { PolicyCandidateUnavailableError, policyCandidateRefusalResponse } from "../../src/server/responses/policy-request-scope";
import { clearFallbackEventsForTests, recentFallbackEvents } from "../../src/routing/fallback-policy";
import type { OcxFallbackConfig } from "../../src/types/fallback";

function config(fallback?: OcxFallbackConfig, redirects?: Record<string, string>): OcxConfig {
  return {
    port: 0, defaultProvider: "provider-a",
    providers: Object.fromEntries(["a", "b"].map(id => ["provider-" + id, {
      adapter: "openai-chat", baseUrl: "https://" + id + ".example/v1", authMode: "key", apiKey: "fixture-key",
      models: ["model-" + id, "model-" + id + "2", "model-x"],
    }])),
    ...(fallback ? { fallback } : {}),
    ...(redirects ? { blockedModelRedirects: redirects } : {}),
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

type Candidate = { provider: string; model: string; score: number };

function traceOf(candidates: Candidate[]): RouteDecisionTraceV1 {
  return {
    ...trace(),
    candidates: candidates.map(c => ({ provider: c.provider, model: c.model, eligible: true, exclusions: [], score: { total: c.score, components: {} } })),
    selected: { candidateIndex: 0, provider: candidates[0]!.provider, model: candidates[0]!.model, reason: "highest-score" },
  };
}

/** Run with scripted core answers: each call takes the next one, and the last repeats. */
async function runScripted(cfg: OcxConfig, candidates: Candidate[], answers: Array<() => Response>): Promise<{ response: Response; models: string[] }> {
  const models: string[] = [];
  const response = await handleResponsesWithPolicyFallback(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "policy/daily", input: "hello", stream: false }),
  }), cfg, {} as RequestLogContext, {}, {
    runCore: async (req, _config, context, options) => {
      const body = await req.json() as { model: string };
      models.push(body.model);
      options.onRequestBodyParsed?.(body);
      context.routeDecision = traceOf(candidates);
      return answers[Math.min(models.length - 1, answers.length - 1)]!();
    },
  });
  return { response, models };
}

const overloaded = () => Response.json({ error: { message: "overloaded", type: "server_error" } }, { status: 503 });
const completed = () => Response.json({ status: "completed" });

describe("routing-profile hops are classified by resolved destination", () => {
  beforeEach(() => clearFallbackEventsForTests());

  test("a same-provider candidate redirected to another provider is a provider hop, and is refused", async () => {
    const { response, models } = await runScripted(
      config({ provider: false }, { "provider-a/model-x": "provider-b/model-b" }),
      [{ provider: "provider-a", model: "model-a", score: 0.9 }, { provider: "provider-a", model: "model-x", score: 0.85 }, { provider: "provider-b", model: "model-b", score: 0.1 }],
      [overloaded, completed],
    );
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { fallback: Record<string, string> } };
    expect(body.error.fallback).toMatchObject({ kind: "provider", from: "provider-a/model-a", to: "provider-b/model-b" });
    expect(models).toEqual(["policy/daily"]);
  });

  test("after a redirected hop, current is the redirected destination", async () => {
    // a/model-a -> a/model-x (really b/model-b) is a provider hop and allowed; the next hop leaves
    // provider-b for b/model-b2, a model hop that provider-b's own model switch refuses.
    const { response, models } = await runScripted(
      config({ providers: { "provider-b": { model: false } } }, { "provider-a/model-x": "provider-b/model-b" }),
      [{ provider: "provider-a", model: "model-a", score: 0.9 }, { provider: "provider-a", model: "model-x", score: 0.85 },
        { provider: "provider-b", model: "model-b2", score: 0.8 }, { provider: "provider-b", model: "model-b", score: 0.1 }],
      [overloaded, overloaded, completed],
    );
    expect(models).toEqual(["policy/daily", "provider-a/model-x"]);
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { fallback: Record<string, string> } };
    expect(body.error.fallback).toMatchObject({ kind: "model", scope: "provider", scopeKey: "provider-b", from: "provider-b/model-b", to: "provider-b/model-b2" });
  });

  test("a candidate the core skips locally is not recorded as a taken hop", async () => {
    const { response, models } = await runScripted(config(),
      [{ provider: "provider-a", model: "model-a", score: 0.9 }, { provider: "provider-b", model: "model-b", score: 0.8 }],
      [overloaded, () => policyCandidateRefusalResponse(new PolicyCandidateUnavailableError())!],
    );
    expect(models).toEqual(["policy/daily", "provider-b/model-b"]);
    expect(response.status).toBe(503);
    expect(recentFallbackEvents()).toEqual([]);
  });
});
