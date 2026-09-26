import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
  forwardLinkRequestHeaders,
  LINK_RELAY_BODY_MAX_BYTES,
  LINK_RELAY_HEADER_TIMEOUT_MS,
  LINK_RELAY_SSE_IDLE_TIMEOUT_MS,
  relayLinkDataRequest,
  sanitizeLinkResponseHeaders,
  type LinkRelayClock,
} from "../../src/client/link-relay";
import { HUB_RELAY_REQUEST_BODY_MAX_BYTES } from "../../src/client/hub-relay";
import { startMachineListener } from "../../src/client/machine-listener";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import type { OcxClientConnectionConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINK_KEY = `ocx_data_${"d".repeat(40)}`;
const target = { tunnelPort: 12000, admissionKey: LINK_KEY };
let servers: Server<unknown>[] = [];
let root = "";
let previousHome: string | undefined;

function linkConnection(tunnelPort: number): OcxClientConnectionConfig {
  return {
    serverUrl: `http://127.0.0.1:${tunnelPort}`,
    managementUrl: `http://127.0.0.1:${tunnelPort}`,
    managementTransport: "direct",
    transport: "link",
    link: { tunnelPort, linkId: `lnk_${"a".repeat(16)}` },
    selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "ocx_data_fixture",
    tokenFingerprint: serviceApiTokenFingerprint(LINK_KEY),
    protocolVersion: 1,
    connectedAt: "2026-09-25T00:00:00.000Z",
    catalogSyncedAt: "2026-09-25T00:00:01.000Z",
  };
}

function relayRequest(init: RequestInit = {}): Request {
  return new Request("http://127.0.0.1:10100/v1/responses?trace=1", init);
}

/** A clock whose timers fire only when the test advances it. */
function manualClock() {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void; ms: number }>();
  let next = 1;
  const clock: LinkRelayClock = {
    setTimeout: ((callback: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, callback, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((id: number) => { timers.delete(id); }) as typeof clearTimeout,
  };
  return {
    clock,
    delays: () => [...timers.values()].map(timer => timer.ms),
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-relay-"));
  process.env.OPENCODEX_HOME = root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify({
    port: 0, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai",
  }));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (root) removeTreeWithRetry(root);
});

describe("client link HTTP relay", () => {
  test("replaces every caller credential with the link key and filters hop-by-hop headers", () => {
    const caller = new Headers({
      Authorization: "Bearer caller-chatgpt-oauth",
      "X-OpenCodex-API-Key": "ocx_data_caller",
      "X-Api-Key": "sk-ant-caller",
      "ChatGPT-Account-Id": "acct-caller",
      Cookie: "session=caller",
      "X-Trace": "trace-1",
      Connection: "keep-alive, X-Remove",
      "X-Remove": "secret",
      Host: "caller.example.test",
      "Content-Length": "2",
    });
    const forwarded = forwardLinkRequestHeaders(caller, LINK_KEY, "/v1/responses");
    expect(forwarded.get("authorization")).toBe(`Bearer ${LINK_KEY}`);
    expect(forwarded.get("x-trace")).toBe("trace-1");
    for (const name of ["x-opencodex-api-key", "x-api-key", "chatgpt-account-id", "cookie", "connection", "keep-alive", "x-remove", "host", "content-length"]) {
      expect(forwarded.get(name)).toBeNull();
    }
    // /v1/usage admits only the dedicated header on the Home.
    const usage = forwardLinkRequestHeaders(caller, LINK_KEY, "/v1/usage");
    expect(usage.get("x-opencodex-api-key")).toBe(LINK_KEY);
    expect(usage.get("authorization")).toBeNull();
    expect(usage.get("x-api-key")).toBeNull();

    const response = sanitizeLinkResponseHeaders(new Headers({
      Connection: "X-Response-Secret",
      "X-Response-Secret": "secret",
      "Content-Type": "application/json",
      "Content-Length": "2",
      "Content-Encoding": "gzip",
    }));
    expect(response.get("content-type")).toBe("application/json");
    for (const name of ["connection", "x-response-secret", "content-length", "content-encoding"]) {
      expect(response.get(name)).toBeNull();
    }
  });

  test("sends the link key, not the caller's credential, to the Home", async () => {
    const sent: Headers[] = [];
    const fetchImpl = (async (_input, init) => { sent.push(new Headers(init?.headers)); return Response.json({ ok: true }); }) as typeof fetch;
    const response = await relayLinkDataRequest(relayRequest({
      method: "POST",
      headers: { Authorization: "Bearer caller-chatgpt-oauth", "ChatGPT-Account-Id": "acct-caller", "Content-Type": "application/json" },
      body: "{}",
    }), target, { fetchImpl });
    expect(response.status).toBe(200);
    expect(sent[0]?.get("authorization")).toBe(`Bearer ${LINK_KEY}`);
    expect(sent[0]?.get("chatgpt-account-id")).toBeNull();
    const usage = await relayLinkDataRequest(new Request("http://127.0.0.1:10100/v1/usage", {
      headers: { Authorization: "Bearer caller-chatgpt-oauth" },
    }), target, { fetchImpl });
    expect(usage.status).toBe(200);
    expect(sent[1]?.get("x-opencodex-api-key")).toBe(LINK_KEY);
    expect(sent[1]?.get("authorization")).toBeNull();
  });

  test("rejects TE/CL ambiguity and oversized requests before outbound I/O", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response(); }) as typeof fetch;
    const ambiguous = new Request("http://127.0.0.1:10100/v1/responses", {
      method: "POST",
      headers: { "Content-Length": "2", "Transfer-Encoding": "chunked" },
      body: "{}",
    });
    expect((await relayLinkDataRequest(ambiguous, target, { fetchImpl })).status).toBe(400);
    for (const [limit, declared] of [[undefined, LINK_RELAY_BODY_MAX_BYTES + 1], [1024, 1025]] as const) {
      const oversized = new Request("http://127.0.0.1:10100/v1/responses", {
        method: "POST",
        headers: { "Content-Length": String(declared) },
        body: "{}",
      });
      expect((await relayLinkDataRequest(oversized, target, { fetchImpl, bodyLimitBytes: limit })).status).toBe(413);
    }
    expect(calls).toBe(0);
  });

  test("streams a body larger than the management relay cap without buffering it", async () => {
    const size = 5 * 1024 * 1024;
    expect(size).toBeGreaterThan(HUB_RELAY_REQUEST_BODY_MAX_BYTES);
    let streamed = false;
    let received = 0;
    let length: string | null = null;
    const response = await relayLinkDataRequest(relayRequest({
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(size) },
      body: new Uint8Array(size).fill(0x61),
    }), target, {
      fetchImpl: (async (_input, init) => {
        streamed = init?.body instanceof ReadableStream;
        length = new Headers(init?.headers).get("content-length");
        received = (await new Response(init!.body).arrayBuffer()).byteLength;
        return Response.json({ received });
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(streamed).toBe(true);
    expect(length).toBe(String(size));
    expect(received).toBe(size);
  });

  test("admits a lone chunked upload as a standalone does and refuses any other Transfer-Encoding", async () => {
    const chunkedBody = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"input":'));
        controller.enqueue(new TextEncoder().encode('"hello"}'));
        controller.close();
      },
    });
    let sentHeaders: Headers | undefined;
    let sentBody = "";
    const fetchImpl = (async (_input, init) => {
      sentHeaders = new Headers(init?.headers);
      sentBody = await new Response(init!.body).text();
      return Response.json({ relayed: true });
    }) as typeof fetch;
    const response = await relayLinkDataRequest(relayRequest({
      method: "POST", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }, body: chunkedBody(), duplex: "half",
    } as RequestInit), target, { fetchImpl });
    expect(response.status).toBe(200);
    expect(sentBody).toBe('{"input":"hello"}');
    // The framing is the fetch's own: neither the caller's Transfer-Encoding nor a Content-Length is copied.
    expect(sentHeaders?.get("transfer-encoding")).toBeNull();
    expect(sentHeaders?.get("content-length")).toBeNull();
    expect(sentHeaders?.get("authorization")).toBe(`Bearer ${LINK_KEY}`);

    let calls = 0;
    const counted = (async () => { calls += 1; return new Response(); }) as typeof fetch;
    for (const encoding of ["gzip, chunked", "chunked, chunked", "identity"]) {
      const refused = await relayLinkDataRequest(relayRequest({
        method: "POST", headers: { "Transfer-Encoding": encoding }, body: chunkedBody(), duplex: "half",
      } as RequestInit), target, { fetchImpl: counted });
      expect(refused.status).toBe(400);
    }
    expect(calls).toBe(0);

    const oversized = await relayLinkDataRequest(relayRequest({
      method: "POST", headers: { "Transfer-Encoding": "chunked" }, body: chunkedBody(), duplex: "half",
    } as RequestInit), target, {
      bodyLimitBytes: 8,
      fetchImpl: (async (_input, init) => {
        await new Response(init!.body).arrayBuffer();
        return Response.json({ unreachable: true });
      }) as typeof fetch,
    });
    expect(oversized.status).toBe(413);
  });

  test("fails a streamed body that grows past the cap with 413", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    const response = await relayLinkDataRequest(relayRequest({ method: "POST", body, duplex: "half" } as RequestInit), target, {
      bodyLimitBytes: 1024,
      fetchImpl: (async (_input, init) => {
        await new Response(init!.body).arrayBuffer();
        return Response.json({ unreachable: true });
      }) as typeof fetch,
    });
    expect(response.status).toBe(413);
  });

  test("waits up to 300 seconds for the Home's response headers", async () => {
    const manual = manualClock();
    const response = await relayLinkDataRequest(relayRequest({ method: "POST", body: "{}" }), target, {
      clock: manual.clock,
      fetchImpl: (async (_input, init) => {
        // A Home that answers after 20 s: past the management relay's 15 s deadline.
        manual.advance(20_000);
        if (init?.signal?.aborted) throw init.signal.reason;
        return Response.json({ late: true });
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ late: true });
    expect(manual.delays()).toEqual([]);

    const stalled = manualClock();
    const refused = await relayLinkDataRequest(relayRequest({ method: "POST", body: "{}" }), target, {
      clock: stalled.clock,
      fetchImpl: (async (_input, init) => {
        expect(stalled.delays()).toEqual([LINK_RELAY_HEADER_TIMEOUT_MS]);
        stalled.advance(LINK_RELAY_HEADER_TIMEOUT_MS);
        if (init?.signal?.aborted) throw init.signal.reason;
        return Response.json({ unreachable: true });
      }) as typeof fetch,
    });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("1");
  });

  test("returns a retryable JSON 503 when the tunnel is refused, without echoing the key", async () => {
    const response = await relayLinkDataRequest(relayRequest({
      method: "POST",
      headers: { "X-OpenCodex-API-Key": "ocx_data_caller", "Content-Type": "application/json" },
      body: JSON.stringify({ input: "private" }),
    }), target, {
      fetchImpl: (async () => { throw new Error(`connection refused ${LINK_KEY}`); }) as typeof fetch,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    const body = await response.text();
    expect(body).not.toContain(LINK_KEY);
    expect(body).not.toContain("ocx_data_caller");
    expect(body).not.toContain("private");
  });

  test("applies the response byte cap to non-SSE responses", async () => {
    const response = await relayLinkDataRequest(relayRequest({ method: "POST" }), target, {
      bodyLimitBytes: 1024,
      fetchImpl: (async () => new Response("too large", {
        headers: { "Content-Length": "1025" },
      })) as typeof fetch,
    });
    expect(response.status).toBe(502);
  });

  test("propagates caller abort to the upstream SSE and cancels its body", async () => {
    const caller = new AbortController();
    const upstream = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: ready\n\n")); },
      cancel() { cancelled = true; },
    });
    const response = await relayLinkDataRequest(relayRequest({ method: "POST", signal: caller.signal }), target, {
      fetchImpl: (async (_input, init) => {
        init!.signal!.addEventListener("abort", () => upstream.abort(), { once: true });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }) as typeof fetch,
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    const pending = reader.read();
    caller.abort();
    await pending;
    expect(upstream.signal.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("closes an idle SSE after the injectable 300 second no-byte deadline", async () => {
    let fireIdle!: () => void;
    let upstreamSignal!: AbortSignal;
    let cancelled = false;
    const response = await relayLinkDataRequest(relayRequest({ method: "POST" }), target, {
      clock: {
        setTimeout: ((callback, ms) => {
          // The header deadline is armed first and cleared once headers arrive.
          if (ms === LINK_RELAY_SSE_IDLE_TIMEOUT_MS) fireIdle = callback;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout,
        clearTimeout: (() => {}) as typeof clearTimeout,
      },
      fetchImpl: (async (_input, init) => {
        upstreamSignal = init!.signal!;
        return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as typeof fetch,
    });
    const reader = response.body!.getReader();
    const pending = reader.read();
    fireIdle();
    expect((await pending).done).toBe(true);
    expect(upstreamSignal.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("relays POST /v1/responses through a real machine listener socket with the stored key", async () => {
    writeFileSync(join(root, "service-api-token"), `${LINK_KEY}\n`, { mode: 0o600 });
    let received: Record<string, string | null> | undefined;
    const hub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        received = {
          method: req.method,
          path: new URL(req.url).pathname + new URL(req.url).search,
          host: req.headers.get("host"),
          authorization: req.headers.get("authorization"),
          dedicated: req.headers.get("x-opencodex-api-key"),
          contentLength: req.headers.get("content-length"),
          transferEncoding: req.headers.get("transfer-encoding"),
          body: await req.text(),
        };
        return Response.json({ relayed: true });
      },
    });
    servers.push(hub);
    const machine = startMachineListener(0, { state: linkConnection(hub.port!) });
    servers.push(machine);
    const body = JSON.stringify({ input: "hello" });
    const response = await fetch(new URL("/v1/responses?trace=1", machine.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer caller-chatgpt-oauth", "X-OpenCodex-API-Key": "ocx_data_caller" },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ relayed: true });
    expect(received).toEqual({
      method: "POST", path: "/v1/responses?trace=1", host: `127.0.0.1:${hub.port}`,
      authorization: `Bearer ${LINK_KEY}`, dedicated: null,
      contentLength: String(body.length), transferEncoding: null, body,
    });
    expect((await fetch(new URL("/v1/unknown", machine.url))).status).toBe(404);
    expect((await fetch(new URL("/api/machine/hub-relay/api/config", machine.url))).status).toBe(404);

    // A chunked upload (a streamed body with no Content-Length) passes through as on a standalone.
    const encoder = new TextEncoder();
    const chunked = await fetch(new URL("/v1/responses", machine.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"input":'));
          controller.enqueue(encoder.encode('"chunked"}'));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(200);
    expect(received).toMatchObject({ authorization: `Bearer ${LINK_KEY}`, contentLength: null, transferEncoding: "chunked", body: '{"input":"chunked"}' });
  });
});
