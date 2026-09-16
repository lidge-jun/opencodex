import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { classifyError, SEND_BUDGET_EXHAUSTED_CODE } from "../../src/lib/errors";
import { adapterFailureFromEvent } from "../../src/bridge/internal";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";

/**
 * A refusal this proxy made must not be reported as a provider failure (#4708).
 *
 * The three dispatch paths disagreed. Passthrough answered 429 and explicitly declined to blame
 * the provider; the adapter paths fell through to `describeUpstreamConnectFailure` and answered
 * 502 "Provider unreachable"; runTurn pushed an unstructured message that was inferred back to
 * 502 under HTTP 200.
 *
 * The 502 is the damaging one, and not only because it is wrong. The Codex client retries 5xx
 * and does not retry a 429, so telling it the provider broke makes it send the whole turn again
 * -- the amplification this budget exists to stop. That is why the fix is the status, and the
 * distinct code is the part that lets an operator tell the two 429s apart afterwards.
 */
const source = (relative: string): string => readFileSync(repoPath(relative), "utf8");

describe("a spent send budget is reported as this proxy's refusal", () => {
  test("the distinct code survives serialization instead of collapsing into the generic one", () => {
    const refusal = classifyError(429, SEND_BUDGET_EXHAUSTED_CODE, "request send budget exhausted before dispatch");
    expect(refusal.type).toBe("rate_limit_error");
    expect(refusal.code).toBe(SEND_BUDGET_EXHAUSTED_CODE);

    // A provider rate limit is still the generic identity: the branch above is keyed on the
    // supplied type, not on the status, so it cannot capture an upstream 429.
    const upstream = classifyError(429, "upstream_error", "Too Many Requests");
    expect(upstream.type).toBe("rate_limit_error");
    expect(upstream.code).toBe("rate_limit_exceeded");
  });

  test("the error class and the classifier name the same identity", () => {
    expect(new SendBudgetExhaustedError("host").code).toBe(SEND_BUDGET_EXHAUSTED_CODE);
  });

  test("a committed stream carries the refusal as a structured terminal", () => {
    const failure = adapterFailureFromEvent({
      type: "error",
      status: 429,
      errorType: "rate_limit_error",
      code: SEND_BUDGET_EXHAUSTED_CODE,
      message: "request send budget exhausted before dispatch",
    });
    expect(failure.httpStatus).toBe(429);
    expect(failure.error.type).toBe("rate_limit_error");
    expect(failure.error.code).toBe(SEND_BUDGET_EXHAUSTED_CODE);

    // Without the structure, the same message is inferred from text alone and lands on the 502
    // the client would retry. This is the control that makes the assertion above mean something.
    const unstructured = adapterFailureFromEvent({
      type: "error",
      message: "request send budget exhausted before dispatch",
    });
    // Asserted as the property rather than the exact status: what matters is that the identity
    // is gone, so the client cannot tell this from an upstream fault and does not get the 429
    // that would stop it retrying.
    expect(unstructured.httpStatus).not.toBe(429);
    expect(unstructured.error.code).not.toBe(SEND_BUDGET_EXHAUSTED_CODE);
  });

  test("both adapter catch sites answer before the upstream-failure description", () => {
    const dispatch = source("src/server/responses/adapter-dispatch.ts");
    const guards = dispatch.match(/if \(err instanceof SendBudgetExhaustedError\) \{/g) ?? [];
    expect(guards).toHaveLength(2);
    // Order is the assertion: describeUpstreamConnectFailure is what launders the refusal into
    // "Provider unreachable", so the typed branch has to precede every one of its call sites.
    let cursor = 0;
    for (let index = 0; index < 2; index += 1) {
      const guard = dispatch.indexOf("if (err instanceof SendBudgetExhaustedError) {", cursor);
      const describe = dispatch.indexOf("describeUpstreamConnectFailure(err, connectMs)", cursor);
      expect(guard).toBeGreaterThan(-1);
      expect(describe).toBeGreaterThan(guard);
      cursor = describe + 1;
    }
  });

  test("a local 429 never rotates a credential or writes a cooldown", () => {
    const runTurn = source("src/server/responses/run-turn-execution.ts");
    const rotate = runTurn.indexOf("const rotateRunTurnAdapterOnPreflight429");
    const guard = runTurn.indexOf("if (error.code === SEND_BUDGET_EXHAUSTED_CODE) return false;", rotate);
    const status = runTurn.indexOf("const status = error.status", rotate);
    expect(rotate).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(rotate);
    // Before the status is even read: a refusal that reached the roster cap would cool down an
    // account that rate-limited nothing, and that fake signal outlives the request.
    expect(status).toBeGreaterThan(guard);
  });

  test("the continuation 429 loop consults the shared remainder before it cancels the body", () => {
    const continuation = source("src/server/responses/adapter-continuation.ts");
    const loop = continuation.indexOf("adapterExchange.rateLimitRetries < rateLimitPolicy.attempts");
    const check = continuation.indexOf("!sendBudgetExhausted()", loop);
    const wait = continuation.indexOf("prepareSameTarget429Wait", loop);
    expect(loop).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(loop);
    expect(wait).toBeGreaterThan(check);
  });
});
