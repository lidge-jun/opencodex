import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { zstdDecompressSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { relayLinkDataRequest, HOME_INITIATED_LINK_TUNNEL, type LinkRelayDeps } from "../../src/client/link-relay";
import { readDeclaredBody } from "../../src/client/link-request-compression";
import { createLinkRelaySessions } from "../../src/server/index/link-relay-sessions";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { createLinkTrafficBook } from "../../src/link/traffic";
import { LINK_REQUEST_ZSTD_FEATURE } from "../../src/link/request-compression";
import { forgetLinkHomeFeaturesForTests } from "../../src/client/link-home-features";
import { readJsonRequestBody } from "../../src/server/request-decompress";
import { buildPeerFeatures, linkHomeFeatures } from "../../src/remote/features";
import { createInboundBodyBudget } from "../../src/server/inbound-body-budget";
import { createLinkListenerLifecycle } from "../../src/server/index/link-listener";
import type { LinkStore } from "../../src/link/store";
import { configSchema } from "../../src/config/schema/config-schema";
import { getDefaultConfig } from "../../src/config";
import { holdLargeSocketWrites, restoreSocketWrites } from "../helpers/held-socket-writes";

const key = `ocx_data_${"a".repeat(40)}`;
const keyId = "test-link-key", linkId = "lnk_0123456789abcdef";
const fp = serviceApiTokenFingerprint(key);
const target = (port: number) => ({ tunnelPort: port, admissionKey: key, apiKeyId: keyId, linkId });
const encoder = new TextEncoder();
let servers: Server<unknown>[] = [];
beforeEach(() => { forgetLinkHomeFeaturesForTests(); });
afterEach(async () => { restoreSocketWrites(); for (const server of servers) await server.stop(true); servers = []; forgetLinkHomeFeaturesForTests(); });

interface Seen { encoding: string | null; length: string | null; wire: Uint8Array; decoded: unknown }

/** A real hub-link session dispatcher that names its features as the Home's listener does, and decodes as the Home's handlers do. */
function home(features: () => readonly string[] | undefined) {
  const seen: Seen[] = [];
  const book = createLinkTrafficBook("content-length");
  const sessions = createLinkRelaySessions({ fingerprints: () => [fp], traffic: book, homeFeatures: () => features() ?? [] });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, s) => sessions.dispatch(req, s, async req => {
    const encoding = req.headers.get("content-encoding"), length = req.headers.get("content-length");
    const wire = new Uint8Array(await req.clone().arrayBuffer());
    seen.push({ encoding, length, wire, decoded: req.method === "POST" ? await readJsonRequestBody(req) : null });
    return Response.json({ ok: true });
  }) });
  servers.push(server);
  return { seen, book, port: server.port! };
}

function post(path: string, body: string | Uint8Array, headers: Record<string, string> = {}): Request {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  return new Request(`http://127.0.0.1${path}`, { method: "POST", body: bytes,
    headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), ...headers } });
}

