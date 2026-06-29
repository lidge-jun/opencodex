import { afterEach, describe, expect, test } from "bun:test";
import { runWebSearch } from "../src/web-search/executor";
import { runWithWebSearch } from "../src/web-search/loop";
import { describeImage } from "../src/vision/describe";
import { parseRequest } from "../src/responses/parser";
import { headersForCodexAuthContext } from "../src/codex-auth-context";
import type { ProviderAdapter } from "../src/adapters/base";
import type { OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test",
  authMode: "forward",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installAbortAwareFetch(): () => AbortSignal {
  let seenSignal: AbortSignal | undefined;
  globalThis.fetch = ((_, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return new Promise<Response>((_, reject) => {
      seenSignal?.addEventListener("abort", () => reject(new Error("aborted by turn")), { once: true });
    });
  }) as typeof fetch;
  return () => {
    if (!seenSignal) throw new Error("fetch was not called");
    return seenSignal;
  };
}

function sseText(text: string): Response {
  return new Response(
    `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":${JSON.stringify(text)}}\n\n` +
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("sidecar abort propagation", () => {
  test("web-search loop routed-provider fetch observes the WebSocket turn abort signal", async () => {
    const getSignal = installAbortAwareFetch();
    const turn = new AbortController();
    const adapter: ProviderAdapter = {
      name: "mock",
      buildRequest: () => ({ url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" }),
      async *parseStream() { /* unused */ },
      async parseResponse() { return []; },
    };
    const response = runWithWebSearch({
      parsed: parseRequest({
        model: "routed/model",
        input: "Search for current docs",
        stream: true,
        tools: [{ type: "web_search" }],
      }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      abortSignal: turn.signal,
    });

    // buildRequest is now async-capable (Vertex ADC), so the loop yields once before dispatching
    // fetch; flush the microtask/timer queue so the routed fetch is observed.
    await new Promise((r) => setTimeout(r, 0));
    const signal = getSignal();
    expect(signal).toBe(turn.signal);
    expect(signal.aborted).toBe(false);
    turn.abort("replacement turn");
    expect(signal.aborted).toBe(true);
    expect((await response).status).toBe(502);
  });

  test("web-search sidecar fetch observes the WebSocket turn abort signal", async () => {
    const getSignal = installAbortAwareFetch();
    const turn = new AbortController();
    const outcome = runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      turn.signal,
    );

    const signal = getSignal();
    expect(signal.aborted).toBe(false);
    turn.abort("replacement turn");
    expect(signal.aborted).toBe(true);
    expect((await outcome).error).toBe("aborted by turn");
  });

  test("web-search sidecar records HTTP and connect outcomes", async () => {
    const recorded: unknown[] = [];
    globalThis.fetch = (() => Promise.resolve(new Response("expired", { status: 401 }))) as typeof fetch;

    const httpOutcome = await runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      undefined,
      outcome => recorded.push(outcome),
    );

    expect(httpOutcome.error).toBe("sidecar HTTP 401: expired");
    expect(recorded).toEqual([401]);

    globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
    const connectOutcome = await runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      undefined,
      outcome => recorded.push(outcome),
    );

    expect(connectOutcome.error).toBe("network down");
    expect(recorded).toEqual([401, "connect_error"]);
  });

  test("web-search loop forwards sidecar outcomes", async () => {
    const recorded: unknown[] = [];
    globalThis.fetch = ((input, init) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer token");
      return Promise.resolve(new Response("expired", { status: 401 }));
    }) as typeof fetch;
    const adapter: ProviderAdapter = {
      name: "mock",
      buildRequest: () => ({ url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" }),
      async *parseStream() { /* unused */ },
      async parseResponse() {
        return [
          { type: "tool_call_start", id: "call_1", name: "web_search" },
          { type: "tool_call_delta", id: "call_1", arguments: JSON.stringify({ query: "current docs" }) },
          { type: "tool_call_end", id: "call_1" },
        ];
      },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({
        model: "routed/model",
        input: "Search for current docs",
        stream: true,
        tools: [{ type: "web_search" }],
      }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      recordSidecarOutcome: outcome => recorded.push(outcome),
    });

    expect(response.status).toBe(200);
    expect(recorded).toEqual([401]);
  });

  test("vision sidecar fetch observes the WebSocket turn abort signal", async () => {
    const getSignal = installAbortAwareFetch();
    const turn = new AbortController();
    const outcome = describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
      turn.signal,
    );

    const signal = getSignal();
    expect(signal.aborted).toBe(false);
    turn.abort("replacement turn");
    expect(signal.aborted).toBe(true);
    expect((await outcome).error).toBe("aborted by turn");
  });

  test("vision sidecar records HTTP and connect outcomes", async () => {
    const recorded: unknown[] = [];
    globalThis.fetch = (() => Promise.resolve(new Response("denied", { status: 403 }))) as typeof fetch;

    const httpOutcome = await describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
      undefined,
      outcome => recorded.push(outcome),
    );

    expect(httpOutcome.error).toBe("vision sidecar HTTP 403: denied");
    expect(recorded).toEqual([403]);

    globalThis.fetch = (() => Promise.reject(new Error("vision network down"))) as typeof fetch;
    const connectOutcome = await describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
      undefined,
      outcome => recorded.push(outcome),
    );

    expect(connectOutcome.error).toBe("vision network down");
    expect(recorded).toEqual([403, "connect_error"]);
  });

  test("web-search sidecar uses selected pool auth instead of inbound main auth", async () => {
    let seenAuthorization: string | null = null;
    let seenAccount: string | null = null;
    globalThis.fetch = ((_, init) => {
      const headers = new Headers(init?.headers);
      seenAuthorization = headers.get("authorization");
      seenAccount = headers.get("chatgpt-account-id");
      return Promise.resolve(sseText("done"));
    }) as typeof fetch;
    const selectedHeaders = headersForCodexAuthContext(
      new Headers({ authorization: "Bearer main-token", "chatgpt-account-id": "main_acc" }),
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool-token", chatgptAccountId: "pool_acc" },
    );

    await runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      selectedHeaders,
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
    );

    expect(seenAuthorization).toBe("Bearer pool-token");
    expect(seenAccount).toBe("pool_acc");
  });

  test("vision sidecar uses selected pool auth instead of inbound main auth", async () => {
    let seenAuthorization: string | null = null;
    let seenAccount: string | null = null;
    globalThis.fetch = ((_, init) => {
      const headers = new Headers(init?.headers);
      seenAuthorization = headers.get("authorization");
      seenAccount = headers.get("chatgpt-account-id");
      return Promise.resolve(sseText("image description"));
    }) as typeof fetch;
    const selectedHeaders = headersForCodexAuthContext(
      new Headers({ authorization: "Bearer main-token", "chatgpt-account-id": "main_acc" }),
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool-token", chatgptAccountId: "pool_acc" },
    );

    await describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      selectedHeaders,
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
    );

    expect(seenAuthorization).toBe("Bearer pool-token");
    expect(seenAccount).toBe("pool_acc");
  });
});
