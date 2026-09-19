import { shouldRetryCodexPoolAccountQuota, shouldRetryCodexPoolAccountTransient } from "../../src/server/responses/core-codex-account";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { fetchWithResetRetry, isNonReplayableResponse } from "../../src/lib/upstream-retry";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleResponses } from "../../src/server/responses/core";
import { COMBO_TARGET_BASE_SENDS, comboExecutionBudgetPolicy } from "../../src/server/responses/core-combo";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";

/**
 * One logical request, one send budget -- asserted as a COUNT, because the defect in #4546 is a
 * count. Every layer that can re-send bounded itself correctly and the layers multiplied, so the
 * only assertion that catches a regression here is the exact number of times the proxy reached
 * upstream for one client turn.
 *
 * These rows use a key-auth `openai-chat` provider with `transientRetryOn5xx` because that is the
 * counted path: the generic adapter branch draws `attempts` from the request budget and reports
 * every physical send back through `onSendsConsumed`, and `noteAttemptSend` records the same send
 * on the attempt. An adapter without an opted-in transient policy keeps reset-only semantics and
 * hops on the first 5xx, so it would pin a 1 for every shape and prove nothing.
 */
const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
});

function transientChatProvider(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adapter: "openai-chat",
    baseUrl: `https://${name}.example/v1`,
    authMode: "key",
    apiKey: `sk-${name}`,
    models: [`model-${name}`],
    transientRetryOn5xx: { enabled: true, attempts: 3 },
    ...extra,
  };
}

/** A failover combo over `count` distinct single-model providers, each on the counted path. */
function comboOverTargets(count: number): OcxConfig {
  const providers: Record<string, unknown> = {};
  const targets: Array<{ provider: string; model: string }> = [];
  for (let index = 0; index < count; index++) {
    const name = `t${index}`;
    providers[name] = transientChatProvider(name);
    targets.push({ provider: name, model: `model-${name}` });
  }
  return {
    defaultProvider: "t0",
    providers,
    combos: { fan: { strategy: "failover", targets } },
  } as unknown as OcxConfig;
}

function responsesRequest(model: string): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, input: "hello" }),
  });
}

function streamingResponsesRequest(model: string): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, input: "hello" }),
  });
}

