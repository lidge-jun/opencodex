import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import { clearKeyCooldowns, getKeyCooldownUntil } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest, setProviderRequestPacingLimitsForTest, setProviderRequestPacingRuntimeForTest, providerRequestPacingStatus, waitForProviderRequestSlot, type ProviderRequestSlot } from "../../src/providers/request-pacing";
import { createRequestExecutionBudget, CODEX_TEXT_GUARDED_BUDGET_POLICY } from "../../src/lib/request-execution-budget";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const creditMessage = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const refusal = (status = 400, message = creditMessage, type = "invalid_request_error") => Response.json({ type: "error", error: { type, message } }, { status });
const sse = (events: Record<string, unknown>[]) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const output = [
  { type: "message_start", message: { id: "msg_billing_fixture", type: "message", role: "assistant", model: "claude-x", content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "billing recovered" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
];
const success = (stream = false) => stream
  ? new Response(sse(output), { headers: { "content-type": "text/event-stream" } })
  : Response.json({ id: "msg_billing_fixture", type: "message", role: "assistant", model: "claude-x",
    content: [{ type: "text", text: "billing recovered" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 2 } });
type Lane = "native" | "translated";
let previousHome: string | undefined;
let home = "";
let releaseSpend: (() => void) | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let seen: { key: string | null; authorization: string | null; apiKey: string | null; body: unknown }[];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-billing-fixture-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  seen = [];
  clearKeyCooldowns();
  resetProviderRequestPacingForTest();
});
afterEach(async () => {
  await upstream?.stop(true);
  upstream = undefined;
  releaseSpend?.();
  releaseSpend = undefined;
  clearKeyCooldowns();
  resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function fixture(reply: (index: number, stream: boolean) => Response, keys = 2): OcxConfig {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean };
    const apiKey = request.headers.get("x-api-key");
    const authorization = request.headers.get("authorization");
    seen.push({ key: apiKey ?? authorization?.replace(/^Bearer /, "") ?? null, authorization, apiKey, body });
    return reply(seen.length - 1, body.stream === true);
  } });
  const config = { port: 0, defaultProvider: "anth", protocols: { rollout: { managedMessagesNative: true } }, providers: { anth: {
    adapter: "anthropic", authMode: "key", baseUrl: `http://127.0.0.1:${upstream.port}`, allowPrivateNetwork: true,
    apiKey: "fixture-key-0", models: ["claude-x"],
    apiKeyPool: Array.from({ length: keys }, (_, id) => ({ id: `k${id}`, key: `fixture-key-${id}`, addedAt: id + 1 })),
  } } } as OcxConfig;
  saveConfig(config);
  return config;
}

async function send(lane: Lane, config: OcxConfig, signal?: AbortSignal, budget?: ReturnType<typeof createRequestExecutionBudget>, stream = false) {
  const request = new Request(`http://localhost/v1/${lane === "native" ? "messages" : "responses"}`, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify(lane === "native"
      ? { model: "anth/claude-x", messages: [{ role: "user", content: "hello" }], max_tokens: 16, stream }
      : { model: "anth/claude-x", input: "hello", stream }),
  });
  return lane === "native"
    ? handleClaudeMessages(request, config, { model: "", provider: "" })
    : handleResponses(request, config, { model: "", provider: "" }, { abortSignal: signal, sendBudget: budget });
}

function threeSendBudget() {
  return createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
    maxTotalModelSends: 3, baseSendAllowance: 3, finalRecoveryAllowance: 0, maxTargetTransitions: 2 });
}

