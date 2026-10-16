import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { createNativeChatComboSource } from "../../src/server/chat-native";
import { createProtocolEnvelope } from "../../src/protocols/envelope";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses/core";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { getActiveTurnCount } from "../../src/server/lifecycle";
import { createRequestExecutionBudget, deriveRequestExecutionBudget, type RequestSendObserver } from "../../src/lib/request-execution-budget";
import { createResponsesSendBudget, transientSendCapFor } from "../../src/server/responses/request-send-budget";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { sharedSpendLedger } from "../../src/lib/spend-reservation-ledger";
import { comboExecutionBudgetPolicy } from "../../src/server/responses/core-combo";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { responsesSuccess, chatSuccess } from "../helpers/combo-failover-upstream";

let home: string, prior: string | undefined, codex: IsolatedCodexHome, release: () => void;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
beforeEach(() => {
  prior = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "first-send-reservation-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("first-send-codex-");
  release = acquireOwnedSpendHome();
  clearComboSelectionState(); clearComboTargetCooldowns(); clearKeyCooldowns();
});
afterEach(async () => {
  release();
  for (const server of servers.splice(0)) await server.stop(true);
  closeRequestHistoryIndex(); await flushResponseState(); clearResponseStateForTests();
  clearComboSelectionState(); clearComboTargetCooldowns(); clearKeyCooldowns();
  resetProviderRequestPacingForTest();
  if (prior === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prior;
  codex.restore(); removeTreeWithRetry(home);
});

/** Capture physical inference bodies on a loopback server with a fixed response status. */
function upstream(status = 200) {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    bodies.push(await req.json() as Record<string, unknown>);
    return status === 200 ? Response.json(responsesSuccess("fixture answer", "m"))
      : Response.json({ error: { message: "fixture unavailable" } }, { status });
  } });
  servers.push(server);
  return { bodies, baseUrl: new URL("/v1", server.url).href };
}
/** Configure the synthetic Responses provider with an optional transient-send ceiling. */
function provider(baseUrl: string, attempts: number | undefined = 1): OcxProviderConfig {
  return { adapter: "openai-responses", baseUrl, allowPrivateNetwork: true,
    apiKey: "fixture-inference-key", authMode: "key", liveModels: false, models: ["m"],
    reasoningEfforts: ["low", "high"], ...(attempts === undefined ? {} : { transientRetryOn5xx: { attempts } }) };
}
/** Observe shared charges and refunds independently of synthetic judge calls. */
function fixture(strategy: "jev" | "failover" | "direct", status = 200, attempts: number | undefined = 1) {
  const inference = upstream(status);
  let judgeCalls = 0;
  const config: OcxConfig = { port: 0, defaultProvider: "a", providers: { a: provider(inference.baseUrl, attempts) },
    ...(strategy === "direct" ? {} : { combos: { auto: { strategy, targets: [{ provider: "a", model: "m" }] } } }) };
  if (strategy === "jev") config.providers.jev = Object.assign({ adapter: "jev-decision", liveModels: false,
    baseUrl: "https://api.typesafe.ai/v1/systemone", apiKey: "fixture-service-key" }, {
    fetch: (async () => { judgeCalls++; return Response.json({ answers: { route: { choice: "a/m:low" } } }); }) as unknown as typeof fetch });
  let charges = 0, refunds = 0;
  const observer: RequestSendObserver = { charge: () => { charges++; return true; }, refund: () => { refunds++; } };
  const budget = createRequestExecutionBudget(undefined, undefined, observer);
  return { config, inference, budget, get judgeCalls() { return judgeCalls; }, get charges() { return charges; }, get refunds() { return refunds; } };
}
/** Dispatch and consume one synthetic request through the real Responses handler. */
async function send(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
  const log: RequestLogContext = { model: "", provider: "" };
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: f.config.combos ? "combo/auto" : "a/m", input: "Synthetic reservation task.", stream: false,
      reasoning: { effort: "high" } }), ...(signal ? { signal } : {}) });
  const response = await handleResponses(req, f.config, log, { sendBudget: f.budget, abortSignal: req.signal });
  const text = await response.text();
  return { response, log, text };
}

