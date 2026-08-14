import { expect, test } from "bun:test";
import type { AdapterRequest } from "../src/adapters/base";
import { createMimoFreeAdapter } from "../src/adapters/mimo-free";
import { adapterDefinitions } from "../src/adapters/registry";
import type { OcxProviderConfig } from "../src/types";

test("wrapper registry entries cannot construct an independent adapter", () => {
  const wrappers = adapterDefinitions().filter(([, definition]) => definition.kind === "wrapper");
  expect(wrappers.length).toBeGreaterThan(0);

  for (const [adapterId, definition] of wrappers) {
    expect("create" in definition, adapterId).toBe(false);
    expect("wrap" in definition, adapterId).toBe(true);
    if (definition.kind === "wrapper") {
      expect(typeof definition.wrap, adapterId).toBe("function");
    }
  }
});

test("MiMo 401 retry invalidates the injected JWT source before reacquiring a token", async () => {
  const originalFetch = globalThis.fetch;
  const observedAuthorization: string[] = [];
  let token = "stale-token";
  let resetCalls = 0;
  let fetchCalls = 0;

  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      const headers = new Headers(init?.headers);
      observedAuthorization.push(headers.get("authorization") ?? "");
      return fetchCalls === 1
        ? new Response("expired", { status: 401 })
        : new Response("ok", { status: 200 });
    }) as typeof fetch;

    const provider = {
      adapter: "mimo-free",
      baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai",
      authMode: "key",
      apiKey: "unused",
      defaultMaxOutputTokens: 64_000,
    } as OcxProviderConfig;
    const adapter = createMimoFreeAdapter(provider, {
      getJwt: async () => token,
      resetJwt: () => {
        resetCalls += 1;
        token = "fresh-token";
      },
    });
    const request: AdapterRequest = {
      url: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
      method: "POST",
      headers: { Authorization: "Bearer stale-token" },
      body: "{}",
    };

    expect(adapter.fetchResponse).toBeDefined();
    const response = await adapter.fetchResponse!(request, {});
    expect(response.status).toBe(200);
    expect(resetCalls).toBe(1);
    expect(observedAuthorization).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
