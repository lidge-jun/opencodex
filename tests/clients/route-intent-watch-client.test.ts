import { afterEach, expect, test } from "bun:test";
import { watchHomeRouteIntent, startRouteIntentWatch } from "../../src/client/route-intent-watch";
import { projectHomeRouteIntent } from "../../src/link/route-intent";
import type { OcxClientConnectionConfig } from "../../src/types";
import { createLinkRelaySessions } from "../../src/server/index/link-relay-sessions";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";

const connection = { transport: "link", apiKeyId: "test-key-id", link: { linkId: "lnk_0123456789abcdef", tunnelPort: 19200 } } as OcxClientConnectionConfig;
const document = projectHomeRouteIntent({} as never, "test");
const handles: Array<{ stop(): void }> = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.stop(); });
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function reply(watch = "1") { return Response.json(document, { headers: watch ? { "x-ocx-route-intent-watch": watch } : {} }); }

test("watch sends only exact read with closed headers, manual redirects and a cancellable deadline", async () => {
  let calls = 0;
  const result = await watchHomeRouteIntent(connection, "test-admission-key", "a".repeat(64), { fetchImpl: (async (url, init) => {
    calls++;
    expect(String(url)).toBe("http://127.0.0.1:19200/v1/link-management/route-intent");
    expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("manual"); expect(init?.body).toBeUndefined();
    const h = new Headers(init?.headers);
    expect([...h.keys()].sort()).toEqual(["accept", "authorization", "x-ocx-route-intent-after", "x-ocx-route-intent-watch"]);
    expect(h.get("authorization")).toBe("Bearer test-admission-key");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return reply();
  }) as typeof fetch });
  expect(calls).toBe(1); expect(result).toMatchObject({ kind: "fresh", watchSupported: true, document });
});

test("unknown identities and malformed digest send nothing", async () => {
  const deps = { fetchImpl: (async () => { throw new Error("must not send"); }) as typeof fetch };
  expect(await watchHomeRouteIntent({ ...connection, apiKeyId: undefined }, "key", undefined, deps)).toMatchObject({ kind: "failed" });
  expect(await watchHomeRouteIntent(connection, "key", "invalid", deps)).toMatchObject({ kind: "failed" });
});

test("untrusted responses have strict size, type, UTF-8, schema and support-header bounds; diagnostics stay fixed", async () => {
  const responses = [new Response("private-body", { status: 302, headers: { location: "http://secret" } }),
    new Response("private-body", { headers: { "content-type": "text/html" } }),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "65537" } }),
    new Response("x".repeat(65537), { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    Response.json({ secret: "private-body" }), reply("secret-invalid"),
    Response.json(document, { headers: { "x-ocx-route-intent-watch": "1", "x-ocx-route-intent-wake": "unknown" } }),
    Response.json(document, { headers: { "x-extra": "x".repeat(8193) } })];
  for (const response of responses) {
    const result = await watchHomeRouteIntent(connection, "secret-key", undefined, { fetchImpl: (async () => response) as typeof fetch });
    expect(result.kind).toBe("failed");
    expect(JSON.stringify(result)).not.toMatch(/private-body|secret-key|secret-invalid/);
  }
  expect(await watchHomeRouteIntent(connection, "key", undefined, { fetchImpl: (async () => { throw new Error("secret-error"); }) as typeof fetch }))
    .toEqual({ kind: "failed", reason: "route_intent_watch_unavailable" });
});

test("abort and stalled body cancel promptly and clean the body", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const result = await watchHomeRouteIntent(connection, "key", undefined, { timeoutMs: 10,
    fetchImpl: (async () => new Response(body, { headers: { "content-type": "application/json" } })) as typeof fetch });
  expect(result.kind).toBe("failed"); expect(cancelled).toBe(true);
  const abort = new AbortController(); abort.abort(new Error("private-reason"));
  expect(await watchHomeRouteIntent(connection, "key", undefined, { signal: abort.signal })).toEqual({ kind: "cancelled" });
});