for (const status of [401, 429, 400]) test(`translated A${status}→B200 attributes recovery to B without extra sends or charges`, async () => {
  const config = fixture((index, stream) => index === 0
    ? refusal(status, status === 400 ? creditMessage : "fixture credential/rate refusal",
      status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "invalid_request_error")
    : success(stream));
  config.providers.anth!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
  saveConfig(config);
  const budget = threeSendBudget();
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const signal = AbortSignal.timeout(2_000);
  const request = new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model: "anth/claude-x", input: "hello", store: false, stream: false }),
  });
  const response = await handleResponses(request, config, logCtx, { abortSignal: signal, sendBudget: budget });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("billing recovered");
  expect(seen.map(entry => entry.key)).toEqual(["fixture-key-0", "fixture-key-1"]);
  expect(seen[1]!.body).toEqual(seen[0]!.body);
  expect(budget.used).toBe(2);
  expect(logCtx.attempts?.[0]?.status).toBe(status);
  expect(logCtx.attempts?.map(attempt => ({ ordinal: attempt.ordinal,
    sendCount: attempt.sendCount, recoveryKinds: attempt.recoveryKinds }))).toEqual([
    { ordinal: 1, sendCount: 1, recoveryKinds: [] },
    { ordinal: 2, sendCount: 1, recoveryKinds: [status === 429 ? "key-429" : "key-401"] },
  ]);
  expect(providerRequestPacingStatus("anth", config.providers.anth!)).toMatchObject({ inFlight: 0, queued: 0 });
});

// Observe the real pacer without replacing its clock, queue, timers, or slot admission.
function observeRecoveryQueued(config: OcxConfig, hasCompetingLease: () => boolean, signal: AbortSignal) {
  const queued = Promise.withResolvers<void>();
  const check = () => {
    if (hasCompetingLease() && providerRequestPacingStatus("anth", config.providers.anth!).queued === 1) {
      signal.removeEventListener("abort", abort);
      queued.resolve();
    }
  };
  const abort = () => queued.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  setProviderRequestPacingRuntimeForTest({
    now: Date.now,
    setTimer(callback, delayMs) { const timer = setTimeout(callback, delayMs); check(); return timer; },
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    enqueueMicrotask: callback => queueMicrotask(() => { callback(); check(); }),
  });
  return queued.promise;
}

for (const ending of ["expires", "caller aborts"] as const) test(`translated queued billing replacement ${ending} without a phantom send`, async () => {
  const config = fixture(() => { throw new Error("queued fixture must use the isolated fetch fake"); });
  config.providers.anth!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
  saveConfig(config);
  setProviderRequestPacingLimitsForTest({ maxQueueAgeMs: ending === "expires" ? 150 : 5_000 });
  const budget = threeSendBudget();
  const caller = new AbortController();
  const deadline = AbortSignal.timeout(2_000);
  const signal = AbortSignal.any([caller.signal, deadline]);
  const competingCaller = new AbortController();
  let competingSlot: ProviderRequestSlot | undefined;
  let competing: Promise<void> | undefined;
  const recoveryQueued = observeRecoveryQueued(config, () => competingSlot !== undefined, deadline);
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const apiKey = request.headers.get("x-api-key");
    const authorization = request.headers.get("authorization");
    seen.push({ key: apiKey, apiKey, authorization, body: await request.json() });
    if (seen.length === 1) {
      // A still owns the physical request lease. Queue a genuine competing request
      // before its exact billing 400 lets recovery consume A's body and release it.
      competing = waitForProviderRequestSlot("anth", config.providers.anth!, "claude-x", competingCaller.signal)
        .then(slot => { competingSlot = slot; });
      expect(providerRequestPacingStatus("anth", config.providers.anth!)).toMatchObject({ inFlight: 1, queued: 1 });
    }
    return refusal();
  }) as typeof globalThis.fetch;
  const pending = send("translated", config, signal, budget);
  try {
    await recoveryQueued;
    await competing;
    expect(competingSlot?.leased).toBe(true);
    expect(competingSlot?.released).toBe(false);
    expect(providerRequestPacingStatus("anth", config.providers.anth!)).toMatchObject({ inFlight: 1, queued: 1 });
    if (ending === "caller aborts") caller.abort(new DOMException("fixture queued caller cancelled", "AbortError"));
    const response = await pending;
    const body = await response.text();
    expect({ status: response.status, physicalFetches: seen.length, used: budget.used })
      .toEqual({ status: ending === "expires" ? 400 : 499, physicalFetches: 1, used: 1 });
    if (ending === "expires") expect(body).toContain(creditMessage);
    expect(body).not.toContain("send_budget_exhausted");
    expect(seen.map(entry => ({ apiKey: entry.apiKey, authorization: entry.authorization })))
      .toEqual([{ apiKey: "fixture-key-0", authorization: null }]);
    expect(getKeyCooldownUntil("anth", "k0")).not.toBeNull();
    expect(getKeyCooldownUntil("anth", "k1")).toBeNull();
    expect(providerRequestPacingStatus("anth", config.providers.anth!)).toMatchObject({ inFlight: 1, queued: 0 });
  } finally {
    caller.abort();
    await pending.catch(() => undefined);
    competingCaller.abort();
    await competing?.catch(() => undefined);
    competingSlot?.release();
    globalThis.fetch = priorFetch;
    await Promise.resolve();
    expect(competingSlot?.released).toBe(true);
    expect(providerRequestPacingStatus("anth", config.providers.anth!)).toMatchObject({ inFlight: 0, queued: 0 });
  }
});

