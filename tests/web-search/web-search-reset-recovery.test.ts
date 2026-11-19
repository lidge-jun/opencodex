import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { withUpstreamHttpVersion } from "../../src/lib/upstream-http-version";
import { parseRequest } from "../../src/responses/parser";
import type { OcxProviderConfig } from "../../src/types";
import { runWebSearch as runOpenAiWebSearch } from "../../src/web-search/executor";
import { runWithWebSearch } from "../../src/web-search/loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

/**
 * Wrap a fetch so it applies the provider's HTTP-version pin the way `providerFetch` does in
 * production. The reset-recovery tests need a provider-scoped executor that pins a protocol, so the
 * composition order in the loop leg is observable without standing up the whole server path.
 */
function withUpstreamHttpVersionExecutor(
  inner: typeof globalThis.fetch,
  provider: Pick<OcxProviderConfig, "upstreamHttpVersion">,
): typeof globalThis.fetch {
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    inner(input, withUpstreamHttpVersion(input, init, provider))) as typeof globalThis.fetch;
}

describe("connection-reset recovery parity on the web-search legs", () => {
  const originalGlobalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalGlobalFetch; });

  /** Bun's reset rejection shape, as matched by isConnectionResetError. */
  function bunResetError(): Error {
    return new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
  }

  type Observed = { keepalive: unknown; connection: string | null; protocol: string | undefined; body: unknown; redirect: string | undefined };

  function observe(init: RequestInit | undefined): Observed {
    const withExtras = init as (RequestInit & { keepalive?: unknown; protocol?: string }) | undefined;
    return {
      keepalive: withExtras?.keepalive,
      connection: new Headers(init?.headers).get("connection"),
      protocol: withExtras?.protocol,
      body: init?.body,
      redirect: init?.redirect,
    };
  }

  test("the sidecar leg replays a reset on a fresh connection while keeping the provider HTTP version pin", async () => {
    const attempts: Observed[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      attempts.push(observe(init));
      if (attempts.length === 1) throw bunResetError();
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    await runOpenAiWebSearch(
      "current docs",
      { type: "web_search" },
      {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
        upstreamHttpVersion: "http1.1",
      },
      new Headers({ authorization: "Bearer selected-token" }),
      { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 1_000 },
    );

    expect(attempts.length).toBe(2);
    // The first attempt must NOT force a fresh connection: pooling is the normal, faster path.
    expect(attempts[0]!.keepalive).toBeUndefined();
    expect(attempts[0]!.connection).toBeNull();
    // The replay must leave the half-closed pooled socket. `keepalive: false` is the field that
    // actually does it — Bun has ignored a bare `Connection: close` (oven-sh/bun#20492) — so
    // assert both rather than treating the header as sufficient.
    expect(attempts[1]!.keepalive).toBe(false);
    expect(attempts[1]!.connection).toBe("close");
    // Composition order guard: recovery must not displace the protocol pin, or a user who set
    // http1.1 to work around a transport failure loses it on exactly the retry that needs it.
    expect(attempts[0]!.protocol).toBe("http1.1");
    expect(attempts[1]!.protocol).toBe("http1.1");
    // Credential-boundary and replayability fields survive the composition.
    expect(attempts[1]!.redirect).toBe("manual");
    expect(typeof attempts[1]!.body).toBe("string");
  });

  test("the routed loop leg replays a reset on a fresh connection through the provider-scoped fetch", async () => {
    const attempts: Observed[] = [];
    const routedProvider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://routed.test/v1",
      apiKey: "routed-key",
      upstreamHttpVersion: "http1.1",
    };
    const providerScopedFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      attempts.push(observe(init));
      if (attempts.length === 1) throw bunResetError();
      return new Response(
        'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":null}]}\n\n'
          + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
          + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    globalThis.fetch = (async () => {
      throw new Error("the routed leg must use the provider-scoped fetch, not the global one");
    }) as typeof fetch;

    const parsed = parseRequest({ model: "routed/model", input: "search please", stream: true });
    const response = await runWithWebSearch({
      parsed,
      adapter: createOpenAIChatAdapter(routedProvider),
      hostedTool: { type: "web_search" },
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 1_000 },
      maxSearches: 1,
      selectedForwardHeaders: new Headers(),
      forwardProvider: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
      incomingMeta: {
        headers: new Headers(),
        translatorBudget: createTestTranslatorBudget(),
        providerFetch: withUpstreamHttpVersionExecutor(providerScopedFetch, routedProvider),
      },
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0]!.keepalive).toBeUndefined();
    expect(attempts[0]!.connection).toBeNull();
    expect(attempts[1]!.keepalive).toBe(false);
    expect(attempts[1]!.connection).toBe("close");
    expect(attempts[1]!.protocol).toBe("http1.1");
    // The loop sets accept-encoding: identity so raw byte progress stays observable; the recovery
    // helper clones headers into a Headers instance and must not drop it.
    expect(typeof attempts[1]!.body).toBe("string");
    expect(attempts.every(attempt => attempt.redirect === "manual")).toBe(true);
  });
});
