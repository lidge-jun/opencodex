import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { createAdapterPhysicalSend } from "../../src/adapters/physical-send";
import { getActiveTurnCount } from "../../src/server/lifecycle";
import * as transport from "../../src/server/responses/request-transport";
import * as oauth from "../../src/oauth/generic-account-failover";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { hostedSendFixture } from "../helpers/hosted-send-fixture";
import { budgetOwner } from "../helpers/send-budget-owner";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { createSidecarSendBudget } from "../../src/server/responses/sidecar-send-budget";
import { createTranslatorBudget } from "../../src/lib/translator-budget";

let forbiddenNetwork: ReturnType<typeof spyOn>;
beforeEach(() => {
  resetProviderRequestPacingForTest();
  forbiddenNetwork = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => {
    throw new Error("Hosted hop regression forbids live network");
  }, { preconnect() {} }));
});
afterEach(() => {
  const calls = forbiddenNetwork.mock.calls.length;
  forbiddenNetwork.mockRestore();
  resetProviderRequestPacingForTest();
  expect(calls).toBe(0);
});

// Only credential selection is synthetic; the hosted loop, dispatch budget and journal are real.
/** Replace only credential selection while exercising real hosted dispatch and settlement. */
async function withSyntheticRotation(run: (rotated: () => boolean) => Promise<void>, onRotation = () => {}) {
  let rotated = false;
  const prepare = transport.prepareResponsesTransport;
  const prepared = spyOn(transport, "prepareResponsesTransport").mockImplementation(async (...args) => {
    const state = await prepare(...args);
    if (state instanceof Response) return state;
    state.genericFailoverAccountId = "synthetic-first";
    state.applyFailoverSnapshot = async snapshot => { rotated = true; onRotation(); return snapshot; };
    return state;
  });
  const enabled = spyOn(oauth, "isGenericOAuthFailoverEnabled").mockReturnValue(true);
  const rotate = spyOn(oauth, "rotateGenericOAuthAccountOn429").mockReturnValue("synthetic-second");
  const snapshot = spyOn(oauth, "failoverAccountSnapshot").mockResolvedValue({ provider: "a", accountId: "synthetic-second",
    generation: "synthetic-generation", accessToken: "synthetic-token" });
  try { await run(() => rotated); }
  finally { snapshot.mockRestore(); rotate.mockRestore(); enabled.mockRestore(); prepared.mockRestore(); }
}

test("real Vertex hosted search refunds replay cancelled after reservation while queued for pacing", async () => hostedSendFixture("search", "failover", async f => {
  const controller = new AbortController();
  let physical = 0, sawQueuedReservation = false, poll: ReturnType<typeof setInterval> | undefined;
  Object.assign(f.config.providers.a!, { adapter: "google", googleMode: "vertex",
    requestPacing: { enabled: true, minIntervalMs: 1000 },
    fetch: async () => { physical++; return Response.json({ error: { status: "RESOURCE_EXHAUSTED", message: "daily limit reached" } }, { status: 429 }); } });
  delete f.config.providers.a!.transientRetryOn5xx;
  const deadline = setTimeout(() => controller.abort(new Error("synthetic queue observation timeout")), 500);
  try {
    await withSyntheticRotation(async () => {
      const response = await f.dispatch(controller.signal); await response.text();
      expect(response.status).toBe(499); expect(sawQueuedReservation).toBe(true);
      expect(physical).toBe(1); expect(f.budget.used).toBe(1);
      expect(f.charges).toBe(2); expect(f.refunds).toBe(1);
      expect(f.settle()).toMatchObject({ settled: 3, reserved: 0, unresolved: 0 });
      expect(getActiveTurnCount()).toBe(0);
    }, () => {
      poll = setInterval(() => {
        if (providerRequestPacingStatus("a", f.config.providers.a!).queued > 0 && f.charges === 2 && f.budget.used === 2) {
          sawQueuedReservation = true;
          clearInterval(poll);
          controller.abort(new Error("synthetic queued replay cancellation"));
        }
      }, 1);
    });
  } finally { clearInterval(poll); clearTimeout(deadline); }
}));

