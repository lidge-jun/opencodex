import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const actualResolver = await import("../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;
let customFetchResponse: ((request: Request) => Promise<Response>) | undefined;
mock.module("../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: import("../src/types").OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter === "test-response") {
      const base = actualResolveAdapter({ ...provider, adapter: "openai-chat" }, cacheRetention);
      return {
        ...base,
        name: "test-response",
        async fetchResponse(request: Request) {
          if (!customFetchResponse) throw new Error("customFetchResponse not installed");
          return customFetchResponse(request);
        },
      };
    }
    return actualResolveAdapter(provider, cacheRetention);
  },
}));

const { handleComboResponses } = await import("../src/server/responses/core");

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
import {
  clearEconomicState,
  reserveEconomicSelection,
  setEconomicQuotaSnapshot,
  settleEconomicReservation,
  getEconomicQuotaSnapshot,
} from "../src/combos/economy";
import type { OcxConfig } from "../src/types";

const now = 1_000_000;

function config(unit: "inputTokens" | "outputTokens" | "totalTokens" | "requests" | "credits" | "usd"): OcxConfig {
  return {
    port: 0,
    defaultProvider: "p",
    providers: { p: { adapter: "openai-chat", baseUrl: "https://example.test", apiKey: "key", authMode: "key" } },
    economicAllowances: {
      allowance: {
        unit,
        capacity: 100,
        window: { kind: "balance" },
        source: "manual",
        rates: unit === "credits" || unit === "usd" ? { fixedPerRequest: 10 } : undefined,
      },
    },
    combos: { c: { strategy: "economy", targets: [{ provider: "p", model: "m", allowances: ["allowance"] }] } },
  };
}

function reserve(unit: Parameters<typeof config>[0], amount = 10): string {
  const selected = reserveEconomicSelection(config(unit), "c", {
    inputTokens: unit === "inputTokens" || unit === "totalTokens" || unit === "credits" || unit === "usd" ? amount : 0,
    outputTokens: unit === "outputTokens" ? amount : 0,
    kind: "configured",
    fixedRequests: unit === "requests" ? amount : 1,
  }, now);
  expect(selected.reservationId).toBeString();
  return selected.reservationId!;
}

beforeEach(() => {
  clearEconomicState();
  setEconomicQuotaSnapshot("allowance", { remaining: 50, updatedAt: Date.now(), source: "manual", confidence: "authoritative" });
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-econ-settle-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-econ-settle-"));
  process.env.OPENCODEX_HOME = testDir;
  customFetchResponse = undefined;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  clearEconomicState();
});

function lifecycleConfig(unit: "outputTokens" | "credits" | "usd" = "outputTokens"): OcxConfig {
  return {
    port: 0,
    defaultProvider: "cheap",
    providers: {
      cheap: { adapter: "test-response", baseUrl: "https://cheap.test/v1", allowPrivateNetwork: true, authMode: "key", apiKey: "key" },
      payg: { adapter: "test-response", baseUrl: "https://payg.test/v1", allowPrivateNetwork: true, authMode: "key", apiKey: "key" },
    },
    economicAllowances: {
      allowance: {
        unit,
        capacity: 100,
        window: { kind: "balance" },
        source: "manual",
        ...(unit === "credits" ? { rates: { inputPerMillion: 1_000_000 } } : {}),
        ...(unit === "usd" ? { rates: { inputPerMillion: 1_000_000 } } : {}),
      },
    },
    combos: {
      c: {
        strategy: "economy",
        economy: { unknownQuota: "reject" },
        targets: [
          { provider: "cheap", model: "m", allowances: ["allowance"], ...(unit === "usd" ? { pricing: { inputUsdPerMillion: 1_000_000 } } : {}) },
          { provider: "payg", model: "m" },
        ],
      },
    },
  };
}

function lifecycleRequest(): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/c", input: "hello", max_output_tokens: 10 }),
  });
}

function lifecycleBody() {
  return { model: "combo/c", input: "hello", max_output_tokens: 10 };
}

