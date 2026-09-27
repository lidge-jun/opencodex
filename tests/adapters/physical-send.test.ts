import { afterEach, describe, expect, test } from "bun:test";
import { createAdapterPhysicalSend } from "../../src/adapters/physical-send";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { budgetOwner } from "../helpers/send-budget-owner";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../../src/types";

const url = "https://adapter-fixture.invalid/inference";
afterEach(() => resetProviderRequestPacingForTest());

/**
 * A credential hop has already reserved the replay it hands to the adapter, so the adapter's
 * first send spends that permit through the dispatch view instead of reserving again.
 */
function prepaid() {
  const parent = createRequestExecutionBudget();
  parent.used = 3;
  const { owner, dispose } = budgetOwner(parent);
  const hop = owner.reserveCredentialHop("auth-recovery", url, true);
  if (!hop.allowed || !hop.permit) throw new Error("Expected prepaid final send");
  owner.pendingHopPermit = hop.permit;
  const scope = owner.adapterDispatchBudget;
  if (!scope) throw new Error("Expected an adapter dispatch budget");
  return { parent, scope, dispose };
}

describe("adapter physical inference admission", () => {
  test("returns a concurrency lease after body completion and a pre-dispatch refusal", async () => {
    const configured = {
      adapter: "openai-chat", baseUrl: "https://adapter-fixture.invalid",
      requestPacing: { enabled: true, maxConcurrentRequests: 1 },
      fetch: Object.assign(async () => new Response("ok"), { preconnect() {} }) as typeof fetch,
    } as OcxProviderConfig & { fetch: typeof fetch };
    const executor = providerFetch(configured, undefined, { providerName: "physical", modelId: "a" });
    const controller = new AbortController();
    const send = createAdapterPhysicalSend({ abortSignal: controller.signal }, executor);
    await expect(send({ url, beforeDispatch: () => { throw new Error("refused"); },
      dispatch: physical => physical(url) })).rejects.toThrow("refused");
    const first = await send({ url, dispatch: physical => physical(url) });
    expect(await first.text()).toBe("ok");
    expect(await (await send({ url, dispatch: physical => physical(url) })).text()).toBe("ok");
  });

  test("a prepaid scope admits exactly one physical send and rejects replay before backoff", async () => {
    const { parent, scope, dispose } = prepaid();
    let sends = 0, waits = 0, pacingSlots = 0;
    const ordinals: number[] = [];
    try {
      const send = createAdapterPhysicalSend({ sendBudget: scope, onPhysicalSend: event => ordinals.push(event.ordinal) },
        Object.assign(async () => { sends += 1; return new Response("ok"); }, {
          waitForPacing: async () => { pacingSlots += 1; },
        }) as typeof fetch);
      await send({ url, dispatch: executor => executor(url) });
      await expect(send({ url, sendClass: "repair", beforeDispatch: () => { waits += 1; },
        dispatch: executor => executor(url) })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
      expect(sends).toBe(1);
      expect(waits).toBe(0);
      expect(pacingSlots).toBe(1);
      expect(ordinals).toEqual([1]);
      expect(parent.used).toBe(4);
    } finally { dispose(); }
  });

  test.each(["pacing", "backoff", "abort", "adapter"] as const)("unused reservation refunds after %s refusal", async phase => {
    const parent = createRequestExecutionBudget();
    parent.used = 3;
    let sends = 0;
    const controller = new AbortController();
    const failure = new Error(`fixture ${phase} refusal`);
    const executor = Object.assign(async () => { sends += 1; return new Response("unexpected"); }, {
      waitForPacing: async () => { if (phase === "pacing") throw failure; },
    }) as typeof fetch;
    const send = createAdapterPhysicalSend({ sendBudget: parent, abortSignal: controller.signal }, executor);
    // A reserve-funded class still gets a real permit once the base allowance is spent; the
    // refusal paths below never reach its dispatch, so the reservation must be handed back.
    await expect(send({ url, sendClass: "repair", beforeDispatch: () => {
      if (phase === "backoff") throw failure;
      if (phase === "abort") controller.abort(failure);
    }, dispatch: physical => {
      if (phase === "adapter") throw failure;
      return physical(url);
    } })).rejects.toBe(failure);
    expect(parent.used).toBe(3);
    expect(parent.reserveSpent).toBe(false);
    expect(sends).toBe(0);
  });

  test.each(["pacing", "backoff", "abort", "adapter"] as const)("a settled hop charge stays charged when the %s leg never dispatches", async phase => {
    const { parent, scope, dispose } = prepaid();
    let sends = 0;
    const controller = new AbortController();
    const failure = new Error(`fixture ${phase} refusal`);
    const executor = Object.assign(async () => { sends += 1; return new Response("unexpected"); }, {
      waitForPacing: async () => { if (phase === "pacing") throw failure; },
    }) as typeof fetch;
    try {
      const send = createAdapterPhysicalSend({ sendBudget: scope, abortSignal: controller.signal }, executor);
      await expect(send({ url, beforeDispatch: () => {
        if (phase === "backoff") throw failure;
        if (phase === "abort") controller.abort(failure);
      }, dispatch: physical => {
        if (phase === "adapter") throw failure;
        return physical(url);
      } })).rejects.toBe(failure);
      // The hop's reservation was the charge and the dispatch view settled it at admission;
      // the adapter's release has nothing left to refund.
      expect(parent.used).toBe(4);
      expect(parent.reserveSpent).toBe(true);
      expect(sends).toBe(0);
    } finally { dispose(); }
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
