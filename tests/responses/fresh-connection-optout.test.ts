import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wantsFreshConnection, providerFetch } from "../../src/server/responses/fetch-helpers";
import { saveCredential } from "../../src/oauth/store";
import { handleResponses } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("wantsFreshConnection", () => {
  test("returns false when env is unset or empty", () => {
    expect(wantsFreshConnection("https://opencode.ai/zen/v1", undefined)).toBe(false);
    expect(wantsFreshConnection("https://opencode.ai/zen/v1", "")).toBe(false);
    expect(wantsFreshConnection("https://opencode.ai/zen/v1", "   ")).toBe(false);
  });

  test("matches exact hostname and subdomain suffixes case-insensitively, trimming leading dots", () => {
    const env = "opencode.ai, .API.Cloudflare.Com";
    expect(wantsFreshConnection("https://opencode.ai/zen/v1", env)).toBe(true);
    expect(wantsFreshConnection("https://api.opencode.ai/zen/v1", env)).toBe(true);
    expect(wantsFreshConnection("https://api.cloudflare.com/v1", env)).toBe(true);
    expect(wantsFreshConnection("https://other-cloudflare.com/v1", env)).toBe(false);
    expect(wantsFreshConnection("https://notopencode.ai/v1", env)).toBe(false);
  });

  test("returns false for unparseable URLs without throwing", () => {
    expect(wantsFreshConnection("::not-a-url::", "opencode.ai")).toBe(false);
  });
});

