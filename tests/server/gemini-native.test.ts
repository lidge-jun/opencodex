import { expect, test } from "bun:test";
import type { OcxConfig } from "../../src/types";
import { handleGeminiNative, type GeminiNativeDeps } from "../../src/server/gemini-native";
import { getActiveTurnCount, tryAdmitTurn } from "../../src/server/lifecycle";
import { rawJsonMember } from "../../src/server/gemini-native-wire";
import type { OAuthAccessSnapshot } from "../../src/oauth";

const config = { providers: { "google-antigravity": { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" } } } as OcxConfig;
const old: OAuthAccessSnapshot = { provider: "google-antigravity", accountId: "fixture-account", generation: "old", accessToken: "fixture-old-token", projectId: "fixture-project" };
const fresh = { ...old, generation: "new", accessToken: "fixture-new-token" };
function request(body = '{"contents":[],"future":9007199254740993123}', signal?: AbortSignal) {
  return new Request("http://localhost/v1beta/models/gemini-test:generateContent", { method: "POST", body, signal, headers: { Authorization: "Bearer fixture-client-key" } });
}
function transport(fn: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return Object.assign((url: RequestInfo | URL, init?: RequestInit) => Promise.resolve(fn(String(url), init!)), { preconnect: fetch.preconnect }) as typeof fetch;
}
async function run(req: Request, deps: GeminiNativeDeps, stream = false, cfg = config) {
  const lease = tryAdmitTurn(undefined, req.signal)!;
  try { return await handleGeminiNative(req, cfg, "gemini-test", stream, lease, deps); }
  finally { if (!lease.isTransferred()) lease.release(); }
}
test("native generation preserves source JSON, binds project and replaces ingress credentials", async () => {
  const baseline = getActiveTurnCount();
  const raw = '{"contents":[],"future":9007199254740993123}';
  const response = await run(request(raw), {
    access: async () => old, refresh: async () => { throw new Error("unexpected refresh"); },
    fetch: transport((url, init) => {
      expect(url).toEndWith("/v1internal:generateContent");
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-old-token");
      expect(rawJsonMember(String(init.body), "request")).toBe(raw);
      expect(JSON.parse(String(init.body)).project).toBe("fixture-project");
      return new Response('{"response":{"future":9007199254740993123}}');
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"future":9007199254740993123}');
  expect(getActiveTurnCount()).toBe(baseline);
});
test("401 refreshes the rejected snapshot once and cancels its response", async () => {
  let calls = 0, refreshes = 0, cancelled = false;
  const response = await run(request(), {
    access: async () => old,
    refresh: async rejected => { expect(rejected).toBe(old); refreshes++; return fresh; },
    fetch: transport((_url, init) => {
      calls++;
      if (calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 });
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-new-token");
      return new Response('{"response":{}}');
    }),
  });
  expect(response.status).toBe(200);
  expect(calls).toBe(2); expect(refreshes).toBe(1); expect(cancelled).toBe(true);
});
test("persistent 401 is terminal and safe error headers retain numeric Retry-After", async () => {
  let calls = 0, refreshes = 0;
  const response = await run(request(), {
    access: async () => old, refresh: async () => { refreshes++; return fresh; },
    fetch: transport(() => { calls++; return new Response("private upstream diagnostics", { status: 401, headers: { "Retry-After": "5", "Set-Cookie": "private" } }); }),
  });
  expect(response.status).toBe(401); expect(calls).toBe(2); expect(refreshes).toBe(1);
  expect(response.headers.get("retry-after")).toBe("5"); expect(response.headers.has("set-cookie")).toBe(false);
  expect(await response.text()).not.toContain("private");
});
test("invalid input, configured byte cap and disabled provider never acquire OAuth", async () => {
  let accessCalls = 0;
  const deps = { access: async () => { accessCalls++; return old; }, refresh: async () => fresh, fetch: transport(() => { throw new Error("unexpected send"); }) };
  expect((await run(request("[]"), deps)).status).toBe(400);
  expect((await run(request(), deps, false, { ...config, maxInboundBodyBytes: 2 })).status).toBe(413);
  expect((await run(request(), deps, false, { ...config, providers: { "google-antigravity": { ...config.providers["google-antigravity"], disabled: true } } })).status).toBe(503);
  expect(accessCalls).toBe(0);
});
test("stream cancellation releases upstream and active turn without a resend", async () => {
  const baseline = getActiveTurnCount();
  let calls = 0, cancelled = false;
  const response = await run(request(), {
    access: async () => old, refresh: async () => { throw new Error("unexpected refresh"); },
    fetch: transport(() => {
      calls++;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"response":{"text":"hello"}}\n\n')); }, cancel() { cancelled = true; } }));
    }),
  }, true);
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
  await reader.cancel();
  await Bun.sleep(0);
  expect(cancelled).toBe(true); expect(calls).toBe(1); expect(getActiveTurnCount()).toBe(baseline);
});
test("client cancellation during headers reaches the physical fetch", async () => {
  const baseline = getActiveTurnCount();
  const ac = new AbortController();
  const result = run(request(undefined, ac.signal), {
    access: async () => old, refresh: async () => fresh,
    fetch: transport((_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      ac.abort();
    })),
  });
  expect((await result).status).toBe(499); expect(getActiveTurnCount()).toBe(baseline);
});
test("malformed stream terminates delivery and never retries after output", async () => {
  let calls = 0;
  const response = await run(request(), {
    access: async () => old, refresh: async () => { throw new Error("unexpected refresh"); },
    fetch: transport(() => { calls++; return new Response('data: {"response":{"text":"first"}}\n\ndata: {}\n\n'); }),
  }, true);
  await expect(response.text()).rejects.toThrow(); expect(calls).toBe(1);
});

test("refresh failure returns a terminal error and releases the turn", async () => {
  const baseline = getActiveTurnCount();
  let calls = 0;
  const response = await run(request(), { access: async () => old, refresh: async () => { throw new Error("fixture-refresh-failure"); }, fetch: transport(() => { calls++; return new Response("{}", { status: 401 }); }) });
  expect(response.status).toBe(502); expect(calls).toBe(1); expect(getActiveTurnCount()).toBe(baseline);
});
test("header deadline aborts fetch and body stall aborts stream without replay", async () => {
  const baseline = getActiveTurnCount();
  const response = await run(request(), {
    access: async () => old, refresh: async () => fresh,
    fetch: transport((_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))),
  }, false, { ...config, connectTimeoutMs: 10 });
  expect(response.status).toBe(502);
  let cancelled = false;
  const stream = await run(request(), {
    access: async () => old, refresh: async () => fresh,
    fetch: transport(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }))),
  }, true, { ...config, stallTimeoutSec: 1 });
  await expect(stream.text()).rejects.toThrow();
  expect(cancelled).toBe(true); expect(getActiveTurnCount()).toBe(baseline);
});