for (const strategy of ["jev", "failover", "direct"] as const) {
  test(`${strategy}: one-send policy reaches real Responses upstream exactly once`, async () => {
    const f = fixture(strategy);
    const { response, log } = await send(f);
    expect(response.status).toBe(200); expect(f.inference.bodies).toHaveLength(1);
    expect(f.budget.used).toBe(1); expect(f.charges).toBe(1); expect(f.refunds).toBe(0);
    expect(f.judgeCalls).toBe(strategy === "jev" ? 1 : 0);
    if (strategy === "jev") {
      expect(log.jevDecision?.selected.effort).toBe("low");
      expect((f.inference.bodies[0]!.reasoning as Record<string, unknown>).effort).toBe("low");
    }
  });
  test(`${strategy}: configured one-send 5xx cannot buy a retry or final recovery`, async () => {
    const f = fixture(strategy, 503);
    const { response, text } = await send(f);
    expect(response.status).toBe(503); expect(text).toContain("fixture unavailable");
    expect(f.inference.bodies).toHaveLength(1); expect(f.budget.used).toBe(1);
    expect(f.charges).toBe(1); expect(f.refunds).toBe(0);
  });
  test(`${strategy}: three-send 5xx ladder charges each physical send once`, async () => {
    const f = fixture(strategy, 503, 3);
    expect((await send(f)).response.status).toBe(503);
    expect(f.inference.bodies).toHaveLength(3); expect(f.budget.used).toBe(3);
    expect(f.charges).toBe(3); expect(f.refunds).toBe(0);
  }, 10_000);
}

for (const attempts of [1, 3, 10]) {
  test(`ordinary Combo: later target keeps its configured allowance under shared ceiling (${attempts})`, async () => {
    const f = fixture("failover", 503, attempts);
    const second = upstream(503), third = upstream(503);
    f.config.providers.b = provider(second.baseUrl, attempts); f.config.providers.c = provider(third.baseUrl, attempts);
    f.config.combos!.auto!.targets.push({ provider: "b", model: "m" }, { provider: "c", model: "m" });
    const { response, log } = await send(f);
    expect(response.status).toBe(503);
    const counts = [f.inference.bodies.length, second.bodies.length, third.bodies.length];
    expect(counts.every(count => count >= 1 && count <= attempts)).toBe(true);
    const sent = counts.reduce((sum, count) => sum + count, 0);
    expect(sent).toBeLessThanOrEqual(comboExecutionBudgetPolicy(3).maxTotalModelSends);
    expect(f.budget.used).toBe(sent); expect(f.charges).toBe(sent); expect(f.refunds).toBe(0);
    expect(log.attempts!.map(attempt => attempt.sendCount)).toEqual(counts);
  }, 15_000);
}

test("unconfigured Google Combo ladder respects prepaid allowance and later-target holdback", async () => {
  const f = fixture("failover", 503);
  const second = upstream(503), third = upstream(503);
  for (const [name, baseUrl] of [["a", f.inference.baseUrl], ["b", second.baseUrl], ["c", third.baseUrl]] as const) {
    const row = provider(baseUrl); delete row.transientRetryOn5xx; row.adapter = "google";
    f.config.providers[name] = row;
  }
  f.config.combos!.auto!.targets.push({ provider: "b", model: "m" }, { provider: "c", model: "m" });
  expect((await send(f)).response.status).toBe(503);
  const counts = [f.inference.bodies.length, second.bodies.length, third.bodies.length];
  expect(counts).toEqual([3, 2, 1]);
  expect(f.budget.used).toBe(comboExecutionBudgetPolicy(3).maxTotalModelSends);
  expect(f.charges).toBe(6); expect(f.refunds).toBe(0);
}, 10_000);

