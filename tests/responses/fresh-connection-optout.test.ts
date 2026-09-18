import { describe, expect, test } from "bun:test";
import { wantsFreshConnection, providerFetch } from "../../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../../src/types";

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
