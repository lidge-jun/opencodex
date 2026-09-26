import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { saveCredential } from "../../src/oauth/store";
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
    home.remove();
  }
});
function run(surface: "grok" | "codex" = "grok", comboAttempt = false, abortSignal?: AbortSignal) {
  const config = {
    port: 0, defaultProvider: "devin", oauthAccountFailover: { enabled: false },
    providers: { devin: { adapter: "devin", authMode: "oauth", baseUrl: "https://server.codeium.com", models: ["swe-2"] } },
  } as OcxConfig;
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "devin/swe-2", input: "answer", stream: true }),
  }), config, { model: "", provider: "", surface }, { comboAttempt, abortSignal });
}

test.each([false, true])("pre-output 429 reaches Grok as HTTP 429 (heartbeat=%s)", async heartbeat => {
  events = heartbeat ? [{ type: "heartbeat" }, limit] : [limit];
  const response = await run();
  expect(response.status).toBe(429);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("retry-after")).toBe("60");
  expect(await response.json()).toEqual({ error: {
    message: limit.message, type: "rate_limit_error", code: "rate_limit_exceeded",
  } });
  expect(calls).toBe(1);
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

test("a replay-unsafe heartbeat leaves the error in SSE", async () => {
  events = [{ type: "heartbeat", replayUnsafe: true }, limit];
  const response = await run();
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("response.failed");
  expect(calls).toBe(1);
});

test("other clients keep their existing SSE response", async () => {
  const response = await run("codex");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("response.failed");
});

test("combo children retain their existing preflight failure", async () => {
  const response = await run("grok", true);
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
  const pending = run("grok", false, controller.signal);
  await started.promise;
  controller.abort();
  const response = await pending;
  await response.text();
  expect(aborted).toBe(true);
  expect(calls).toBe(1);
});
