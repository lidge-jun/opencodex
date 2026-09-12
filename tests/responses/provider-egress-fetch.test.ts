import { afterEach, describe, expect, mock, test } from "bun:test";
import { InvalidProviderEgressError } from "../../src/lib/provider-egress";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import { CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import type { OcxProviderConfig } from "../../src/types";

const PROXY_B = "http://127.0.0.1:7897";
const PROXY_B_URL = new URL(PROXY_B).toString();
const TARGET = "https://provider.example/v1/responses";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function baseProvider(extra?: Partial<OcxProviderConfig>): OcxProviderConfig {
  return { adapter: "openai-responses", baseUrl: "https://provider.example/v1", ...extra } as OcxProviderConfig;
}

function stubGlobalFetch(): { seen: Array<{ input: unknown; init?: RequestInit }>; spy: ReturnType<typeof mock> } {
  const seen: Array<{ input: unknown; init?: RequestInit }> = [];
  const spy = mock(async (input: unknown, init?: RequestInit) => {
    seen.push({ input, init });
    return new Response("ok");
  });
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  return { seen, spy };
}

describe("providerFetch egress wiring", () => {
  test("inherit sends without a request-scoped proxy (legacy behavior)", async () => {
    const { seen } = stubGlobalFetch();
    const fetch = providerFetch(baseProvider());
    const response = await fetch(TARGET, { method: "POST", body: "{}" });
    expect(await response.text()).toBe("ok");
    expect(seen.length).toBe(1);
    expect("proxy" in (seen[0]?.init ?? {})).toBe(false);
  });

  test("explicit custom proxy is pinned request-scoped", async () => {
    const { seen } = stubGlobalFetch();
    const fetch = providerFetch(baseProvider({ proxy: PROXY_B }));
    await fetch(TARGET, { method: "POST", body: "{}" });
    expect(seen.length).toBe(1);
    expect((seen[0]?.init as Record<string, unknown>)?.proxy).toBe(PROXY_B_URL);
    });

  test("explicit proxy skips the WS fast lane before dispatch (HTTP fallback)", async () => {
    const { seen } = stubGlobalFetch();
    const fetch = providerFetch(baseProvider({ proxy: PROXY_B }));
    const init = { method: "POST", body: JSON.stringify({ stream: true, model: "m" }) };
    const response = await fetch(CODEX_RESPONSES_HTTP_URL, init);
    expect(await response.text()).toBe("ok");
    expect(seen.length).toBe(1);
    expect(seen[0]?.input).toBe(CODEX_RESPONSES_HTTP_URL);
    expect((seen[0]?.init as Record<string, unknown>)?.proxy).toBe(PROXY_B_URL);
  });

  test("invalid proxy fails closed before anything dispatches", async () => {
    const { seen, spy } = stubGlobalFetch();
    const fetch = providerFetch(baseProvider({ proxy: "direct" }));
    await expect(fetch(TARGET, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(InvalidProviderEgressError);
    expect(spy.mock.calls.length).toBe(0);
    expect(seen.length).toBe(0);
  });

  test("invalid proxy fails closed on WS-eligible turns without dialing", async () => {
    const { spy } = stubGlobalFetch();
    const fetch = providerFetch(baseProvider({ proxy: "socks5://127.0.0.1:1080" }));
    const init = { method: "POST", body: JSON.stringify({ stream: true, model: "m" }) };
    await expect(fetch(CODEX_RESPONSES_HTTP_URL, init)).rejects.toBeInstanceOf(InvalidProviderEgressError);
    expect(spy.mock.calls.length).toBe(0);
  });

  test("prebuilt Request with explicit proxy fails closed", async () => {
    const { spy } = stubGlobalFetch();
    const fetch = providerFetch(baseProvider({ proxy: PROXY_B }));
    await expect(fetch(new Request(TARGET), { method: "POST", body: "{}" })).rejects.toBeInstanceOf(InvalidProviderEgressError);
    expect(spy.mock.calls.length).toBe(0);
  });

  test("caller-owned executor with explicit proxy fails closed", async () => {
    const executor = mock(async () => new Response("must-not-send"));
    const fetch = providerFetch(baseProvider({ proxy: PROXY_B, fetch: executor as unknown as typeof globalThis.fetch }));
    await expect(fetch(TARGET, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(InvalidProviderEgressError);
    expect(executor.mock.calls.length).toBe(0);
  });

  test("caller-owned executor without proxy keeps legacy behavior", async () => {
    const seen: Array<{ input: unknown; init?: RequestInit }> = [];
    const executor = mock(async (input: unknown, init?: RequestInit) => {
      seen.push({ input, init });
      return new Response("ok");
    });
    const fetch = providerFetch(baseProvider({ fetch: executor as unknown as typeof globalThis.fetch }));
    await fetch(TARGET, { method: "POST", body: "{}" });
    expect(seen.length).toBe(1);
    expect("proxy" in (seen[0]?.init ?? {})).toBe(false);
  });
});
