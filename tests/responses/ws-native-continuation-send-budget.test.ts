import { afterEach, beforeEach, expect, test } from "bun:test";
import { bindWorkflowBudgetConfig } from "../../src/lib/workflow-budget-config";
import { resetWorkflowBudgetsForTest, workflowBudgetSnapshot, listWorkflowBudgetEvents, WORKFLOW_LOCAL_REFUSAL_HEADER } from "../../src/lib/workflow-budget";
import { configureSharedSpendLedger, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import { claimNativeContinuationSend } from "../../src/server/responses/native-continuation-send";
import { NativeContinuationRefusalError } from "../../src/server/responses/native-continuation-refusal";
import {
  installInjectionFixture, prepareInjectionSpendHome, beginInjection, injectionConfig,
  advertiseInjection, completeInjection, savedResult, continuationFrame,
  acknowledgeInjection, waitForInjection, fallbackCalls, InjectionSocket,
} from "../helpers/native-injection-fixture";

installInjectionFixture();
beforeEach(() => resetWorkflowBudgetsForTest());
afterEach(() => { bindWorkflowBudgetConfig(null); resetWorkflowBudgetsForTest(); });

async function begin(root: string, limit?: number, enforced = false, mode: "injection" | "steering" = "injection") {
  prepareInjectionSpendHome();
  bindWorkflowBudgetConfig(limit === undefined ? null : { workflowBudget: { maxPhysicalSends: limit } });
  configureSharedSpendLedger(spendPolicyFromConfig(enforced ? { root: { maxTokens: 1_000_000 } } : undefined));
  const fields = mode === "steering" ? { multi_agent: undefined } : {};
  return beginInjection(fields, { ...injectionConfig(), codexNativeSteering: mode === "steering" }, "test",
    { "x-codex-parent-thread-id": root, "thread-id": root });
}

for (const mode of ["injection", "steering"] as const) for (const enforced of [false, true]) for (const limit of [1, 2]) {
  test(`${mode} continuation stops at the root ceiling ${limit} (spend=${enforced})`, async () => {
    const root = `native-budget-${mode}-${limit}-${enforced}`;
    const x = await begin(root, limit, enforced, mode);
    expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 1, active: 1 });
    let id = x.id;
    for (let sendNumber = 1; sendNumber <= limit; sendNumber++) {
      const call = `call-${sendNumber}`;
      const item = advertiseInjection(x.socket, call);
      if (mode === "steering") {
        x.send({ type: "response.steer", previous_response_id: id, input: "continue with the saved result" });
        x.socket.emit({ type: "response.steer.accepted", steer: { id: `steer-${sendNumber}`, previous_response_id: id } });
        expect(workflowBudgetSnapshot(root)?.sends).toBe(sendNumber);
      }
      completeInjection(x.socket, { output: [item] }, id);
      if (mode === "steering") x.socket.emit({ type: "response.steer.pending",
        steer: { id: `steer-${sendNumber}`, previous_response_id: id }, reason: "waiting_for_required_input",
        required_input: [{ type: "function_call_output", call_id: call }] });
      await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed" && frame.response.id === id));
      expect(x.ws.data.nativeControl).toBeDefined();
      const before = x.socket.frames.length;
      x.send(continuationFrame({ type: "response.create", previous_response_id: id, input: [savedResult(call)],
        ...(mode === "steering" ? { multi_agent: undefined } : {}) }));
      // Channel admission and the pacing microtask do not claim a physical start.
      expect(x.socket.frames).toHaveLength(before);
      expect(workflowBudgetSnapshot(root)?.sends).toBe(sendNumber);
      if (sendNumber < limit) {
        await waitForInjection(() => x.socket.frames.length === before + 1);
        expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: sendNumber + 1, active: 1 });
        const previous = id; id = `successor-${sendNumber}`;
        x.socket.emit({ type: "response.created", response: { id, previous_response_id: previous, output: [] } });
      }
    }
    await waitForInjection(() => x.sent.some(frame => frame.type === "error")
      || x.socket.frames.filter(frame => frame.type === "response.create").length > limit);
    expect(x.socket.frames.filter(frame => frame.type === "response.create")).toHaveLength(limit);
    await waitForInjection(() => !x.ws.data.nativeControl);
    const refusal = x.sent.find(frame => frame.type === "error")!;
    expect(refusal.status).toBe(429);
    expect(refusal.headers?.[WORKFLOW_LOCAL_REFUSAL_HEADER]).toBe("workflow_sends_exhausted");
    expect(refusal.error.message).toContain("no additional provider request was sent");
    expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: limit, active: 0 });
    expect(listWorkflowBudgetEvents().filter(event => event.rootId === root && event.kind === "refused")).toHaveLength(1);
    expect(InjectionSocket.all).toHaveLength(1);
    expect(fallbackCalls).toBe(0);
  });
}

for (const enforced of [false, true]) test(`native chains without a send ceiling exceed four sends (spend=${enforced})`, async () => {
  const root = `native-unconfigured-chain-${enforced}`;
  const x = await begin(root, undefined, enforced);
  let id = x.id;
  for (let i = 1; i <= 5; i++) {
    const call = `call-${i}`, item = advertiseInjection(x.socket, call);
    completeInjection(x.socket, { output: [item] }, id);
    await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed" && frame.response.id === id));
    x.send(continuationFrame({ type: "response.create", previous_response_id: id, input: [savedResult(call)] }));
    await waitForInjection(() => x.socket.frames.length === i + 1 || x.sent.some(frame => frame.type === "error"));
    expect(x.socket.frames).toHaveLength(i + 1);
    expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: i + 1, active: 1 });
    const previous = id; id = `long-successor-${i}`;
    x.socket.emit({ type: "response.created", response: { id, previous_response_id: previous, output: [] } });
  }
  completeInjection(x.socket, {}, id);
  await waitForInjection(() => !x.ws.data.nativeControl);
  expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 6, active: 0 });
  expect(x.sent.filter(frame => frame.type === "error")).toHaveLength(0);
  expect(fallbackCalls).toBe(0);
});

