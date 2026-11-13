import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { relayLinkDataRequest, HOME_INITIATED_LINK_TUNNEL } from "../../src/client/link-relay";
import { createLinkRelaySessions } from "../../src/server/index/link-relay-sessions";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { childLinkTraffic, createLinkTrafficBook, MAX_LINKS } from "../../src/link/traffic";
import { linkBoundFetch } from "../../src/client/link-home";
import { gzipSync } from "node:zlib";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { fetchBoundLinkRelay, linkResponseOnConnectionForTests } from "../../src/client/link-relay-transport";
import { holdLargeSocketWrites, restoreSocketWrites } from "../helpers/held-socket-writes";

const key = `ocx_data_${"a".repeat(40)}`;
const keyId = "test-link-key", linkId = "lnk_0123456789abcdef";
const fp = serviceApiTokenFingerprint(key);
const target = (port: number) => ({ tunnelPort: port, admissionKey: key, apiKeyId: keyId, linkId });
const encoder = new TextEncoder();
let servers: Server<unknown>[] = [];
afterEach(async () => { restoreSocketWrites(); for (const server of servers) await server.stop(true); servers = []; });

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** A real hub-link session dispatcher counting into its own book, as the Home's listener does. */
function home(dispatch: (req: Request) => Promise<Response>) {
  const book = createLinkTrafficBook("content-length");
  const sessions = createLinkRelaySessions({ fingerprints: () => [fp], traffic: book });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, s) => sessions.dispatch(req, s, dispatch) });
  servers.push(server);
  return { book, port: server.port! };
}

/** A caller body delivered in chunks of the given sizes, with a declared length. */
function chunkedRequest(sizes: number[], signal?: AbortSignal): Request {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST", signal, duplex: "half",
    headers: { "content-type": "application/json", "content-length": String(total) },
    body: new ReadableStream<Uint8Array>({ start(controller) {
      for (const size of sizes) controller.enqueue(new Uint8Array(size).fill(0x61));
      controller.close();
    } }),
  } as RequestInit);
}

