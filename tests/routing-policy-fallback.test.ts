import { describe, expect, test } from "bun:test";

import { formatErrorResponse } from "../src/bridge";
import { RequestPacingQueueOverloadError } from "../src/providers/request-pacing";
import type { OcxConfig } from "../src/types";
import { beginRequestAttempt, type RequestLogContext } from "../src/server/request-log";
import type { RouteDecisionTraceV1 } from "../src/routing/trace";
import {
  handleResponsesWithPolicyFallback,
  rankPolicyFallbackCandidates,
} from "../src/server/responses/policy-fallback";

function policyTrace(): RouteDecisionTraceV1 {
  return {
    version: 1,
    decisionId: "decision-1",
    createdAt: 1,
    requestedModel: "policy/daily",
    routeKind: "policy",
    profile: { id: "daily", revision: "rev-1" },
    requirements: [],
    candidates: [
      { provider: "provider-a", model: "model-a", eligible: true, exclusions: [], score: { total: 0.90, components: {} } },
      { provider: "provider-b", model: "model-b", eligible: true, exclusions: [], score: { total: 0.80, components: {} } },
      { provider: "provider-c", model: "model-c", eligible: true, exclusions: [], score: { total: 0.80, components: {} } },
      { provider: "provider-d", model: "model-d", eligible: false, exclusions: [{ code: "tools" }], score: { total: 1, components: {} } },
    ],
    selected: { candidateIndex: 0, provider: "provider-a", model: "model-a", reason: "highest-score" },
  };
}

function request(signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "policy/daily", input: "hello", stream: false }),
    signal,
  });
}

function seedAttempt(logCtx: RequestLogContext, provider: string, model: string): void {
  if (logCtx.activeAttempt) return;
  const attempt = beginRequestAttempt((logCtx.attempts?.length ?? 0) + 1, provider, model, "test");
  (logCtx.attempts ??= []).push(attempt);
  logCtx.activeAttempt = attempt;
  logCtx.activeAttemptStartedAt = Date.now();
}