describe("providerFetch fresh connection dispatch", () => {
  test("injects Connection: close and keepalive: false when host matches env", async () => {
    const previous = process.env.OCX_FRESH_CONNECTION_HOSTS;
    process.env.OCX_FRESH_CONNECTION_HOSTS = "special-relay.test";
    let observedInit: RequestInit | undefined;

    const dummyProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://special-relay.test/v1",
      fetch: (async (_input, init) => {
        observedInit = init;
        return new Response("ok", { status: 200 });
      }) as typeof globalThis.fetch,
    };

    try {
      const fetcher = providerFetch(dummyProvider);
      await fetcher("https://special-relay.test/v1/responses", { method: "POST" });

      expect(observedInit).toBeDefined();
      expect((observedInit as any)?.keepalive).toBe(false);
      const headers = new Headers(observedInit?.headers);
      expect(headers.get("Connection")).toBe("close");
    } finally {
      if (previous === undefined) delete process.env.OCX_FRESH_CONNECTION_HOSTS;
      else process.env.OCX_FRESH_CONNECTION_HOSTS = previous;
    }
  });

  test("overwrites caller Connection: keep-alive header when fresh connection is enforced", async () => {
    const previous = process.env.OCX_FRESH_CONNECTION_HOSTS;
    process.env.OCX_FRESH_CONNECTION_HOSTS = "special-relay.test";
    let observedInit: RequestInit | undefined;

    const dummyProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://special-relay.test/v1",
      fetch: (async (_input, init) => {
        observedInit = init;
        return new Response("ok", { status: 200 });
      }) as typeof globalThis.fetch,
    };

    try {
      const fetcher = providerFetch(dummyProvider);
      await fetcher("https://special-relay.test/v1/responses", {
        method: "POST",
        headers: { Connection: "keep-alive" },
      });

      expect((observedInit as any)?.keepalive).toBe(false);
      const headers = new Headers(observedInit?.headers);
      expect(headers.get("Connection")).toBe("close");
    } finally {
      if (previous === undefined) delete process.env.OCX_FRESH_CONNECTION_HOSTS;
      else process.env.OCX_FRESH_CONNECTION_HOSTS = previous;
    }
  });

  test("accepts a Request object as input and applies fresh connection settings", async () => {
    const previous = process.env.OCX_FRESH_CONNECTION_HOSTS;
    process.env.OCX_FRESH_CONNECTION_HOSTS = ".special-relay.test";
    let observedInit: RequestInit | undefined;

    const dummyProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://sub.special-relay.test/v1",
      fetch: (async (_input, init) => {
        observedInit = init;
        return new Response("ok", { status: 200 });
      }) as typeof globalThis.fetch,
    };

    try {
      const fetcher = providerFetch(dummyProvider);
      const req = new Request("https://sub.special-relay.test/v1/responses", {
        method: "POST",
        headers: { "x-custom": "value" },
      });
      await fetcher(req);

      expect((observedInit as any)?.keepalive).toBe(false);
      const headers = new Headers(observedInit?.headers);
      expect(headers.get("Connection")).toBe("close");
      expect(headers.get("x-custom")).toBe("value");
    } finally {
      if (previous === undefined) delete process.env.OCX_FRESH_CONNECTION_HOSTS;
      else process.env.OCX_FRESH_CONNECTION_HOSTS = previous;
    }
  });

  test("preserves default keepalive and headers when host is not configured", async () => {
    const previous = process.env.OCX_FRESH_CONNECTION_HOSTS;
    delete process.env.OCX_FRESH_CONNECTION_HOSTS;
    let observedInit: RequestInit | undefined;

    const dummyProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://normal-relay.test/v1",
      fetch: (async (_input, init) => {
        observedInit = init;
        return new Response("ok", { status: 200 });
      }) as typeof globalThis.fetch,
    };

    try {
      const fetcher = providerFetch(dummyProvider);
      await fetcher("https://normal-relay.test/v1/responses", { method: "POST" });

      expect(observedInit).toBeDefined();
      expect((observedInit as any)?.keepalive).toBeUndefined();
      const headers = new Headers(observedInit?.headers);
      expect(headers.has("Connection")).toBe(false);
    } finally {
      if (previous !== undefined) process.env.OCX_FRESH_CONNECTION_HOSTS = previous;
    }
  });

  test("matches the destination introduced by a dispatch override", async () => {
    const previous = process.env.OCX_FRESH_CONNECTION_HOSTS;
    process.env.OCX_FRESH_CONNECTION_HOSTS = "special-relay.test";
    let observedInput: Parameters<typeof globalThis.fetch>[0] | undefined;
    let observedInit: RequestInit | undefined;

    const dummyProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://normal-relay.test/v1",
      fetch: (async (input, init) => {
        observedInput = input;
        observedInit = init;
        return new Response("ok", { status: 200 });
      }) as typeof globalThis.fetch,
    };

    try {
      const fetcher = providerFetch(dummyProvider, undefined, {
        dispatchOverride: (_input, init, execute) =>
          execute("https://special-relay.test/v1/responses", init),
      });
      await fetcher("https://normal-relay.test/v1/responses", { method: "POST" });

      expect(observedInput).toBe("https://special-relay.test/v1/responses");
      expect((observedInit as any)?.keepalive).toBe(false);
      const headers = new Headers(observedInit?.headers);
      expect(headers.get("Connection")).toBe("close");
    } finally {
      if (previous === undefined) delete process.env.OCX_FRESH_CONNECTION_HOSTS;
      else process.env.OCX_FRESH_CONNECTION_HOSTS = previous;
    }
  });

  test("does not match a destination removed by a dispatch override", async () => {
    const previous = process.env.OCX_FRESH_CONNECTION_HOSTS;
    process.env.OCX_FRESH_CONNECTION_HOSTS = "special-relay.test";
    let observedInput: Parameters<typeof globalThis.fetch>[0] | undefined;
    let observedInit: RequestInit | undefined;

    const dummyProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://special-relay.test/v1",
      fetch: (async (input, init) => {
        observedInput = input;
        observedInit = init;
        return new Response("ok", { status: 200 });
      }) as typeof globalThis.fetch,
    };

    try {
      const fetcher = providerFetch(dummyProvider, undefined, {
        dispatchOverride: (_input, init, execute) =>
          execute("https://normal-relay.test/v1/responses", init),
      });
      await fetcher("https://special-relay.test/v1/responses", { method: "POST" });

      expect(observedInput).toBe("https://normal-relay.test/v1/responses");
      expect((observedInit as any)?.keepalive).toBeUndefined();
      const headers = new Headers(observedInit?.headers);
      expect(headers.has("Connection")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OCX_FRESH_CONNECTION_HOSTS;
      else process.env.OCX_FRESH_CONNECTION_HOSTS = previous;
    }
  });

  test("a beforeDispatch hook cannot defeat the fresh-connection decision", async () => {
    // The hook receives a copy it cannot send. Even if it could, `Connection` is decided
    // inside the executor, which runs after the hook, so the policy wins either way.
    const previous = process.env.OCX_FRESH_CONNECTION_HOSTS;
    process.env.OCX_FRESH_CONNECTION_HOSTS = "special-relay.test";
    let observedInit: RequestInit | undefined;
    let sawHeaders = false;

    const dummyProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://special-relay.test/v1",
      fetch: (async (_input, init) => {
        observedInit = init;
        return new Response("ok", { status: 200 });
      }) as typeof globalThis.fetch,
    };

    try {
      const fetcher = providerFetch(dummyProvider, undefined, {
        beforeDispatch: headers => {
          sawHeaders = headers.get("x-custom") === "value";
          headers.set("Connection", "keep-alive");
        },
      });
      await fetcher("https://special-relay.test/v1/responses", {
        method: "POST",
        headers: { "x-custom": "value" },
      });

      expect(sawHeaders).toBe(true);
      const headers = new Headers(observedInit?.headers);
      expect(headers.get("Connection")).toBe("close");
      expect(headers.get("x-custom")).toBe("value");
    } finally {
      if (previous === undefined) delete process.env.OCX_FRESH_CONNECTION_HOSTS;
      else process.env.OCX_FRESH_CONNECTION_HOSTS = previous;
    }
  });
});