describe("link traffic counters (#3023)", () => {
  test("count the bodies of a streamed request and a streamed SSE response on both ends", async () => {
    const events = ["data: one\n\n", "data: two two\n\n", `data: ${"x".repeat(70_000)}\n\n`];
    let received = 0;
    const h = home(async req => {
      received = (await req.arrayBuffer()).byteLength;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    });
    const child = createLinkTrafficBook("relayed");
    const response = await relayLinkDataRequest(chunkedRequest([1000, 64 * 1024, 7]), target(h.port), { tunnel: HOME_INITIATED_LINK_TUNNEL, traffic: child });
    expect(response.status).toBe(200);
    const read = (await response.arrayBuffer()).byteLength;
    const sent = events.reduce((sum, event) => sum + encoder.encode(event).byteLength, 0);
    expect(received).toBe(1000 + 64 * 1024 + 7);
    expect(read).toBe(sent);
    expect(child.snapshot(linkId)).toMatchObject({ requests: 1, incomplete: 0, toHomeBytes: received, fromHomeBytes: sent, toHomeSource: "relayed", toHomeUncounted: 0 });
    expect(h.book.snapshot(linkId)).toMatchObject({ requests: 1, incomplete: 0, toHomeBytes: received, fromHomeBytes: sent, toHomeSource: "content-length", toHomeUncounted: 0 });
  });

  test("an aborted response counts only the bytes that crossed and marks the request incomplete", async () => {
    const first = encoder.encode("data: first\n\n");
    const homeCancelled = gate();
    const h = home(async req => {
      await req.arrayBuffer();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(first); },
        cancel() { homeCancelled.resolve(); },
      }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    });
    const child = createLinkTrafficBook("relayed");
    const caller = new AbortController();
    const response = await relayLinkDataRequest(chunkedRequest([2048], caller.signal), target(h.port), { tunnel: HOME_INITIATED_LINK_TUNNEL, traffic: child });
    const reader = response.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(first.byteLength);
    const pending = reader.read();
    caller.abort();
    await pending.catch(() => undefined);
    await homeCancelled.promise;
    expect(child.snapshot(linkId)).toMatchObject({ requests: 1, incomplete: 1, toHomeBytes: 2048, fromHomeBytes: first.byteLength });
    expect(h.book.snapshot(linkId)).toMatchObject({ requests: 1, incomplete: 1, toHomeBytes: 2048, fromHomeBytes: first.byteLength });
  });

  test("a Home request without Content-Length is counted as uncounted, not guessed", async () => {
    const h = home(async req => Response.json({ bytes: (await req.arrayBuffer()).byteLength }));
    const child = createLinkTrafficBook("relayed");
    const response = await relayLinkDataRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", duplex: "half", headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(300)); controller.close(); } }),
    } as RequestInit), target(h.port), { tunnel: HOME_INITIATED_LINK_TUNNEL, traffic: child });
    const body = await response.text();
    expect(child.snapshot(linkId)).toMatchObject({ requests: 1, toHomeBytes: 300, fromHomeBytes: encoder.encode(body).byteLength });
    expect(h.book.snapshot(linkId)).toMatchObject({ requests: 1, toHomeBytes: 0, toHomeUncounted: 1, fromHomeBytes: encoder.encode(body).byteLength });
  });

  test("a request refused before any send leaves the book untouched", async () => {
    const child = createLinkTrafficBook("relayed");
    const response = await relayLinkDataRequest(chunkedRequest([10]), target(20000), { traffic: child });
    expect(response.status).toBe(503);
    expect(child.snapshot(linkId)).toMatchObject({ requests: 0, incomplete: 0, toHomeBytes: 0, fromHomeBytes: 0 });
  });

  test("the book is bounded and a link it forgot reads zeros under a new generation", () => {
    const book = createLinkTrafficBook("relayed", { now: () => Date.parse("2026-11-12T00:00:00.000Z") });
    const first = book.begin("lnk_0000000000000000"); first.toHome(1); first.end(true);
    const before = book.snapshot("lnk_0000000000000000");
    for (let i = 1; i <= MAX_LINKS; i++) {
      const flow = book.begin(`lnk_${i.toString(16).padStart(16, "0")}`);
      flow.toHome(1); flow.end(true);
    }
    const after = book.snapshot("lnk_0000000000000000");
    expect(after).toMatchObject({ requests: 0, toHomeBytes: 0, toHomeSource: "relayed", untrackedRequests: 0 });
    expect(after.generation).not.toBe(before.generation);
    expect(book.linkCount()).toBe(MAX_LINKS);
    expect(book.snapshot(`lnk_${MAX_LINKS.toString(16).padStart(16, "0")}`).toHomeBytes).toBe(1);
  });
});