describe("economic reservation settlement", () => {
  test("settles smaller actual usage and releases excess", () => {
    const id = reserve("inputTokens");
    settleEconomicReservation(id, { inputTokens: 4 }, now + 1);
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(46);
  });

  test("clamps larger actual usage at zero", () => {
    const id = reserve("inputTokens");
    settleEconomicReservation(id, { inputTokens: 100 }, now + 1);
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(0);
  });

  test("settles every economic unit", () => {
    for (const unit of ["inputTokens", "outputTokens", "totalTokens", "requests", "credits", "usd"] as const) {
      clearEconomicState();
      setEconomicQuotaSnapshot("allowance", { remaining: 50, updatedAt: Date.now(), source: "manual", confidence: "authoritative" });
      const id = reserve(unit);
      settleEconomicReservation(id, { [unit]: 4 }, now + 1);
      expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(46);
    }
  });

  test("is idempotent", () => {
    const id = reserve("inputTokens");
    settleEconomicReservation(id, { inputTokens: 4 }, now + 1);
    settleEconomicReservation(id, { inputTokens: 0 }, now + 2);
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(46);
  });

  test("rejects invalid actual usage and releases the reservation", () => {
    const cfg = config("inputTokens");
    setEconomicQuotaSnapshot("allowance", { remaining: 50, updatedAt: now, source: "manual", confidence: "authoritative" });
    const id = reserve("inputTokens", 45);
    expect(() => settleEconomicReservation(id, { inputTokens: -1 })).toThrow();
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(50);
    expect(() => settleEconomicReservation(id, { inputTokens: Number.NaN })).toThrow();
    // The failed settle must not leave the reservation blocking headroom until TTL.
    const retry = reserveEconomicSelection(cfg, "c", { inputTokens: 45, outputTokens: 0, kind: "configured" }, now + 1);
    expect(retry.reservationId).toBeString();
  });

  test("undefined actual releases the reservation", () => {
    const id = reserve("inputTokens");
    settleEconomicReservation(id, undefined, now + 1);
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(50);
  });

  test("settles successful child usage exactly once", async () => {
    setEconomicQuotaSnapshot("allowance", { remaining: 50, updatedAt: Date.now(), source: "manual", confidence: "authoritative" });
    customFetchResponse = async () => Response.json({ id: "ok", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 } });
    const response = await handleComboResponses(lifecycleRequest(), lifecycleBody(), "c", lifecycleConfig(), { model: "", provider: "" }, {});
    expect(response.status).toBe(200);
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(46);
  });

  test("settles credits from token rates through the response lifecycle", async () => {
    setEconomicQuotaSnapshot("allowance", { remaining: 50, updatedAt: Date.now(), source: "manual", confidence: "authoritative" });
    customFetchResponse = async () => Response.json({ id: "ok", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 } });
    const response = await handleComboResponses(lifecycleRequest(), lifecycleBody(), "c", lifecycleConfig("credits"), { model: "", provider: "" }, {});
    expect(response.status).toBe(200);
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(49);
  });

  test("settles usd from target pricing through the response lifecycle", async () => {
    setEconomicQuotaSnapshot("allowance", { remaining: 50, updatedAt: Date.now(), source: "manual", confidence: "authoritative" });
    customFetchResponse = async () => Response.json({ id: "ok", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 } });
    const response = await handleComboResponses(lifecycleRequest(), lifecycleBody(), "c", lifecycleConfig("usd"), { model: "", provider: "" }, {});
    expect(response.status).toBe(200);
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(49);
  });

  test("settles streamed success after body consumption", async () => {
    setEconomicQuotaSnapshot("allowance", { remaining: 50, updatedAt: Date.now(), source: "manual", confidence: "authoritative" });
    customFetchResponse = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}

data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":4,"total_tokens":5}}

data: [DONE]

`));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/c", input: "hello", max_output_tokens: 10, stream: true }),
    });
    const response = await handleComboResponses(request, { model: "combo/c", input: "hello", max_output_tokens: 10, stream: true }, "c", lifecycleConfig("credits"), { model: "", provider: "" }, {});
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(50);
    await response.arrayBuffer();
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(49);
  });

  test("releases streamed reservation when cancelled before usage", async () => {
    setEconomicQuotaSnapshot("allowance", { remaining: 50, updatedAt: Date.now(), source: "manual", confidence: "authoritative" });
    customFetchResponse = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\\n\\n"));
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const request = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/c", input: "hello", max_output_tokens: 10, stream: true }),
    });
    const response = await handleComboResponses(request, { model: "combo/c", input: "hello", max_output_tokens: 10, stream: true }, "c", lifecycleConfig("credits"), { model: "", provider: "" }, {});
    await response.body?.cancel();
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(50);
  });

  test("settles terminal failure usage", async () => {
    setEconomicQuotaSnapshot("allowance", { remaining: 50, updatedAt: Date.now(), source: "manual", confidence: "authoritative" });
    customFetchResponse = async () => Response.json({ error: { code: "context_length_exceeded", message: "too long" }, usage: { input_tokens: 1, output_tokens: 4, total_tokens: 5 } }, { status: 400 });
    const response = await handleComboResponses(lifecycleRequest(), lifecycleBody(), "c", lifecycleConfig(), { model: "", provider: "" }, {});
    expect(response.status).toBe(400);
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(46);
  });

  test("settles retryable failure usage before failover", async () => {
    setEconomicQuotaSnapshot("allowance", { remaining: 50, updatedAt: Date.now(), source: "manual", confidence: "authoritative" });
    let calls = 0;
    customFetchResponse = async () => {
      calls += 1;
      if (calls === 1) return Response.json({ error: { code: "rate_limit_exceeded", message: "busy" }, usage: { input_tokens: 1, output_tokens: 4, total_tokens: 5 } }, { status: 429 });
      return Response.json({ id: "ok", object: "response", status: "completed", output: [] });
    };
    const response = await handleComboResponses(lifecycleRequest(), lifecycleBody(), "c", lifecycleConfig(), { model: "", provider: "" }, {});
    expect(response.status).toBe(200);
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(46);
  });

  test("recent id remains idempotent after bounded idempotency eviction", () => {
    for (let i = 0; i < 10_000; i += 1) {
      settleEconomicReservation(`pre-${i}`, { inputTokens: 1 }, now + i);
    }
    setEconomicQuotaSnapshot("allowance", { remaining: 50, updatedAt: now + 20_000, source: "manual", confidence: "authoritative" });
    const recent = reserve("inputTokens", 10);
    settleEconomicReservation(recent, { inputTokens: 4 }, now + 20_001);
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(46);
    for (let i = 0; i < 5_000; i += 1) {
      settleEconomicReservation(`post-${i}`, { inputTokens: 1 }, now + 30_000 + i);
    }
    settleEconomicReservation(recent, { inputTokens: 999 }, now + 40_000);
    expect(getEconomicQuotaSnapshot("allowance")?.remaining).toBe(46);
  });

});