test("later translated Combo target retains configured recovery total", async () => {
  const f = fixture("failover", 503, 1);
  let sent = 0;
  f.config.providers.b = Object.assign({ ...provider("https://fixture.invalid", 2), adapter: "openai-chat",
    retryOn429: { attempts: 1, intervalMs: 1, maxIntervalMs: 1 } }, { fetch: (async () => {
      sent++;
      return sent === 1 ? Response.json({ error: { message: "fixture limited" } }, { status: 429 })
        : chatSuccess("fixture recovery", "m");
    }) as unknown as typeof fetch });
  f.config.combos!.auto!.targets.push({ provider: "b", model: "m" });
  expect((await send(f)).response.status).toBe(200);
  expect(sent).toBe(2); expect(f.budget.used).toBe(3); expect(f.charges).toBe(3);
});

for (const attempts of [1, 2]) for (const refused of [false, true]) test(`native Chat receipt owns pending booking (attempts=${attempts}, refused=${refused})`, async () => {
  const f = fixture("failover", 200, attempts);
  let sends = 0;
  f.config.providers.a = Object.assign({ ...f.config.providers.a!, adapter: "openai-chat",
    ...(refused ? { proxy: "direct" as const } : {}) }, {
    fetch: (async () => {
      sends++;
      return attempts === 2 && sends === 1 ? Response.json({ error: { message: "fixture transient" } }, { status: 503 })
        : chatSuccess("fixture native", "m");
    }) as unknown as typeof fetch });
  f.config.protocols = { rollout: { nativeChatCombos: true } };
  const other = f.budget.reserveDispatch({ sendClass: "initial", targetKey: "unrelated", countedExternally: true });
  if (!other.allowed) throw new Error("fixture refused");
  const translatorBudget = createTranslatorBudget();
  const body = { model: "combo/auto", messages: [{ role: "user", content: "fixture" }], stream: false };
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/auto", input: "fixture", stream: false }) });
  const protocolSource = createNativeChatComboSource({ req, config: f.config,
    envelope: createProtocolEnvelope({ inbound: "chat", body, translatorBudget }),
    requestedModel: "combo/auto", requestedStream: false, translatorBudget });
  try {
    const response = await handleResponses(req, f.config, { model: "", provider: "" }, {
      sendBudget: f.budget, translatorBudget, protocolSource });
    expect(response.ok).toBe(!refused); await response.text(); expect(sends).toBe(refused ? 0 : attempts);
    expect(f.budget.used).toBe(refused ? 1 : attempts + 1); expect(f.charges).toBe(refused ? 2 : attempts + 1);
    expect(f.refunds).toBe(refused ? 1 : 0);
    other.permit.release(); expect(f.budget.used).toBe(refused ? 0 : attempts); expect(f.refunds).toBe(refused ? 2 : 1);
  } finally { other.permit.release(); translatorBudget.dispose(); }
});

test("pre-dispatch body refusal refunds prepaid reservation and observer charge", async () => {
  const f = fixture("failover"); f.config.maxUpstreamBodyBytes = 1;
  expect((await send(f)).response.status).toBe(413);
  expect(f.inference.bodies).toHaveLength(0); expect(f.budget.used).toBe(0);
  expect(f.charges).toBe(1); expect(f.refunds).toBe(1);
});

test("missing credential refusal sends nothing and refunds reservation", async () => {
  const f = fixture("failover");
  delete f.config.providers.a!.apiKey;
  const { response } = await send(f);
  expect(response.ok).toBe(false); expect(f.inference.bodies).toHaveLength(0);
  expect(f.budget.used).toBe(0); expect(f.charges).toBe(f.refunds);
});

