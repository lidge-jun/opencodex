import { test } from "bun:test";
import assert from "node:assert/strict";
import { createAdmittedHttpTurn } from "../../src/server/admitted-http-turn";
import { getDefaultConfig } from "../../src/config";
import { MAX_CONFIGURABLE_INBOUND_BODY_BYTES } from "../../src/server/request-decompress";
import { inboundBodyBudget, configureInboundBodyBudget, MAX_QUEUED_INBOUND_BODIES } from "../../src/server/inbound-body-budget";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import { getActiveTurnCount, MAX_ACTIVE_TURNS, tryAdmitTurn } from "../../src/server/lifecycle";
import { admitWorkflowTurn, resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";

const limit = MAX_CONFIGURABLE_INBOUND_BODY_BYTES;
const policy = getDefaultConfig();
const request = (signal?: AbortSignal) => new Request("http://localhost/v1/responses", {
  method: "POST", body: "{}", signal,
});
const mapRefusal = (response: Response) => new Response("native", { status: response.status, headers: response.headers });
const busy = () => new Response("busy", { status: 503, headers: { "Retry-After": "1" } });
const log = (id: string, onLogged: () => void) => ({
  requestId: id, start: Date.now(), logCtx: { model: "unknown", provider: "unknown" }, onLogged,
});
const rows = (id: string) => getRequestLogEntries().filter(row => row.requestId === id);
const mapWithLoggedId = (id: string, logged: () => number) => (response: Response) => {
  const mapped = mapRefusal(response);
  if (logged()) mapped.headers.set("x-fixture-response-id", id);
  return mapped;
};

test("admission cancellation owns the row and releases the turn on an immediate grant race", async () => {
  clearRequestLogsForTests();
  inboundBodyBudget.setCapacity(limit);
  const abort = new AbortController();
  let logged = 0;
  let worked = false;
  const before = getActiveTurnCount();
  const run = createAdmittedHttpTurn(() => limit, busy);
  const pending = run(request(abort.signal), policy, async () => { worked = true; return new Response(); }, {
    requestId: "native-cancel", start: Date.now(), logCtx: { model: "unknown", provider: "unknown" },
    onLogged: () => { logged++; },
  }, { mapRefusal: mapWithLoggedId("native-cancel", () => logged), onAdmissionError: () => new Response("cancelled", { status: 499 }) });
  abort.abort(new Error("client cancelled"));
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal(await response.text(), "native");
  assert.equal(response.headers.get("x-fixture-response-id"), "native-cancel");
  assert.ok(response.headers.has("access-control-allow-origin"));
  assert.equal(worked, false);
  assert.equal(logged, 1);
  assert.equal(getRequestLogEntries().filter(row => row.requestId === "native-cancel").length, 1);
  assert.equal(getActiveTurnCount(), before);
  assert.equal(inboundBodyBudget.snapshot().activeLeases, 0);
  configureInboundBodyBudget();
});

test("active-turn refusal maps without a row or callback, then recovers", async () => {
  clearRequestLogsForTests();
  const leases = Array.from({ length: MAX_ACTIVE_TURNS }, () => tryAdmitTurn());
  assert.ok(leases.every(Boolean));
  let logged = 0;
  const run = createAdmittedHttpTurn(() => undefined, busy);
  try {
    const response = await run(request(), policy, async () => new Response("work"), log("active", () => logged++), { mapRefusal: mapWithLoggedId("active", () => logged) });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(await response.text(), "native");
    assert.equal(response.headers.get("x-fixture-response-id"), null);
    assert.ok(response.headers.has("access-control-allow-origin"));
    assert.equal(logged, 0);
    assert.equal(rows("active").length, 0);
  } finally { leases.forEach(lease => lease?.release()); }
  assert.equal(await (await run(request(), policy, async () => new Response("recovered"))).text(), "recovered");
});

test("workflow refusal maps after its single row and recovers", async () => {
  clearRequestLogsForTests();
  resetWorkflowBudgetsForTest();
  const leases = Array.from({ length: 8 }, () => admitWorkflowTurn("native-root", "interactive"));
  assert.ok(leases.every(decision => decision?.admitted));
  let logged = 0;
  const run = createAdmittedHttpTurn(() => undefined, busy);
  const req = () => new Request("http://localhost/v1/responses", { method: "POST", body: "{}", headers: { "x-codex-parent-thread-id": "native-root" } });
  try {
    const response = await run(req(), policy, async () => new Response("work"), log("workflow", () => logged++), { mapRefusal: mapWithLoggedId("workflow", () => logged) });
    assert.equal(response.status, 429);
    assert.equal(await response.text(), "native");
    assert.equal(response.headers.get("x-fixture-response-id"), "workflow");
    assert.ok(response.headers.has("access-control-allow-origin"));
    assert.equal(logged, 1);
    assert.equal(rows("workflow").length, 1);
  } finally {
    for (const decision of leases) if (decision?.admitted) decision.lease.release();
    resetWorkflowBudgetsForTest();
  }
  assert.equal(await (await run(req(), policy, async () => new Response("recovered"))).text(), "recovered");
});

test("body refusal maps after its row, preserves retry advice and recovers", async () => {
  clearRequestLogsForTests();
  inboundBodyBudget.setCapacity(limit);
  const holder = await inboundBodyBudget.acquire(limit, new AbortController().signal);
  const abort = new AbortController();
  const waiters = Array.from({ length: MAX_QUEUED_INBOUND_BODIES }, () => inboundBodyBudget.acquire(limit, abort.signal).catch(() => null));
  let logged = 0;
  const run = createAdmittedHttpTurn(() => limit, busy);
  try {
    const response = await run(request(), policy, async () => new Response("work"), log("body", () => logged++), { mapRefusal: mapWithLoggedId("body", () => logged) });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(await response.text(), "native");
    assert.equal(response.headers.get("x-fixture-response-id"), "body");
    assert.ok(response.headers.has("access-control-allow-origin"));
    assert.equal(logged, 1);
    assert.equal(rows("body").length, 1);
  } finally {
    abort.abort();
    await Promise.all(waiters);
    holder?.release();
  }
  assert.equal(await (await run(request(), policy, async () => new Response("recovered"))).text(), "recovered");
  configureInboundBodyBudget();
});

test("queued cancellation logs once, releases the turn, and unrelated admission errors propagate", async () => {
  clearRequestLogsForTests();
  inboundBodyBudget.setCapacity(limit);
  const holder = await inboundBodyBudget.acquire(limit, new AbortController().signal);
  const abort = new AbortController();
  const before = getActiveTurnCount();
  let logged = 0;
  const run = createAdmittedHttpTurn(() => limit, busy);
  try {
    const pending = run(request(abort.signal), policy, async () => new Response("work"), log("queued", () => logged++), {
      mapRefusal, onAdmissionError: () => new Response("cancel", { status: 499 }),
    });
    assert.equal(inboundBodyBudget.snapshot().queuedRequests, 1);
    abort.abort(new Error("cancelled"));
    const response = await pending;
    assert.equal(response.status, 499);
    assert.equal(await response.text(), "native");
    assert.equal(logged, 1);
    assert.equal(rows("queued").length, 1);
    assert.equal(getActiveTurnCount(), before);
    assert.equal(inboundBodyBudget.snapshot().queuedRequests, 0);
  } finally { holder?.release(); }
  inboundBodyBudget.setCapacity(limit - 1);
  await assert.rejects(run(request(), policy, async () => new Response(), log("error", () => logged++), {
    mapRefusal, onAdmissionError: () => new Response(null, { status: 499 }),
  }), RangeError);
  assert.equal(rows("error").length, 0);
  assert.equal(logged, 1);
  assert.equal(getActiveTurnCount(), before);
  configureInboundBodyBudget();
});
