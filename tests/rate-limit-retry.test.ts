import { afterEach, describe, expect, test } from "bun:test";
import {
  rateLimitRetryDelayMs,
  rateLimitRetryPolicyFor,
} from "../src/providers/key-failover";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

describe("rateLimitRetryPolicyFor", () => {
  test("null when absent or explicitly disabled", () => {
    expect(rateLimitRetryPolicyFor({} as OcxProviderConfig)).toBeNull();
    expect(rateLimitRetryPolicyFor({ retryOn429: { enabled: false } } as OcxProviderConfig)).toBeNull();
  });

  test("null for OAuth, forward, local, and unknown auth modes (fail closed)", () => {
    expect(rateLimitRetryPolicyFor({
      authMode: "oauth",
      retryOn429: {},
    } as OcxProviderConfig)).toBeNull();
    expect(rateLimitRetryPolicyFor({
      authMode: "forward",
      retryOn429: {},
    } as OcxProviderConfig)).toBeNull();
    expect(rateLimitRetryPolicyFor({
      authMode: "local",
      retryOn429: {},
    } as OcxProviderConfig)).toBeNull();
    expect(rateLimitRetryPolicyFor({
      authMode: "custom-unknown",
      retryOn429: {},
    } as OcxProviderConfig)).toBeNull();
    expect(rateLimitRetryPolicyFor({
      authMode: "key",
      retryOn429: {},
    } as OcxProviderConfig)).not.toBeNull();
  });

  test("applies defaults when the object is present", () => {
    expect(rateLimitRetryPolicyFor({ retryOn429: {} } as OcxProviderConfig)).toEqual({
      enabled: true,
      attempts: 3,
      intervalMs: 5_000,
      maxIntervalMs: 60_000,
      respectRetryAfter: true,
    });
  });

  test("honors explicit values", () => {
    expect(rateLimitRetryPolicyFor({
      retryOn429: { attempts: 10, intervalMs: 1_000, maxIntervalMs: 5_000, respectRetryAfter: false },
    } as OcxProviderConfig)).toEqual({
      enabled: true,
      attempts: 10,
      intervalMs: 1_000,
      maxIntervalMs: 5_000,
      respectRetryAfter: false,
    });
  });
});

describe("rateLimitRetryDelayMs", () => {
  const policy = rateLimitRetryPolicyFor({ retryOn429: {} } as OcxProviderConfig)!;

  test("fixed interval when no header is present", () => {
    expect(rateLimitRetryDelayMs(policy, null, 1_000_000)).toBe(5_000);
    expect(rateLimitRetryDelayMs(policy, undefined, 1_000_000)).toBe(5_000);
  });

  test("honors Retry-After seconds and caps it at maxIntervalMs", () => {
    expect(rateLimitRetryDelayMs(policy, "2", 1_000_000)).toBe(2_000);
    expect(rateLimitRetryDelayMs(policy, "3600", 1_000_000)).toBe(60_000);
  });

  test("honors an HTTP-date Retry-After", () => {
    const now = Date.parse("2026-10-21T07:27:30Z");
    expect(rateLimitRetryDelayMs(policy, "Wed, 21 Oct 2026 07:28:00 GMT", now)).toBe(30_000);
  });

  test("an already-expired HTTP-date Retry-After retries immediately", () => {
    const now = Date.parse("2026-10-21T07:28:00Z");
    expect(rateLimitRetryDelayMs(policy, "Wed, 21 Oct 2026 07:27:30 GMT", now)).toBe(1);
    expect(rateLimitRetryDelayMs(policy, "Wed, 21 Oct 2026 07:28:00 GMT", now)).toBe(1);
  });

  test("a far-future HTTP-date Retry-After is capped at maxIntervalMs", () => {
    const now = Date.parse("2026-10-21T07:27:30Z");
    expect(rateLimitRetryDelayMs(policy, "Wed, 21 Oct 2027 07:28:00 GMT", now)).toBe(60_000);
  });

  test("Retry-After 0 retries immediately instead of falling back to the interval", () => {
    expect(rateLimitRetryDelayMs(policy, "0", 1_000_000)).toBe(1);
  });

  test("fixed fallback is capped at maxIntervalMs (a single wait never exceeds the cap)", () => {
    const p = rateLimitRetryPolicyFor({
      retryOn429: { intervalMs: 600_000, maxIntervalMs: 100 },
    } as OcxProviderConfig)!;
    expect(rateLimitRetryDelayMs(p, null, 1_000_000)).toBe(100);
    expect(rateLimitRetryDelayMs(p, "3600", 1_000_000)).toBe(100);
  });

  test("malformed Retry-After falls back to the fixed interval", () => {
    expect(rateLimitRetryDelayMs(policy, "soon", 1_000_000)).toBe(5_000);
  });

  test("respectRetryAfter=false ignores the header", () => {
    const p = rateLimitRetryPolicyFor({
      retryOn429: { respectRetryAfter: false, intervalMs: 111 },
    } as OcxProviderConfig)!;
    expect(rateLimitRetryDelayMs(p, "2", 1_000_000)).toBe(111);
  });
});