test("native delivery logging observes EOF, failure and cancellation without changing bytes", async () => {
  const { logGeminiNativeDelivery } = await import("../../src/server/gemini-native-log");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const context = () => ({ model: "gemini-test", provider: "google-antigravity" });
  const id = `gemini-native-fixture-${crypto.randomUUID()}`;
  const raw = '{"unknown":9007199254740993123}';
  const delivered = logGeminiNativeDelivery(new Response(raw), request(), id, Date.now(), context());
  expect(await delivered.text()).toBe(raw);
  expect(getRequestLogEntries().find(row => row.requestId === id)?.status).toBe(200);
  const failedId = `${id}-failure`;
  const failed = logGeminiNativeDelivery(new Response(new ReadableStream({ pull(c) { c.error(new Error("fixture failure")); } })), request(), failedId, Date.now(), context());
  await expect(failed.text()).rejects.toThrow();
  expect(getRequestLogEntries().find(row => row.requestId === failedId)?.status).toBe(502);
  const cancelledId = `${id}-cancel`;
  const cancelled = logGeminiNativeDelivery(new Response(new ReadableStream({})), request(), cancelledId, Date.now(), context());
  await cancelled.body!.cancel();
  expect(getRequestLogEntries().find(row => row.requestId === cancelledId)?.status).toBe(499);
});