const big = JSON.stringify({ input: "an agent re-sends its whole conversation ".repeat(200) });
const relay = (req: Request, port: number, deps: LinkRelayDeps = {}) => relayLinkDataRequest(req, target(port), { tunnel: HOME_INITIATED_LINK_TUNNEL, ...deps });

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("per-body zstd from Child to Home (#3023)", () => {
  test("the production Home names link-request-zstd/1", () => {
    expect(buildPeerFeatures()).toContain(LINK_REQUEST_ZSTD_FEATURE);
  });

  test("a body over 1 KiB reaches a Home that named the capability compressed, and decodes to the same bytes", async () => {
    const h = home(() => [LINK_REQUEST_ZSTD_FEATURE]);
    const child = createLinkTrafficBook("relayed");
    // The first request learns the Home's features on its verified answer; its body still goes as it is.
    expect((await relay(post("/v1/responses", big), h.port, { traffic: child })).status).toBe(200);
    expect(h.seen[0]).toMatchObject({ encoding: null, length: String(encoder.encode(big).byteLength) });
    expect((await relay(post("/v1/responses", big), h.port, { traffic: child })).status).toBe(200);
    const compressed = h.seen[1]!;
    expect(compressed.encoding).toBe("zstd");
    expect(compressed.length).toBe(String(compressed.wire.byteLength));
    expect(compressed.wire.byteLength).toBeLessThan(encoder.encode(big).byteLength / 4);
    expect(new TextDecoder().decode(zstdDecompressSync(compressed.wire))).toBe(big);
    expect(compressed.decoded).toEqual(JSON.parse(big));
    // The relay-auth session admitted it (only verified sessions reach the dispatcher and count), and both ends counted the wire bytes.
    expect(h.book.snapshot(linkId)).toMatchObject({ requests: 2, toHomeBytes: encoder.encode(big).byteLength + compressed.wire.byteLength });
    expect(child.snapshot(linkId).toHomeBytes).toBe(encoder.encode(big).byteLength + compressed.wire.byteLength);
  });

  test("small, already encoded, other routes and chunked bodies go exactly as sent", async () => {
    const h = home(() => [LINK_REQUEST_ZSTD_FEATURE]);
    await relay(post("/v1/responses", big), h.port);
    const small = JSON.stringify({ input: "x".repeat(1024 - 12) });
    expect(encoder.encode(small).byteLength).toBe(1024);
    const gz = Bun.gzipSync(encoder.encode(big));
    await relay(post("/v1/responses", small), h.port);
    await relay(post("/v1/responses", gz, { "content-encoding": "gzip" }), h.port);
    await relay(post("/v1/images/generations", big), h.port);
    await relay(new Request("http://127.0.0.1/v1/responses", { method: "POST", duplex: "half", headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(big)); c.close(); } }) } as RequestInit), h.port);
    expect(h.seen.slice(1).map(seen => [seen.encoding, seen.wire.byteLength])).toEqual([
      [null, 1024], ["gzip", gz.byteLength], [null, encoder.encode(big).byteLength], [null, encoder.encode(big).byteLength],
    ]);
  });

  test("an older Home that names nothing gets identity bodies, every time", async () => {
    const h = home(() => undefined);
    for (let i = 0; i < 3; i++) await relay(post("/v1/responses", big), h.port);
    expect(h.seen.map(seen => [seen.encoding, seen.length])).toEqual(Array(3).fill([null, String(encoder.encode(big).byteLength)]));
  });

  test("a Home that stops naming the capability gets the original body on that same connection", async () => {
    let named = true;
    const h = home(() => named ? [LINK_REQUEST_ZSTD_FEATURE] : []);
    await relay(post("/v1/responses", big), h.port);
    named = false;
    await relay(post("/v1/responses", big), h.port);
    expect(h.seen[1]).toMatchObject({ encoding: null, length: String(encoder.encode(big).byteLength) });
    expect(new TextDecoder().decode(h.seen[1]!.wire)).toBe(big);
  });

  test("a body that would compress past the Home's ratio bound goes as it is, and the request succeeds", async () => {
    const h = home(() => [LINK_REQUEST_ZSTD_FEATURE]);
    await relay(post("/v1/responses", big), h.port);
    const repetitive = JSON.stringify({ input: "a".repeat(9 * 1024 * 1024) });
    const response = await relay(post("/v1/responses", repetitive), h.port);
    expect(response.status).toBe(200);
    expect(h.seen[1]).toMatchObject({ encoding: null, length: String(encoder.encode(repetitive).byteLength) });
  });

  test("bodies being prepared share one bounded allowance; a body that does not fit streams unchanged", async () => {
    const h = home(() => [LINK_REQUEST_ZSTD_FEATURE]);
    await relay(post("/v1/responses", big), h.port);
    const budget = createInboundBodyBudget(2 * encoder.encode(big).byteLength - 1, 0);
    await relay(post("/v1/responses", big), h.port, { requestCompression: { budget } });
    expect(h.seen[1]).toMatchObject({ encoding: null });
    const roomy = createInboundBodyBudget(2 * encoder.encode(big).byteLength, 0);
    await relay(post("/v1/responses", big), h.port, { requestCompression: { budget: roomy } });
    expect(h.seen[2]).toMatchObject({ encoding: "zstd" });
    expect(roomy.snapshot()).toEqual({ reservedBytes: 0, activeLeases: 0, queuedRequests: 0 });
  });

  test("a Home that answers before reading the upload keeps the preparation allowance held until the request ends", async () => {
    const sessions = createLinkRelaySessions({ fingerprints: () => [fp], homeFeatures: () => [LINK_REQUEST_ZSTD_FEATURE] });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, s) => sessions.dispatch(req, s, async req => {
      if (req.method !== "POST" || req.headers.get("content-encoding") !== "zstd") return Response.json({ ok: true });
      // Answers at once and never reads the body, holding the response open.
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode("data: early\n\n")); } }),
        { headers: { "content-type": "text/event-stream" } });
    }) });
    servers.push(server);
    await relay(post("/v1/responses", big), server.port!);
    // About 1.3:1 like screenshots. The Home never reads the upload, so its write stays pending, held
    // the way a full send buffer holds it (Windows would otherwise accept the whole body at once).
    holdLargeSocketWrites(1024 * 1024);
    const noise = JSON.stringify({ input: randomBytes(11 * 1024 * 1024).toString("base64") });
    const budget = createInboundBodyBudget(64 * 1024 * 1024, 0);
    const response = await relay(post("/v1/responses", noise), server.port!, { requestCompression: { budget } });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("early");
    expect(budget.snapshot().reservedBytes).toBe(2 * encoder.encode(noise).byteLength);
    // The relay cancels its upstream without awaiting the teardown, and a pending write fails once its
    // connection closes: within the cancel on Linux, on the socket's close event where the OS had taken it.
    await reader.cancel();
    for (const deadline = performance.now() + 2_000; budget.snapshot().activeLeases > 0 && performance.now() < deadline;) await Bun.sleep(5);
    expect(budget.snapshot()).toEqual({ reservedBytes: 0, activeLeases: 0, queuedRequests: 0 });
  });

  test("a compressor that fails sends the original body and the request succeeds", async () => {
    const h = home(() => [LINK_REQUEST_ZSTD_FEATURE]);
    const deps: LinkRelayDeps = { requestCompression: { compress: async () => { throw new Error("zstd unavailable"); } } };
    await relay(post("/v1/responses", big), h.port, deps);
    const response = await relay(post("/v1/responses", big), h.port, deps);
    expect(response.status).toBe(200);
    expect(h.seen[1]).toMatchObject({ encoding: null });
    expect(new TextDecoder().decode(h.seen[1]!.wire)).toBe(big);
  });

  test("a Home that names the capability keeps accepting identity bodies from a Child that never compresses", async () => {
    const h = home(() => [LINK_REQUEST_ZSTD_FEATURE]);
    for (let i = 0; i < 2; i++) expect((await relay(post("/v1/responses", big), h.port, { requestCompression: { enabled: false } })).status).toBe(200);
    expect(h.seen.map(seen => [seen.encoding, seen.decoded])).toEqual(Array(2).fill([null, JSON.parse(big)]));
  });

  test("bodies whose uploads finished keep their allowance while the Home holds its response headers", async () => {
    let received = 0;
    const allRead = gate(), answer = gate();
    const sessions = createLinkRelaySessions({ fingerprints: () => [fp], homeFeatures: () => [LINK_REQUEST_ZSTD_FEATURE] });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, s) => sessions.dispatch(req, s, async req => {
      if (req.method !== "POST" || req.headers.get("content-encoding") !== "zstd") return Response.json({ ok: true });
      await req.arrayBuffer();
      if (++received === 3) allRead.resolve();
      await answer.promise;
      return Response.json({ ok: true });
    }) });
    servers.push(server);
    await relay(post("/v1/responses", big), server.port!);
    const budget = createInboundBodyBudget(64 * 1024 * 1024, 0);
    const pending = [0, 1, 2].map(() => relay(post("/v1/responses", big), server.port!, { requestCompression: { budget } }));
    await allRead.promise;
    // Every upload is in the Home's hands, but each request still holds its prepared bytes until it has an answer.
    expect(budget.snapshot()).toMatchObject({ reservedBytes: 3 * 2 * encoder.encode(big).byteLength, activeLeases: 3 });
    answer.resolve();
    for (const response of await Promise.all(pending)) {
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(budget.snapshot()).toEqual({ reservedBytes: 0, activeLeases: 0, queuedRequests: 0 });
  });

  test("a request cancelled while its body is being compressed leaves no allowance behind", async () => {
    const h = home(() => [LINK_REQUEST_ZSTD_FEATURE]);
    await relay(post("/v1/responses", big), h.port);
    const budget = createInboundBodyBudget(64 * 1024 * 1024, 0);
    const started = gate(), finish = gate<Uint8Array>();
    const caller = new AbortController();
    const bytes = encoder.encode(big);
    const req = new Request("http://127.0.0.1/v1/responses", { method: "POST", body: bytes, signal: caller.signal,
      headers: { "content-type": "application/json", "content-length": String(bytes.byteLength) } });
    const pending = relay(req, h.port, { requestCompression: { budget, compress: async () => { started.resolve(); return await finish.promise; } } });
    await started.promise;
    expect(budget.snapshot().reservedBytes).toBe(2 * bytes.byteLength);
    caller.abort();
    finish.resolve(new Uint8Array(16));
    expect((await pending).status).toBe(503);
    expect(budget.snapshot()).toEqual({ reservedBytes: 0, activeLeases: 0, queuedRequests: 0 });
    expect(h.seen).toHaveLength(1);
  });

  const bigBytes = encoder.encode(big);
  const shortBody = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bigBytes.subarray(0, bigBytes.byteLength - 10)); c.close(); } });

  test("a body that ends cleanly before its declared length is unreadable, never a shorter complete body", async () => {
    const bytes = bigBytes;
    await expect(readDeclaredBody(shortBody(), bytes.byteLength, new AbortController().signal)).rejects.toThrow(RangeError);
    const whole = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
    expect(await readDeclaredBody(whole, bytes.byteLength, new AbortController().signal)).toEqual(bytes);
  });

  test("a prepared body shorter than its declared Content-Length answers 400 and reaches no Home", async () => {
    const bytes = bigBytes;
    const h = home(() => [LINK_REQUEST_ZSTD_FEATURE]);
    await relay(post("/v1/responses", big), h.port);
    const budget = createInboundBodyBudget(64 * 1024 * 1024, 0);
    const req = new Request("http://127.0.0.1/v1/responses", { method: "POST", duplex: "half", body: shortBody(),
      headers: { "content-type": "application/json", "content-length": String(bytes.byteLength) } } as RequestInit);
    expect(req.headers.get("content-length")).toBe(String(bytes.byteLength));
    const res = await relay(req, h.port, { requestCompression: { budget } });
    // The Home's session layer counts every request it dispatched: only the first one got there.
    expect(h.book.snapshot(linkId)).toMatchObject({ requests: 1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "link relay request body unreadable" });
    expect(budget.snapshot()).toEqual({ reservedBytes: 0, activeLeases: 0, queuedRequests: 0 });
  });
});