test("old Home without watch support (including 404) defers to periodic tick without repeat reads or writes", async () => {
  for (const response of [reply(""), new Response(null, { status: 404 })]) {
    let reads = 0, applies = 0;
    const timers: Array<() => void> = [];
    const handle = startRouteIntentWatch(connection, "key", { requestSync: async () => { applies++; },
      fetchImpl: (async () => { reads++; return response; }) as typeof fetch,
      setTimer: cb => { timers.push(cb); return cb; }, clearTimer() {} }); handles.push(handle);
    timers.shift()?.(); await turn(); await turn();
    expect(reads).toBe(1); expect(applies).toBe(0); expect(timers).toHaveLength(0);
    handle.stop();
  }
});

test("unchanged watch timeout skips sync but explicit and legacy wakeups still apply", async () => {
  const timers: Array<() => void> = [];
  const wakes: Array<string | null> = ["changed", "timeout", "notified", null];
  let reads = 0, applies = 0;
  const handle = startRouteIntentWatch(connection, "key", {
    requestSync: async () => { applies++; },
    fetchImpl: (async () => {
      const wake = wakes[reads++];
      if (wake === undefined) return new Promise<Response>(() => {});
      return Response.json(document, { headers: { "x-ocx-route-intent-watch": "1",
        ...(wake === null ? {} : { "x-ocx-route-intent-wake": wake }) } });
    }) as typeof fetch,
    setTimer: cb => { timers.push(cb); return cb; }, clearTimer() {},
  }); handles.push(handle);
  timers.shift()?.(); await turn(); await turn(); expect(applies).toBe(1);
  timers.shift()?.(); await turn(); await turn(); expect(applies).toBe(1);
  timers.shift()?.(); await turn(); await turn(); expect(applies).toBe(2);
  timers.shift()?.(); await turn(); await turn(); expect(applies).toBe(3);
});

test("a changed digest is applied even when the Home reports a timeout", async () => {
  const timers: Array<() => void> = [];
  const changed = structuredClone(document);
  changed.clients.grok.enabled = !changed.clients.grok.enabled;
  let reads = 0, applies = 0;
  const handle = startRouteIntentWatch(connection, "key", {
    requestSync: async () => { applies++; },
    fetchImpl: (async () => Response.json(reads++ === 0 ? document : changed,
      { headers: { "x-ocx-route-intent-watch": "1", "x-ocx-route-intent-wake": "timeout" } })) as typeof fetch,
    setTimer: cb => { timers.push(cb); return cb; }, clearTimer() {},
  }); handles.push(handle);
  timers.shift()?.(); await turn(); await turn(); expect(applies).toBe(1);
  timers.shift()?.(); await turn(); await turn(); expect(applies).toBe(2);
});

test("watch keeps reading while apply busy, coalesces wakeups and retries without overlapping local writes", async () => {
  const timers: Array<() => void> = [];
  const releases: Array<() => void> = [];
  let reads = 0, active = 0, maximum = 0, applies = 0;
  let finalSignal: AbortSignal | null | undefined;
  const handle = startRouteIntentWatch(connection, "key", {
    requestSync: async () => { applies++; maximum = Math.max(maximum, ++active); await new Promise<void>(r => releases.push(r)); active--; },
    fetchImpl: (async (_url, init) => { reads++; if (reads <= 3) return reply();
      finalSignal = init?.signal;
      return new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }) as typeof fetch,
    setTimer: cb => { timers.push(cb); return cb; }, clearTimer() {},
  }); handles.push(handle);
  // A duplicate runtime registration cannot create a second long-poll for the same link.
  expect(startRouteIntentWatch(connection, "key", { requestSync: async () => { throw new Error("duplicate"); } })).toBe(handle);
  for (let i = 0; i < 4; i++) { timers.shift()?.(); await turn(); }
  expect(reads).toBe(4); expect(applies).toBe(1);
  releases.shift()?.(); await turn();
  expect(applies).toBe(2); expect(maximum).toBe(1);
  releases.shift()?.(); await turn(); expect(applies).toBe(2);
  handle.stop(); await turn(); expect(finalSignal?.aborted).toBe(true);
});