describe("retry loop client-abort handling", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("abort during the wait interrupts the sleep, cancels the 429 body, and returns 499 without replaying", async () => {
    let sends = 0;
    let upstreamBodyCancelled = false;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://llmapi.blsc.cn/chat/completions") {
        sends += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: "rate limited" } })));
            controller.close();
          },
          cancel() {
            upstreamBodyCancelled = true;
          },
        }), { status: 429, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const config = {
      port: 0,
      defaultProvider: "blsc",
      providers: {
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://llmapi.blsc.cn",
          authMode: "key",
          apiKey: "key-alpha-000111222333",
          retryOn429: { attempts: 3, intervalMs: 30_000, respectRetryAfter: false },
        },
      },
    } as OcxConfig;

    const abort = new AbortController();
    const pending = handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "blsc/DeepSeek-V4-Flash", input: "hello", stream: false }),
    }), config, { model: "blsc/DeepSeek-V4-Flash", provider: "blsc" }, { abortSignal: abort.signal });

    // Wait until the first upstream 429 lands and the retry sleep is running.
    for (let i = 0; i < 100 && sends === 0; i += 1) await Bun.sleep(10);
    expect(sends).toBe(1);

    abort.abort(new DOMException("client disconnected", "AbortError"));
    const response = await pending;
    expect(response.status).toBe(499);
    expect(sends).toBe(1);
    expect(upstreamBodyCancelled).toBe(true);
    const body = await response.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("client_cancelled");
  });

  test("a never-settling 429 body cancel() cannot block the abort-aware backoff", async () => {
    let sends = 0;
    let cancelInitiated = false;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://llmapi.blsc.cn/chat/completions") {
        sends += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: "rate limited" } })));
            controller.close();
          },
          cancel() {
            cancelInitiated = true;
            // Never settles: the release must be bounded or the retry loop hangs here.
            return new Promise<void>(() => {});
          },
        }), { status: 429, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const config = {
      port: 0,
      defaultProvider: "blsc",
      providers: {
        blsc: {
          adapter: "openai-chat",
          baseUrl: "https://llmapi.blsc.cn",
          authMode: "key",
          apiKey: "key-alpha-000111222333",
          retryOn429: { attempts: 3, intervalMs: 30_000, respectRetryAfter: false },
        },
      },
    } as OcxConfig;

    const abort = new AbortController();
    const pending = handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "blsc/DeepSeek-V4-Flash", input: "hello", stream: false }),
    }), config, { model: "blsc/DeepSeek-V4-Flash", provider: "blsc" }, { abortSignal: abort.signal });

    for (let i = 0; i < 100 && sends === 0; i += 1) await Bun.sleep(10);
    expect(sends).toBe(1);

    abort.abort(new DOMException("client disconnected", "AbortError"));
    const started = Date.now();
    const response = await pending;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(response.status).toBe(499);
    expect(sends).toBe(1);
    expect(cancelInitiated).toBe(true);
  });
});
