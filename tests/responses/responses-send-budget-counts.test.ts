import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleResponses } from "../../src/server/responses/core";
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

  test("a three-target combo preserves every target while bounding same-target retries", async () => {
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(responsesRequest("combo/fan"), comboOverTargets(3), logCtx);

    expect(response.status).toBe(502);
    await response.text();
    expect(sendCounts(logCtx)).toEqual([3, 1, 1]);
    expect(totalSends(logCtx)).toBe(5);
    expect(upstream.authorizations).toEqual([
      "Bearer sk-t0", "Bearer sk-t0", "Bearer sk-t0",
      "Bearer sk-t1", "Bearer sk-t2",
    ]);
  });

  test("a thirteen-target combo reaches every declared fallback before returning failure", async () => {
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(responsesRequest("combo/fan"), comboOverTargets(13), logCtx);

    expect(response.status).toBe(502);
    await response.text();
    expect(sendCounts(logCtx)).toEqual([3, ...Array.from({ length: 12 }, () => 1)]);
    expect(totalSends(logCtx)).toBe(15);
    expect(upstream.authorizations).toHaveLength(15);
    for (let index = 0; index < 13; index++) {
      expect(upstream.authorizations).toContain(`Bearer sk-t${index}`);
    }
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