test("caller abort during queued dispatch refunds unsent booking", async () => {
  const f = fixture("failover");
  const controller = new AbortController();
  f.config.providers.a!.requestPacing = { enabled: true, minIntervalMs: 1000 };
  // Prime pacing with a separate logical request; this turn owns only its unsent booking.
  expect((await send({ ...f, budget: createRequestExecutionBudget() })).response.status).toBe(200);
  const before = f.budget.used;
  const timer = setTimeout(() => controller.abort(), 40);
  try {
    expect((await send(f, controller.signal)).response.status).toBe(499);
    expect(f.inference.bodies).toHaveLength(1); expect(f.budget.used).toBe(before);
    expect(f.charges).toBe(1); expect(f.refunds).toBe(1);
  } finally { clearTimeout(timer); }
});

test("detached Responses model judge keeps its own one-send booking and lease", async () => {
  const f = fixture("jev");
  delete f.config.providers.jev;
  const judge = upstream();
  let judgeSends = 0;
  // A model judge needs the choice in its output text rather than in the service envelope.
  f.config.providers.judge = Object.assign(provider(judge.baseUrl), { fetch: (async () => {
    judgeSends++;
    expect(getActiveTurnCount()).toBe(turns + 1);
    return Response.json(responsesSuccess('{"choice":"a/m:low"}', "m"));
  }) as unknown as typeof fetch });
  f.config.combos!.auto!.decisionModel = "judge/m";
  const turns = getActiveTurnCount();
  const { response, log } = await send(f);
  expect(response.status).toBe(200); expect(f.inference.bodies).toHaveLength(1);
  expect(log.jevDecision).toMatchObject({ backend: "model", gate: "apply" });
  expect(f.budget.used).toBe(1); expect(f.charges).toBe(1); expect(judgeSends).toBe(1);
  expect(sharedSpendLedger().snapshot("pool", "judge")).toMatchObject({ reserved: 0, settled: 3, unresolved: 0 });
  expect(getActiveTurnCount()).toBe(turns);
});

for (const abort of [false, true]) test(`translated Chat Combo consumes or refunds prepaid initial send (${abort})`, async () => {
  const f = fixture("failover");
  let sent = 0;
  f.config.providers.a = Object.assign({ ...f.config.providers.a!, adapter: "openai-chat",
    requestPacing: { enabled: true, minIntervalMs: 1000 } }, {
    fetch: (async () => { sent++; return chatSuccess("fixture translated answer", "m"); }) as unknown as typeof fetch });
  if (!abort) {
    expect((await send(f)).response.status).toBe(200);
    expect(sent).toBe(1); expect(f.budget.used).toBe(1); expect(f.charges).toBe(1); expect(f.refunds).toBe(0);
    return;
  }
  expect((await send({ ...f, budget: createRequestExecutionBudget() })).response.status).toBe(200);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 40);
  try {
    expect((await send(f, controller.signal)).response.status).toBe(499);
    expect(sent).toBe(1); expect(f.budget.used).toBe(0); expect(f.charges).toBe(1); expect(f.refunds).toBe(1);
  } finally { clearTimeout(timer); }
});

test("streaming runTurn producer retains prepaid send after ingress returns", async () => {
  const f = fixture("failover");
  f.config.providers.a = { ...f.config.providers.a!, adapter: "openai-chat" };
  let finish!: () => void, sent!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const dispatched = new Promise<void>(resolve => { sent = resolve; });
  const adapter = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation(() => ({
    name: "fixture-runturn", reportsPhysicalSends: true,
    buildRequest: () => ({ url: f.inference.baseUrl, method: "POST", headers: {}, body: "{}" }),
    async *parseStream() { yield { type: "done" as const }; },
    async runTurn(_parsed, incoming, emit) {
      emit({ type: "text_delta", text: "fixture preliminary output" });
      await gate;
      const booking = incoming.sendBudget!.reserveDispatch({ sendClass: "initial", targetKey: "fixture-endpoint" });
      expect(booking.allowed).toBe(true); if (!booking.allowed) throw new Error("prepaid send lost");
      expect(booking.permit.use()).toBe(true);
      incoming.onPhysicalSend?.({ ordinal: 1 }); sent();
      emit({ type: "done" });
    },
  }));
  try {
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/auto", input: "fixture", stream: true }) });
    const response = await handleResponses(req, f.config, { model: "", provider: "" }, { sendBudget: f.budget });
    expect(response.status).toBe(200); expect(f.budget.used).toBe(1); expect(f.refunds).toBe(0);
    finish(); await dispatched; await response.text();
    expect(f.budget.used).toBe(1); expect(f.charges).toBe(1); expect(f.refunds).toBe(0);
  } finally { finish(); adapter.mockRestore(); }
});

