import { describe, expect, test } from "bun:test";

import { formatErrorResponse } from "../../src/bridge";
import { RequestPacingQueueOverloadError } from "../../src/providers/request-pacing";
import { fetchWithTransientRetry, isNonReplayableResponse, markResponseNonReplayable } from "../../src/lib/upstream-retry";
import { shouldRetryCodexPoolAccountQuota } from "../../src/server/responses/core-codex-account";
import type { OcxConfig } from "../../src/types";
import { beginRequestAttempt, type RequestLogContext } from "../../src/server/request-log";
import type { RouteDecisionTraceV1 } from "../../src/routing/trace";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { parseSyntheticRowId } from "../../src/server/fast-row";
import {
  handleResponsesWithPolicyFallback,
  rankPolicyFallbackCandidates,
  type PolicyFallbackDeps,
} from "../../src/server/responses/policy-fallback";

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
  test("a marked context overflow never tries another policy route", async () => {
    const failure = Response.json({ error: {
      type: "invalid_request_error", code: "context_length_exceeded", message: "Context window exceeded",
    } }, { status: 400 });
    markResponseNonReplayable(failure);
    let coreCalls = 0;
    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, {} as RequestLogContext, {}, {
      runCore: async (req, _config, context, options) => {
        coreCalls += 1;
        options.onRequestBodyParsed?.(await req.json());
        context.routeDecision = policyTrace();
        return coreCalls === 1 ? failure : Response.json({ status: "completed" });
      },
    });

    expect(coreCalls).toBe(1);
    expect(response).toBe(failure);
    expect(response.status).toBe(400);
    expect(isNonReplayableResponse(response)).toBe(true);
  });

  test.each([false, true])("reset refusal stays terminal across policy and account recovery (replacement=%s)", async replacement => {
    let sends = 0;
    let coreCalls = 0;
    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, {} as RequestLogContext, {}, {
      runCore: async (req, _config, context, options) => {
        coreCalls += 1;
        const body = await req.json();
        options.onRequestBodyParsed?.(body);
        body.input = "attempt-local recovered text";
        context.routeDecision = policyTrace();
        return fetchWithTransientRetry(async () => {
          sends += 1;
          if (sends === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
          return new Response("busy", { status: 502 });
        }, { attempts: 3, claimAmbiguousResend: () => replacement });
      },
    });

    expect(response.status).toBe(429);
    expect(isNonReplayableResponse(response)).toBe(true);
    await expect(shouldRetryCodexPoolAccountQuota(response)).resolves.toBe(false);
    expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
    expect(coreCalls).toBe(1);
    expect(sends).toBe(replacement ? 2 : 1);
  });

  test("policy hops retain only the original sidecar snapshot outside primary headers", async () => {
    const authorization = `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "sidecar-account" })}`;
    const initial = request();
    const headers = new Headers(initial.headers);
    headers.set("authorization", authorization);
    headers.set("chatgpt-account-id", "sidecar-account");
    const log = { model: "", provider: "" } as RequestLogContext;
    const snapshots: unknown[] = [];
    const primaryAuth: Array<string | null> = [];
    const response = await handleResponsesWithPolicyFallback(new Request(initial, { headers }), {
      port: 0, defaultProvider: "provider-a", providers: {},
    }, log, {}, {
      runCore: async (req, _config, context, options) => {
        options.onRequestBodyParsed?.(await req.json());
        snapshots.push(options.openAiSidecarAuth);
        primaryAuth.push(req.headers.get("authorization"));
        context.routeDecision = policyTrace();
        return snapshots.length === 1
          ? Response.json({ error: { message: "retry next candidate" } }, { status: 503 })
          : Response.json({ status: "completed" });
      },
    });
    expect(response.status).toBe(200);
    expect(primaryAuth).toEqual([authorization, null]);
    expect(snapshots).toEqual([
      { authorization, chatgptAccountId: "sidecar-account" },
      { authorization, chatgptAccountId: "sidecar-account" },
    ]);
    expect(snapshots[1]).toBe(snapshots[0]);
  });

  test("ranks only eligible untried candidates by score and stable original order", () => {
    const ranked = rankPolicyFallbackCandidates(policyTrace(), new Set(["provider-a\u0000model-a"]));
    expect(ranked.map(candidate => `${candidate.provider}/${candidate.model}`)).toEqual([
      "provider-b/model-b",
      "provider-c/model-c",
    ]);
  });

  test("leaves request body parsing to the core handler", async () => {
    const req = request();
    let cloneCalls = 0;
    Object.defineProperty(req, "clone", {
      value: () => {
        cloneCalls += 1;
        throw new Error("fallback wrapper must not clone the request body");
      },
    });

    const response = await handleResponsesWithPolicyFallback(
      req,
      {} as OcxConfig,
      {} as RequestLogContext,
      {},
      { runCore: async () => new Response(null, { status: 204 }) },
    );

    expect(response.status).toBe(204);
    expect(cloneCalls).toBe(0);
  });

  test("retries from an immutable snapshot of the initially parsed body", async () => {
    const trace = policyTrace();
    const logCtx = { routeDecision: trace } as RequestLogContext;
    const seenInputs: unknown[] = [];
    let calls = 0;
    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, {
      runCore: async (req, _config, context, options) => {
        calls += 1;
        const body = await req.json() as { input: unknown; model: string };
        options.onRequestBodyParsed?.(body);
        seenInputs.push(body.input);
        context.routeDecision = trace;
        if (calls === 1) {
          body.input = "recovered plaintext";
          return Response.json({ error: { type: "rate_limit_error" } }, { status: 429 });
        }
        return Response.json({ status: "completed" });
      },
    });

    expect(response.status).toBe(200);
    expect(seenInputs).toEqual(["hello", "hello"]);
  });

  test("non-policy requests do not deep-clone their parsed body", async () => {
    const body = {
      model: "provider-a/model-a",
      input: { get content(): string { throw new Error("unexpected deep clone"); } },
    };
    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, {} as RequestLogContext, {}, {
      runCore: async (_req, _config, _context, options) => {
        options.onRequestBodyParsed?.(body);
        return new Response(null, { status: 204 });
      },
    });
    expect(response.status).toBe(204);
  });

  test.each(["ocx/primary--fast", "ocx/primary--high"])("decorated policy selector %s keeps an immutable candidate-retry body", async selector => {
    const config = {
      port: 0, defaultProvider: "provider-a", cursorEffortRows: true,
      providers: {
        "provider-a": { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "a", models: ["model-a"] },
        "provider-b": { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "b", models: ["model-b"] },
      },
      routingProfiles: { daily: { alias: "ocx/primary", candidates: [{ provider: "provider-a", model: "model-a" }] } },
    } as OcxConfig;
    const parsed = parseSyntheticRowId(selector, config);
    expect(parsed.fastRow?.baseId ?? parsed.effortRow?.baseId).toBe("ocx/primary");
    const trace = policyTrace();
    const seen: Array<{ model: string; input: unknown }> = [];
    const req = new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: selector, input: [{ role: "user", content: "original" }] }),
    });
    const response = await handleResponsesWithPolicyFallback(req, config, { routeDecision: trace } as RequestLogContext, {}, {
      runCore: async (attempt, _config, context, options) => {
        const body = await attempt.json() as { model: string; input: Array<{ role: string; content: string }> };
        options.onRequestBodyParsed?.(body);
        seen.push({ model: body.model, input: structuredClone(body.input) });
        context.routeDecision = trace;
        if (seen.length === 1) {
          body.input[0]!.content = "mutated by recovery";
          return Response.json({ error: { type: "rate_limit_error" } }, { status: 429 });
        }
        return Response.json({ status: "completed" });
      },
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      { model: selector, input: [{ role: "user", content: "original" }] },
      { model: "provider-b/model-b", input: [{ role: "user", content: "original" }] },
    ]);
  });

  test("the retry snapshot survives mutation inside the input array", async () => {
    // The top-level field swap above also passes under a shallow `{...body}` copy. The
    // real leaks mutate deeper: the sanitizer splices input entries in place and the
    // assignment injector rewrites inside the same array. Pin a nested mutation so a
    // shallow-copy regression cannot stay green.
    const trace = policyTrace();
    const logCtx = { routeDecision: trace } as RequestLogContext;
    const seenInputs: unknown[] = [];
    let calls = 0;
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "policy/daily", input: [{ role: "user", content: "hello" }], stream: false }),
    });
    const response = await handleResponsesWithPolicyFallback(req, {} as OcxConfig, logCtx, {}, {
      runCore: async (req, _config, context, options) => {
        calls += 1;
        const body = await req.json() as { input: { role: string; content: string }[]; model: string };
        options.onRequestBodyParsed?.(body);
        seenInputs.push(JSON.parse(JSON.stringify(body.input)));
        context.routeDecision = trace;
        if (calls === 1) {
          body.input.splice(0, 1, { role: "assistant", content: "recovered plaintext" });
          return Response.json({ error: { type: "rate_limit_error" } }, { status: 429 });
        }
        return Response.json({ status: "completed" });
      },
    });

    expect(response.status).toBe(200);
    expect(seenInputs).toEqual([
      [{ role: "user", content: "hello" }],
      [{ role: "user", content: "hello" }],
    ]);
  });

  test("a local input-admission refusal hops instead of ending the chain (#1524)", async () => {
    // #1524: a candidate whose context window cannot fit the request used to TERMINATE the
    // fallback chain. It is a local preflight verdict about ONE candidate, not about the
    // request, so the next candidate -- which may have a larger window -- must still be tried.
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const runCore: NonNullable<PolicyFallbackDeps["runCore"]> = async (req, _config, ctx, options) => {
      const body = await req.clone().json() as { model?: string };
      options.onRequestBodyParsed?.(body);
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
    const runCore: NonNullable<PolicyFallbackDeps["runCore"]> = async (req, _config, ctx, options) => {
      const body = await req.clone().json() as { model?: string };
      options.onRequestBodyParsed?.(body);
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
  test("an upstream context_length_exceeded advances to the next policy candidate", async () => {
    // A context verdict is about THIS model's window, not about the request in the abstract:
    // the next candidate may be able to hold the same turn. Traversal stays finite because
    // `tried` admits each candidate once, and nothing has been sent to the client yet.
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const runCore: NonNullable<PolicyFallbackDeps["runCore"]> = async (req, _config, ctx, options) => {
      const body = await req.clone().json() as { model?: string };
      options.onRequestBodyParsed?.(body);
      seenModels.push(String(body.model));
      ctx.routeDecision = trace;
      seedAttempt(ctx, "provider", String(body.model));
      if (seenModels.length === 1) {
        return Response.json(
          { error: { message: "context length exceeded", type: "invalid_request_error", code: "context_length_exceeded" } },
          { status: 400 },
        );
      }
      return Response.json({ id: "resp", object: "response", status: "completed", output: [] });
    };

    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, { runCore });

    expect(response.status).toBe(200);
    expect(seenModels).toEqual(["policy/daily", "provider-b/model-b"]);
  });
  test("retries the next policy candidate and keeps distinct physical attempts", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const seenAuthorization: Array<string | null> = [];
    const seenAccountIds: Array<string | null> = [];
    const seenTerminalCodes: Array<string | undefined> = [];
    let bodyAcceptedCount = 0;

    const initialRequest = request();
    const initialHeaders = new Headers(initialRequest.headers);
    initialHeaders.set("authorization", "Bearer fixture");
    initialHeaders.set("chatgpt-account-id", "caller-account");
    const credentialedRequest = new Request(initialRequest, { headers: initialHeaders });

    const response = await handleResponsesWithPolicyFallback(credentialedRequest, {} as OcxConfig, logCtx, {
      onRequestBodyRead: () => {
        bodyAcceptedCount += 1;
      },
    }, {
      runCore: async (req, _config, childLog, options) => {
        options.onRequestBodyRead?.();
        seenAuthorization.push(req.headers.get("authorization"));
        seenAccountIds.push(req.headers.get("chatgpt-account-id"));
        const body = await req.json() as { model: string };
        options.onRequestBodyParsed?.(body);
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
    expect(seenAuthorization).toEqual(["Bearer fixture", null]);
    expect(seenAccountIds).toEqual(["caller-account", null]);
    expect(seenTerminalCodes).toEqual([undefined, undefined]);
    expect(logCtx.requestedModel).toBe("policy/daily");
    expect(logCtx.routeDecision).toBe(trace);
    expect(logCtx.attempts).toHaveLength(2);
    expect(logCtx.attempts?.[0]).toMatchObject({ provider: "provider-a", model: "model-a", status: 429 });
    expect(logCtx.attempts?.[1]).toMatchObject({ provider: "provider-b", model: "model-b" });
    expect(logCtx.activeAttempt).toBe(logCtx.attempts?.[1]);
  });

  test("a stored Pool 401 replay dispatch stops policy candidate fallback", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    let replaySignals = 0;

    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {
      onStoredPool401ReplayDispatched: () => { replaySignals += 1; },
    }, {
      runCore: async (req, _config, childLog, options) => {
        const body = await req.json() as { model: string };
        options.onRequestBodyParsed?.(body);
        seenModels.push(body.model);
        childLog.routeDecision = trace;
        seedAttempt(childLog, "provider-a", "model-a");
        options.onStoredPool401ReplayDispatched?.();
        return Response.json(
          { error: { message: "stored replay exhausted", type: "rate_limit_error" } },
          { status: 429 },
        );
      },
    });

    expect(response.status).toBe(429);
    expect(seenModels).toEqual(["policy/daily"]);
    expect(replaySignals).toBe(1);
  });

  test("returns local pacing overload without switching policy candidates", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, {
      runCore: async (req, _config, _ctx, options) => {
        calls += 1;
        options.onRequestBodyParsed?.(await req.json());
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
      runCore: async (req, _config, childLog, options) => {
        calls += 1;
        options.onRequestBodyParsed?.(await req.json());
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
      runCore: async (req, _config, childLog, options) => {
        calls += 1;
        options.onRequestBodyParsed?.(await req.json());
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
      runCore: async (req, _config, childLog, options) => {
        calls += 1;
        options.onRequestBodyParsed?.(await req.json());
        childLog.routeDecision = trace;
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hello");
    expect(calls).toBe(1);
  });
});