test("translated initial queued request expires without any physical fetch or budget charge", async () => {
  const config = fixture(() => { throw new Error("queued fixture must use the isolated fetch fake"); });
  config.providers.anth!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
  saveConfig(config);
  setProviderRequestPacingLimitsForTest({ maxQueueAgeMs: 150 });
  const competingSlot = await waitForProviderRequestSlot("anth", config.providers.anth!, "claude-x");
  const budget = threeSendBudget();
  const priorFetch = globalThis.fetch;
  let physicalFetches = 0;
  globalThis.fetch = (async () => { physicalFetches++; return success(); }) as typeof globalThis.fetch;
  try {
    const response = await send("translated", config, AbortSignal.timeout(2_000), budget);
    expect(response.ok).toBe(false);
    expect(await response.text()).toContain("maximum queued age");
    expect(physicalFetches).toBe(0);
    expect(budget.used).toBe(0);
    expect(providerRequestPacingStatus("anth", config.providers.anth!)).toMatchObject({ inFlight: 1, queued: 0 });
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
    expect(getKeyCooldownUntil("anth", "k1")).toBeNull();
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-0");
  } finally {
    competingSlot.release();
    globalThis.fetch = priorFetch;
    await Promise.resolve();
    expect(competingSlot.released).toBe(true);
    expect(providerRequestPacingStatus("anth", config.providers.anth!)).toMatchObject({ inFlight: 0, queued: 0 });
  }
});

test("translated billing replacement allows one physical reset replay within the shared send budget", async () => {
  const config = fixture(() => { throw new Error("reset fixture must use the isolated fetch fake"); });
  config.providers.anth!.retryOnReset = { enabled: true, replacements: 1 };
  config.providers.anth!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
  saveConfig(config);
  expect(loadConfig().providers.anth!.retryOnReset).toEqual({ enabled: true, replacements: 1 });
  const budget = threeSendBudget();
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const apiKey = request.headers.get("x-api-key");
    const authorization = request.headers.get("authorization");
    seen.push({ key: apiKey, apiKey, authorization, body: await request.json() });
    if (seen.length === 1) return refusal();
    if (seen.length === 2) throw Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
    return success();
  }) as typeof globalThis.fetch;
  try {
    // Explicitly disable storage: this complete, tool-free request is eligible for
    // the configured one-request-wide ambiguous resend grant.
    const signal = AbortSignal.timeout(2_000);
    const request = new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ model: "anth/claude-x", input: "hello", store: false, stream: false }),
    });
    const response = await handleResponses(request, config, { model: "", provider: "" }, { abortSignal: signal, sendBudget: budget });
    expect({ status: response.status, physicalFetches: seen.length, used: budget.used })
      .toEqual({ status: 200, physicalFetches: 3, used: 3 });
    expect(await response.text()).toContain("billing recovered");
    expect(seen.map(entry => ({ apiKey: entry.apiKey, authorization: entry.authorization })))
      .toEqual([
        { apiKey: "fixture-key-0", authorization: null },
        { apiKey: "fixture-key-1", authorization: null },
        { apiKey: "fixture-key-1", authorization: null },
      ]);
    expect(seen[1]!.body).toEqual(seen[0]!.body);
    expect(seen[2]!.body).toEqual(seen[1]!.body);
    expect(budget.ambiguousResendSpent).toBe(true);
    expect(getKeyCooldownUntil("anth", "k0")).not.toBeNull();
    expect(getKeyCooldownUntil("anth", "k1")).toBeNull();
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-1");
  } finally {
    globalThis.fetch = priorFetch;
    expect(providerRequestPacingStatus("anth", config.providers.anth!)).toMatchObject({ inFlight: 0, queued: 0 });
  }
});

