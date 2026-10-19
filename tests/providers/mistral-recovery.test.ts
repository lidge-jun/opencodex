import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { providerConfigSeed } from "../../src/providers/derive";
import { clearKeyCooldowns, rateLimitRetryPolicyFor } from "../../src/providers/key-failover";
import { isCanonicalMistralChat, MistralBudgetPacer, mistralMinuteRefusal, resolveMistralTransport } from "../../src/providers/mistral-transport";
import { carryReplayRefusal, isNonReplayableResponse, isSameTargetRetryHold, sleepWithAbort } from "../../src/lib/upstream-retry";
import { resolveProviderTransport } from "../../src/providers/xai-transport";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routedProviderConfig } from "../../src/providers/routed-config";
import { parseRequest } from "../../src/responses/parser";
import { handleResponses } from "../../src/server/responses";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { fetchWithHeaderTimeout } from "../../src/server/responses/fetch-helpers";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const baseUrl = "https://api.mistral.ai/v1";
const model = "zai-glm-5-3";
const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl, authMode: "key", apiKey: "synthetic-mistral-key" };
const policy = { enabled: true, attempts: 6, intervalMs: 10_000, maxIntervalMs: 60_000, respectRetryAfter: true };
const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
let dispatchId = 0;

afterEach(() => {
  globalThis.fetch = originalFetch;
  releaseSpendHome?.();
  releaseSpendHome = undefined;
});

describe("Mistral recovery defaults", () => {
  test.each([baseUrl, `${baseUrl}/`, "https://API.MISTRAL.AI:443/v1"])("canonical key destination %s waits on 429", url => {
    const row = { ...provider, baseUrl: url };
    expect(rateLimitRetryPolicyFor(row)).toEqual(policy);
    expect(isCanonicalMistralChat(row)).toBe(true);
    expect(resolveMistralTransport(row)).not.toBe(row);
  });

  test("explicit settings and opt-out remain authoritative", () => {
    expect(rateLimitRetryPolicyFor({ ...provider, authMode: undefined })).toEqual(policy);
    expect(rateLimitRetryPolicyFor({ ...provider, retryOn429: { enabled: false } })).toBeNull();
    expect(rateLimitRetryPolicyFor({ ...provider, retryOn429: { attempts: 1, intervalMs: 123 } }))
      .toMatchObject({ attempts: 1, intervalMs: 123 });
    expect(rateLimitRetryPolicyFor({ ...provider, retryOn429: {} }))
      .toMatchObject({ attempts: 3, intervalMs: 5_000 });
  });

  test.each(["oauth", "forward", "local"] as const)("%s authentication never enables same-key retries", authMode => {
    expect(rateLimitRetryPolicyFor({ ...provider, authMode })).toBeNull();
  });

  test.each([
    "https://api.openai.com/v1", "https://api.mistral.ai.example.test/v1",
    "https://example.test/api.mistral.ai/v1", "http://api.mistral.ai/v1",
    "https://api.mistral.ai:8443/v1", `${baseUrl}?route=custom`, `${baseUrl}#custom`,
    "https://api.mistral.ai/other/v1", `${baseUrl}//`,
    baseUrl.replace("://", "://synthetic-user:synthetic-password@"), "not a URL",
  ])("other destinations retain fail-fast behavior: %s", url => {
    const row = { ...provider, baseUrl: url };
    expect(rateLimitRetryPolicyFor(row)).toBeNull();
    expect(isCanonicalMistralChat(row)).toBe(false);
    expect(resolveMistralTransport(row)).toBe(row);
  });

  test("a non-Chat adapter at the same host retains its previous behavior", () => {
    expect(rateLimitRetryPolicyFor({ ...provider, adapter: "openai-responses" })).toBeNull();
  });

  test("Mistral registry defaults forward stable caller cache keys, with an explicit opt-out", async () => {
    const entry = PROVIDER_REGISTRY.find(row => row.id === "mistral")!;
    expect(providerConfigSeed(entry).promptCacheKey).toBe(true);
    for (const enabled of [undefined, false]) {
      const routed = routedProviderConfig("mistral", { ...provider, ...(enabled === false ? { promptCacheKey: false } : {}) });
      const adapter = createOpenAIChatAdapter(routed);
      const cacheKey = "  synthetic-대화/会話:cache  ";
      const parsed = parseRequest({ model, input: "Synthetic fixture", prompt_cache_key: cacheKey });
      const request = await adapter.buildRequest(parsed);
      expect(JSON.parse(request.body!).prompt_cache_key).toBe(enabled === false ? undefined : cacheKey);
    }
  });
});

