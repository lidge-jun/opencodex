import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { runWebSearch as runOpenAiWebSearch } from "../../src/web-search/executor";
import { listOpenAiForwardSidecarCandidates } from "../../src/providers/openai-sidecar";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(() => { globalThis.fetch = originalFetch; });

function testConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: {},
    ...overrides,
  };
}

describe("web-search sidecar 429 replays", () => {
  function sidecarProvider() {
    const cfg = testConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    return listOpenAiForwardSidecarCandidates(cfg)[0]!.provider;
  }

  function sseDone(): Response {
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }

  function searchWith(
    fetchImpl: () => Promise<Response>,
    timeoutMs = 30_000,
    recordOutcome?: (outcome: number | "connect_error" | "connect_neutral" | "timeout") => void,
    abortSignal?: AbortSignal,
  ) {
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    return runOpenAiWebSearch(
      "current docs",
      { type: "web_search" },
      sidecarProvider(),
      new Headers({ authorization: "Bearer selected-token" }),
      { model: "gpt-5.6-luna", reasoning: "low", timeoutMs },
      abortSignal,
      recordOutcome,
    );
  }

  function socketReset(): Error {
    // Shape of Bun's fetch rejection on a stale pooled socket.
    const err = new Error("The socket connection was closed unexpectedly");
    (err as Error & { code: string }).code = "ECONNRESET";
    return err;
  }

  test("a burst 429 is replayed and the recovered answer is returned", async () => {
    let calls = 0;
    const outcome = await searchWith(async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return sseDone();
    });
    expect(calls).toBe(2);
    expect(outcome.error).toBeUndefined();
  });

  test("a persistent 429 ends with the 429 after bounded attempts", async () => {
    let calls = 0;
    const outcome = await searchWith(async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    });
    expect(calls).toBe(3);
    expect(outcome.error).toContain("429");
  });

  test("a Retry-After past the ceiling ends with the 429 without parking", async () => {
    let calls = 0;
    const outcome = await searchWith(async () => {
      calls += 1;
      return new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
    });
    expect(calls).toBe(1);
    expect(outcome.error).toContain("429");
  });

  test("a Retry-After that cannot fit the sidecar deadline preserves the 429", async () => {
    let calls = 0;
    const recorded: Array<number | string> = [];
    const outcome = await searchWith(async () => {
      calls += 1;
      return new Response("slow down", { status: 429, headers: { "retry-after": "0.1" } });
    }, 50, value => recorded.push(value));
    expect(calls).toBe(1);
    expect(outcome.error).toContain("429");
    expect(recorded).toEqual([429]);
  });

  test("a deadline expiring during pre-retry body cleanup preserves the 429", async () => {
    // The never-settling body is a worse leak than the other mocks leave behind: restore
    // fetch so a later file's shared search loop does not inherit a 1s release per retry.
    const originalFetch = globalThis.fetch;
    try {
      let calls = 0;
      const recorded: Array<number | string> = [];
      const outcome = await searchWith(async () => {
        calls += 1;
        // A cancel() that never settles makes the bounded 1s release run to its cap; the
        // remaining deadline then cannot fit the backoff, so the wait ends mid-sleep. The
        // observed 429 must survive that expiry instead of being recorded as a timeout.
        const body = new ReadableStream<Uint8Array>({
          start: controller => controller.enqueue(new TextEncoder().encode("rate limited")),
          cancel: () => new Promise<void>(() => {}),
        });
        return new Response(body, { status: 429, headers: { "retry-after": "1" } });
      }, 1_500, value => recorded.push(value));
      expect(calls).toBe(1);
      expect(outcome.error).toContain("429");
      expect(recorded).toEqual([429]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reset recovery and 429 replays share one three-send budget", async () => {
    // Each quota leg used to open its own three-send reset allowance, so resets in front of every
    // 429 could reach nine paid requests. The script repeats reset, reset, 429 indefinitely.
    let calls = 0;
    const recorded: Array<number | string> = [];
    const outcome = await searchWith(async () => {
      calls += 1;
      if (calls % 3 !== 0) throw socketReset();
      return new Response("rate limited", { status: 429 });
    }, 30_000, value => recorded.push(value));
    expect(calls).toBe(3);
    // The budget ran out with the 429 in hand, so the quota evidence survives rather than being
    // replaced by a send-budget error recorded as a connection failure.
    expect(outcome.error).toContain("429");
    expect(recorded).toEqual([429]);
  });

  test("a reset in front of the first 429 leaves only one quota replay", async () => {
    let calls = 0;
    const recorded: Array<number | string> = [];
    const outcome = await searchWith(async () => {
      calls += 1;
      if (calls === 1) throw socketReset();
      return new Response("rate limited", { status: 429 });
    }, 30_000, value => recorded.push(value));
    expect(calls).toBe(3);
    expect(outcome.error).toContain("429");
    expect(recorded).toEqual([429]);
  });

  test("a caller abort during 429 backoff ends the search as a cancellation", async () => {
    let calls = 0;
    const recorded: Array<number | string> = [];
    const caller = new AbortController();
    const outcome = await searchWith(async () => {
      calls += 1;
      setTimeout(() => caller.abort(new DOMException("caller left", "AbortError")), 20);
      return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
    }, 30_000, value => recorded.push(value), caller.signal);
    expect(calls).toBe(1);
    expect(outcome.error).toBeDefined();
    // A caller that left is neither a quota signal nor a connection failure.
    expect(recorded).toEqual(["connect_neutral"]);
  });
});