/** Construct a child-local owner over one externally counted shared reservation. */
function prepaidOwner() {
  let charges = 0, refunds = 0;
  const policy = { maxTotalModelSends: 3, baseSendAllowance: 3, finalRecoveryAllowance: 0,
    maxAlternateTargetSends: 1, maxTargetTransitions: 1 };
  const budget = createRequestExecutionBudget(policy, undefined, {
    charge: () => { charges++; return true; }, refund: () => { refunds++; },
  });
  const target = deriveRequestExecutionBudget(budget, policy);
  const booking = budget.reserveDispatch({ sendClass: "initial", targetKey: "a/m", countedExternally: true });
  if (!booking.allowed) throw new Error("fixture reservation refused");
  const translatorBudget = createTranslatorBudget();
  const owner = createResponsesSendBudget({ req: new Request("http://localhost/v1/responses"),
    logCtx: { provider: "a", model: "m" }, options: { translatorBudget, sendBudget: target,
      comboInitialSend: { permit: booking.permit } } });
  if (owner instanceof Response) throw new Error("unexpected workflow refusal");
  return { budget, target, owner, permit: booking.permit, dispose: () => translatorBudget.dispose(),
    get charges() { return charges; }, get refunds() { return refunds; } };
}

test("prepaid helper exposes only child's booking, never unrelated pending capacity", () => {
  const f = prepaidOwner();
  try {
    const other = f.budget.reserveDispatch({ sendClass: "transient", targetKey: "a/m", countedExternally: true });
    expect(other.allowed).toBe(true);
    expect(f.budget.used).toBe(2); expect(f.target.remainingBaseSends(10)).toBe(1);
    expect(f.owner.initialSendAllowance(10)).toBe(2);
    expect(f.owner.initialSendAllowance(1)).toBe(1);
    f.owner.noteInitialDispatch();
    expect(f.budget.used).toBe(2); expect(f.charges).toBe(2); expect(f.refunds).toBe(0);
    f.permit.release(); expect(f.budget.used).toBe(2);
    if (other.allowed) other.permit.release();
    expect(f.budget.used).toBe(1); expect(f.refunds).toBe(1);
    expect(transientSendCapFor(1, f.owner.targetSendsUsed)).toBe(0);
  } finally { f.dispose(); }
});

for (const transport of ["receipt", "adapter", "reporter"] as const) test(`target-local ${transport} sends ignore later bookings by another owner`, () => {
  const f = prepaidOwner();
  try {
    const other = f.budget.reserveDispatch({ sendClass: "transient", targetKey: "a/m", countedExternally: true });
    if (!other.allowed) throw new Error("fixture refused");
    expect(f.owner.targetSendsUsed).toBe(0);
    if (transport === "receipt") f.owner.noteInitialDispatch();
    else if (transport === "reporter") f.owner.noteTransientSends(1);
    else {
      const first = f.owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "initial", targetKey: "endpoint-one" });
      if (!first.allowed || !first.permit.use()) throw new Error("fixture dispatch denied");
      f.owner.noteAdapterPhysicalSend(undefined, { ordinal: 1 });
    }
    expect(f.owner.targetSendsUsed).toBe(1);
    expect(transientSendCapFor(2, f.owner.targetSendsUsed)).toBe(1);
    expect(f.owner.sendsUsed).toBe(2); // Both owners still occupy shared admission capacity.
    if (transport === "receipt") f.owner.noteInitialDispatch();
    else if (transport === "reporter") f.owner.noteTransientSends(1);
    else {
      const retry = f.owner.adapterDispatchBudget!.reserveDispatch({ sendClass: "transient", targetKey: "endpoint-one" });
      if (!retry.allowed || !retry.permit.use()) throw new Error("fixture retry denied");
      f.owner.noteAdapterPhysicalSend(undefined, { ordinal: 2 });
    }
    expect(f.owner.targetSendsUsed).toBe(2); expect(transientSendCapFor(2, f.owner.targetSendsUsed)).toBe(0);
    other.permit.release();
    expect(f.owner.targetSendsUsed).toBe(2);
  } finally { f.dispose(); }
});

