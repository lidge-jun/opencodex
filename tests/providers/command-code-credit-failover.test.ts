import { afterEach, describe, expect, test } from "bun:test";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { resetCommandCodeReasoningEffortsForTest } from "../../src/providers/command-code-efforts";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const CREDITS_EXHAUSTED = {
  success: false,
  error: {
    code: "BAD_REQUEST",
    message: "You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
  },
};

function parsed(modelId = "deepseek/deepseek-v4-flash", reasoning = "high"): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    context: {
      systemPrompt: [],
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    },
    options: { reasoning, maxOutputTokens: 100 },
  };
}

function adapterWith(fetch: typeof globalThis.fetch, authMode: OcxProviderConfig["authMode"] = "oauth") {
  return createCommandCodeAdapter({
    adapter: "command-code",
    baseUrl: "https://api.commandcode.ai",
    authMode,
    apiKey: "synthetic-credential",
    fetch,
  } as OcxProviderConfig & { fetch: typeof globalThis.fetch });
}

afterEach(() => resetCommandCodeReasoningEffortsForTest());

describe("Command Code insufficient-credit refusal", () => {
  test("maps the exact credit refusal to the shared 429 rotation path", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return new Response(JSON.stringify(CREDITS_EXHAUSTED), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const adapter = adapterWith(fetchMock);
    const response = await adapter.fetchResponse(await adapter.buildRequest(parsed()));

    expect(calls).toBe(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-upstream-status")).toBe("400");
    expect(response.headers.get("x-opencodex-refusal")).toBe("insufficient-credits");
    expect(await response.json()).toEqual(CREDITS_EXHAUSTED);
  });

  test("leaves ordinary 400s and other statuses untouched", async () => {
    const fixtures = [
      { status: 400, body: { success: false, error: { code: "BAD_REQUEST", message: "invalid params" } } },
      { status: 400, body: { success: false, error: { code: "RATE_LIMITED", message: CREDITS_EXHAUSTED.error.message } } },
      { status: 402, body: CREDITS_EXHAUSTED },
      { status: 400, body: { success: true, error: CREDITS_EXHAUSTED.error } },
      { status: 400, body: { success: false, error: { code: "BAD_REQUEST", message: "You have insufficient credits to make this request!" } } },
      { status: 400, body: { success: false, error: { code: "BAD_REQUEST", message: "You have insufficient credits to make this request" } } },
      { status: 400, body: { success: false, error: { code: "BAD_REQUEST", message: "you have insufficient credits to make this request." } } },
    ];

    for (const fixture of fixtures) {
      let calls = 0;
      const fetchMock = (async () => {
        calls += 1;
        return new Response(JSON.stringify(fixture.body), { status: fixture.status });
      }) as typeof globalThis.fetch;
      const adapter = adapterWith(fetchMock);
      const response = await adapter.fetchResponse(await adapter.buildRequest(parsed()));

      expect(calls).toBe(1);
      expect(response.status).toBe(fixture.status);
      expect(response.headers.get("x-opencodex-refusal")).toBeNull();
      expect(response.headers.get("x-opencodex-upstream-status")).toBeNull();
    }
  });

  test("leaves the credit refusal as a 400 on key and forward rows", async () => {
    // Only OAuth has sibling accounts to rotate to. A canonical key row has a same-key 429 retry
    // ladder (rateLimitRetryPolicyFor), so a rewrite would replay a credential with no credits left.
    for (const authMode of ["key", "forward"] as const) {
      let calls = 0;
      const adapter = adapterWith((async () => {
        calls += 1;
        return new Response(JSON.stringify(CREDITS_EXHAUSTED), { status: 400 });
      }) as typeof globalThis.fetch, authMode);
      const response = await adapter.fetchResponse(await adapter.buildRequest(parsed()));

      expect(calls).toBe(1);
      expect(response.status).toBe(400);
      expect(response.headers.get("x-opencodex-refusal")).toBeNull();
      expect(response.headers.get("x-opencodex-upstream-status")).toBeNull();
      expect(await response.json()).toEqual(CREDITS_EXHAUSTED);
    }
  });

  test("keeps upstream 429 and 402 refusals out of the credit classification", async () => {
    // A real 429 already reaches the OAuth rotation and must keep its own Retry-After; a 402
    // is a different failure class downstream. Neither may be relabelled as the credit
    // refusal, even when its body carries the same wording.
    const rateLimited = { error: { type: "rate_limit_error", message: "Too many requests" } };
    const paymentRequired = { error: { code: "PAYMENT_REQUIRED", message: "Payment required" } };
    const fixtures = [
      { status: 429, body: rateLimited, headers: { "retry-after": "30" } },
      { status: 429, body: CREDITS_EXHAUSTED, headers: { "retry-after": "7" } },
      { status: 402, body: CREDITS_EXHAUSTED, headers: {} },
      { status: 402, body: paymentRequired, headers: {} },
    ];

    for (const fixture of fixtures) {
      let calls = 0;
      const fetchMock = (async () => {
        calls += 1;
        return new Response(JSON.stringify(fixture.body), {
          status: fixture.status,
          headers: { "content-type": "application/json", ...fixture.headers },
        });
      }) as typeof globalThis.fetch;
      const adapter = adapterWith(fetchMock);
      const response = await adapter.fetchResponse(await adapter.buildRequest(parsed()));

      expect(calls).toBe(1);
      expect(response.status).toBe(fixture.status);
      expect(response.headers.get("x-opencodex-refusal")).toBeNull();
      expect(response.headers.get("x-opencodex-upstream-status")).toBeNull();
      expect(response.headers.get("retry-after")).toBe(fixture.headers["retry-after" as keyof typeof fixture.headers] ?? null);
      expect(await response.json()).toEqual(fixture.body);
    }
  });

  test("fails open for malformed and oversized bodies", async () => {
    const invalidUtf8Prefix = new TextEncoder().encode(
      '{"success":false,"error":{"code":"BAD_REQUEST","message":"You have insufficient credits to make this request.',
    );
    const invalidUtf8Suffix = new TextEncoder().encode('"}}');
    const invalidUtf8Body = new Uint8Array(invalidUtf8Prefix.length + 1 + invalidUtf8Suffix.length);
    invalidUtf8Body.set(invalidUtf8Prefix);
    invalidUtf8Body[invalidUtf8Prefix.length] = 0x80;
    invalidUtf8Body.set(invalidUtf8Suffix, invalidUtf8Prefix.length + 1);
    const fixtures = [
      new Response("{not json", { status: 400 }),
      new Response(JSON.stringify({ ...CREDITS_EXHAUSTED, pad: "x".repeat(9_000) }), { status: 400 }),
      new Response(invalidUtf8Body, { status: 400 }),
    ];

    for (const fixture of fixtures) {
      let calls = 0;
      const fetchMock = (async () => {
        calls += 1;
        return fixture.clone();
      }) as typeof globalThis.fetch;
      const adapter = adapterWith(fetchMock);
      const response = await adapter.fetchResponse(await adapter.buildRequest(parsed()));

      expect(calls).toBe(1);
      expect(response.status).toBe(400);
      expect(response.headers.get("x-opencodex-refusal")).toBeNull();
    }
  });

  test("normalizes the retry response after a reasoning-effort rejection", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "unsupported reasoning_effort" }), { status: 400 });
      }
      return new Response(JSON.stringify(CREDITS_EXHAUSTED), { status: 400 });
    }) as typeof globalThis.fetch;
    const adapter = adapterWith(fetchMock);
    const response = await adapter.fetchResponse(await adapter.buildRequest(parsed("moonshotai/Kimi-K3", "max")));

    expect(calls).toBe(2);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-refusal")).toBe("insufficient-credits");
    expect(response.headers.get("x-opencodex-upstream-status")).toBe("400");
    expect(await response.json()).toEqual(CREDITS_EXHAUSTED);
  });

  test("re-throws the caller abort reason instead of failing open", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const adapter = adapterWith((async () => {
      controller.abort(reason);
      return new Response(JSON.stringify(CREDITS_EXHAUSTED), { status: 400 });
    }) as typeof globalThis.fetch);
    await expect(adapter.fetchResponse(await adapter.buildRequest(parsed()), { abortSignal: controller.signal }))
      .rejects.toBe(reason);
  });
});