test("cancellation while a continuation is queued claims no additional send", async () => {
  const root = "native-cancelled-before-send";
  const x = await begin(root, 2);
  const item = advertiseInjection(x.socket);
  completeInjection(x.socket, { output: [item] });
  await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed"));
  x.send(continuationFrame({ type: "response.create", previous_response_id: x.id, input: [savedResult()] }));
  x.ws.close();
  await waitForInjection(() => !x.ws.data.nativeControl && x.ws.data.cancel === undefined);
  expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 1, active: 0 });
  expect(x.socket.frames).toHaveLength(1);
  expect(fallbackCalls).toBe(0);
});

test("native injection control frames do not consume the next continuation slot", async () => {
  const root = "native-control-not-a-send";
  const x = await begin(root, 2);
  const first = advertiseInjection(x.socket, "injected");
  const remaining = advertiseInjection(x.socket, "continued", 1);
  x.send({ type: "response.inject", response_id: x.id, input: [savedResult("injected")] });
  await waitForInjection(() => x.socket.frames.length === 2);
  acknowledgeInjection(x.socket);
  expect(workflowBudgetSnapshot(root)?.sends).toBe(1);
  completeInjection(x.socket, { output: [first, remaining] });
  await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed"));
  x.send(continuationFrame({ type: "response.create", previous_response_id: x.id, input: [savedResult("continued")] }));
  await waitForInjection(() => x.socket.frames.length === 3);
  expect(workflowBudgetSnapshot(root)?.sends).toBe(2);
  x.socket.emit({ type: "response.created", response: { id: "control-successor", previous_response_id: x.id, output: [] } });
  completeInjection(x.socket, {}, "control-successor");
  await waitForInjection(() => !x.ws.data.nativeControl);
  expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 2, active: 0 });
  expect(fallbackCalls).toBe(0);
});

test("native token-ceiling refusal preserves its workflow identity after earlier sends", async () => {
  const root = "native-token-refusal";
  prepareInjectionSpendHome(); bindWorkflowBudgetConfig(null);
  configureSharedSpendLedger(spendPolicyFromConfig({ root: { maxTokens: 4096 } }));
  const x = await beginInjection({ max_output_tokens: 1024 }, injectionConfig(), "test",
    { "x-codex-parent-thread-id": root, "thread-id": root });
  let id = x.id, refused = false;
  for (let i = 1; i <= 8; i++) {
    const call = `token-call-${i}`, item = advertiseInjection(x.socket, call);
    completeInjection(x.socket, { output: [item] }, id);
    await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed" && frame.response.id === id));
    const count = x.socket.frames.length;
    x.send(continuationFrame({ type: "response.create", previous_response_id: id,
      max_output_tokens: 1024, input: [savedResult(call)] }));
    await waitForInjection(() => x.socket.frames.length > count || x.sent.some(frame => frame.type === "error"));
    const error = x.sent.find(frame => frame.type === "error");
    if (error) {
      refused = true;
      expect(error.status).toBe(429);
      expect(error.headers?.[WORKFLOW_LOCAL_REFUSAL_HEADER]).toBe("workflow_spend_exhausted");
      expect(error.error.message.replaceAll(",", "")).toContain("4096");
      expect(x.socket.frames).toHaveLength(count);
      expect(workflowBudgetSnapshot(root)?.sends).toBe(count);
      break;
    }
    const previous = id; id = `token-successor-${i}`;
    x.socket.emit({ type: "response.created", response: { id, previous_response_id: previous, output: [] } });
  }
  expect(refused).toBe(true);
  const denials = listWorkflowBudgetEvents().filter(event => event.rootId === root && event.kind === "refused");
  expect(denials).toHaveLength(1);
  expect(denials[0]).toMatchObject({ reason: "workflow-spend-exhausted", spendScope: "root", spendLimit: 4096 });
  await waitForInjection(() => !x.ws.data.nativeControl);
  expect(workflowBudgetSnapshot(root)?.active).toBe(0);
  expect(fallbackCalls).toBe(0);
});

test("an independent continuation refusal does not replay stale spend details", async () => {
  let reports = 0, closes = 0;
  const tracker = { refusals: 1, settle() {}, lastRefusal: {
    reason: "workflow-spend-exhausted", spend: { scope: "pool", limit: 7, projected: 8, includesUnboundPoolHistory: true },
  } };
  const reporter = Object.assign((_count: number) => { reports++; }, { beforeSend: () => false, close: () => { closes++; } });
  let refusal: Response | undefined;
  try { claimNativeContinuationSend(reporter, { model: "m", provider: "fixture", spendTracker: tracker,
    spendRefusalDetail: { scope: "pool", limit: 7, projected: 8, includesUnboundPoolHistory: true } }); }
  catch (error) { if (!(error instanceof NativeContinuationRefusalError)) throw error; refusal = error.response; }
  expect(refusal?.status).toBe(429);
  expect(refusal?.headers.has(WORKFLOW_LOCAL_REFUSAL_HEADER)).toBe(false);
  expect((await refusal!.json()).error.message).toContain("request send budget exhausted before dispatch");
  expect(reports).toBe(0); expect(closes).toBe(1);
});
