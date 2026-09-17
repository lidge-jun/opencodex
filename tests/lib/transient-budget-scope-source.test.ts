import { describe, expect, test } from "bun:test";
import {
  createRequestExecutionBudget,
  deriveRequestExecutionBudget,
  type RequestExecutionBudget,
  type RequestExecutionBudgetPolicy,
  type RequestSendObserver,
} from "../../src/lib/request-execution-budget";
import {
  fetchWithResetRetry,
  fetchWithTransientRetry,
  SendBudgetExhaustedError,
} from "../../src/lib/upstream-retry";

const THREE_SEND_POLICY: RequestExecutionBudgetPolicy = {
  maxTotalModelSends: 3,
  baseSendAllowance: 3,
  finalRecoveryAllowance: 0,
  maxAlternateTargetSends: 1,
  maxTargetTransitions: 1,
};

const recordingObserver = (): RequestSendObserver & { readonly charges: number; readonly refunds: number } => {
  let charges = 0;
  let refunds = 0;
  return {
    get charges() { return charges; },
    get refunds() { return refunds; },
    charge() {
      charges += 1;
      return true;
    },
    refund() {
      refunds += 1;
    },
  };
};

/**
 * `transientRetryOn5xx.attempts` is one request-wide total-send budget, not a per-leg
 * allowance. The historical failure gave a continuation or combo child a fresh allowance,
 * so several individually bounded retry helpers multiplied into an unbounded request.
 *
 * These cases drive the `src/lib` boundary directly: separate helper invocations report their
 * physical sends into one request ledger, and a derived child shares that exact ledger. The
 * observer is the durable-spend boundary, so its event count independently proves that one
 * physical send produced one charge.
 */
describe("transient send accounting stays request-scoped", () => {
  test("separate retry legs and a derived child consume one shared allowance", async () => {
    const observer = recordingObserver();
    const parent = createRequestExecutionBudget(THREE_SEND_POLICY, "lr-shared", observer);
    const child = deriveRequestExecutionBudget(parent, THREE_SEND_POLICY);
    let physicalSends = 0;

    const sendOne = async (budget: RequestExecutionBudget): Promise<Response> =>
      fetchWithTransientRetry(async () => {
        physicalSends += 1;
        return new Response("ok");
      }, {
        attempts: budget.remainingBaseSends(3),
        onSendsConsumed: (count) => { budget.used += count; },
      });

    expect((await sendOne(parent)).status).toBe(200);
    expect((await sendOne(child)).status).toBe(200);
    expect((await sendOne(parent)).status).toBe(200);
    await expect(sendOne(child)).rejects.toBeInstanceOf(SendBudgetExhaustedError);

    expect(physicalSends).toBe(3);
    expect(parent.used).toBe(3);
    expect(child.used).toBe(3);
    expect(observer.charges).toBe(3);
    expect(observer.refunds).toBe(0);
  });

  test("an externally counted reservation and its helper report book one send", async () => {
    const observer = recordingObserver();
    const budget = createRequestExecutionBudget(THREE_SEND_POLICY, "lr-external", observer);
    const reserved = budget.reserveDispatch({
      sendClass: "auth-recovery",
      targetKey: "provider|model",
      countedExternally: true,
    });
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) throw new Error("unreachable");

    let physicalSends = 0;
    const response = await fetchWithTransientRetry(async () => {
      physicalSends += 1;
      return new Response("ok");
    }, {
      attempts: 1,
      onSendsConsumed: (count) => { budget.used += count; },
    });

    expect(response.status).toBe(200);
    expect(physicalSends).toBe(1);
    expect(budget.used).toBe(1);
    expect(observer.charges).toBe(1);
    expect(reserved.permit.use()).toBe(true);
    expect(reserved.permit.use()).toBe(false);
  });

  test("the transient wrapper reports a rejected physical send exactly once", async () => {
    const observer = recordingObserver();
    const budget = createRequestExecutionBudget(THREE_SEND_POLICY, "lr-rejected", observer);
    const reports: number[] = [];
    let physicalSends = 0;
    const rejection = new Error("transport failed before a response");

    await expect(fetchWithTransientRetry(async () => {
      physicalSends += 1;
      throw rejection;
    }, {
      attempts: budget.remainingBaseSends(3),
      onSendsConsumed: (count) => {
        reports.push(count);
        budget.used += count;
      },
    })).rejects.toBe(rejection);

    expect(physicalSends).toBe(1);
    expect(reports).toEqual([1]);
    expect(budget.used).toBe(1);
    expect(observer.charges).toBe(1);
  });
});

/**
 * The reset helper is also a physical-send owner. It must report before awaiting the transport,
 * while the transient wrapper must suppress that inner report because its counted fetch already
 * owns the same send. Otherwise a rejected send disappears, or a successful send is charged twice.
 */
describe("retry helpers expose one accounting event per physical send", () => {
  test("the reset-only helper reports a rejected send", async () => {
    const reports: number[] = [];
    let physicalSends = 0;
    const rejection = new Error("connection refused");

    await expect(fetchWithResetRetry(async () => {
      physicalSends += 1;
      throw rejection;
    }, {
      attempts: 1,
      onSendsConsumed: (count) => reports.push(count),
    })).rejects.toBe(rejection);

    expect(physicalSends).toBe(1);
    expect(reports).toEqual([1]);
  });

  test("the transient wrapper suppresses the nested reset report", async () => {
    const reports: number[] = [];
    let physicalSends = 0;

    const response = await fetchWithTransientRetry(async () => {
      physicalSends += 1;
      return new Response("ok");
    }, {
      attempts: 1,
      onSendsConsumed: (count) => reports.push(count),
    });

    expect(response.status).toBe(200);
    expect(physicalSends).toBe(1);
    expect(reports).toEqual([1]);
  });

  test("zero remaining sends refuses both helpers before dispatch", async () => {
    for (const send of [fetchWithResetRetry, fetchWithTransientRetry]) {
      let physicalSends = 0;
      await expect(send(async () => {
        physicalSends += 1;
        return new Response("must not send");
      }, { attempts: 0 })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
      expect(physicalSends).toBe(0);
    }
  });
});
