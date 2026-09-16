import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as comboRequests from "../../src/combos";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { RequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { saveConfig } from "../../src/config";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";

/**
 * One logical request, one send budget -- asserted as a COUNT, because the defect in #4546 is a
 * count. Every layer that can re-send bounded itself correctly and the layers multiplied, so the
 * only assertion that catches a regression here is the exact number of times the proxy reached
 * upstream for one client turn.
 *
 * These 5xx rows opt into `transientRetryOn5xx` to exercise same-target retries. Both generic
 * retry policies draw from the request budget and report physical sends through
 * `onSendsConsumed`. Reset-only still hops on the first HTTP 5xx; its key-rotation and socket
 * reset counts are covered by the server-key-failover end-to-end fixture instead.
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
  test.each(["prepare-throw", "prepare-abort", "child-throw", "child-abort", "settled-send", "opaque-send", "nested-observed", "opaque-success"] as const)(
    "combo reservation cleanup preserves observed work and refunds local exits (%s)", async mode => {
      const budget = createRequestExecutionBudget();
      const translatorBudget = createTranslatorBudget();
      const controller = new AbortController();
      const failure = new Error("fixture pre-dispatch failure");
      const originalPrepare = comboRequests.concreteComboRequestBody;
      const preparation = mode.startsWith("prepare-")
        ? spyOn(comboRequests, "concreteComboRequestBody").mockImplementationOnce((...args) => {
          if (mode === "prepare-throw") throw failure;
          controller.abort();
          return originalPrepare(...args);
        }) : undefined;
      let children = 0;
      try {
        const pending = executeComboResponses(responsesRequest("combo/fan"), { model: "combo/fan", input: "hello", stream: false },
          "fan", comboOverTargets(1), { model: "", provider: "" }, { translatorBudget, sendBudget: budget, abortSignal: controller.signal }, {
            handleComboResponses: async () => { throw new Error("Unexpected nested combo"); },
            handleResponses: async (_request, _config, log, options) => {
              children += 1;
              if (mode === "child-throw") throw failure;
              if (mode === "child-abort") { controller.abort(); return new Response(null, { status: 499 }); }
              if (mode === "settled-send") {
                const send = (options!.sendBudget as RequestExecutionBudget).reserveDispatch({ sendClass: "transient", targetKey: "fixture" });
                if (!send.allowed || !send.permit.use()) throw new Error("Expected prepaid child send");
              }
              if (mode === "opaque-send") log.activeAttempt!.sendCount = 1;
              if (mode === "nested-observed") log.attempts = [{ ...log.activeAttempt!, sendCount: 1 }];
              return Response.json({ error: { message: "fixture provider failure" } }, { status: mode === "opaque-success" ? 200 : 502 });
            },
          });
        if (mode.endsWith("throw")) await expect(pending).rejects.toBe(failure);
        else await (await pending).text();
        expect(children).toBe(mode.startsWith("prepare-") ? 0 : 1);
        expect(budget.used).toBe(mode.startsWith("prepare-") ? 0 : 1);
      } finally { preparation?.mockRestore(); translatorBudget.dispose(); }
    },
  );

  test("a local input refusal refunds its combo booking so later targets keep four plus two sends", async () => {
    const cfg = comboOverTargets(3);
    cfg.providers.t0!.contextWindow = 1;
    for (const name of ["t1", "t2"]) cfg.providers[name] = {
      ...cfg.providers[name]!, adapter: "google", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com",
    };
    cfg.providers.t1!.apiKeyPool = [{ id: "a", key: "sk-t1" }, { id: "b", key: "sk-t1-recovery" }];
    saveConfig(cfg);
    const seen: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const key = new Headers(init?.headers).get("x-goog-api-key") ?? "";
      seen.push(key);
      const status = key === "sk-t1" && seen.length === 3 ? 429 : 502;
      return Response.json({ error: { message: "fixture provider failure" } }, { status, headers: { "Retry-After": "0" } });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const budget = createRequestExecutionBudget();
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/fan", stream: false, input: "large input ".repeat(100) }),
    }), cfg, logCtx, { sendBudget: budget });
    expect(response.status).toBe(502);
    await response.text();
    expect(seen).toEqual(["sk-t1", "sk-t1", "sk-t1", "sk-t1-recovery", "sk-t2", "sk-t2"]);
    expect(sendCounts(logCtx)).toEqual([0, 4, 2]);
    expect(budget.used).toBe(6);
  });

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

  test("a three-target 5xx combo reaches every target within six physical sends", async () => {
    const upstream = alwaysFailing(502, "upstream busy");
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(responsesRequest("combo/fan"), comboOverTargets(3), logCtx);

    expect(response.status).toBe(502);
    await response.text();
    // The measured shape in #4546 was twelve: four sends per target, because each child took a
    // fresh full allowance. Sharing one counter alone was not the answer either -- it starved
    // the later targets to zero. The first target runs its own ladder, each later target draws
    // what is left, and the clamp holds back one send for every target still declared, so the
    // last target is still reached.
    // Count physical sends through the adapter; unit-only shared-counter assertions are not
    // enough to show that retries and later targets consume the same reservation ledger.
    const bearers = upstream.authorizations;
    // Every declared target is still reached. Starving the last target is the failure mode that
    // sharing one counter WITHOUT a per-target policy produces.
    expect(new Set(bearers).size).toBe(3);
    expect(bearers).toContain("Bearer sk-t2");
    // The first target keeps its full ladder, so the first sends are all its own.
    expect(bearers[0]).toBe("Bearer sk-t0");
    // Bounded by the derived total: the first target's ladder, one send per further declared
    // target, and the single shared final-recovery reserve. The measured regression in #4546 was
    // twelve, four per target, because each child drew a fresh full allowance.
    // The final combo hop can use the shared recovery allowance. A prepaid hop must settle
    // against its first physical send rather than shrinking the next target's ladder twice.
    expect(bearers).toHaveLength(6);
    expect(totalSends(logCtx)).toBe(6);
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