for (const kind of ["search", "image", "video"] as const) for (const sent of [false, true]) {
  test(`${kind} adapter OAuth replay ${sent ? "cancelled after dispatch stays charged" : "beforeDispatch failure refunds only unsent hop"}`, async () => hostedSendFixture(kind, "failover", async f => {
    delete f.config.providers.a!.transientRetryOn5xx;
    const controller = new AbortController();
    let physical = 0, replayPrepared = false;
    f.config.providers.a!.fetch = (async () => {
      physical++;
      if (physical === 1) return Response.json({ error: { message: "synthetic quota refusal" } }, { status: 429 });
      controller.abort(new Error("synthetic dispatched replay cancellation"));
      throw controller.signal.reason;
    }) as unknown as typeof fetch;
    await withSyntheticRotation(async rotated => {
      const create = ADAPTER_REGISTRY["openai-chat"].create;
      const adapter = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({
        ...create(...args), async fetchResponse(request, ctx) {
          const send = createAdapterPhysicalSend(ctx);
          return send({ url: request.url, beforeDispatch: () => {
            if (!rotated()) return;
            replayPrepared = true;
            expect(f.budget.used).toBe(2); expect(f.charges).toBe(2); expect(f.refunds).toBe(0);
            if (!sent) throw new Error("synthetic abandoned hop before send");
          }, dispatch: executor => executor(request.url, { method: request.method, headers: request.headers,
            body: request.body, signal: ctx?.abortSignal }) });
        },
      }));
      try {
        const response = await f.dispatch(controller.signal); const text = await response.text();
        expect(response.ok).toBe(false); expect(replayPrepared).toBe(true);
        if (!sent) { expect(response.status).toBe(502); expect(text).toContain("synthetic abandoned hop before send"); }
        expect(physical).toBe(sent ? 2 : 1); expect(f.budget.used).toBe(sent ? 2 : 1);
        expect(f.charges).toBe(2); expect(f.refunds).toBe(sent ? 0 : 1);
        expect(f.settle()).toMatchObject({ settled: 3, reserved: 0, unresolved: sent ? 3 : 0 });
        expect(getActiveTurnCount()).toBe(0);
      } finally { adapter.mockRestore(); }
    });
  }));
}

for (const claimed of [false, true]) for (const sent of [false, true]) test(`sidecar iteration cannot release active producer hop (claimed=${claimed}, sent=${sent})`, async () => {
  let refunds = 0, physical = 0;
  const budget = createRequestExecutionBudget(undefined, undefined, { charge: () => true, refund: () => { refunds++; } });
  const initial = budget.reserveDispatch({ sendClass: "initial", targetKey: "endpoint-one", countedExternally: true });
  if (!initial.allowed) throw new Error("synthetic initial denied");
  const translatorBudget = createTranslatorBudget();
  const options = { sendBudget: budget, translatorBudget, comboInitialSend: { permit: initial.permit } };
  const owner = createResponsesSendBudget({ req: new Request("http://localhost/v1/responses"),
    logCtx: { provider: "a", model: "m" }, options });
  if (owner instanceof Response) throw new Error("synthetic owner refused");
  const sidecar = createSidecarSendBudget(options, owner, () => undefined);
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  try {
    sidecar.takeProducerOwnership();
    const first = owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey: "endpoint-one" });
    if (!first.allowed || !first.permit.use()) throw new Error("synthetic initial dispatch denied");
    sidecar.ownCredentialHop(owner.reserveCredentialHop("auth-recovery", "endpoint-one", true).permit);
    const send = createAdapterPhysicalSend({ sendBudget: owner.adapterDispatchBudget,
      executor: (async () => { physical++; return Response.json({ ok: true }); }) as unknown as typeof fetch });
    const producer = claimed ? send({ url: "endpoint-one", beforeDispatch: async () => {
      entered(); await gate;
      if (!sent) throw new Error("synthetic abandoned producer");
    }, dispatch: executor => executor("https://synthetic.invalid") }) : undefined;
    const result = producer?.then(() => undefined, error => error);
    if (claimed) await waiting;
    sidecar.releaseUnsentHop();
    expect(budget.used).toBe(2); expect(refunds).toBe(0);
    resume();
    if (claimed && sent) expect(await result).toBeUndefined();
    else if (claimed) expect(await result).toBeInstanceOf(Error);
    sidecar.release(); sidecar.releaseUnsentHop(); sidecar.release();
    expect(owner.pendingHopPermit).toBeUndefined();
    expect(physical).toBe(claimed && sent ? 1 : 0);
    expect(budget.used).toBe(claimed && sent ? 2 : 1); expect(refunds).toBe(claimed && sent ? 0 : 1);
  } finally { resume(); sidecar.release(); translatorBudget.dispose(); }
});