test("failed apply retains the event for a bounded retry", async () => {
  const timers: Array<{ cb: () => void; ms: number }> = [];
  let calls = 0;
  const handle = startRouteIntentWatch(connection, "key", { requestSync: async () => { if (++calls === 1) throw new Error("client_lifecycle_busy"); },
    fetchImpl: (async () => reply()) as typeof fetch,
    setTimer: (cb, ms) => { const timer = { cb, ms }; timers.push(timer); return timer; }, clearTimer() {} }); handles.push(handle);
  timers.shift()?.cb(); await turn();
  expect(calls).toBe(1);
  const retry = timers.find(timer => timer.ms === 5000); expect(retry).toBeDefined();
  retry?.cb(); await turn(); expect(calls).toBe(2);
});

test("production watch proves the actual socket before sending a key and never falls back to ordinary fetch", async () => {
  const key = "test-watch-admission-key";
  const seen: Array<{ port: number; path: string; auth: string | null }> = [];
  const sessions = createLinkRelaySessions({ fingerprints: () => [serviceApiTokenFingerprint(key)] });
  const home = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, server) => {
    seen.push({ port: server.requestIP(req)!.port, path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
    return sessions.dispatch(req, server, async () => Response.json(document,
      { headers: { "x-ocx-route-intent-watch": "1", "x-ocx-route-intent-wake": "timeout" } }));
  } });
  try {
    const bound = { ...connection, link: { ...connection.link!, tunnelPort: home.port! } };
    expect(await watchHomeRouteIntent(bound, key)).toMatchObject({ kind: "fresh", watchSupported: true, wakeReason: "timeout" });
    expect(seen).toHaveLength(2); expect(seen[0]!.port).toBe(seen[1]!.port);
    expect(seen[0]!.auth).toBeNull(); expect(seen[1]!.auth).toBe(`Bearer ${key}`);
    expect(seen[1]!.path).toBe("/v1/link-management/route-intent");
  } finally { await home.stop(true); }
  let attempts = 0;
  const impostor = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    attempts++; expect(req.headers.has("authorization")).toBe(false); return reply();
  } });
  try {
    expect((await watchHomeRouteIntent({ ...connection, link: { ...connection.link!, tunnelPort: impostor.port! } }, key)).kind).toBe("failed");
    expect(attempts).toBe(1);
  } finally { await impostor.stop(true); }
});

test("failed polls back off and immediately answering same-digest peers cannot tight-loop", async () => {
  for (const good of [false, true]) {
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const handle = startRouteIntentWatch(connection, "key", { requestSync: async () => {},
      fetchImpl: (async () => good ? reply() : new Response(null, { status: 503 })) as typeof fetch,
      setTimer: (cb, ms) => { const timer = { cb, ms }; timers.push(timer); return timer; }, clearTimer() {} }); handles.push(handle);
    timers.shift()?.cb(); await turn();
    if (good) { expect(timers[0]?.ms).toBe(0); timers.shift()?.cb(); await turn(); expect(timers[0]!.ms).toBeGreaterThan(0); }
    else expect(timers[0]?.ms).toBe(5000);
    handle.stop();
  }
});

test("runtime resolves a fresh key per GET and skips missing credentials without changing its pinned owner", async () => {
  let key: string | null = "before-rotation";
  const timers: Array<() => void> = [];
  const authorizations: Array<string | null> = [];
  const owner = structuredClone(connection);
  const handle = startRouteIntentWatch(owner, () => key, { requestSync: async () => {},
    fetchImpl: (async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:19200/v1/link-management/route-intent");
      authorizations.push(new Headers(init?.headers).get("authorization")); return reply();
    }) as typeof fetch,
    setTimer: cb => { timers.push(cb); return cb; }, clearTimer() {} }); handles.push(handle);
  timers.shift()?.(); await turn();
  owner.link!.tunnelPort = 19999; owner.apiKeyId = "different-owner";
  key = null; timers.shift()?.(); await turn();
  expect(authorizations).toEqual(["Bearer before-rotation"]);
  key = "after-rotation"; timers.shift()?.(); await turn();
  expect(authorizations).toEqual(["Bearer before-rotation", "Bearer after-rotation"]);
  expect(await watchHomeRouteIntent(connection, () => { throw new Error("secret-key-error"); })).toEqual({ kind: "failed", reason: "route_intent_watch_unavailable" });
});