test("initial-ladder retry reserves its own send without settling another pending booking", () => {
  const f = prepaidOwner();
  try {
    const other = f.budget.reserveDispatch({ sendClass: "transient", targetKey: "a/m", countedExternally: true });
    if (!other.allowed) throw new Error("fixture refused");
    expect(f.owner.initialSendAllowance(3)).toBe(2);
    f.owner.noteInitialDispatch(); f.owner.noteInitialDispatch();
    expect(f.budget.used).toBe(3); expect(f.charges).toBe(3);
    expect(() => f.owner.noteInitialDispatch()).toThrow(SendBudgetExhaustedError);
    other.permit.release(); expect(f.budget.used).toBe(2); expect(f.refunds).toBe(1);
  } finally { f.dispose(); }
});

test("released prepaid permit cannot dispatch or be refunded twice", () => {
  const f = prepaidOwner();
  try {
    f.permit.release(); f.permit.release();
    expect(() => f.owner.noteInitialDispatch()).toThrow(SendBudgetExhaustedError);
    expect(f.budget.used).toBe(0); expect(f.charges).toBe(1); expect(f.refunds).toBe(1);
  } finally { f.dispose(); }
});

for (const dispatch of [false, true]) test(`adapter claims prepaid send once and preserves endpoint transition bound (${dispatch})`, () => {
  const f = prepaidOwner();
  try {
    const adapter = f.owner.adapterDispatchBudget!;
    const first = adapter.reserveDispatch({ sendClass: "transient", targetKey: "endpoint-one" });
    expect(first.allowed).toBe(true); if (!first.allowed) throw new Error("fixture refused");
    expect(f.budget.used).toBe(1); expect(f.charges).toBe(1);
    if (!dispatch) {
      first.permit.release(); first.permit.release();
      expect(f.budget.used).toBe(0); expect(f.refunds).toBe(1);
      expect(first.permit.use()).toBe(false); return;
    }
    expect(first.permit.use()).toBe(true); expect(first.permit.use()).toBe(false);
    first.permit.release(); expect(f.refunds).toBe(0);
    const second = adapter.reserveDispatch({ sendClass: "transient", targetKey: "endpoint-two" });
    expect(second.allowed).toBe(true); if (second.allowed) expect(second.permit.use()).toBe(true);
    expect(adapter.targetTransitions).toBe(1);
    expect(adapter.reserveDispatch({ sendClass: "transient", targetKey: "endpoint-three" })).toMatchObject({
      allowed: false, reason: "target-transition-exhausted" });
    f.owner.noteTransientSends(1); // No external booking remains to swallow this unrelated send.
    expect(f.budget.used).toBe(3); expect(f.charges).toBe(3);
  } finally { f.dispose(); }
});

test("released initial booking followed by a transient report charges exactly one send", () => {
  const f = prepaidOwner();
  try {
    f.permit.release();
    expect(f.budget.used).toBe(0); expect(f.charges - f.refunds).toBe(0);
    f.owner.noteTransientSends(1);
    expect(f.budget.used).toBe(1); expect(f.charges - f.refunds).toBe(1);
    expect(f.charges).toBe(2); expect(f.refunds).toBe(1);
    expect(f.owner.targetSendsUsed).toBe(1);
    f.permit.release();
    expect(f.budget.used).toBe(1); expect(f.refunds).toBe(1);
  } finally { f.dispose(); }
});
