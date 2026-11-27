import { afterEach, describe, expect, test } from "bun:test";
import { providerFetch, sendWithConnectionPolicy, wantsFreshConnection } from "../../src/server/responses/fetch-helpers";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { registerUpstreamRewriter, resetUpstreamRewritersForTests } from "../../src/plugins/upstream-hooks";
import { markEgressTransparentExecutor } from "../../src/lib/provider-egress";
import { markTlsContextTransparentExecutor } from "../../src/lib/tls-context-proof";
import { markPassiveKeyTransparent } from "../../src/lib/passive-key-fetch-proof";
import { anthropicBillingPhysicalFetch } from "../../src/providers/anthropic-billing-ownership";
import { distributedKeyPhysicalFetch } from "../../src/providers/api-key-response-ownership";
import { passiveKeyPhysicalFetch } from "../../src/providers/passive-key-observation";

const originalHosts = process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS;
const builtinBinding = { providerName: "fixture", provider: {} };
const builtinFetch = (executor: typeof fetch) => markTlsContextTransparentExecutor(markEgressTransparentExecutor(executor));
afterEach(() => {
  resetUpstreamRewritersForTests();
  if (originalHosts === undefined) delete process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS;
  else process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = originalHosts;
});

describe("host-scoped classical TLS groups", () => {
  test("applies the curve override while preserving TLS verification and request properties", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    let observed: BunFetchRequestInit | undefined;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      observed = init as BunFetchRequestInit;
      return new Response("ok");
    }) as typeof fetch;
    const input: BunFetchRequestInit = {
      method: "POST", body: "{}", headers: { "X-Test": "value" },
      tls: { rejectUnauthorized: true, serverName: "relay.example" },
    };
    await sendWithConnectionPolicy(builtinFetch(fetcher), "https://relay.example/v1/responses", input, builtinBinding);
    expect(observed?.tls).toMatchObject({
      rejectUnauthorized: true, serverName: "relay.example", ecdhCurve: "X25519:P-256:P-384",
    });
    expect(observed?.method).toBe("POST");
    expect(observed?.body).toBe("{}");
    expect(new Headers(observed?.headers).get("X-Test")).toBe("value");
    expect((input.tls as Record<string, unknown>).ecdhCurve).toBeUndefined();
  });

  test("leaves nonmatching, cleartext and unconfigured requests unchanged", async () => {
    let observed: BunFetchRequestInit | undefined;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      observed = init as BunFetchRequestInit;
      return new Response("ok");
    }) as typeof fetch;
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    for (const url of ["https://other.example/v1", "https://notrelay.example/v1", "http://relay.example/v1"]) {
      await sendWithConnectionPolicy(fetcher, url);
      expect(observed?.tls).toBeUndefined();
    }
    delete process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS;
    await sendWithConnectionPolicy(fetcher, "https://relay.example/v1");
    expect(observed?.tls).toBeUndefined();
  });

  test("matches configured subdomains case-insensitively for Request inputs", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = " .EXAMPLE.test , other.invalid ";
    let observed: BunFetchRequestInit | undefined;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      observed = init as BunFetchRequestInit;
      return new Response("ok");
    }) as typeof fetch;
    await sendWithConnectionPolicy(builtinFetch(fetcher), new Request("https://sub.example.test/v1"), undefined, builtinBinding);
    expect((observed?.tls as Record<string, unknown>)?.ecdhCurve).toBe("X25519:P-256:P-384");
  });

  test("matches a trailing DNS root dot in either hostname", async () => {
    let observed: BunFetchRequestInit | undefined;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      observed = init as BunFetchRequestInit;
      return new Response("ok");
    }) as typeof fetch;
    for (const [configured, url] of [
      ["relay.example", "https://relay.example./v1"],
      ["relay.example.", "https://relay.example/v1"],
      [".EXAMPLE.test.", "https://sub.example.test./v1"],
    ]) {
      process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = configured;
      await sendWithConnectionPolicy(builtinFetch(fetcher), url, undefined, builtinBinding);
      expect((observed?.tls as Record<string, unknown>)?.ecdhCurve).toBe("X25519:P-256:P-384");
    }
    expect(wantsFreshConnection("https://sub.example.test./v1", ".example.test.")).toBe(true);
    expect(wantsFreshConnection("https://example.test/v1", ".")).toBe(false);
  });

  test("refuses to discard TLS settings from a FetchSession", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    let dispatched = false;
    const fetcher = (async () => { dispatched = true; return new Response("ok"); }) as typeof fetch;
    const session = new Bun.FetchSession({ tls: { checkServerIdentity: () => new Error("fixture pin") } });
    try {
      await expect(sendWithConnectionPolicy(fetcher, "https://relay.example/v1", { session } as BunFetchRequestInit,
        { providerName: "fixture", provider: {} })).rejects.toThrow(/FetchSession/);
      expect(dispatched).toBe(false);
    } finally { session.close(); }
  });

  test("refuses an opaque provider fetch that may own its TLS session", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    let dispatched = false;
    const fetcher = (async () => { dispatched = true; return new Response("ok"); }) as typeof fetch;
    await expect(sendWithConnectionPolicy(fetcher, "https://relay.example/v1", undefined,
      { providerName: "fixture", provider: { fetch: fetcher } as never })).rejects.toThrow(/custom.*transport/i);
    expect(dispatched).toBe(false);
  });

  test("refuses a bound FetchSession executor without dispatching", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    const session = new Bun.FetchSession({ tls: { checkServerIdentity: () => new Error("fixture pin") } });
    try {
      await expect(sendWithConnectionPolicy(session.fetch as typeof fetch, "https://relay.example/v1"))
        .rejects.toThrow(/custom.*transport/i);
    } finally { session.close(); }
  });

  test("refuses an opaque executor even when a provider binding is supplied", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    let dispatched = false;
    const opaque = (async () => { dispatched = true; return new Response("ok"); }) as typeof fetch;
    await expect(sendWithConnectionPolicy(opaque, "https://relay.example/v1", undefined, builtinBinding))
      .rejects.toThrow(/custom.*transport/i);
    expect(dispatched).toBe(false);
  });

  test("proxy transparency alone does not prove that an executor preserves TLS settings", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    let dispatched = false;
    const session = new Bun.FetchSession({ tls: { checkServerIdentity: () => new Error("fixture pin") } });
    const opaque = markEgressTransparentExecutor((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      dispatched = true; return session.fetch(input, init);
    }) as typeof fetch);
    try {
      await expect(sendWithConnectionPolicy(opaque, "https://relay.example/v1", undefined, builtinBinding))
        .rejects.toThrow(/custom.*transport/i);
      const provider = { adapter: "openai-responses", baseUrl: "https://relay.example/v1" } as OcxProviderConfig;
      const wrapped = anthropicBillingPhysicalFetch(opaque, "fixture", provider);
      await expect(sendWithConnectionPolicy(wrapped, "https://relay.example/v1", undefined, builtinBinding))
        .rejects.toThrow(/custom.*transport/i);
      expect(dispatched).toBe(false);
    } finally { session.close(); }
  });

  test("built-in credential observation wrappers preserve the TLS proof", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    let observed: BunFetchRequestInit | undefined;
    const base = builtinFetch((async (_input: unknown, init?: RequestInit) => {
      observed = init as BunFetchRequestInit; return new Response("ok");
    }) as typeof fetch);
    markPassiveKeyTransparent(base);
    const provider = { adapter: "openai-responses", baseUrl: "https://relay.example/v1", apiKey: "fixture-key",
      _apiKeyAttempt: { distributed: true, reference: "fixture-key" } } as OcxProviderConfig;
    const config = { defaultProvider: "fixture", providers: { fixture: provider } } as OcxConfig;
    const billing = anthropicBillingPhysicalFetch(base, "fixture", provider);
    const distributed = distributedKeyPhysicalFetch(billing, "fixture", provider, "https://relay.example/v1");
    const physical = passiveKeyPhysicalFetch(distributed, config, "fixture", provider);
    expect(billing).not.toBe(base);
    expect(distributed).not.toBe(billing);
    expect(physical).not.toBe(distributed);
    await sendWithConnectionPolicy(physical, "https://relay.example/v1", undefined, builtinBinding);
    expect((observed?.tls as Record<string, unknown>)?.ecdhCurve).toBe("X25519:P-256:P-384");
  });

  test("refuses a provider-owned FetchSession executor only for opted-in hosts", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    let dispatched = false;
    const session = new Bun.FetchSession({ tls: { checkServerIdentity: () => new Error("fixture pin") } });
    const provider = { adapter: "openai-responses", baseUrl: "https://relay.example/v1",
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        dispatched = true; return session.fetch(input, init);
      }) as typeof fetch,
    } as OcxProviderConfig;
    try {
      await expect(providerFetch(provider, undefined, { providerName: "fixture" })("https://relay.example/v1"))
        .rejects.toThrow(/custom.*transport/i);
      expect(dispatched).toBe(false);
      const otherProvider = { ...provider, fetch: (async () => { dispatched = true; return new Response("ok"); }) as typeof fetch };
      const other = await providerFetch(otherProvider, undefined, { providerName: "fixture" })("https://other.example/v1");
      expect(other.status).toBe(200);
      expect(dispatched).toBe(true);
    } finally { session.close(); }
  });

  test("leaves an unmatched FetchSession unchanged", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    let observed: BunFetchRequestInit | undefined;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      observed = init as BunFetchRequestInit;
      return new Response("ok");
    }) as typeof fetch;
    const session = new Bun.FetchSession({ tls: { checkServerIdentity: () => new Error("fixture pin") } });
    try {
      await sendWithConnectionPolicy(fetcher, "https://other.example/v1", { session } as BunFetchRequestInit);
      expect(observed?.session).toBe(session);
      expect(observed?.tls).toBeUndefined();
    } finally { session.close(); }
  });

  test("preserves explicit request TLS options when a FetchSession is supplied", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    let observed: BunFetchRequestInit | undefined;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      observed = init as BunFetchRequestInit;
      return new Response("ok");
    }) as typeof fetch;
    const pin = () => new Error("fixture pin");
    const session = new Bun.FetchSession();
    try {
      await sendWithConnectionPolicy(builtinFetch(fetcher), "https://relay.example/v1",
        { session, tls: { checkServerIdentity: pin } } as BunFetchRequestInit, builtinBinding);
      expect(observed?.tls?.checkServerIdentity).toBe(pin);
      expect((observed?.tls as Record<string, unknown>)?.ecdhCurve).toBe("X25519:P-256:P-384");
    } finally { session.close(); }
  });

  test("matches the final rewritten destination instead of the original URL", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    let observed: BunFetchRequestInit | undefined;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      observed = init as BunFetchRequestInit;
      return new Response("ok");
    }) as typeof fetch;
    registerUpstreamRewriter("test-rewrite", target => { target.url = "https://relay.example/v1"; });
    await sendWithConnectionPolicy(builtinFetch(fetcher), "https://other.example/v1", undefined, builtinBinding);
    expect((observed?.tls as Record<string, unknown>)?.ecdhCurve).toBe("X25519:P-256:P-384");
    resetUpstreamRewritersForTests();
    registerUpstreamRewriter("test-rewrite", target => { target.url = "https://other.example/v1"; });
    await sendWithConnectionPolicy(builtinFetch(fetcher), "https://relay.example/v1", undefined, builtinBinding);
    expect(observed?.tls).toBeUndefined();
  });
});
