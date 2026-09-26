import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { saveCredential } from "../../src/oauth/store";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { SEND_BUDGET_EXHAUSTED_CODE } from "../../src/lib/errors";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

const resolver = await import("../../src/server/adapter-resolve");
const originalResolve = resolver.resolveAdapter;
let events: AdapterEvent[] = [];
let calls = 0;
let blockedRun: ProviderAdapter["runTurn"];
const limit: AdapterEvent = {
  type: "error", status: 429, errorType: "rate_limit_error", code: "resource_exhausted",
  retryable: true, message: "Cognition chat failed (resource_exhausted); retry after ~60s",
};
mock.module("../../src/server/adapter-resolve", () => ({ ...resolver,
  resolveAdapter(provider: OcxProviderConfig, cache?: "none" | "short" | "long") {
    if (provider.adapter !== "devin") return originalResolve(provider, cache);
    return {
      name: "devin",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async *parseStream() { yield { type: "done" } as AdapterEvent; },
      async runTurn(parsed, incoming, emit) {
        calls++;
        if (blockedRun) return blockedRun(parsed, incoming, emit);
        for (const event of events) emit(event);
      },
    } satisfies ProviderAdapter;
  },
}));
const { handleResponses } = await import("../../src/server/responses");
let home: ReturnType<typeof createTempHome>;
let release: (() => void) | undefined;
beforeEach(async () => {
  home = createTempHome("ocx-grok-devin-preflight-");
  release = acquireOwnedSpendHome();
  clearGenericFailoverHealth();
  calls = 0;
  events = [limit];
  blockedRun = undefined;
  await saveCredential("devin", {
    access: "synthetic-devin-preflight", refresh: "synthetic-refresh",
    expires: Date.now() + 3_600_000, accountId: "fixture",
  });
});
afterEach(() => {
  try {
    release?.();
  } finally {
    clearGenericFailoverHealth();
    home.remove();
  }
});
function run({
  surface = "grok", comboAttempt = false, abortSignal, stallTimeoutSec,
  oauthFailoverEnabled = false, stream = true,
}: {
  surface?: "grok" | "codex"; comboAttempt?: boolean; abortSignal?: AbortSignal;
  stallTimeoutSec?: number; oauthFailoverEnabled?: boolean; stream?: boolean;
} = {}) {
  const config = {
    port: 0, defaultProvider: "devin", oauthAccountFailover: { enabled: oauthFailoverEnabled },
    stallTimeoutSec,
    providers: { devin: { adapter: "devin", authMode: "oauth", baseUrl: "https://server.codeium.com", models: ["swe-2"] } },
  } as OcxConfig;
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "devin/swe-2", input: "answer", stream }),
  }), config, { model: "", provider: "", surface }, { comboAttempt, abortSignal });
}

async function waitForPreflightResponse(pending: Promise<Response>, started: Promise<void>, resume: () => void) {
  let guard: ReturnType<typeof setTimeout> | undefined;
  let response: Response | null;
  try {
    response = await Promise.race([
      Promise.all([started, pending]).then(([, value]) => value),
      new Promise<null>(resolve => { guard = setTimeout(() => resolve(null), 2_500); }),
    ]);
  } finally {
    if (guard !== undefined) clearTimeout(guard);
    resume();
  }
  if (response === null) {
    await (await pending).body?.cancel();
    throw new Error("Grok did not receive a response before the next provider event");
  }
  return response;
}

test.each([
  { stream: true, heartbeat: false }, { stream: true, heartbeat: true },
  { stream: false, heartbeat: false }, { stream: false, heartbeat: true },
])("pre-output 429 reaches Grok as HTTP 429 (stream=$stream heartbeat=$heartbeat)", async ({ stream, heartbeat }) => {
  events = heartbeat ? [{ type: "heartbeat" }, limit] : [limit];
  const response = await run({ stream });
  expect(response.status).toBe(429);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("retry-after")).toBe("60");
  expect(await response.json()).toEqual({ error: {
    message: limit.message, type: "rate_limit_error", code: "rate_limit_exceeded",
  } });
  expect(calls).toBe(1);
});

test("buffered cooldown heartbeat keeps a final refusal as HTTP 429", async () => {
  events = [{ type: "heartbeat", preflightReady: true }, limit];

  const response = await run({ stream: false });

  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect(calls).toBe(1);
});

