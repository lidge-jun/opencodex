import { afterEach, describe, expect, test } from "bun:test";
import { sendWithConnectionPolicy } from "../../src/server/responses/fetch-helpers";
import { registerUpstreamRewriter, resetUpstreamRewritersForTests } from "../../src/plugins/upstream-hooks";

const originalHosts = process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS;
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
    await sendWithConnectionPolicy(fetcher, "https://relay.example/v1/responses", input);
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
    await sendWithConnectionPolicy(fetcher, new Request("https://sub.example.test/v1"));
    expect((observed?.tls as Record<string, unknown>)?.ecdhCurve).toBe("X25519:P-256:P-384");
  });

  test("matches the final rewritten destination instead of the original URL", async () => {
    process.env.OCX_TLS_CLASSICAL_GROUPS_HOSTS = "relay.example";
    let observed: BunFetchRequestInit | undefined;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      observed = init as BunFetchRequestInit;
      return new Response("ok");
    }) as typeof fetch;
    registerUpstreamRewriter("test-rewrite", target => { target.url = "https://relay.example/v1"; });
    await sendWithConnectionPolicy(fetcher, "https://other.example/v1");
    expect((observed?.tls as Record<string, unknown>)?.ecdhCurve).toBe("X25519:P-256:P-384");
    resetUpstreamRewritersForTests();
    registerUpstreamRewriter("test-rewrite", target => { target.url = "https://other.example/v1"; });
    await sendWithConnectionPolicy(fetcher, "https://relay.example/v1");
    expect(observed?.tls).toBeUndefined();
  });
});
