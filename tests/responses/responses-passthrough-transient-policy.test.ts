import { describe, expect, test } from "bun:test";
import { readResponsesCoreModule } from "../helpers/responses-core-source";
import {
  createResponsesSendBudget,
  transientSendCapFor,
} from "../../src/server/responses/request-send-budget";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { TRANSIENT_RETRY_MAX_ATTEMPTS } from "../../src/lib/upstream-retry";
import type { RequestLogContext } from "../../src/server/request-log";
import type { ResponsesRequestContext } from "../../src/server/responses/core-options";

/** Whitespace-independent, so reformatting a call site cannot silently retire an assertion. */
function dense(source: string): string {
  return source.replace(/\s+/gu, "");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * #4893. A provider's `transientRetryOn5xx` never reached the Responses passthrough lane.
 *
 * `createResponsesPassthroughAdapter` sets `passthrough: true`, and `core.ts` returns into
 * `executePassthroughResponse` on that flag before the three call sites that read
 * `transientRetryPolicyFor` are ever constructed. This file hard-codes nothing else: it asserts
 * that every send this lane makes takes its ladder from the provider policy, so the fix cannot
 * regress by one call site being left on the constant -- which is exactly how the defect looked,
 * with four sites in one file all passing `TRANSIENT_RETRY_MAX_ATTEMPTS`.
 */
describe("the Responses passthrough lane reads the provider transient policy", () => {
  const source = readResponsesCoreModule("passthrough-dispatch.ts");
  const packed = dense(source);

  test("the ladder is resolved from the provider row, not a constant", () => {
    expect(packed).toContain(dense(
      "const transientSendPolicy = () => transientRetryPolicyFor(route.provider);\n"
      + "const transientSendAttempts = (): number => transientSendCapFor(\n"
      + "  transientSendPolicy()?.attempts,\n"
      + "  sendBudgetState.sendsUsed,\n"
      + ");",
    ));
  });

  test("every transient-retry send takes its attempts from that resolver", () => {
    const sites = occurrences(packed, "fetchWithTransientRetry(");
    // The lane's initial send plus its recovery legs. A site that stops being counted here is a
    // site that stopped being governed by the policy.
    expect(sites).toBeGreaterThanOrEqual(4);

    const budgeted = occurrences(packed, "attempts:remainingTransientSendBudget(transientSendAttempts())");
    const allowanceBacked = occurrences(packed, "attempts:allowance.attempts");
    expect(budgeted + allowanceBacked).toBe(sites);

    // The rebuild leg spends a recovery allowance rather than the base budget directly, so its
    // cap has to come from the same resolver one level up.
    expect(occurrences(packed, "recoverySendAllowance(transientSendAttempts(),")).toBe(allowanceBacked);
  });

  test("no dispatch or exhaustion check is left on the fixed constant", () => {
    expect(packed).not.toContain("remainingTransientSendBudget(TRANSIENT_RETRY_MAX_ATTEMPTS)");
    expect(packed).not.toContain("recoverySendAllowance(TRANSIENT_RETRY_MAX_ATTEMPTS,");
    // The exhaustion predicate has to ask at the SAME cap the sends use. Asking at the constant
    // while dispatching at a configured value is how a request with headroom gets told it is
    // spent, and how one configured below the constant passes the check and is then refused.
    const checks = occurrences(packed, "sendBudgetExhausted(");
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(occurrences(packed, "sendBudgetExhausted(transientSendAttempts())")).toBe(checks);
    expect(packed).not.toContain("sendBudgetExhausted()");
  });
});

function sendBudgetFor(budget: ReturnType<typeof createRequestExecutionBudget>) {
  const state = createResponsesSendBudget({
    options: { sendBudget: budget } as unknown as ResponsesRequestContext["options"],
    req: new Request("http://127.0.0.1/v1/responses"),
    logCtx: {} as unknown as RequestLogContext,
  });
  if (state instanceof Response) throw new Error("unexpected workflow refusal");
  return state;
}

/**
 * The budget half of the same issue.
 *
 * A configured `attempts` is documented as the TOTAL sends for one request including the first,
 * so the cap each leg receives is that total minus what the request has already sent. Passing the
 * configured value straight through would make it a per-leg ceiling instead, and a provider
 * configured at one send could still reach upstream again on a recovery leg.
 *
 * The result is then intersected with the request-wide base allowance by `remainingBaseSends`.
 * That intersection is the deliberate settlement the issue asked for: an operator can narrow this
 * request's sends exactly, and cannot widen the bound that exists to stop per-request
 * amplification (#4546).
 */
describe("a configured ladder is bounded by the request budget", () => {
  test("an absent policy resolves to the constant, unchanged at every send count", () => {
    for (const used of [0, 1, 2, 3, 9]) {
      expect(transientSendCapFor(undefined, used)).toBe(TRANSIENT_RETRY_MAX_ATTEMPTS);
    }
  });

  test("a configured total is measured against what the request already sent", () => {
    expect(transientSendCapFor(1, 0)).toBe(1);
    // The whole total is spent, so no later leg may dispatch. Passing the configured value
    // straight through would answer 1 here and fund a second upstream send.
    expect(transientSendCapFor(1, 1)).toBe(0);
    expect(transientSendCapFor(5, 2)).toBe(3);
    expect(transientSendCapFor(5, 9)).toBe(0);
  });

  test("a lower configured value ends the ladder the constant would have continued", () => {
    const budget = createRequestExecutionBudget();
    const state = sendBudgetFor(budget);

    expect(state.sendBudgetExhausted(transientSendCapFor(1, state.sendsUsed))).toBe(false);
    budget.used = 1;
    // Configured `attempts: 1`: one send is the whole request, so no recovery leg may dispatch.
    expect(state.sendBudgetExhausted(transientSendCapFor(1, state.sendsUsed))).toBe(true);
    // At the constant the same request still looks fundable, which is the behaviour the reporter
    // measured as "three sends whatever I configure".
    expect(state.sendBudgetExhausted(transientSendCapFor(undefined, state.sendsUsed))).toBe(false);
  });

  test("a higher configured value does not lift the request-wide allowance", () => {
    const budget = createRequestExecutionBudget();
    const state = sendBudgetFor(budget);

    // The guarded profile allows three base sends per logical request.
    expect(state.remainingTransientSendBudget(transientSendCapFor(10, state.sendsUsed))).toBe(3);
    budget.used = 2;
    expect(state.remainingTransientSendBudget(transientSendCapFor(10, state.sendsUsed))).toBe(1);
    // And a narrower configured value still wins over the remaining allowance.
    expect(state.remainingTransientSendBudget(transientSendCapFor(2, state.sendsUsed))).toBe(0);
  });

  test("a configured one-send total cannot draw the final recovery reserve", () => {
    const budget = createRequestExecutionBudget();
    const state = sendBudgetFor(budget);

    state.noteTransientSends(1);
    const cap = transientSendCapFor(1, state.sendsUsed);
    expect(cap).toBe(0);

    // Compose the real rebuild allowance rather than checking only the exhaustion predicate.
    const allowance = state.recoverySendAllowance(
      cap,
      "repair",
      "provider|model|reasoning-effort-downgrade",
      { allowFinalRecoveryReserve: false },
    );
    expect(allowance).toEqual({ attempts: 0 });
    expect(budget.used).toBe(1);
    expect(budget.reserveSpent).toBe(false);
  });

  test("an unconfigured provider retains the shared final recovery reserve", () => {
    const budget = createRequestExecutionBudget();
    const state = sendBudgetFor(budget);

    state.noteTransientSends(TRANSIENT_RETRY_MAX_ATTEMPTS);
    const cap = transientSendCapFor(undefined, state.sendsUsed);
    const allowance = state.recoverySendAllowance(
      cap,
      "repair",
      "provider|model|reasoning-effort-downgrade",
    );

    expect(allowance.attempts).toBe(1);
    expect(allowance.permit).toBeDefined();
    expect(budget.used).toBe(4);
    expect(budget.reserveSpent).toBe(true);
    allowance.permit?.release();
    expect(budget.used).toBe(3);
    expect(budget.reserveSpent).toBe(false);
  });
});

  const goPacked = dense(readResponsesCoreModule("passthrough-dispatch.ts"));
describe("the Go destination replays ambiguous resets on the initial send", () => {
  test("replaySafe is destination-scoped to exactly one leg", () => {
    expect(occurrences(goPacked, "replaySafe:isOpenCodeGoDestination(route.provider)")).toBe(1);
  });
});