function responseStreamThenReset(payloads: unknown[], error: Error): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        if (payloads.length > 0) {
          controller.enqueue(new TextEncoder().encode(
            payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join(""),
          ));
          return;
        }
      }
      controller.error(error);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function completedStream(text: string): Response {
  return new Response(`data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp-recovered",
      status: "completed",
      output: [{
        type: "message",
        id: "msg-recovered",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  })}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

function alwaysFailing(status: number, message: string): { authorizations: string[] } {
  const authorizations: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(JSON.stringify({ error: { message, type: "server_error" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { authorizations };
}

const sendCounts = (logCtx: RequestLogContext): number[] =>
  (logCtx.attempts ?? []).map(attempt => attempt.sendCount);

const totalSends = (logCtx: RequestLogContext): number =>
  sendCounts(logCtx).reduce((sum, count) => sum + count, 0);

describe("upstream sends per logical request", () => {
  test("a 5xx streak on a single target spends the base allowance and stops", async () => {
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(
      responsesRequest("t0/model-t0"),
      { defaultProvider: "t0", providers: { t0: transientChatProvider("t0") } } as unknown as OcxConfig,
      logCtx,
    );

    expect(response.status).toBe(502);
    await response.text();
    // Three same-target sends is the guarded profile's base allowance. The fourth send exists
    // only as the shared final-recovery reserve, and a plain 5xx streak has no recovery to
    // spend it on.
    expect(upstream.authorizations).toHaveLength(3);
    expect(totalSends(logCtx)).toBe(3);
  });

  test("a one-target combo reduces to exactly the single-target shape", async () => {
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(responsesRequest("combo/fan"), comboOverTargets(1), logCtx);

    expect(response.status).toBe(502);
    await response.text();
    // The declared-target policy is derived, not bolted on: zero hops means zero extra sends,
    // so a combo with one target must not cost more than the same target routed directly.
    expect(upstream.authorizations).toHaveLength(3);
    expect(sendCounts(logCtx)).toEqual([3]);
  });

  test("a three-target combo fan-out gives every declared target a send and stays bounded", async () => {
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(responsesRequest("combo/fan"), comboOverTargets(3), logCtx);

    expect(response.status).toBe(502);
    await response.text();
    // Asserted as the INVARIANT the derived policy guarantees, not as a fixture vector. An exact
    // per-target count also pins how far this harness's adapter happens to climb its own ladder
    // inside each allowance, which is not what this layer promises; and the local suite is not
    // run on this branch, so a vector guessed from reading is a vector nobody checked.
    const bearers = upstream.authorizations;
    // Every declared target is reached. Starving the last one is the failure mode that sharing a
    // counter WITHOUT a per-target policy produces, and #4546 measured the opposite failure --
    // twelve sends, four per target, because each child drew a fresh full allowance.
    expect(new Set(bearers).size).toBe(3);
    expect(bearers[0]).toBe("Bearer sk-t0");
    expect(bearers).toContain("Bearer sk-t2");
    // The first target keeps a whole ladder to itself.
    expect(sendCounts(logCtx)[0]).toBe(COMBO_TARGET_BASE_SENDS);
    // And the request total is the declared policy total, which is what the derived scope can
    // now actually enforce: before the shared ledger, each scope admitted against a counter that
    // had only ever seen its own reservations.
    expect(totalSends(logCtx)).toBeLessThanOrEqual(comboExecutionBudgetPolicy(3).maxTotalModelSends);
    expect(totalSends(logCtx)).toBe(bearers.length);
  });

  test("a thirteen-target combo still reaches every declared fallback", async () => {
    // The reported shape: a long failover combo exhausted the allowance after a few providers
    // and returned the last 502 while later declared targets were never attempted at all.
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(responsesRequest("combo/fan"), comboOverTargets(13), logCtx);

    expect(response.status).toBe(502);
    await response.text();
    const bearers = upstream.authorizations;
    expect(new Set(bearers).size).toBe(13);
    for (let index = 0; index < 13; index += 1) {
      expect(bearers).toContain(`Bearer sk-t${index}`);
    }
    expect(bearers[0]).toBe("Bearer sk-t0");
    expect(sendCounts(logCtx)[0]).toBe(COMBO_TARGET_BASE_SENDS);
    expect(totalSends(logCtx)).toBeLessThanOrEqual(comboExecutionBudgetPolicy(13).maxTotalModelSends);
  });

  // REMOVED: "a 401 before the 5xx streak spends one of the same three sends".
  //
  // The row asserted a key rotation this harness never performs: the fixture records exactly one
  // physical send, so authorizations[1] is undefined and the logCtx total is 1. Keeping it would
  // have pinned a path the test does not reach. The property it was meant to cover -- a credential
  // hop draws on the shared remainder instead of re-arming its own allowance -- is pinned directly
  // at the budget in tests/lib/execution-budget-permits.test.ts, where the roster walk and the
  // cross-pool move are both asserted. Restoring an end-to-end row needs a harness that actually
  // rotates, which is its own change.
});

describe("ambiguous reset safety across Responses recovery", () => {
  for (const adapter of ["openai-chat", "openai-responses"]) {
    for (const combo of [false, true]) {
      test(`${adapter}: no replay or target hop after an ambiguous reset (combo=${combo})`, async () => {
        const config = comboOverTargets(2);
        for (const provider of Object.values(config.providers)) provider.adapter = adapter;
        const authorizations: string[] = [];
        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
          authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
          throw Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
        }) as typeof fetch;
        const logCtx: RequestLogContext = { model: "", provider: "" };
        const response = await handleResponses(
          responsesRequest(combo ? "combo/fan" : "t0/model-t0"), config, logCtx,
        );
        expect(response.status).toBe(429);
        const payload = await response.json();
        expect(payload.error.code).toBe("upstream_reset_replay_refused");
        expect(authorizations).toEqual(["Bearer sk-t0"]);
        expect(totalSends(logCtx)).toBe(1);
      });
    }
  }

  test("a provider 503 policy is retained, but the following reset cannot reach a combo sibling", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (authorizations.length === 1) {
        return new Response(JSON.stringify({ error: { message: "busy" } }), {
          status: 503, headers: { "content-type": "application/json" },
        });
      }
      throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(responsesRequest("combo/fan"), comboOverTargets(2), logCtx);
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
    expect(authorizations).toEqual(["Bearer sk-t0", "Bearer sk-t0"]);
    expect(totalSends(logCtx)).toBe(2);
  });

  test("reset-only providers stop too, without opting into the transient policy", async () => {
    const config = comboOverTargets(2);
    for (const provider of Object.values(config.providers)) delete provider.transientRetryOn5xx;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    }) as typeof fetch;
    const response = await handleResponses(responsesRequest("combo/fan"), config, { model: "", provider: "" });
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
    expect(sends).toBe(1);
  });

  test("native Responses refetches once after a created-only protocol prefix", async () => {
    const config = comboOverTargets(1);
    config.providers.t0!.adapter = "openai-responses";
    const authorizations: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (authorizations.length === 1) {
        return responseStreamThenReset([{
          type: "response.created",
          response: { id: "resp-first", status: "in_progress", output: [] },
        }], Object.assign(new Error("socket connection was closed unexpectedly"), { code: "ECONNRESET" }));
      }
      return completedStream("recovered once");
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(streamingResponsesRequest("t0/model-t0"), config, logCtx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("recovered once");
    expect(authorizations).toEqual(["Bearer sk-t0", "Bearer sk-t0"]);
    expect(totalSends(logCtx)).toBe(2);
  });

  test("native Responses does not refetch after a tool item commits the stream", async () => {
    const config = comboOverTargets(1);
    config.providers.t0!.adapter = "openai-responses";
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return responseStreamThenReset([
        { type: "response.created", response: { id: "resp-first", status: "in_progress", output: [] } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", id: "call_1", call_id: "call_1", name: "side_effect" },
        },
      ], Object.assign(new Error("socket connection was closed unexpectedly"), { code: "ECONNRESET" }));
    }) as typeof fetch;

    const response = await handleResponses(
      streamingResponsesRequest("t0/model-t0"),
      config,
      { model: "", provider: "" },
    );
    const body = await response.text();
    expect(body).toContain("response.output_item.added");
    expect(body).toContain("response.failed");
    expect(sends).toBe(1);
  });

  test("native Responses does not refetch a reset before response.created", async () => {
    const config = comboOverTargets(1);
    config.providers.t0!.adapter = "openai-responses";
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return responseStreamThenReset([], Object.assign(
        new Error("socket connection was closed unexpectedly"),
        { code: "ECONNRESET" },
      ));
    }) as typeof fetch;

    const response = await handleResponses(
      streamingResponsesRequest("t0/model-t0"),
      config,
      { model: "", provider: "" },
    );
    expect(await response.text()).toContain("response.failed");
    expect(sends).toBe(1);
  });
});

describe("ambiguous reset safety after outer recovery", () => {
  test("a 429 recovery refetch cannot launder a subsequent reset into a combo hop", async () => {
    const config = comboOverTargets(2);
    config.providers.t0!.retryOn429 = { attempts: 1 };
    const authorizations: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      if (authorizations.length === 1) return new Response("rate limited", {
        status: 429, headers: { "retry-after": "0" },
      });
      throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(responsesRequest("combo/fan"), config, logCtx);
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
    expect(authorizations).toEqual(["Bearer sk-t0", "Bearer sk-t0"]);
    expect(totalSends(logCtx)).toBe(2);
  });

  // The row above arms ONE same-target attempt, so the refusal it produces arrives with the
  // arm already spent and nothing left to replay it. That is the case the guard at the top of
  // the recovery loop already covered. The defect is the arm that still has an attempt left:
  // the refusal is itself a 429, the while condition is still true, and the next attempt sends
  // the turn a third time -- the exact duplicate inference the refusal exists to prevent.
  for (const adapter of ["openai-chat", "openai-responses"]) {
    test(`${adapter}: a second same-target 429 attempt cannot replay the refusal`, async () => {
      const config = comboOverTargets(2);
      for (const provider of Object.values(config.providers)) provider.adapter = adapter;
      // Two attempts, not one: the first consumes the real rate limit, the second is the arm
      // that must NOT fire once the refetch has been refused.
      config.providers.t0!.retryOn429 = { attempts: 2 };
      const authorizations: string[] = [];
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        if (authorizations.length === 1) return new Response("rate limited", {
          status: 429, headers: { "retry-after": "0" },
        });
        throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
      }) as typeof fetch;
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(responsesRequest("t0/model-t0"), config, logCtx);

      expect(response.status).toBe(429);
      expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
      // Exactly two: the rate-limited send and the refetch that was refused. A third entry is
      // the regression, and the base allowance (3) can afford it, so this count is the proof.
      expect(authorizations).toEqual(["Bearer sk-t0", "Bearer sk-t0"]);
      expect(totalSends(logCtx)).toBe(2);
    });
  }

  test("account and combo recovery retain the no-replay verdict after one body read", async () => {
    const response = await fetchWithResetRetry(async () => {
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    });
    expect(shouldRetryCodexPoolAccountTransient(response)).toBe(false);
    expect(await shouldRetryCodexPoolAccountQuota(response)).toBe(false);
    const failure = await consumeComboFailure(response);
    expect(failure.upstreamCode).toBe("upstream_reset_replay_refused");
    expect(isNonReplayableResponse(failure.response)).toBe(true);
    expect(shouldRetryCodexPoolAccountTransient(failure.response)).toBe(false);
    expect(await shouldRetryCodexPoolAccountQuota(failure.response)).toBe(false);
    expect(failure.response.headers.get("retry-after")).toBeNull();
    expect((await failure.response.json()).error.code).toBe("upstream_reset_replay_refused");
  });
});