describe("link traffic counters at the transport boundary (#3023 review)", () => {
  test("a refused challenge and a refused connection count nothing, even with a body read ahead", async () => {
    const refusing = createLinkRelaySessions({ fingerprints: () => [] });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, s) => refusing.dispatch(req, s, async () => Response.json({})) });
    servers.push(server);
    const child = createLinkTrafficBook("relayed");
    const refused = await relayLinkDataRequest(chunkedRequest([4096]), target(server.port!), { tunnel: HOME_INITIATED_LINK_TUNNEL, traffic: child });
    expect(refused.status).toBe(503);
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const closedPort = closed.port!;
    await closed.stop(true);
    const unreachable = await relayLinkDataRequest(chunkedRequest([4096]), target(closedPort), { tunnel: HOME_INITIATED_LINK_TUNNEL, traffic: child });
    expect(unreachable.status).toBe(503);
    expect(child.snapshot(linkId)).toMatchObject({ requests: 0, incomplete: 0, toHomeBytes: 0, fromHomeBytes: 0 });
  });

  test("a compressed response counts the bytes on the link, not the decoded bytes", async () => {
    const decoded = encoder.encode(JSON.stringify({ text: "z".repeat(50_000) }));
    const wire = gzipSync(decoded);
    const h = home(async () => new Response(wire, { headers: { "content-type": "application/json", "content-encoding": "gzip" } }));
    const child = createLinkTrafficBook("relayed");
    const response = await relayLinkDataRequest(new Request("http://127.0.0.1/v1/models"), target(h.port), { tunnel: HOME_INITIATED_LINK_TUNNEL, traffic: child });
    expect((await response.arrayBuffer()).byteLength).toBe(decoded.byteLength);
    expect(child.snapshot(linkId)).toMatchObject({ requests: 1, incomplete: 0, fromHomeBytes: wire.byteLength });
    expect(h.book.snapshot(linkId).fromHomeBytes).toBe(wire.byteLength);
  });

  test("the Child's own reads of the Home count in the process book", async () => {
    const ownLink = "lnk_00000000000000aa";
    const h = home(async () => Response.json({ state: "ok" }));
    const before = childLinkTraffic.snapshot(ownLink);
    const read = linkBoundFetch({ transport: "link", link: { tunnelPort: h.port, linkId: ownLink }, apiKeyId: keyId }, key);
    const body = await (await read(`http://127.0.0.1:${h.port}/v1/hub-state`)).text();
    const after = childLinkTraffic.snapshot(ownLink);
    expect(after.requests - before.requests).toBe(1);
    expect(after.fromHomeBytes - before.fromHomeBytes).toBe(encoder.encode(body).byteLength);
  });

  test("identity bytes read off the socket count even when the caller cancels before consuming them", async () => {
    const incoming = Object.assign(new PassThrough(), { statusCode: 200, rawHeaders: ["content-type", "text/event-stream"] });
    const book = createLinkTrafficBook("relayed");
    const flow = book.begin(linkId);
    const first = encoder.encode("data: first\n\n"), second = encoder.encode("data: queued but never read\n\n");
    incoming.write(first); incoming.write(second);
    let closed = 0;
    const response = await linkResponseOnConnectionForTests(incoming as unknown as IncomingMessage, async () => { closed += 1; }, "POST", flow);
    const reader = response.body!.getReader();
    const read = await reader.read();
    expect(read.value?.byteLength).toBeGreaterThan(0);
    await reader.cancel();
    expect(book.snapshot(linkId)).toMatchObject({ requests: 1, incomplete: 1, fromHomeBytes: first.byteLength + second.byteLength });
    expect(closed).toBeGreaterThan(0);
  });

  test("a Home request aborted before its headers stays incomplete when the handler then answers without a body", async () => {
    const answered = gate(), received = gate();
    const h = home(async req => {
      received.resolve();
      await new Promise<void>(resolve => req.signal.addEventListener("abort", () => resolve(), { once: true }));
      queueMicrotask(() => answered.resolve());
      return new Response(null, { status: 204 });
    });
    const caller = new AbortController();
    const relayed = relayLinkDataRequest(chunkedRequest([100], caller.signal), target(h.port), { tunnel: HOME_INITIATED_LINK_TUNNEL, traffic: createLinkTrafficBook("relayed") });
    // The dispatcher runs only after the Home's listener counted the request.
    await received.promise;
    caller.abort();
    await relayed.catch(() => undefined);
    await answered.promise;
    expect(h.book.snapshot(linkId)).toMatchObject({ requests: 1, incomplete: 1 });
  });
});