describe("policy candidate fallback", () => {
  test("ranks only eligible untried candidates by score and stable original order", () => {
    const ranked = rankPolicyFallbackCandidates(policyTrace(), new Set(["provider-a\u0000model-a"]));
    expect(ranked.map(candidate => `${candidate.provider}/${candidate.model}`)).toEqual([
      "provider-b/model-b",
      "provider-c/model-c",
    ]);
  });

  test("a local input-admission refusal hops instead of ending the chain (#1524)", async () => {
    // #1524: a candidate whose context window cannot fit the request used to TERMINATE the
    // fallback chain. It is a local preflight verdict about ONE candidate, not about the
    // request, so the next candidate -- which may have a larger window -- must still be tried.
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const runCore = async (req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      const body = await req.clone().json() as { model?: string };
      seenModels.push(String(body.model));
      ctx.routeDecision = trace;
      seedAttempt(ctx, "provider", String(body.model));
      if (seenModels.length === 1) {
        // Built by the PRODUCTION emitter, not by hand. A hand-written envelope hid the real
        // defect: formatErrorResponse runs classifyError, whose "context window" remap rewrote
        // our own code to context_length_exceeded, so the shape the proxy actually ships never
        // carried the marker the hop rule looks for.
        return formatErrorResponse(
          413,
          "input_admission_refused",
          "Estimated input (~500000 tokens) is far past the context window of test-model (100000 tokens)."
            + " Start a new session or choose a model with a larger context window.",
        );
      }
      return Response.json({ id: "resp", object: "response", status: "completed", output: [] });
    };

    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, { runCore });

    expect(response.status).toBe(200);
    expect(seenModels).toEqual(["policy/daily", "provider-b/model-b"]);
  });

  test("an upstream body that merely echoes the marker does not hop (#1524)", async () => {
    // The refusal is ours and always carries the structured code, so the decision keys on that
    // alone. Error text is provider-controlled and crosses a trust boundary: matching on it
    // would let any upstream override a terminal verdict by mentioning the token.
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const runCore = async (req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      const body = await req.clone().json() as { model?: string };
      seenModels.push(String(body.model));
      ctx.routeDecision = trace;
      seedAttempt(ctx, "provider", String(body.model));
      return Response.json(
        { error: { message: "upstream says: input_admission_refused is not a thing here", type: "invalid_request_error", code: "invalid_request_error" } },
        { status: 400 },
      );
    };

    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, { runCore });

    expect(response.status).toBe(400);
    expect(seenModels).toEqual(["policy/daily"]);
  });
  test("an upstream context_length_exceeded still stops the chain (#1524)", async () => {
    // The mirror-image contract. An upstream verdict is about the REQUEST, so retrying it
    // elsewhere is guesswork -- and hopping would burn every candidate on a doomed request.
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const runCore = async (req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      const body = await req.clone().json() as { model?: string };
      seenModels.push(String(body.model));
      ctx.routeDecision = trace;
      seedAttempt(ctx, "provider", String(body.model));
      return Response.json(
        { error: { message: "context length exceeded", type: "invalid_request_error", code: "context_length_exceeded" } },
        { status: 400 },
      );
    };

    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, { runCore });

    expect(response.status).toBe(400);
    expect(seenModels).toEqual(["policy/daily"]);
  });
  test("retries the next policy candidate and keeps distinct physical attempts", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const seenTerminalCodes: Array<string | undefined> = [];
    let bodyAcceptedCount = 0;

    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {
      onRequestBodyRead: () => {
        bodyAcceptedCount += 1;
      },
    }, {
      runCore: async (req, _config, childLog, options) => {
        options.onRequestBodyRead?.();
        const body = await req.json() as { model: string };
        seenModels.push(body.model);
        seenTerminalCodes.push(childLog.terminalErrorCode);
        const first = seenModels.length === 1;
        seedAttempt(childLog, first ? "provider-a" : "provider-b", first ? "model-a" : "model-b");
        if (first) {
          childLog.requestedModel = "policy/daily";
          childLog.routeDecision = trace;
          childLog.terminalErrorCode = "cyber_policy";
          return new Response(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        childLog.requestedModel = body.model;
        childLog.routeDecision = { ...trace, requestedModel: body.model, routeKind: "explicit-provider", profile: undefined };
        return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
      },
    });

    expect(response.status).toBe(200);
    expect(bodyAcceptedCount).toBe(1);
    expect(seenModels).toEqual(["policy/daily", "provider-b/model-b"]);
    expect(seenTerminalCodes).toEqual([undefined, undefined]);
    expect(logCtx.requestedModel).toBe("policy/daily");
    expect(logCtx.routeDecision).toBe(trace);
    expect(logCtx.attempts).toHaveLength(2);
    expect(logCtx.attempts?.[0]).toMatchObject({ provider: "provider-a", model: "model-a", status: 429 });
    expect(logCtx.attempts?.[1]).toMatchObject({ provider: "provider-b", model: "model-b" });
    expect(logCtx.activeAttempt).toBe(logCtx.attempts?.[1]);
  });

  test("returns local pacing overload without switching policy candidates", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, {
      runCore: async () => {
        calls += 1;
        throw new RequestPacingQueueOverloadError("provider-a", "queue_full", 2);
      },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(calls).toBe(1);
  });

  test("does not switch candidates for terminal client/input failures", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, {
      runCore: async (_req, _config, childLog) => {
        calls += 1;
        childLog.requestedModel = "policy/daily";
        childLog.routeDecision = trace;
        return new Response(JSON.stringify({ error: { message: "invalid request", type: "invalid_request_error" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });

  test("does not switch candidates after client cancellation", async () => {
    const trace = policyTrace();
    const controller = new AbortController();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const response = await handleResponsesWithPolicyFallback(request(controller.signal), {} as OcxConfig, logCtx, {}, {
      runCore: async (_req, _config, childLog) => {
        calls += 1;
        childLog.routeDecision = trace;
        controller.abort();
        return new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 });
      },
    });
    expect(response.status).toBe(429);
    expect(calls).toBe(1);
  });

  test("does not switch candidates after a streaming response has started", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const body = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\ndata: {\"type\":\"response.failed\"}\n\n";
    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, {
      runCore: async (_req, _config, childLog) => {
        calls += 1;
        childLog.routeDecision = trace;
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hello");
    expect(calls).toBe(1);
  });
});