test.each(["codex", "grok"] as const)("%s cooldown starts SSE before a later 429 rotates to a second account", async surface => {
  await saveCredential("devin", {
    access: "synthetic-devin-preflight-spare", refresh: "synthetic-refresh-spare",
    expires: Date.now() + 3_600_000, accountId: "fixture-spare",
  });
  const started = Promise.withResolvers<void>();
  const continueTurn = Promise.withResolvers<void>();
  blockedRun = async (_parsed, _incoming, emit) => {
    if (calls === 1) {
      emit({ type: "heartbeat", preflightReady: true });
      started.resolve();
      await continueTurn.promise;
      emit(limit);
      return;
    }
    emit({ type: "text_delta", text: "alternate answer" });
    emit({ type: "done" });
  };

  const response = await waitForPreflightResponse(
    run({ surface, oauthFailoverEnabled: true }), started.promise, () => continueTurn.resolve(),
  );
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(calls).toBe(2);
  expect(body).toContain("alternate answer");
  expect(body).not.toContain("rate_limit_exceeded");
  expect(body).toContain("response.completed");
});

test("a final cooldown refusal after SSE starts remains an in-stream error", async () => {
  events = [{ type: "heartbeat", preflightReady: true }, limit];

  const response = await run();
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("retry-after")).toBeNull();
  expect(body).toContain("response.failed");
  expect(calls).toBe(1);
});

test("a replay-unsafe heartbeat after cooldown readiness forbids account rotation", async () => {
  await saveCredential("devin", {
    access: "synthetic-devin-preflight-spare", refresh: "synthetic-refresh-spare",
    expires: Date.now() + 3_600_000, accountId: "fixture-spare",
  });
  events = [
    { type: "heartbeat", preflightReady: true },
    { type: "heartbeat", replayUnsafe: true },
    limit,
  ];

  const response = await run({ surface: "codex", oauthFailoverEnabled: true });

  expect(response.status).toBe(200);
  expect(await response.text()).toContain("response.failed");
  expect(calls).toBe(1);
});

test("a timed-out preflight can rotate a later pre-output 429", async () => {
  await saveCredential("devin", {
    access: "synthetic-devin-preflight-spare", refresh: "synthetic-refresh-spare",
    expires: Date.now() + 3_600_000, accountId: "fixture-spare",
  });
  const started = Promise.withResolvers<void>();
  const continueTurn = Promise.withResolvers<void>();
  blockedRun = async (_parsed, _incoming, emit) => {
    if (calls === 1) {
      started.resolve();
      await continueTurn.promise;
      emit(limit);
      return;
    }
    emit({ type: "text_delta", text: "after timeout" });
    emit({ type: "done" });
  };

  const response = await waitForPreflightResponse(
    run({ stallTimeoutSec: 1, oauthFailoverEnabled: true }), started.promise, () => continueTurn.resolve(),
  );
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(calls).toBe(2);
  expect(body).toContain("after timeout");
  expect(body).toContain("response.completed");
});

test.each([false, true])("first text is replayed once and later errors stay SSE (failure=%s)", async failure => {
  events = [{ type: "heartbeat" }, { type: "text_delta", text: "answer" }, failure ? limit : { type: "done" }];
  const response = await run();
  expect(response.status).toBe(200);
  const text = await response.text();
  const frames = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  expect(frames.filter(frame => frame.type === "response.output_text.delta").map(frame => frame.delta)).toEqual(["answer"]);
  expect(frames.filter(frame => frame.type === (failure ? "response.failed" : "response.completed"))).toHaveLength(1);
  expect(calls).toBe(1);
});

test("a disabled stall watchdog still gives Devin a finite preflight", async () => {
  // stallTimeoutSec: 0 disables the stream watchdog (#5876); it must not turn into a zero-length
  // preflight that commits SSE before the first event.
  const response = await run({ stallTimeoutSec: 0 });
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect(calls).toBe(1);
});

test("a replay-unsafe heartbeat leaves the error in SSE", async () => {
  events = [{ type: "heartbeat", replayUnsafe: true }, limit];
  const response = await run();
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("response.failed");
  expect(calls).toBe(1);
});

test("other clients keep their existing SSE response", async () => {
  const response = await run({ surface: "codex" });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("response.failed");
});

test.each([false, true])("Grok starts SSE after bounded Devin preflight (heartbeat=%s)", async heartbeat => {
  const started = Promise.withResolvers<void>();
  const continueTurn = Promise.withResolvers<void>();
  blockedRun = async (_parsed, _incoming, emit) => {
    if (heartbeat) emit({ type: "heartbeat" });
    started.resolve();
    await continueTurn.promise;
    emit({ type: "text_delta", text: "after preflight" });
    emit({ type: "done" });
  };

  const response = await waitForPreflightResponse(
    run({ stallTimeoutSec: 1 }), started.promise, () => continueTurn.resolve(),
  );
  expect(response.status).toBe(200);
  const frames = (await response.text()).split("\n")
    .filter(line => line.startsWith("data: {"))
    .map(line => JSON.parse(line.slice(6)));
  expect(frames.filter(frame => frame.type === "response.output_text.delta").map(frame => frame.delta))
    .toEqual(["after preflight"]);
  expect(frames.filter(frame => frame.type === "response.completed")).toHaveLength(1);
});