describe("Mistral Responses recovery", () => {
  async function dispatch(options: { failures: number; stream?: boolean; disabled?: boolean; abort?: AbortController; retryAfter?: string; leased?: boolean; minuteBudget?: boolean; providerName?: string; maxIntervalMs?: number }) {
    const bodies: string[] = [];
    const authorizations: (string | null)[] = [];
    const apiKey = `synthetic-mistral-key-${++dispatchId}`;
    globalThis.fetch = (async (_input, init) => {
      bodies.push(String(init?.body));
      authorizations.push(new Headers(init?.headers).get("authorization"));
      if (options.abort) {
        setTimeout(() => options.abort!.abort(), 10);
      }
      if (bodies.length <= options.failures) return Response.json({ message: "Not enough capacity available for this request, please retry later." }, {
        status: 429, headers: options.minuteBudget ? {
          "x-ratelimit-limit-tokens-minute": "1000", "x-ratelimit-remaining-tokens-minute": "400",
          "x-ratelimit-tokens-query-cost": "600",
        } : { "retry-after": options.retryAfter ?? (options.abort ? "30" : "0") },
      });
      const completion = { id: "synthetic-completion", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
      return options.stream
        ? new Response(`data: ${JSON.stringify({ ...completion, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: completion.usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json(completion);
    }) as typeof fetch;
    releaseSpendHome = acquireOwnedSpendHome();
    let now = 0;
    const waits: number[] = [];
    const providerName = options.providerName ?? "mistral";
    const row = { ...provider, apiKey, ...(options.maxIntervalMs === undefined ? {} : { retryOn429: { maxIntervalMs: options.maxIntervalMs } }), ...(options.disabled ? { retryOn429: { enabled: false } } : {}),
      ...(options.leased ? { requestPacing: { enabled: true, maxConcurrentRequests: 1 } } : {}) };
    const transport = options.minuteBudget ? resolveMistralTransport({ ...row, fetch: globalThis.fetch,
      retryOn429: { intervalMs: 0 } }, new MistralBudgetPacer(() => now, async (ms, signal) => {
      signal?.throwIfAborted(); waits.push(ms); now += ms;
    })) : row;
    const config = { port: 0, defaultProvider: providerName, providers: { [providerName]: transport } } as OcxConfig;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `${providerName}/${model}`, input: "Synthetic fixture", stream: options.stream ?? false, prompt_cache_key: "synthetic-conversation" }),
    }), config, { model: `${providerName}/${model}`, provider: providerName }, { abortSignal: options.abort?.signal });
    return { response, bodies, authorizations, apiKey, waits };
  }

  test.each([false, true])("pre-output 429 recovers on the same request and key (stream=%s)", async stream => {
    const { response, bodies, authorizations, apiKey } = await dispatch({ failures: 1, stream });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("OK");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]!).prompt_cache_key).toBe("synthetic-conversation");
    expect(authorizations).toEqual([`Bearer ${apiKey}`, `Bearer ${apiKey}`]);
  });

  test("persistent 429 stops after the six configured replays", async () => {
    const { response, bodies } = await dispatch({ failures: 10 });
    expect(response.status).toBe(429);
    expect(bodies).toHaveLength(7);
    await response.text();
  });

  test.each([false, true])("measured minute pressure recovers through the Responses pipeline (stream=%s)", async stream => {
    const { response, bodies, waits } = await dispatch({ failures: 1, stream, minuteBudget: true, leased: true });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("OK");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]!).prompt_cache_key).toBe("synthetic-conversation");
    expect(waits).toEqual([60000]);
  });

  test("a custom-named Mistral provider returns long server delays without early replay", async () => {
    const { response, bodies } = await dispatch({ failures: 1, providerName: "mistral-vibe", retryAfter: "120", maxIntervalMs: 1, leased: true });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(bodies).toHaveLength(1);
    await response.text();
  });

  test("explicit opt-out surfaces the first 429", async () => {
    const { response, bodies } = await dispatch({ failures: 1, disabled: true });
    expect(response.status).toBe(429);
    expect(bodies).toHaveLength(1);
    await response.text();
  });

  test("cancellation during backoff stops without another send", async () => {
    const { response, bodies } = await dispatch({ failures: 1, abort: new AbortController() });
    expect(response.status).toBe(499);
    expect(bodies).toHaveLength(1);
    await response.text();
  });

  test.each([false, true])("a server wait beyond the budget surfaces without an early replay (leased=%s)", async leased => {
    const { response, bodies } = await dispatch({ failures: 1, retryAfter: "120", leased });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(bodies).toHaveLength(1);
    await response.text();
  });

  test.each(["error-event", "broken-body"])("committed stream output is never replayed after %s", async failure => {
    let sends = 0;
    const encoder = new TextEncoder();
    globalThis.fetch = (async () => {
      sends++;
      let pulls = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) {
            controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"committed fixture"}}]}\n\n'));
          } else if (failure === "error-event") {
            controller.enqueue(encoder.encode('data: {"error":{"message":"rate limited after output","type":"rate_limit_error","code":"rate_limit_exceeded"}}\n\n'));
            controller.close();
          } else {
            controller.error(Object.assign(new Error("synthetic reset after output"), { code: "ECONNRESET" }));
          }
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    releaseSpendHome = acquireOwnedSpendHome();
    const config = { port: 0, defaultProvider: "mistral", providers: { mistral: {
      ...provider, apiKey: `synthetic-stream-key-${++dispatchId}`, retryOnReset: { enabled: true },
    } } } as OcxConfig;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `mistral/${model}`, input: "Synthetic fixture", stream: true }),
    }), config, { model: `mistral/${model}`, provider: "mistral" });
    const text = await response.text();
    expect(text).toContain("committed fixture");
    expect(text).toContain("response.failed");
    expect(sends).toBe(1);
  });
});

describe("Mistral observed budget pacing", () => {
  function fixture() {
    let now = 0;
    const waits: number[] = [];
    const pacing = new MistralBudgetPacer(() => now, async (ms, signal) => {
      signal?.throwIfAborted();
      waits.push(ms);
      now += ms;
    });
    return { pacing, waits };
  }

  const budget = (tokens: string, cost: string, requests = "10", retryAfter?: string) => new Headers({
    "x-ratelimit-remaining-tokens-minute": tokens,
    "x-ratelimit-tokens-query-cost": cost,
    "x-ratelimit-remaining-req-minute": requests,
    ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
  });

  test("uses each account's advertised budget without a fixed million-token ceiling", async () => {
    const { pacing, waits } = fixture();
    pacing.observe("higher-tier", budget("6000000", "1200000"));
    await pacing.acquire("higher-tier");
    expect(waits).toEqual([]);
    pacing.observe("lower-tier", budget("0", "600", "10", "7"));
    await pacing.acquire("lower-tier");
    expect(waits).toEqual([7000]);
  });

  test("evicting a live deadline at capacity never admits that identity early", async () => {
    const { pacing, waits } = fixture();
    for (let index = 0; index <= 128; index++) pacing.observe(`identity-${index}`, budget("0", "600", "10", "30"));
    // identity-0 was evicted to bound memory; its 30 s server delay still applies.
    await pacing.acquire("identity-0");
    expect(waits).toEqual([30_000]);
  });

  test("a shorter fresh delay never overrides an evicted identity's live deadline", async () => {
    const { pacing, waits } = fixture();
    pacing.observe("identity-0", budget("0", "600", "10", "60"));
    for (let index = 1; index <= 128; index++) pacing.observe(`identity-${index}`, budget("0", "600", "10", "30"));
    pacing.observe("identity-0", budget("0", "600", "10", "10"));
    await pacing.acquire("identity-0");
    expect(waits).toEqual([60_000]);
  });

  test("waits for explicit retry times after token or request exhaustion", async () => {
    const { pacing, waits } = fixture();
    pacing.observe("tokens", budget("800", "600", "10", "9"));
    await pacing.acquire("tokens");
    expect(waits).toEqual([]);
    pacing.observe("tokens", budget("0", "600", "10", "9"));
    await pacing.acquire("tokens");
    expect(waits).toEqual([9000]);
    pacing.observe("requests", budget("9000", "1", "0", "3"));
    await pacing.acquire("requests");
    await pacing.acquire("requests");
    expect(waits).toEqual([9000, 3000]);
  });

  test("missing, ambiguous, malformed and stale measurements do not impose quotas", async () => {
    const { pacing, waits } = fixture();
    for (const headers of [new Headers(), new Headers({ "x-ratelimit-remaining": "0" }),
      new Headers({ "x-ratelimit-remaining-tokens-minute": "NaN" }),
      new Headers({ "x-ratelimit-remaining-req-minute": "-1" }),
      new Headers({ "x-ratelimit-remaining-tokens-minute": "9007199254740992" }),
      budget("0", "600"), budget("400", "600"), budget("0", "600", "10", "invalid")]) {
      pacing.observe("unknown", headers);
      await pacing.acquire("unknown");
    }
    expect(waits).toEqual([]);
    pacing.observe("expired", budget("0", "100", "10", "2"));
    await pacing.acquire("expired");
    await pacing.acquire("expired");
    expect(waits).toEqual([2000]);
  });

  test.each(["zai-glm-5-3", "mistral-large-4"])("actual credential and model isolate %s budgets", async modelId => {
    const { pacing, waits } = fixture();
    const replies: Response[] = [];
    const transport = resolveMistralTransport({ ...provider, fetch: (async () => {
      const response = new Response("unchanged", { headers: budget("0", "600", "10", "4") });
      replies.push(response);
      return response;
    }) as typeof fetch }, pacing);
    const send = (key: string, model = modelId) => transport.fetch!(new URL(`${baseUrl}/chat/completions`), {
      method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ model }),
    });
    expect(await send("synthetic-key-a")).toBe(replies[0]!);
    await send("synthetic-key-b");
    await send("synthetic-key-a", "another-model");
    expect(waits).toEqual([]);
    await send("synthetic-key-a");
    expect(waits).toEqual([4000]);
  });

  test("pacing opt-out and unrelated providers retain their transport behavior", async () => {
    const { pacing, waits } = fixture();
    const fetch = (async () => new Response("OK", { headers: budget("0", "100", "10", "4") })) as typeof globalThis.fetch;
    const disabled = { ...provider, fetch, requestPacing: { enabled: false } };
    const transport = resolveMistralTransport(disabled, pacing);
    const init = { method: "POST", headers: { authorization: "Bearer synthetic-key" }, body: JSON.stringify({ model }) };
    await transport.fetch!(`${baseUrl}/chat/completions`, init);
    await transport.fetch!(`${baseUrl}/chat/completions`, init);
    expect(waits).toEqual([]);
    expect(resolveProviderTransport("another-provider", { ...provider, fetch, baseUrl: "https://example.test/v1" }).fetch).toBe(fetch);
    expect(resolveMistralTransport({ ...provider, fetch, baseUrl: "https://example.test/v1" }).fetch).toBe(fetch);
    expect(resolveMistralTransport(transport)).toBe(transport);
  });

  test("long Retry-After is preserved for both numeric and date hints", async () => {
    for (const hint of ["120", new Date(Date.now() + 120000).toUTCString()]) {
      const response = new Response("original refusal", { status: 429, headers: { "retry-after": hint } });
      const transport = resolveMistralTransport({ ...provider, fetch: (async () => response) as typeof fetch }, new MistralBudgetPacer());
      const result = await transport.fetch!(`${baseUrl}/chat/completions`, {
        method: "POST", headers: { authorization: "Bearer synthetic-key" }, body: JSON.stringify({ model }),
      });
      expect(result).toBe(response);
      // Only same-key replays stop: key rotation and unsanitized error delivery stay available.
      expect(isSameTargetRetryHold(result)).toBe(true);
      expect(isNonReplayableResponse(result)).toBe(false);
      expect(isSameTargetRetryHold(carryReplayRefusal(result, new Response(null, { status: 429 })))).toBe(true);
      expect(await result.text()).toBe("original refusal");
    }
  });

  test("cancelling a budget wait promptly releases it without sending", async () => {
    const pacing = new MistralBudgetPacer();
    pacing.observe("cancelled", budget("0", "100", "10", "30"));
    const abort = new AbortController();
    const waiting = pacing.acquire("cancelled", abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow();
  });

  test("a dated refusal without remaining counters holds later calls within their configured wait budget", async () => {
    const { pacing, waits } = fixture();
    pacing.observe("refused", new Headers({ "retry-after": "90" }), 429);
    await expect(pacing.acquire("refused", undefined, 10000)).rejects.toMatchObject({ retryAfterSeconds: 90 });
    expect(waits).toEqual([]);
    await pacing.acquire("refused", undefined, 90000);
    expect(waits).toEqual([90000]);
  });

  test("queue pressure is bounded and cancelled waiters release their capacity", async () => {
    const pacing = new MistralBudgetPacer();
    pacing.observe("pressure", budget("0", "1", "10", "30"));
    const abort = new AbortController();
    const waiting = Array.from({ length: 128 }, () => pacing.acquire("pressure", abort.signal));
    const settled = Promise.allSettled(waiting);
    await expect(pacing.acquire("pressure")).rejects.toMatchObject({ reason: "queue_full" });
    abort.abort();
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
    const cancelled = new AbortController();
    const next = pacing.acquire("pressure", cancelled.signal);
    cancelled.abort();
    await expect(next).rejects.toThrow();
  });
});

describe("Mistral error-triggered minute recovery", () => {
  const headers = (limit: number, remaining: number, cost: number, requests = 100, reqRemaining = requests) => new Headers({
    "x-ratelimit-limit-tokens-minute": String(limit), "x-ratelimit-remaining-tokens-minute": String(remaining),
    "x-ratelimit-tokens-query-cost": String(cost), "x-ratelimit-limit-req-minute": String(requests),
    "x-ratelimit-remaining-req-minute": String(reqRemaining),
  });
  function fixture() {
    let now = 0;
    const waits: number[] = [];
    const pacing = new MistralBudgetPacer(() => now, async (ms, signal) => {
      signal?.throwIfAborted(); waits.push(ms); now += ms;
    });
    return { pacing, waits };
  }

  test.each([1000, 1000000, 6000000])("only a refused measured charge activates the %s-token minute recovery", async limit => {
    const { pacing, waits } = fixture();
    const evidence = headers(limit, limit * 0.4, limit * 0.6);
    pacing.observe("key/model", evidence, 200);
    (await pacing.acquire("key/model"))(true);
    expect(waits).toEqual([]);
    pacing.observe("key/model", evidence, 429);
    (await pacing.acquire("key/model"))(true);
    (await pacing.acquire("key/model"))(true);
    expect(waits).toEqual([60000]);
  });

  test("request-minute exhaustion is independent of available tokens", async () => {
    const { pacing, waits } = fixture();
    pacing.observe("glm", headers(1000, 990, 10, 1, 0), 429);
    (await pacing.acquire("glm"))(true);
    expect(waits).toEqual([60000]);
  });

  test("known exhausted monthly allowance never becomes a minute reset or compaction signal", async () => {
    const { pacing, waits } = fixture();
    for (const cost of [600, 1200]) {
      const evidence = headers(1000, 0, cost);
      evidence.set("x-ratelimit-limit-tokens-month", "10000000");
      evidence.set("x-ratelimit-remaining-tokens-month", "0");
      expect(mistralMinuteRefusal(evidence)).toBe("unknown");
      pacing.observe("glm", evidence, 429);
      (await pacing.acquire("glm"))(true);
    }
    expect(waits).toEqual([]);
  });

  test("unknown, malformed, zero-entitlement and above-allowance refusals never invent a reset", async () => {
    const { pacing, waits } = fixture();
    for (const evidence of [new Headers(), headers(0, 0, 10), headers(1000, 1001, 10),
      headers(1000, 500, 10), headers(1000, 0, 1200),
      new Headers({ "x-ratelimit-remaining-tokens-minute": "0" })]) {
      pacing.observe("glm", evidence, 429);
      (await pacing.acquire("glm"))(true);
    }
    expect(waits).toEqual([]);
    expect(mistralMinuteRefusal(headers(1000, 0, 1200))).toBe("charge-above-allowance");
    expect(mistralMinuteRefusal(headers(0, 0, 1200))).toBe("unknown");
  });

  test("healthy cache hits and cold requests remain unpaced before a refusal", async () => {
    const { pacing, waits } = fixture();
    for (const evidence of [headers(1000, 400, 600), headers(1000, 0, 600), headers(1000, 390, 10)]) {
      pacing.observe("glm", evidence, 200);
      (await pacing.acquire("glm"))(true);
    }
    expect(waits).toEqual([]);
  });

  test("an explicit Retry-After including zero takes precedence over minute fallback", async () => {
    const { pacing, waits } = fixture();
    for (const hint of ["2", "0"]) {
      const evidence = headers(1000, 400, 600); evidence.set("retry-after", hint);
      pacing.observe("glm", evidence, 429);
      (await pacing.acquire("glm"))(true);
    }
    expect(waits).toEqual([2000]);
  });

  test("a minute hold exceeding the caller's wait budget never starts a send", async () => {
    const { pacing, waits } = fixture();
    pacing.observe("glm", headers(1000, 400, 600), 429);
    await expect(pacing.acquire("glm", undefined, 5000)).rejects.toMatchObject({ reason: "queue_expired", retryAfterSeconds: 60 });
    expect(waits).toEqual([]);
  });

  test("one recovery probe gates concurrent callers, then a success restores ordinary traffic", async () => {
    let now = 0;
    let sleepers = 0;
    const pacing = new MistralBudgetPacer(() => now, (_ms, signal) => new Promise((_resolve, reject) => {
      sleepers++;
      const abort = () => { sleepers--; reject(signal?.reason); };
      signal?.addEventListener("abort", abort, { once: true });
    }));
    pacing.observe("glm", headers(1000, 400, 600), 429);
    now = 60000;
    const release = await pacing.acquire("glm");
    let admitted = false;
    const second = pacing.acquire("glm").then(value => { admitted = true; return value; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    release(true);
    (await second)(true);
    expect(admitted).toBe(true);
    expect(sleepers).toBe(0);
    (await pacing.acquire("glm"))(true);
  });

  test("an intervening refusal survives an older probe's successful release", async () => {
    const { pacing, waits } = fixture();
    pacing.observe("glm", headers(1000, 400, 600), 429);
    const release = await pacing.acquire("glm");
    pacing.observe("glm", headers(1000, 0, 600), 429);
    release(true);
    (await pacing.acquire("glm"))(true);
    expect(waits).toEqual([60000, 60000]);
  });

  test("transport recovery preserves the exact body and cache key, with no lasting delay after success", async () => {
    const { pacing, waits } = fixture();
    const bodies: string[] = [];
    const transport = resolveMistralTransport({ ...provider, fetch: (async (_input, init) => {
      bodies.push(String(init?.body));
      return new Response("fixture", { status: bodies.length === 1 ? 429 : 200,
        headers: headers(1000, bodies.length === 1 ? 400 : 390, bodies.length === 1 ? 600 : 10) });
    }) as typeof fetch }, pacing);
    const body = JSON.stringify({ model, prompt_cache_key: "stable-fixture-conversation", messages: [{ role: "user", content: "fixture" }] });
    const send = () => transport.fetch!(`${baseUrl}/chat/completions`, { method: "POST", headers: { authorization: "Bearer synthetic-key" }, body });
    expect((await send()).status).toBe(429);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(waits).toEqual([60000]);
    expect(bodies).toEqual([body, body, body]);
  });

  test("failed network probe releases its slot for a later caller", async () => {
    const { pacing, waits } = fixture();
    pacing.observe("glm", headers(1000, 400, 600), 429);
    const failed = await pacing.acquire("glm");
    failed();
    (await pacing.acquire("glm"))(true);
    expect(waits).toEqual([60000]);
  });

  test("cancelling behind the recovery probe releases the waiter without affecting the probe", async () => {
    let now = 0;
    let sleepers = 0;
    const pacing = new MistralBudgetPacer(() => now, (_ms, signal) => new Promise((_resolve, reject) => {
      sleepers++;
      signal?.addEventListener("abort", () => { sleepers--; reject(signal.reason); }, { once: true });
    }));
    pacing.observe("glm", headers(1000, 400, 600), 429);
    now = 60000;
    const release = await pacing.acquire("glm");
    const abort = new AbortController();
    const pending = pacing.acquire("glm", abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(sleepers).toBe(0);
    release(true);
    (await pacing.acquire("glm"))(true);
  });

  test("a stalled recovery probe cannot hold later callers past their wait budget", async () => {
    const pacing = new MistralBudgetPacer();
    pacing.observe("blocked-probe", new Headers({ "retry-after": "0.001" }), 429);
    const release = await pacing.acquire("blocked-probe");
    try {
      await expect(pacing.acquire("blocked-probe", undefined, 5)).rejects.toMatchObject({ reason: "queue_expired" });
    } finally { release(true); }
    (await pacing.acquire("blocked-probe"))(true);
  });

  test("repeated variable-cost traffic recovers within one retry without predicting cache behavior", async () => {
    let now = 0;
    let window = 0;
    let remaining = 1000;
    let failures = 0;
    let sends = 0;
    let waits = 0;
    const pacing = new MistralBudgetPacer(() => now, async (ms, signal) => {
      signal?.throwIfAborted(); now += ms; waits++;
    });
    for (let index = 0; index < 300; index++) {
      // Cheap cached-shaped calls alternate with expensive cold-shaped calls.
      const cost = index % 3 === 0 ? 1 : 100 + ((index * 197) % 900);
      let completed = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const release = await pacing.acquire("glm");
        if (Math.floor(now / 60000) !== window) { window = Math.floor(now / 60000); remaining = 1000; }
        const status = cost <= remaining ? 200 : 429;
        sends++;
        if (status === 200) remaining -= cost;
        else failures++;
        pacing.observe("glm", headers(1000, remaining, cost), status);
        release(status === 200);
        if (status === 200) { completed = true; break; }
      }
      expect(completed).toBe(true);
    }
    expect(failures).toBeGreaterThan(0); // The first refusal is reactive evidence.
    expect(waits).toBe(failures);
    expect(sends).toBe(300 + failures);
  });

  test("recovery waiting is outside the upstream response-header deadline", async () => {
    let now = 0;
    const pacing = new MistralBudgetPacer(() => now, async (ms, signal) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      signal?.throwIfAborted(); now += ms;
    });
    let sends = 0;
    const transport = resolveMistralTransport({ ...provider, fetch: (async (_input, init) => {
      if (sends++ === 0) return new Response(null, { status: 429, headers: headers(1000, 400, 600) });
      init?.signal?.throwIfAborted();
      return new Response("OK");
    }) as typeof fetch }, pacing);
    const body = JSON.stringify({ model, prompt_cache_key: "deadline-fixture" });
    const init = { method: "POST", body, headers: { authorization: "Bearer synthetic-key" } };
    await transport.fetch!(`${baseUrl}/chat/completions`, init);
    const response = await fetchWithHeaderTimeout(`${baseUrl}/chat/completions`, init,
      new AbortController().signal, 5, false, transport.fetch!);
    expect(await response.text()).toBe("OK");
    expect(sends).toBe(2);
  });

  test("pausing the header deadline never disables client cancellation during admission", async () => {
    let now = 0;
    let sends = 0;
    const pacing = new MistralBudgetPacer(() => now, async (ms, signal) => {
      await sleepWithAbort(1000, signal); now += ms;
    });
    const transport = resolveMistralTransport({ ...provider, fetch: (async () => {
      sends++; return new Response(null, { status: 429, headers: headers(1000, 400, 600) });
    }) as typeof fetch }, pacing);
    const init = { method: "POST", body: JSON.stringify({ model }), headers: { authorization: "Bearer synthetic-key" } };
    await transport.fetch!(`${baseUrl}/chat/completions`, init);
    const abort = new AbortController();
    const pending = fetchWithHeaderTimeout(`${baseUrl}/chat/completions`, init, abort.signal, 5, false, transport.fetch!);
    setTimeout(() => abort.abort(new Error("client stopped")), 15);
    await expect(pending).rejects.toThrow("client stopped");
    expect(sends).toBe(1);
  });

  test("the response-header timeout still bounds the actual Mistral send", async () => {
    const transport = resolveMistralTransport({ ...provider, fetch: (async (_input, init) => {
      await sleepWithAbort(1000, init?.signal ?? undefined); return new Response("too late");
    }) as typeof fetch }, new MistralBudgetPacer());
    const init = { method: "POST", body: JSON.stringify({ model }), headers: { authorization: "Bearer synthetic-key" } };
    await expect(fetchWithHeaderTimeout(`${baseUrl}/chat/completions`, init,
      new AbortController().signal, 5, false, transport.fetch!)).rejects.toThrow("Timeout elapsed");
  });
});

describe("Mistral native Chat recovery", () => {
  test("an over-budget Retry-After reaches the caller without a replay", async () => {
    let sends = 0;
    globalThis.fetch = (async () => {
      sends++;
      return sends === 1
        ? Response.json({ error: { message: "synthetic capacity refusal" } }, { status: 429, headers: { "retry-after": "120" } })
        : Response.json({ id: "synthetic", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    }) as typeof fetch;
    releaseSpendHome = acquireOwnedSpendHome();
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/model", messages: [{ role: "user", content: "Synthetic fixture" }], stream: false }),
    }), { port: 0, defaultProvider: "fixture", providers: { fixture: {
      adapter: "openai-chat", baseUrl, authMode: "key", apiKey: "synthetic-native-chat-key",
    } } } as OcxConfig, { model: "", provider: "" });
    await response.text();
    expect(sends).toBe(1);
    expect(response.status).toBe(429);
  });
});


describe("Mistral native Chat key rotation", () => {
  test("an over-budget Retry-After still lets a pooled request rotate to another key", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seen.push(auth);
      return auth.endsWith("first")
        ? Response.json({ error: { message: "synthetic capacity refusal" } }, { status: 429, headers: { "retry-after": "120" } })
        : Response.json({ id: "synthetic", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    }) as typeof fetch;
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-mistral-rotation-"));
    process.env.OPENCODEX_HOME = home;
    releaseSpendHome = acquireOwnedSpendHome();
    const keys = ["synthetic-rotation-first", "synthetic-rotation-second"];
    const config = { port: 0, defaultProvider: "fixture", providers: { fixture: {
      adapter: "openai-chat", baseUrl, authMode: "key", apiKey: keys[0],
      apiKeyPool: keys.map((key, index) => ({ id: `k${index + 1}`, key, addedAt: index + 1 })),
    } } } as OcxConfig;
    try {
      saveConfig(config);
      const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/model", messages: [{ role: "user", content: "Synthetic fixture" }], stream: false }),
      }), config, { model: "", provider: "" });
      await response.text();
      expect(response.status).toBe(200);
      expect(seen.map(auth => auth.split(" ").at(-1))).toEqual(keys);
    } finally {
      clearKeyCooldowns(); releaseSpendHome?.(); releaseSpendHome = undefined;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