describe("traffic book eviction and buffered bodies (#3023 final review)", () => {
  test("eviction never drops a link with a request in flight", () => {
    const book = createLinkTrafficBook("relayed");
    const live = book.begin("lnk_ffffffffffffffff");
    live.toHome(10);
    for (let i = 0; i < MAX_LINKS + 5; i++) {
      const flow = book.begin(`lnk_${(i + 1).toString(16).padStart(16, "0")}`);
      flow.toHome(1); flow.end(true);
    }
    live.toHome(5); live.end(true);
    expect(book.snapshot("lnk_ffffffffffffffff")).toMatchObject({ requests: 1, toHomeBytes: 15 });
    expect(book.linkCount()).toBe(MAX_LINKS);
  });

  test("more links in flight than the bound: the book never grows past it, and the rest are counted as untracked", () => {
    const book = createLinkTrafficBook("relayed");
    const flows = Array.from({ length: MAX_LINKS + 100 }, (_, i) => book.begin(`lnk_${(i + 1).toString(16).padStart(16, "0")}`));
    for (const flow of flows) flow.toHome(7);
    expect(book.linkCount()).toBe(MAX_LINKS);
    for (const flow of flows) flow.end(true);
    expect(book.linkCount()).toBe(MAX_LINKS);
    const tracked = book.snapshot("lnk_0000000000000001"), untracked = book.snapshot(`lnk_${(MAX_LINKS + 100).toString(16).padStart(16, "0")}`);
    expect(tracked).toMatchObject({ requests: 1, toHomeBytes: 7, untrackedRequests: 100 });
    expect(untracked).toMatchObject({ requests: 0, toHomeBytes: 0, untrackedRequests: 100 });
  });

  for (const [label, clockFor] of [
    ["repeats", () => { const at = Date.parse("2026-11-12T00:00:00.000Z"); return () => at; }],
    ["moves backward", () => { let at = Date.parse("2026-11-12T00:00:00.000Z"); return () => (at -= 1000); }],
  ] as const) {
    test(`a reset gets a new generation even when the clock ${label}`, () => {
      const book = createLinkTrafficBook("relayed", { now: clockFor() });
      const flow = book.begin("lnk_0000000000000000"); flow.toHome(4); flow.end(true);
      const counted = book.snapshot("lnk_0000000000000000");
      for (let i = 1; i <= MAX_LINKS; i++) { const other = book.begin(`lnk_${i.toString(16).padStart(16, "0")}`); other.end(true); }
      const forgotten = book.snapshot("lnk_0000000000000000");
      const again = book.begin("lnk_0000000000000000"); again.toHome(1); again.end(true);
      const recounted = book.snapshot("lnk_0000000000000000");
      const generations = new Set([counted.generation, forgotten.generation, recounted.generation]);
      expect(generations.size).toBe(3);
      expect(recounted).toMatchObject({ requests: 1, toHomeBytes: 1 });
    });
  }

  test("a buffered body counts only once the socket took it", async () => {
    const answered = gate();
    // Bun sends response headers with the first body chunk, so the Home answers with one event at once.
    const h = home(async () => {
      answered.resolve();
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode("data: early\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    });
    const child = createLinkTrafficBook("relayed");
    const caller = new AbortController();
    // The Home never reads it, and its single write is held the way a full send buffer holds it.
    holdLargeSocketWrites(1024 * 1024);
    const body = "x".repeat(48 * 1024 * 1024);
    const response = await fetchBoundLinkRelay(target(h.port), `http://127.0.0.1:${h.port}/v1/responses`,
      { method: "POST", body, headers: { "content-type": "application/json" }, signal: caller.signal }, { traffic: child });
    await answered.promise;
    const reader = response.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
    expect(child.snapshot(linkId).toHomeBytes).toBe(0);
    await reader.cancel();
    expect(child.snapshot(linkId)).toMatchObject({ requests: 1, incomplete: 1, toHomeBytes: 0 });
  });

  test("a Home that read a prefix before the request was cancelled: toHomeBytes is a lower bound of what crossed", async () => {
    const prefix = 1024 * 1024;
    const read = gate<number>();
    const h = home(async req => {
      const reader = req.body!.getReader();
      let got = 0;
      while (got < prefix) { const next = await reader.read(); if (next.done) break; got += next.value.byteLength; }
      read.resolve(got);
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode("data: early\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    });
    const child = createLinkTrafficBook("relayed");
    // The Home reads only a prefix: the write stays pending, as a send buffer holds it on any platform.
    holdLargeSocketWrites(1024 * 1024);
    const body = "x".repeat(48 * 1024 * 1024);
    const response = await fetchBoundLinkRelay(target(h.port), `http://127.0.0.1:${h.port}/v1/responses`,
      { method: "POST", body, headers: { "content-type": "application/json" } }, { traffic: child });
    const crossed = await read.promise;
    expect(crossed).toBeGreaterThanOrEqual(prefix);
    await response.body!.cancel();
    const counted = child.snapshot(linkId);
    // The contract: with incomplete > 0, toHomeBytes may miss bytes of those requests that did cross.
    expect(counted.incomplete).toBe(1);
    expect(counted.toHomeBytes).toBeLessThan(crossed);
    expect(counted.toHomeBytes).toBeLessThanOrEqual(body.length);
  });
});

describe("traffic identity across restarts and cut uploads (#3023 review round 8)", () => {
  test("two books (two process lifetimes) never share a comparison identity, even for the same link under a repeating clock", () => {
    const at = Date.parse("2026-11-12T00:00:00.000Z");
    const reads = [0, 1].map(() => {
      const book = createLinkTrafficBook("relayed", { now: () => at });
      const flow = book.begin(linkId); flow.toHome(3); flow.end(true);
      return book.snapshot(linkId);
    });
    expect(reads[0]!.since).toBe(reads[1]!.since);
    expect(`${reads[0]!.epoch}/${reads[0]!.generation}`).not.toBe(`${reads[1]!.epoch}/${reads[1]!.generation}`);
    expect(reads[0]!.epoch).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a Home that reads a prefix and then answers in full: the response completes, the cut upload still marks the request incomplete", async () => {
    const prefix = 1024 * 1024;
    const h = home(async req => {
      const reader = req.body!.getReader();
      let got = 0;
      while (got < prefix) { const next = await reader.read(); if (next.done) break; got += next.value.byteLength; }
      return new Response("data: done\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const child = createLinkTrafficBook("relayed");
    // The Home reads only a prefix: the write stays pending, as a send buffer holds it on any platform.
    holdLargeSocketWrites(1024 * 1024);
    const body = "x".repeat(48 * 1024 * 1024);
    const response = await fetchBoundLinkRelay(target(h.port), `http://127.0.0.1:${h.port}/v1/responses`,
      { method: "POST", body, headers: { "content-type": "application/json" } }, { traffic: child });
    expect(await response.text()).toBe("data: done\n\n");
    const counted = child.snapshot(linkId);
    expect(counted).toMatchObject({ requests: 1, incomplete: 1 });
    expect(counted.toHomeBytes).toBeLessThan(body.length);
  });

  test("an ordinary request whose upload and response both finish stays complete", async () => {
    const h = home(async req => new Response(`got ${(await req.arrayBuffer()).byteLength}`));
    const child = createLinkTrafficBook("relayed");
    const response = await fetchBoundLinkRelay(target(h.port), `http://127.0.0.1:${h.port}/v1/responses`,
      { method: "POST", body: "y".repeat(200_000), headers: { "content-type": "application/json" } }, { traffic: child });
    expect(await response.text()).toBe("got 200000");
    expect(child.snapshot(linkId)).toMatchObject({ requests: 1, incomplete: 0, toHomeBytes: 200_000 });
  });

  test("a read taken while a large write is still pending lags: the Home already has a prefix, incomplete is 0 and toHomeBytes misses it", async () => {
    const prefix = 1024 * 1024;
    const read = gate<number>(), answer = gate();
    const h = home(async req => {
      const reader = req.body!.getReader();
      let got = 0;
      while (got < prefix) { const next = await reader.read(); if (next.done) break; got += next.value.byteLength; }
      read.resolve(got);
      await answer.promise;
      return new Response("data: done\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const child = createLinkTrafficBook("relayed");
    // The Home reads only a prefix: the write stays pending, as a send buffer holds it on any platform.
    holdLargeSocketWrites(1024 * 1024);
    const body = "x".repeat(48 * 1024 * 1024);
    const pending = fetchBoundLinkRelay(target(h.port), `http://127.0.0.1:${h.port}/v1/responses`,
      { method: "POST", body, headers: { "content-type": "application/json" } }, { traffic: child });
    const crossed = await read.promise;
    // The contract: an active write counts only once it completes, so a delta measures completed writes.
    expect(child.snapshot(linkId)).toMatchObject({ requests: 1, incomplete: 0, toHomeBytes: 0 });
    expect(crossed).toBeGreaterThanOrEqual(prefix);
    answer.resolve();
    await (await pending).body!.cancel();
    expect(child.snapshot(linkId).incomplete).toBe(1);
  });
});