test("timed-out OAuth replay keeps its reserved dispatch permit until Devin sends", async () => {
  await saveCredential("devin", {
    access: "synthetic-devin-preflight-spare", refresh: "synthetic-refresh-spare",
    expires: Date.now() + 3_600_000, accountId: "fixture-spare",
  });
  const retryStarted = Promise.withResolvers<void>();
  const dispatchRetry = Promise.withResolvers<void>();
  let retryBudgetUsed: number | undefined;
  let retryDispatchAllowed: boolean | undefined;
  blockedRun = async (_parsed, incoming, emit) => {
    if (calls === 1) {
      const decision = incoming.sendBudget?.reserveDispatch({ sendClass: "initial", targetKey: "devin|first" });
      if (decision?.allowed) decision.permit.use();
      emit(limit);
      return;
    }
    retryStarted.resolve();
    await dispatchRetry.promise;
    const budget = incoming.sendBudget;
    const decision = budget?.reserveDispatch({ sendClass: "auth-recovery", targetKey: "devin|retry" });
    retryDispatchAllowed = decision?.allowed;
    if (decision?.allowed) decision.permit.use();
    retryBudgetUsed = budget?.used;
    emit(limit);
  };

  const response = await waitForPreflightResponse(
    run({ stallTimeoutSec: 1, oauthFailoverEnabled: true }), retryStarted.promise, () => dispatchRetry.resolve(),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("response.failed");
  expect(retryDispatchAllowed).toBe(true);
  expect(retryBudgetUsed).toBe(2);
});

test("combo children retain their existing preflight failure", async () => {
  const response = await run({ comboAttempt: true });
  expect(response.status).toBe(502);
  expect(response.headers.get("retry-after")).toBeNull();
  await response.text();
});

test.each([
  { ...limit, status: 503, errorType: "upstream_error", code: "unavailable" },
  { ...limit, code: SEND_BUDGET_EXHAUSTED_CODE },
])("unrelated errors keep their existing SSE response ($code)", async error => {
  events = [error];
  const response = await run();
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("response.failed");
});

test("cancellation before the first event aborts the producer", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let aborted = false;
  blockedRun = async (_parsed, incoming, emit) => {
    const stopped = Promise.withResolvers<void>();
    incoming.abortSignal!.addEventListener("abort", () => {
      aborted = true;
      emit({ type: "error", status: 499, message: "client closed request" });
      stopped.resolve();
    }, { once: true });
    started.resolve();
    await stopped.promise;
  };
  const pending = run({ abortSignal: controller.signal });
  await started.promise;
  controller.abort();
  const response = await pending;
  await response.text();
  expect(aborted).toBe(true);
  expect(calls).toBe(1);
});

const bufferedExclusions: { name: string; surface?: "grok" | "codex"; source: AdapterEvent[] }[] = [
  { name: "other client", surface: "codex", source: [limit] },
  { name: "replay-unsafe activity", source: [{ type: "heartbeat", replayUnsafe: true }, limit] },
  { name: "local send budget", source: [{ ...limit, code: SEND_BUDGET_EXHAUSTED_CODE }] },
  { name: "non-429 failure", source: [{ ...limit, status: 503, errorType: "upstream_error" }] },
];
test.each(bufferedExclusions)("buffered $name retains its existing JSON result", async ({ surface, source }) => {
  events = source;
  const response = await run({ stream: false, surface });
  expect(response.status).toBe(200);
  expect(response.headers.get("retry-after")).toBeNull();
  expect(await response.json()).toMatchObject({ status: "failed", error: { message: limit.message } });
});

test("buffered output before a 429 is retained exactly once", async () => {
  events = [{ type: "text_delta", text: "answer" }, limit];
  const response = await run({ stream: false });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "failed", output: [{ content: [{ type: "output_text", text: "answer" }] }],
    error: { message: limit.message },
  });
  expect(calls).toBe(1);
});

test.each([true, false])("OAuth replay preserves unsafe activity through heartbeat eviction (stream=%s)", async stream => {
  await saveCredential("devin", {
    access: "synthetic-devin-preflight-spare", refresh: "synthetic-refresh-spare",
    expires: Date.now() + 3_600_000, accountId: "fixture-spare",
  });
  blockedRun = async (_parsed, _incoming, emit) => {
    if (calls > 1) {
      emit({ type: "heartbeat", replayUnsafe: true });
      for (let i = 0; i < 32; i++) {
        await Bun.sleep(1);
        emit({ type: "heartbeat" });
      }
    }
    emit(limit);
  };
  const response = await run({ stream, oauthFailoverEnabled: true });
  expect(response.status).toBe(200);
  if (stream) expect(await response.text()).toContain("response.failed");
  else expect(await response.json()).toMatchObject({ status: "failed", error: { message: limit.message } });
  expect(calls).toBe(2);
});