describe("the Home's switch for per-body zstd (#3023)", () => {
  const store = (): LinkStore => ({ version: 1, listenerPort: null, links: [{ id: linkId, alias: "child", direction: "client-initiated",
    hostKeyFingerprint: null, tunnelPort: 22222, apiKeyId: keyId, createdAt: "2026-10-22T00:00:00.000Z" }] });

  /** Two relayed bodies through a real Home listener lifecycle; the encodings its data plane saw. */
  async function encodingsThrough(homeFeatures?: () => readonly string[]): Promise<(string | null)[]> {
    const encodings: (string | null)[] = [];
    let current = store();
    const lifecycle = createLinkListenerLifecycle({ readStore: () => current, writeStore: (_path, next) => { current = next; } });
    lifecycle.start({ maxRequestBodySize: 1024 * 1024, keyFingerprints: id => id === keyId ? [fp] : [], ...(homeFeatures ? { homeFeatures } : {}),
      dispatch: async req => { encodings.push(req.headers.get("content-encoding")); await req.arrayBuffer(); return Response.json({ ok: true }); } });
    try {
      for (let i = 0; i < 2; i++) expect((await relay(post("/v1/responses", big), lifecycle.status().port!)).status).toBe(200);
    } finally { await lifecycle.stop(); }
    return encodings;
  }

  test("on by default; linkRequestCompression: false stops the Home naming it, and its Child sends identity bodies", async () => {
    expect(linkHomeFeatures(undefined)).toEqual(buildPeerFeatures());
    expect(linkHomeFeatures({ linkRequestCompression: true })).toEqual(buildPeerFeatures());
    expect(linkHomeFeatures({ linkRequestCompression: false })).toEqual(buildPeerFeatures().filter(id => id !== LINK_REQUEST_ZSTD_FEATURE));
    expect(await encodingsThrough()).toEqual([null, "zstd"]);
    forgetLinkHomeFeaturesForTests();
    expect(await encodingsThrough(() => linkHomeFeatures({ linkRequestCompression: false }))).toEqual([null, null]);
  });

  test("the config keeps a boolean and reads anything else as unset, which is on", () => {
    const base = { ...getDefaultConfig(), defaultProvider: "fixture", providers: { fixture: { adapter: "openai-responses", baseUrl: "https://provider.invalid/v1" } } };
    expect(configSchema.parse({ ...base, linkRequestCompression: false }).linkRequestCompression).toBe(false);
    expect(configSchema.parse({ ...base, linkRequestCompression: "off" }).linkRequestCompression).toBeUndefined();
    expect(getDefaultConfig().linkRequestCompression).toBeUndefined();
  });
});
