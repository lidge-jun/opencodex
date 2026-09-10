import { expect, test } from "bun:test";
import { fetchHubUsage } from "../../src/client/hub-client";
import { MAX_HUB_USAGE_BYTES, parseHubUsage } from "../../src/remote/hub-usage";

const report = () => ({
  schemaVersion: 1, source: "hub", scope: "client", range: "all", surface: "all", since: null, generatedAt: 1,
  summary: { requests: 1, totalTokens: 3, inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, unpricedRequests: 1, unmeteredRequests: 0 },
  providers: [{ provider: "fixture", requests: 1, totalTokens: 3 }],
  models: [{ provider: "fixture", model: "model", requests: 1, totalTokens: 3 }], days: [],
  filter: { provider: null, model: null, matched: true, comboOverlap: false },
});

test("hub usage sends only the data key, preserves query and incomplete metadata", async () => {
  const result = await fetchHubUsage("https://hub.example.test", "client-data-key", new URLSearchParams("range=all&model=model"), {
    fetchImpl: (async (input, init) => {
      expect(String(input)).toBe("https://hub.example.test/v1/usage?range=all&model=model");
      expect(new Headers(init?.headers).get("x-opencodex-api-key")).toBe("client-data-key");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(init?.redirect).toBe("manual");
      expect(init?.cache).toBe("no-store");
      return Response.json({ ...report(), usageIncomplete: true, usageIncompleteReason: "oversized_rows" });
    }) as typeof fetch,
  });
  expect(result).toMatchObject({ scope: "client", usageIncomplete: true });
});

test.each([401, 403, 404, 500])("hub usage reports HTTP %i without a fallback request", async status => {
  let calls = 0;
  await expect(fetchHubUsage("https://hub.example.test", "client-key", new URLSearchParams(), {
    fetchImpl: (async () => { calls++; return new Response(null, { status }); }) as typeof fetch,
  })).rejects.toThrow(status === 404 ? "upgrade the hub" : status === 500 ? "500" : "rejected");
  expect(calls).toBe(1);
});

test("redirects, offline hubs, malformed bodies and oversized responses fail", async () => {
  for (const fetchImpl of [
    async () => new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
    async () => { throw new Error("offline"); },
    async () => Response.json({ ...report(), summary: {} }),
    async () => new Response("not json", { headers: { "content-type": "application/json" } }),
    async () => new Response("html", { headers: { "content-type": "text/html" } }),
    async () => new Response("x", { headers: { "content-type": "application/json", "content-length": String(MAX_HUB_USAGE_BYTES + 1) } }),
  ]) {
    await expect(fetchHubUsage("https://hub.example.test", "client-key", new URLSearchParams(), { fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow();
  }
});

test("every DTO level drops management-only fields", () => {
  const data = report();
  const result = parseHubUsage({ ...data, accounts: [{ accountLogLabel: "private" }],
    summary: { ...data.summary, private: "private" },
    providers: data.providers.map(row => ({ ...row, private: "private" })),
    models: data.models.map(row => ({ ...row, private: "private" })),
    days: [{ date: "2026-01-01", requests: 1, totalTokens: 3, models: [{ private: "private" }] }],
    filter: { ...data.filter, apiKeyId: "private" },
  });
  expect(result).not.toBeNull();
  expect(JSON.stringify(result)).not.toContain("private");
});


test("header deadline aborts an unresponsive hub transport", async () => {
  let aborted = false;
  await expect(fetchHubUsage("https://hub.example.test", "client-key", new URLSearchParams(), {
    timeoutMs: 10,
    fetchImpl: ((_input, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
    })) as typeof fetch,
  })).rejects.toThrow("did not complete");
  expect(aborted).toBe(true);
});

test("stalled hub usage body is cancelled at the inactivity deadline", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await expect(fetchHubUsage("https://hub.example.test", "client-key", new URLSearchParams(), {
    timeoutMs: 10,
    fetchImpl: (async () => new Response(body, { headers: { "content-type": "application/json" } })) as typeof fetch,
  })).rejects.toThrow("stalled");
  expect(cancelled).toBe(true);
});


test.each(["http://192.0.2.1", "http://hub.example.test", "https://user:password@hub.example.test"])(
  "unsafe credential destination %s is refused before transport", async origin => {
    let calls = 0;
    await expect(fetchHubUsage(origin, "client-key", new URLSearchParams(), {
      fetchImpl: (async () => { calls++; return Response.json(report()); }) as typeof fetch,
    })).rejects.toThrow();
    expect(calls).toBe(0);
  },
);

test.each(["https://hub.example.test", "http://127.0.0.1:12345", "http://[::1]:12345", "http://localhost:12345"])(
  "supported credential destination %s keeps an uncached read", async origin => {
    let calls = 0;
    await fetchHubUsage(origin, "client-key", new URLSearchParams(), {
      fetchImpl: (async (_input, init) => { calls++; expect(init?.cache).toBe("no-store"); return Response.json(report()); }) as typeof fetch,
    });
    expect(calls).toBe(1);
  },
);