test("issue #8160 - OpenAI search helper strips responses-lite marker from merged headers", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Headers | undefined;
  globalThis.fetch = (async (_url: any, init: any) => {
    capturedHeaders = new Headers(init?.headers);
    return new Response(
      'data: ' + JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } }) + '\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;

  try {
    await runOpenAiWebSearch(
      "synthetic query",
      { type: "web_search" },
      {
        adapter: "openai-responses",
        authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        headers: { "x-openai-internal-codex-responses-lite": "true", "x-custom-test": "forwarded" },
      } as any,
      new Headers({
        "x-openai-internal-codex-responses-lite": "true",
        "chatgpt-account-id": "test-account",
      }),
      { model: "gpt-6.1-sol", reasoning: "low", timeoutMs: 1_000 },
    );

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.has("x-openai-internal-codex-responses-lite")).toBe(false);
    expect(capturedHeaders!.get("chatgpt-account-id")).toBe("test-account");
    expect(capturedHeaders!.get("x-custom-test")).toBe("forwarded");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.each([
  { name: "configured header only", configured: true, selected: false },
  { name: "selected header only", configured: false, selected: true },
])("classic search strips the Responses Lite marker from $name", async ({ configured, selected }) => {
  let sent: Headers | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent = new Headers(init?.headers);
    return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
  }) as typeof fetch;

  await runOpenAiWebSearch(
    "synthetic query",
    { type: "web_search" },
    {
      adapter: "openai-responses",
      authMode: "forward",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      headers: { ...(configured ? { "X-OpenAI-Internal-Codex-Responses-Lite": "true" } : {}), "x-custom-test": "forwarded" },
    } as OcxProviderConfig,
    new Headers({ ...(selected ? { "X-OpenAI-Internal-Codex-Responses-Lite": "true" } : {}), "chatgpt-account-id": "test-account" }),
    { model: "gpt-6.1-sol", reasoning: "low", timeoutMs: 1_000 },
  );

  expect(sent).toBeDefined();
  expect(sent!.has("x-openai-internal-codex-responses-lite")).toBe(false);
  expect(sent!.get("chatgpt-account-id")).toBe("test-account");
  expect(sent!.get("x-custom-test")).toBe("forwarded");
});
