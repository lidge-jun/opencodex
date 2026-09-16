import { describe, expect, test } from "bun:test";
import { createAdapterPhysicalSend } from "../../src/adapters/physical-send";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";

const url = "https://adapter-fixture.invalid/inference";
function prepaid() {
  const parent = createRequestExecutionBudget();
  parent.used = 3;
  const hop = parent.reserveDispatch({ sendClass: "auth-recovery", targetKey: url, countedExternally: true });
  if (!hop.allowed) throw new Error("Expected prepaid final send");
  const scope = parent.deriveScope({ ...parent.policy, finalRecoveryAllowance: 0 }, hop.permit);
  return { parent, scope, hop: hop.permit };
}

describe("adapter physical inference admission", () => {
  test("a prepaid scope admits exactly one physical send and rejects replay before backoff", async () => {
    const { parent, scope, hop } = prepaid();
    let sends = 0, waits = 0;
    const ordinals: number[] = [];
    const send = createAdapterPhysicalSend({ sendBudget: scope, onPhysicalSend: event => ordinals.push(event.ordinal) },
      (async () => { sends += 1; return new Response("ok"); }) as typeof fetch);
    await send({ url, dispatch: executor => executor(url) });
    await expect(send({ url, sendClass: "repair", beforeDispatch: () => { waits += 1; },
      dispatch: executor => executor(url) })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    hop.release();
    expect(sends).toBe(1);
    expect(waits).toBe(0);
    expect(ordinals).toEqual([1]);
    expect(parent.used).toBe(4);
  });

  test.each(["pacing", "backoff", "abort", "adapter"] as const)("unused prepaid send refunds after %s refusal", async phase => {
    const { parent, scope, hop } = prepaid();
    let sends = 0;
    const controller = new AbortController();
    const failure = new Error(`fixture ${phase} refusal`);
    const executor = Object.assign(async () => { sends += 1; return new Response("unexpected"); }, {
      waitForPacing: async () => { if (phase === "pacing") throw failure; },
    }) as typeof fetch;
    const send = createAdapterPhysicalSend({ sendBudget: scope, abortSignal: controller.signal }, executor);
    await expect(send({ url, beforeDispatch: () => {
      if (phase === "backoff") throw failure;
      if (phase === "abort") controller.abort(failure);
    }, dispatch: physical => {
      if (phase === "adapter") throw failure;
      return physical(url);
    } })).rejects.toBe(failure);
    hop.release();
    expect(parent.used).toBe(3);
    expect(parent.reserveSpent).toBe(false);
    expect(sends).toBe(0);
  });

  test("an exhausted initial send performs no inference or retry preparation", async () => {
    const budget = createRequestExecutionBudget();
    budget.used = 4;
    let prepared = false, sends = 0;
    const send = createAdapterPhysicalSend({ sendBudget: budget },
      (async () => { sends += 1; return new Response("unexpected"); }) as typeof fetch);
    await expect(send({ url, beforeDispatch: () => { prepared = true; },
      dispatch: physical => physical(url) })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(prepared).toBe(false);
    expect(sends).toBe(0);
    expect(budget.used).toBe(4);
  });
});