/**
 * The cases above drive `providerFetch` with an override that cooperates by calling the executor
 * it was handed. Production's OAuth override does not: it re-reads `route.provider.fetch` at the
 * send boundary, because credential reselection can install a different provider transport after
 * the wrapper was built, and calls that implementation directly. Every test above still passed
 * while the operator's configured host reused a pooled socket on that path (#4992), so the
 * regression has to enter through `handleResponses` rather than through a hand-written override.
 *
 * xAI OAuth is the live consumer: `resolveProviderTransport` installs a provider-scoped fetch and
 * rewrites the destination to the Grok CLI host, which is what makes it observable here.
 */
describe("the OAuth dispatch boundary", () => {
  test("a provider-scoped transport selected at dispatch receives the fresh-connection policy", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-fresh-connection-oauth-"));
    const nativeFetch = globalThis.fetch;
    const previousHosts = process.env.OCX_FRESH_CONNECTION_HOSTS;
    const previousOpencodexHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = home;
    process.env.OCX_FRESH_CONNECTION_HOSTS = "cli-chat-proxy.grok.com";
    const sends: Array<{ url: string; init?: RequestInit }> = [];

    try {
      await saveCredential("xai", {
        access: "xai-access-token",
        refresh: "xai-refresh-token",
        expires: Date.now() + 3_600_000,
        accountId: "xai-acct-1",
        source: "local-cli",
      });
      globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        sends.push({ url, init });
        return Response.json({
          id: "resp_fresh_connection",
          status: "completed",
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      }) as typeof globalThis.fetch;

      const config = {
        defaultProvider: "xai",
        providers: {
          xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
        },
      } as OcxConfig;
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "grok-4.6", input: "hello", stream: false }),
        }),
        config,
        logCtx,
        {},
      );

      expect(response.status).toBe(200);
      const inference = sends.filter(send => send.url.endsWith("/chat/completions"));
      expect(inference).toHaveLength(1);
      const [send] = inference;
      // The provider transport rewrote the destination, which is the host the operator named.
      expect(new URL(send.url).hostname).toBe("cli-chat-proxy.grok.com");
      const headers = new Headers(send.init?.headers);
      expect(headers.get("Connection")).toBe("close");
      expect((send.init as { keepalive?: boolean } | undefined)?.keepalive).toBe(false);
      // And the provider's own implementation still ran: only the xAI wrapper pins this header,
      // so wrapping the selected fetch did not replace it with the generic executor.
      expect(headers.get("x-grok-req-id")).toBeTruthy();
    } finally {
      globalThis.fetch = nativeFetch;
      if (previousHosts === undefined) delete process.env.OCX_FRESH_CONNECTION_HOSTS;
      else process.env.OCX_FRESH_CONNECTION_HOSTS = previousHosts;
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      removeTreeWithRetry(home);
    }
  });
});