/** Reserve a recovery hop after a consumed initial send with observable refunds. */
function hopOwner(maxTargetTransitions = 1) {
  let charges = 0, refunds = 0;
  const budget = createRequestExecutionBudget({ baseSendAllowance: 1, maxTotalModelSends: 2,
    finalRecoveryAllowance: 1, maxAlternateTargetSends: 1, maxTargetTransitions }, undefined, {
    charge: () => { charges++; return true; }, refund: () => { refunds++; },
  });
  const { owner, dispose } = budgetOwner(budget);
  const first = budget.reserveDispatch({ sendClass: "initial", targetKey: "endpoint-one" });
  if (!first.allowed || !first.permit.use()) throw new Error("synthetic first dispatch denied");
  const hop = owner.reserveCredentialHop("auth-recovery", "diagnostic-hop", true);
  if (!hop.permit) throw new Error("synthetic hop denied");
  owner.pendingHopPermit = hop.permit;
  return { budget, owner, dispose, hop: hop.permit, get charges() { return charges; }, get refunds() { return refunds; } };
}

for (const sent of [false, true]) test(`same-endpoint replay retains exact permit single-use and refund ownership (${sent})`, () => {
  const f = hopOwner();
  try {
    expect(f.owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey: "endpoint-one", replaySafe: false }))
      .toMatchObject({ allowed: false, reason: "not-replay-safe" });
    expect(f.owner.pendingHopPermit).toBe(f.hop);
    const replay = f.owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey: "endpoint-one" });
    if (!replay.allowed) throw new Error("synthetic replay denied");
    expect(f.owner.pendingHopPermit).toBeUndefined(); expect(f.budget.used).toBe(2); expect(f.charges).toBe(2);
    if (sent) expect(replay.permit.use()).toBe(true);
    replay.permit.release(); replay.permit.release(); f.hop.release();
    expect(replay.permit.use()).toBe(false); expect(replay.permit.assumeCharge()).toBe(false);
    expect(f.hop.use()).toBe(false); expect(f.refunds).toBe(sent ? 0 : 1); expect(f.budget.used).toBe(sent ? 2 : 1);
    if (sent) {
      // Closing the exact external booking cannot swallow a later independent send report.
      f.owner.noteTransientSends(1); expect(f.budget.used).toBe(3); expect(f.charges).toBe(3);
    }
  } finally { f.dispose(); }
});

for (const cap of [0, 1]) test(`rotated endpoint still passes transition admission and refunds unsent replacement (${cap})`, () => {
  const f = hopOwner(cap);
  try {
    const replay = f.owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey: "endpoint-two" });
    expect(f.hop.use()).toBe(false); expect(f.refunds).toBe(1);
    if (cap === 0) {
      expect(replay).toMatchObject({ allowed: false, reason: "target-transition-exhausted" });
      expect(f.budget.used).toBe(1); expect(f.charges).toBe(2);
    } else {
      if (!replay.allowed) throw new Error("synthetic endpoint transition denied");
      expect(f.budget.targetTransitions).toBe(1); expect(f.budget.used).toBe(2); expect(f.charges).toBe(3);
      replay.permit.release(); replay.permit.release();
      expect(f.budget.targetTransitions).toBe(0); expect(f.budget.used).toBe(1); expect(f.refunds).toBe(2);
    }
  } finally { f.dispose(); }
});

for (const settled of ["used", "released"] as const) test(`a hop already ${settled} by another owner cannot authorize replacement dispatch`, () => {
  const f = hopOwner();
  try {
    if (settled === "used") expect(f.hop.assumeCharge()).toBe(true);
    else f.hop.release();
    const replay = f.owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey: "endpoint-one" });
    if (!replay.allowed) throw new Error("synthetic handoff missing");
    expect(replay.permit.use()).toBe(false); expect(replay.permit.assumeCharge()).toBe(false);
    replay.permit.release();
    expect(f.charges).toBe(2); expect(f.refunds).toBe(settled === "used" ? 0 : 1);
    expect(f.budget.used).toBe(settled === "used" ? 2 : 1);
  } finally { f.dispose(); }
});