for (const lane of ["native", "translated"] as const) describe(`${lane} Anthropic billing sends`, () => {
  for (const status of [400, 402]) test(`Bearer ${status} billing refusal recovers A→B with identical content`, async () => {
    const config = fixture((index, stream) => index === 0 ? refusal(status) : success(stream));
    config.providers.anth!.apiKeyTransport = "bearer";
    saveConfig(config);
    expect(loadConfig().providers.anth!.apiKeyTransport).toBe("bearer");
    const response = await send(lane, config);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("billing recovered");
    expect(seen.map(entry => entry.authorization)).toEqual(["Bearer fixture-key-0", "Bearer fixture-key-1"]);
    expect(seen.map(entry => entry.apiKey)).toEqual([null, null]);
    expect(seen[1]!.body).toEqual(seen[0]!.body);
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-1");
    expect(loadConfig().providers.anth!.apiKeyTransport).toBe("bearer");
    const remaining = getKeyCooldownUntil("anth", "k0")! - Date.now();
    expect(remaining).toBeGreaterThan(3_590_000);
    expect(remaining).toBeLessThanOrEqual(3_600_000);
    expect(getKeyCooldownUntil("anth", "k1")).toBeNull();
  });

  for (const kind of ["override", "conflict"] as const) test(`Bearer runtime header ${kind} cannot cool A or commit B`, async () => {
    const config = fixture(() => refusal());
    config.providers.anth!.apiKeyTransport = "bearer";
    saveConfig(config);
    // Auth-header overrides are runtime-only: persisted config rejects them.
    config.providers.anth!.headers = kind === "override"
      ? { Authorization: "Bearer fixture-key-C" } : { "x-api-key": "fixture-key-C" };
    const response = await send(lane, config);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(creditMessage);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization).toBe(kind === "override" ? "Bearer fixture-key-C" : "Bearer fixture-key-0");
    expect(seen[0]!.apiKey).toBe(kind === "conflict" ? "fixture-key-C" : null);
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-0");
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
    expect(getKeyCooldownUntil("anth", "k1")).toBeNull();
  });

  for (const status of [400, 402]) test(`rotates a proven ${status} billing refusal once with identical request content`, async () => {
    const config = fixture((index, stream) => index === 0 ? refusal(status) : success(stream));
    const response = await send(lane, config);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("billing recovered");
    expect(seen.map(entry => entry.key)).toEqual(["fixture-key-0", "fixture-key-1"]);
    expect(seen[1]!.body).toEqual(seen[0]!.body);
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-1");
    const remaining = getKeyCooldownUntil("anth", "k0")! - Date.now();
    expect(remaining).toBeGreaterThan(3_590_000);
    expect(remaining).toBeLessThanOrEqual(3_600_000);
  });

  test("configured headers overriding A with C do not cool A or commit B", async () => {
    const config = fixture(() => refusal());
    // A runtime override exercises the send fence; persisted config rejects auth headers.
    config.providers.anth!.headers = { "x-api-key": "fixture-key-C" };
    const response = await send(lane, config);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(creditMessage);
    expect(seen.map(entry => entry.key)).toEqual(["fixture-key-C"]);
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-0");
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
  });

  test("billing ownership survives a leased concurrency response-body wrapper", async () => {
    const config = fixture((index, stream) => index === 0 ? refusal() : success(stream));
    config.providers.anth!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
    saveConfig(config);
    const response = await send(lane, config);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("billing recovered");
    expect(seen.map(entry => entry.key)).toEqual(["fixture-key-0", "fixture-key-1"]);
    expect(getKeyCooldownUntil("anth", "k0")).not.toBeNull();
  });

  for (const kind of ["ordinary", "truncated", "code", "message", "envelope"] as const) test(`${kind} 400 stays terminal`, async () => {
    const config = fixture(() => kind === "ordinary" ? refusal(400, "Invalid request")
      : kind === "truncated" ? new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: creditMessage } }).slice(0, -1), { status: 400, headers: { "content-type": "application/json" } })
      : kind === "code" ? Response.json({ type: "error", error: { type: "invalid_request_error", code: "context_length_exceeded", message: creditMessage } }, { status: 400 })
      : kind === "message" ? refusal(400, `Diagnostic: ${creditMessage}`)
      : Response.json({ response: { type: "error", error: { type: "invalid_request_error", message: creditMessage } } }, { status: 400 }));
    const response = await send(lane, config);
    await response.text();
    expect(seen).toHaveLength(1);
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-0");
  });

  test("exhaustion preserves the last upstream billing body", async () => {
    const config = fixture(() => refusal());
    const response = await send(lane, config);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(creditMessage);
    expect(seen.map(entry => entry.key)).toEqual(["fixture-key-0", "fixture-key-1"]);
    expect(getKeyCooldownUntil("anth", "k0")).not.toBeNull();
    expect(getKeyCooldownUntil("anth", "k1")).not.toBeNull();
  });

  for (const keys of [0, 1]) test(`${keys === 0 ? "an empty pool" : "a single key"} does not rotate or cool on billing`, async () => {
    const config = fixture(() => refusal(), keys);
    const response = await send(lane, config);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(creditMessage);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe("fixture-key-0");
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-0");
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
  });

  test("the shared send ceiling retains the actual terminal refusal", async () => {
    const config = fixture(() => refusal(), 8);
    const budget = lane === "translated" ? createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      maxTotalModelSends: 2, baseSendAllowance: 2, finalRecoveryAllowance: 0 }) : undefined;
    const response = await send(lane, config, undefined, budget);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(creditMessage);
    expect(seen).toHaveLength(lane === "native" ? 4 : 2);
  });

  for (const kind of ["text", "tool"] as const) test(`billing error after emitted ${kind} is never replayed`, async () => {
    const emitted = kind === "text" ? output.slice(0, 3) : [output[0]!,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_billing_fixture", name: "billing_tool", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 0 }];
    const config = fixture(() => new Response(sse([...emitted, { type: "error", error: { type: "billing_error", message: creditMessage } }]), {
      headers: { "content-type": "text/event-stream" },
    }));
    const response = await send(lane, config, undefined, undefined, true);
    expect(await response.text()).toContain(kind === "text" ? "billing recovered" : "billing_tool");
    expect(seen).toHaveLength(1);
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
  });

  for (const statuses of [[400, 401], [400, 429], [400, 429, 400], [429, 400], [429, 402]]) test(`mixed ${statuses.join("→")} refusals share billing recovery`, async () => {
    const config = fixture((index, stream) => index < statuses.length
      ? refusal(statuses[index]!, [400, 402].includes(statuses[index]!) ? creditMessage : "fixture credential/rate refusal",
        statuses[index] === 401 ? "authentication_error" : statuses[index] === 429 ? "rate_limit_error" : "invalid_request_error")
      : success(stream), statuses.length + 1);
    const response = await send(lane, config);
    expect(seen.map(entry => entry.key)).toEqual(Array.from({ length: statuses.length + 1 }, (_, index) => `fixture-key-${index}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("billing recovered");
    expect(seen).toHaveLength(statuses.length + 1);
  });

  for (const statuses of [[401, 400], [400, 429], [429, 402]]) test(`distributed ${statuses.join("→")} preserves billing and key recovery`, async () => {
    const { forgetApiKeyRotationCursor, ANTHROPIC_BILLING_COOLDOWN_MS } = await import("../../src/providers/key-failover");
    forgetApiKeyRotationCursor("anth");
    const config = fixture((index, stream) => index < statuses.length
      ? refusal(statuses[index]!, [400, 402].includes(statuses[index]!) ? creditMessage : "fixture refusal",
        statuses[index] === 401 ? "authentication_error" : statuses[index] === 429 ? "rate_limit_error" : "invalid_request_error")
      : success(stream), 3);
    config.providers.anth!.requestPacing = { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } };
    saveConfig(config);
    const startedAt = Date.now();
    try {
      const response = await send(lane, config);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("billing recovered");
      expect(seen.map(entry => entry.key)).toEqual(["fixture-key-0", "fixture-key-1", "fixture-key-2"]);
      expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-0");
      const billingKey = `k${statuses.findIndex(status => status === 400 || status === 402)}`;
      expect(getKeyCooldownUntil("anth", billingKey)).toBeGreaterThanOrEqual(startedAt + ANTHROPIC_BILLING_COOLDOWN_MS);
      expect(providerRequestPacingStatus("anth", config.providers.anth!).inFlight).toBe(0);
    } finally { forgetApiKeyRotationCursor("anth"); }
  });

  if (lane === "translated") for (const status of [401, 429]) test(`mixed billing→${status} keeps B's terminal body at an exact two-send budget`, async () => {
    const terminalMessage = `fixture terminal ${status} from B`;
    const config = fixture((index, stream) => index === 0 ? refusal()
      : index === 1 ? refusal(status, terminalMessage, status === 401 ? "authentication_error" : "rate_limit_error")
      : success(stream), 3);
    const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      maxTotalModelSends: 2, baseSendAllowance: 2, finalRecoveryAllowance: 0 });
    const response = await send(lane, config, undefined, budget);
    expect(response.status).toBe(status);
    const body = await response.text();
    expect(body).toContain(terminalMessage);
    expect(body).not.toContain("send_budget_exhausted");
    expect(seen.map(entry => entry.key)).toEqual(["fixture-key-0", "fixture-key-1"]);
    expect(seen[1]!.body).toEqual(seen[0]!.body);
    expect(budget.used).toBe(2);
  });

  test("client cancellation during the refusal peek never sends B", async () => {
    const opened = Promise.withResolvers<void>();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const config = fixture(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      body = controller;
      controller.enqueue(new TextEncoder().encode('{"type":"error","error":'));
      opened.resolve();
    } }), { status: 400, headers: { "content-type": "application/json" } }));
    const abort = new AbortController();
    const pending = send(lane, config, abort.signal);
    await opened.promise;
    await Bun.sleep(30);
    abort.abort();
    body.close();
    const response = await pending;
    expect(response.status).toBe(499);
    await response.text();
    expect(seen).toHaveLength(1);
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-0");
  });
});

for (const statusCode of [401, 429, 413]) test(`translated ${statusCode} recovery releases the refused response concurrency lease`, async () => {
  setProviderRequestPacingLimitsForTest({ maxQueueAgeMs: 200 });
  const config = fixture((index, stream) => index === 0
    ? refusal(statusCode, statusCode === 429 ? "fixture rate refusal" + " ".repeat(5_000) : "fixture credential/image refusal",
      statusCode === 401 ? "authentication_error" : statusCode === 429 ? "rate_limit_error" : "request_too_large")
    : success(stream));
  config.providers.anth!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
  saveConfig(config);
  const request = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anth/claude-x", stream: false, input: statusCode === 413
      ? [{ role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image",
        image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2G0AAAAAASUVORK5CYII=" }] }]
      : "hello" }) });
  const response = await handleResponses(request, config, { model: "", provider: "" }, { abortSignal: AbortSignal.timeout(2_000) });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("billing recovered");
  expect(seen.map(entry => entry.key)).toEqual(statusCode === 413 ? ["fixture-key-0", "fixture-key-0"] : ["fixture-key-0", "fixture-key-1"]);
  expect(providerRequestPacingStatus("anth", config.providers.anth!)).toMatchObject({ inFlight: 0, queued: 0 });
});
