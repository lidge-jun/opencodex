import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { relayLinkDataRequest, HOME_INITIATED_LINK_TUNNEL } from "../../src/client/link-relay";
import { createLinkRelaySessions } from "../../src/server/index/link-relay-sessions";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { createLinkTrafficBook, MAX_LINKS } from "../../src/link/traffic";

const key = `ocx_data_${"a".repeat(40)}`;
const keyId = "test-link-key", linkId = "lnk_0123456789abcdef";
const fp = serviceApiTokenFingerprint(key);
const target = (port: number) => ({ tunnelPort: port, admissionKey: key, apiKeyId: keyId, linkId });
const encoder = new TextEncoder();
let servers: Server<unknown>[] = [];
afterEach(async () => { for (const server of servers) await server.stop(true); servers = []; });

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

  test("the book is bounded and reads zeros since its start for a link it never saw", () => {
    const book = createLinkTrafficBook("relayed", { now: () => Date.parse("2026-11-12T00:00:00.000Z") });
    for (let i = 0; i <= MAX_LINKS; i++) book.begin(`lnk_${i.toString(16).padStart(16, "0")}`).toHome(1);
    expect(book.snapshot("lnk_0000000000000000")).toEqual({ since: "2026-11-12T00:00:00.000Z", requests: 0, incomplete: 0,
      toHomeBytes: 0, fromHomeBytes: 0, toHomeSource: "relayed", toHomeUncounted: 0 });
    expect(book.snapshot(`lnk_${MAX_LINKS.toString(16).padStart(16, "0")}`).toHomeBytes).toBe(1);
  });
});
