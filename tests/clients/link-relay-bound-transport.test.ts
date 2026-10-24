import { describe, expect, test } from "bun:test";
import { Agent, createServer, request as httpRequest, type RequestListener } from "node:http";
import type { Server } from "bun";
import { gzipSync } from "node:zlib";
import { fetchBoundLinkRelay, LinkRelayAuthenticationError, LinkRelayAuthTimeoutError, probeLinkRelayPreflight } from "../../src/client/link-relay-transport";
import { relayLinkDataRequest, HOME_INITIATED_LINK_TUNNEL } from "../../src/client/link-relay";
import { createLinkRelaySessions } from "../../src/server/index/link-relay-sessions";
import { createLinkListenerLifecycle } from "../../src/server/index/link-listener";
import { createOptionalListenerSet } from "../../src/server/index/optional-listeners";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import type { LinkStore } from "../../src/link/store";
import type { OcxConfig } from "../../src/types";
import { LINK_RELAY_AUTH_PATH, LINK_RELAY_PROBE_HEADER, LINK_RELAY_SESSION_HEADER, linkRelayChallenge, linkRelayProof } from "../../src/link/relay-auth";

const key = `ocx_data_${"a".repeat(40)}`, pendingKey = `ocx_data_${"b".repeat(40)}`;
const keyId = "test-link-key", linkId = "lnk_0123456789abcdef";
const fp = serviceApiTokenFingerprint(key);
const target = (port: number, admissionKey = key) => ({ tunnelPort: port, admissionKey, apiKeyId: keyId, linkId });
function store(): LinkStore {
  return { version: 1, listenerPort: null, links: [{ id: linkId, alias: "test", direction: "client-initiated",
    hostKeyFingerprint: null, tunnelPort: 22222, apiKeyId: keyId, createdAt: "2026-09-27T00:00:00.000Z" }] };
}
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function proofUrl(port: number, admissionKey = key) {
  const proof = linkRelayChallenge(serviceApiTokenFingerprint(admissionKey), keyId, linkId);
  const url = new URL(LINK_RELAY_AUTH_PATH, `http://127.0.0.1:${port}`);
  url.search = new URLSearchParams({ version: "2", key: keyId, link: linkId, nonce: proof.nonce, proof: proof.caller }).toString();
  return { url, proof };
}
async function rawGet(url: URL, agent: Agent, headers?: Record<string, string>) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = httpRequest(url, { agent, headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}

async function withHttpPeer(handler: RequestListener, run: (port: number) => Promise<void>) {
  const server = createServer(handler);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing peer port");
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("connection-bound link relay", () => {
  test("direction and both identities are authenticated", () => {
    const nonce = "c".repeat(64);
    const caller = linkRelayProof(fp, "caller", keyId, linkId, nonce);
    expect(caller).not.toBeNull();
    expect(linkRelayProof(fp, "listener", keyId, linkId, nonce)).not.toBe(caller);
    expect(linkRelayProof(fp, "caller", "other", linkId, nonce)).not.toBe(caller);
    expect(linkRelayProof(fp, "caller", keyId, "lnk_fedcba9876543210", nonce)).not.toBe(caller);
    expect(linkRelayProof(fp, "caller", keyId, linkId, "invalid")).toBeNull();
  });

  test("authenticates and streams on the same actual peer socket without exposing caller credentials", async () => {
    const peers: number[] = [], seen: Headers[] = [], bodies: string[] = [];
    const sessions = createLinkRelaySessions({ fingerprints: () => [fp] });
    const home = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, server) => {
      peers.push(server.requestIP(req)!.port); seen.push(new Headers(req.headers));
      return sessions.dispatch(req, server, async req => { bodies.push(await req.text()); return Response.json({ ok: true }); });
    } });
    try {
      const response = await relayLinkDataRequest(new Request("http://127.0.0.1/v1/responses", {
        method: "POST", headers: { authorization: "Bearer caller-secret", "content-type": "application/json" }, body: '{"input":"hello"}',
      }), target(home.port!), { tunnel: HOME_INITIATED_LINK_TUNNEL });
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
      expect(peers).toHaveLength(2); expect(peers[0]).toBe(peers[1]);
      expect(seen[0]!.has("authorization")).toBe(false);
      // A relayed request's preflight reserves its session; only readiness probes are probe-only.
      expect(seen[0]!.has(LINK_RELAY_PROBE_HEADER)).toBe(false);
      expect(seen[1]!.get("authorization")).toBe(`Bearer ${key}`);
      expect(bodies).toEqual(['{"input":"hello"}']);
    } finally { await home.stop(true); }
  });

  test("a proof cannot be consumed on a different actual connection or replayed", async () => {
    let dispatched = 0;
    const book = createLinkRelaySessions({ fingerprints: () => [fp], reservationMs: 40 });
    const home = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, server) => book.dispatch(req, server,
      async () => { dispatched++; return new Response("data"); }) });
    const first = new Agent({ keepAlive: true, maxSockets: 1 }), second = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const { url, proof } = proofUrl(home.port!);
      expect((await rawGet(url, first)).status).toBe(204);
      const data = new URL("/v1/models", home.url), header = { [LINK_RELAY_SESSION_HEADER]: proof.nonce };
      expect((await rawGet(data, second, header)).status).toBe(404);
      expect((await rawGet(data, first, header)).status).toBe(404);
      expect(dispatched).toBe(0);
    } finally { first.destroy(); second.destroy(); await home.stop(true); }
  });

  test("a server that closes after its proof never receives a credential-bearing reconnect", async () => {
    let dataRequests = 0, proofs = 0;
    const home = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== LINK_RELAY_AUTH_PATH) { dataRequests++; return new Response("leak"); }
      proofs++;
      return new Response(null, { status: 204, headers: { connection: "close",
        "x-opencodex-link-proof": linkRelayProof(fp, "listener", keyId, linkId, url.searchParams.get("nonce")!)! } });
    } });
    try {
      await expect(fetchBoundLinkRelay(target(home.port!), `${home.url}v1/responses`, {
        method: "POST", headers: { authorization: `Bearer ${key}` }, body: "private body",
      })).rejects.toThrow();
      expect(proofs).toBe(1); expect(dataRequests).toBe(0);
    } finally { await home.stop(true); }
  });

  test("an unrecognized or invalid peer gets no credentials or body, and missing identity refuses locally", async () => {
    const requests: Request[] = [];
    const home = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => {
      requests.push(req);
      return new Response(null, requests.length === 1 ? { status: 404 }
        : { status: 204, headers: { "x-opencodex-link-proof": "0".repeat(64) } });
    } });
    try {
      await expect(fetchBoundLinkRelay(target(home.port!), `${home.url}v1/models`, {})).rejects.toBeInstanceOf(LinkRelayAuthenticationError);
      expect(requests).toHaveLength(1); expect(requests[0]!.headers.has("authorization")).toBe(false);
      expect(requests[0]!.method).toBe("GET"); expect(requests[0]!.body).toBeNull();
      await expect(fetchBoundLinkRelay(target(home.port!), `${home.url}v1/models`, {})).rejects.toBeInstanceOf(LinkRelayAuthenticationError);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.headers.has("authorization")).toBe(false); expect(requests[1]!.body).toBeNull();
      await expect(fetchBoundLinkRelay({ tunnelPort: home.port!, admissionKey: key }, `${home.url}v1/models`, {})).rejects.toThrow();
      expect(requests).toHaveLength(2);
    } finally { await home.stop(true); }
  });

  test("a silent actual peer expires only the credential-free auth deadline without touching the body", async () => {
    const seen: Array<{ url: string; authorization: string | undefined; body: string }> = [];
    let bodyRead = false, bodyCancelled = false;
    const body = new ReadableStream({
      pull() { bodyRead = true; }, cancel() { bodyCancelled = true; },
    }, { highWaterMark: 0 });
    await withHttpPeer(req => {
      const record = { url: req.url!, authorization: req.headers.authorization, body: "" };
      seen.push(record);
      req.on("data", chunk => { record.body += chunk.toString(); });
    }, async port => {
      await expect(fetchBoundLinkRelay(target(port), `http://127.0.0.1:${port}/v1/responses`, {
        method: "POST", headers: { authorization: `Bearer ${key}` }, body,
      }, { authTimeoutMs: 20 })).rejects.toBeInstanceOf(LinkRelayAuthTimeoutError);
      expect(seen).toHaveLength(1);
      expect(new URL(seen[0]!.url, "http://peer").pathname).toBe(LINK_RELAY_AUTH_PATH);
      expect(seen[0]!.authorization).toBeUndefined(); expect(seen[0]!.body).toBe("");
      expect(bodyRead).toBe(false); expect(bodyCancelled).toBe(false); expect(body.locked).toBe(false);
    });
  });

  test("parent abort during a real auth probe is not an auth deadline", async () => {
    const parent = new AbortController();
    let probes = 0;
    await withHttpPeer(() => { probes++; parent.abort(new DOMException("caller stopped", "AbortError")); }, async port => {
      const error = await fetchBoundLinkRelay(target(port), `http://127.0.0.1:${port}/v1/models`, {
        signal: parent.signal,
      }, { authTimeoutMs: 40 }).catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(LinkRelayAuthTimeoutError);
      expect(probes).toBe(1);
    });
  });

  for (const failure of ["header timeout", "reset"] as const) {
    test(`post-proof data ${failure} is never a preflight auth timeout`, async () => {
      const parent = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let probes = 0, dataRequests = 0;
      await withHttpPeer((req, res) => {
        const url = new URL(req.url!, "http://peer");
        if (url.pathname === LINK_RELAY_AUTH_PATH) {
          probes++;
          res.writeHead(204, { "x-opencodex-link-proof": linkRelayProof(fp, "listener", keyId, linkId,
            url.searchParams.get("nonce")!)! });
          res.end(); return;
        }
        dataRequests++;
        if (failure === "reset") req.socket.destroy();
        else timer = setTimeout(() => parent.abort(new DOMException("data headers timed out", "TimeoutError")), 40);
      }, async port => {
        try {
          const error = await fetchBoundLinkRelay(target(port), `http://127.0.0.1:${port}/v1/models`, {
            headers: { authorization: `Bearer ${key}` }, signal: parent.signal,
          }, { authTimeoutMs: 20 }).catch(error => error);
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(LinkRelayAuthTimeoutError);
          expect(probes).toBe(1); expect(dataRequests).toBe(1);
        } finally { clearTimeout(timer); parent.abort(); }
      });
    });
  }

  test("auth deadline overrides must be finite and positive", async () => {
    for (const authTimeoutMs of [0, -1, NaN, Infinity]) {
      await expect(fetchBoundLinkRelay(target(1), "http://127.0.0.1:1/v1/models", {}, { authTimeoutMs }))
        .rejects.toBeInstanceOf(RangeError);
    }
  });

  test("a removed last link cannot release its port while an authenticated response is still streaming", async () => {
    let current = store();
    const body = gate(), entered = gate();
    let bound!: Server<unknown>;
    const lifecycle = createLinkListenerLifecycle({ readStore: () => current,
      writeStore: (_p, next) => { current = next; }, serve: options => { bound = Bun.serve(options); return bound; } });
    lifecycle.start({ maxRequestBodySize: 1024, keyFingerprints: () => [fp], dispatch: async () => {
      entered.resolve();
      return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(new TextEncoder().encode("first")); await body.promise;
        controller.enqueue(new TextEncoder().encode("last")); controller.close();
      } }));
    } });
    const port = lifecycle.status().port!;
    try {
      const response = await fetchBoundLinkRelay(target(port), `http://127.0.0.1:${port}/v1/models`, {});
      await entered.promise;
      current = { ...current, links: [] };
      let closed = false;
      const closing = lifecycle.close().then(() => { closed = true; });
      await Bun.sleep(15);
      expect(closed).toBe(false); expect(lifecycle.ownsListener(bound)).toBe(true);
      let replacement: Server<unknown> | undefined;
      expect(() => { replacement = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("squatter") }); }).toThrow();
      replacement?.stop(true);
      body.resolve(); expect(await response.text()).toBe("firstlast");
      await closing;
      expect(lifecycle.ownsListener(bound)).toBe(false);
      const after = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("released") });
      await after.stop(true);
    } finally { body.resolve(); await bound.stop(true); await lifecycle.stop(); }
  });

  test("an unused authenticated reservation keeps the listener bound only for its bounded lease", async () => {
    const book = createLinkRelaySessions({ fingerprints: () => [fp], reservationMs: 40 });
    const home = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, server) => book.dispatch(req, server, async () => new Response("ok")) });
    const agent = new Agent({ keepAlive: true });
    try {
      const { url } = proofUrl(home.port!); expect((await rawGet(url, agent)).status).toBe(204);
      let done = false; const drain = book.drain().then(() => { done = true; });
      expect(done).toBe(false);
      await drain; expect(done).toBe(true);
      expect((await rawGet(proofUrl(home.port!).url, agent)).status).toBe(404);
    } finally { agent.destroy(); await home.stop(true); }
  });

  test("a readiness preflight is proven without reserving a session or holding the listener's drain", async () => {
    let dispatched = 0;
    const book = createLinkRelaySessions({ fingerprints: () => [fp], reservationMs: 60_000 });
    const home = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, server) => book.dispatch(req, server,
      async () => { dispatched++; return new Response("data"); }) });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      expect(await probeLinkRelayPreflight(target(home.port!), { timeoutMs: 2_000 })).toBe("ok");
      // A probe-marked proof is still a valid answer, but its nonce authorizes nothing afterwards.
      const { url, proof } = proofUrl(home.port!);
      const answered = await rawGet(url, agent, { [LINK_RELAY_PROBE_HEADER]: "1" });
      expect(answered.status).toBe(204);
      expect(answered.headers["x-opencodex-link-proof"]).toBe(proof.expected);
      expect((await rawGet(new URL("/v1/models", home.url), agent, { [LINK_RELAY_SESSION_HEADER]: proof.nonce })).status).toBe(404);
      expect(dispatched).toBe(0);
      // With nothing reserved, a drain settles in the same turn instead of after the lease.
      const settled = await Promise.race([
        book.drain().then(() => "drained"),
        new Promise<string>(resolve => setImmediate(() => resolve("pending"))),
      ]);
      expect(settled).toBe("drained");
    } finally { book.abortReservations(); agent.destroy(); await home.stop(true); }
  });

  test("real optional-listener lookup accepts current and pending keys, but expiry, commit, abort and removal revoke old proofs", async () => {
    let current = store();
    const cfg = { port: 0, providers: {}, defaultProvider: "test", claudeCode: { enabled: false },
      apiKeys: [{ id: keyId, name: "fixture", key, pendingRotation: { id: "rotation", key: pendingKey,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } }] } as OcxConfig;
    const listeners = createOptionalListenerSet({ readStore: () => current, writeStore: (_p, next) => { current = next; } });
    // No supervisor / SSH process is required for this real listening socket fixture.
    listeners.linkSupervisor().start = () => {}; listeners.linkSupervisor().stop = async () => {};
    listeners.start({ config: cfg, publicPort: 0, maxRequestBodySize: 1024, dispatch: async () => new Response("ok") });
    const port = listeners.status().port!;
    const use = async (credential: string) => {
      const response = await fetchBoundLinkRelay(target(port, credential), `http://127.0.0.1:${port}/v1/models`, {});
      return response.text();
    };
    try {
      expect(await use(key)).toBe("ok"); expect(await use(pendingKey)).toBe("ok");
      cfg.apiKeys![0]!.pendingRotation!.expiresAt = new Date(0).toISOString();
      await expect(use(pendingKey)).rejects.toThrow(); expect(await use(key)).toBe("ok");
      cfg.apiKeys![0]!.pendingRotation = undefined;
      await expect(use(pendingKey)).rejects.toThrow();
      cfg.apiKeys![0]!.key = pendingKey;
      expect(await use(pendingKey)).toBe("ok"); await expect(use(key)).rejects.toThrow();
      current = { ...current, links: [] };
      await expect(use(pendingKey)).rejects.toThrow();
    } finally { await listeners.stop(); }
  });

  test("caller abort cancels a real response stream and releases listener drainage", async () => {
    let current = store();
    const cancelled = gate();
    const lifecycle = createLinkListenerLifecycle({ readStore: () => current,
      writeStore: (_p, next) => { current = next; } });
    lifecycle.start({ maxRequestBodySize: 1024, keyFingerprints: () => [fp], dispatch: async () =>
      new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); },
        cancel() { cancelled.resolve(); },
      }), { headers: { "content-type": "text/event-stream" } }) });
    const caller = new AbortController(), port = lifecycle.status().port!;
    try {
      const response = await fetchBoundLinkRelay(target(port), `http://127.0.0.1:${port}/v1/models`, { signal: caller.signal });
      const reader = response.body!.getReader();
      expect((await reader.read()).value!.length).toBeGreaterThan(0);
      caller.abort();
      await reader.read().catch(() => {});
      await cancelled.promise;
      await lifecycle.close();
      expect(lifecycle.status().state).toBe("off");
    } finally { caller.abort(); await lifecycle.stop(); }
  });

  test("process shutdown cancels an unending response rather than waiting for its EOF", async () => {
    let current = store();
    const cancelled = gate();
    const lifecycle = createLinkListenerLifecycle({ readStore: () => current,
      writeStore: (_p, next) => { current = next; } });
    lifecycle.start({ maxRequestBodySize: 1024, keyFingerprints: () => [fp], dispatch: async () =>
      new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("first")); },
        cancel() { cancelled.resolve(); },
      })) });
    const port = lifecycle.status().port!;
    const response = await fetchBoundLinkRelay(target(port), `http://127.0.0.1:${port}/v1/models`, {});
    const read = response.text().catch(() => "aborted");
    await lifecycle.stop();
    await read;
    await cancelled.promise;
    expect(lifecycle.status().state).toBe("off");
  });

  test("compressed bodies are decoded and non-success HTTP statuses stay observable", async () => {
    const book = createLinkRelaySessions({ fingerprints: () => [fp] });
    const home = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, server) => book.dispatch(req, server,
      async () => new Response(gzipSync("unavailable"), { status: 503, headers: { "content-encoding": "gzip" } })) });
    try {
      const response = await fetchBoundLinkRelay(target(home.port!), `${home.url}v1/models`, {});
      expect(response.status).toBe(503); expect(await response.text()).toBe("unavailable");
    } finally { await home.stop(true); }
  });
});
