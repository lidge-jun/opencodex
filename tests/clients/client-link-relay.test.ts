import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
  forwardLinkRequestHeaders,
  LINK_RELAY_SSE_IDLE_TIMEOUT_MS,
  relayLinkDataRequest,
  sanitizeLinkResponseHeaders,
} from "../../src/client/link-relay";
import {
  HUB_RELAY_REQUEST_BODY_MAX_BYTES,
  HUB_RELAY_RESPONSE_BODY_MAX_BYTES,
} from "../../src/client/hub-relay";
import { startMachineListener } from "../../src/client/machine-listener";
import type { OcxClientConnectionConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const target = { tunnelPort: 12000 };
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
    tokenFingerprint: "b".repeat(64),
    protocolVersion: 1,
    connectedAt: "2026-09-25T00:00:00.000Z",
    catalogSyncedAt: "2026-09-25T00:00:01.000Z",
  };
}

function relayRequest(init: RequestInit = {}): Request {
  return new Request("http://127.0.0.1:10100/v1/responses?trace=1", init);
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
  test("filters hop-by-hop and Connection-nominated headers while preserving caller credentials", () => {
    const forwarded = forwardLinkRequestHeaders(new Headers({
      Authorization: "Bearer caller-token",
      "X-OpenCodex-API-Key": "ocx_data_caller",
      "X-Trace": "trace-1",
      Connection: "keep-alive, X-Remove",
      "X-Remove": "secret",
      Host: "caller.example.test",
      "Content-Length": "2",
    }));
    expect(forwarded.get("authorization")).toBe("Bearer caller-token");
    expect(forwarded.get("x-opencodex-api-key")).toBe("ocx_data_caller");
    expect(forwarded.get("x-trace")).toBe("trace-1");
    for (const name of ["connection", "keep-alive", "x-remove", "host", "content-length"]) {
      expect(forwarded.get(name)).toBeNull();
    }

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

  test("rejects TE/CL ambiguity and oversized requests before outbound I/O", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response(); }) as typeof fetch;
    const ambiguous = new Request("http://127.0.0.1:10100/v1/responses", {
      method: "POST",
      headers: { "Content-Length": "2", "Transfer-Encoding": "chunked" },
      body: "{}",
    });
    expect((await relayLinkDataRequest(ambiguous, target, { fetchImpl })).status).toBe(400);
    const oversized = new Request("http://127.0.0.1:10100/v1/responses", {
      method: "POST",
      headers: { "Content-Length": String(HUB_RELAY_REQUEST_BODY_MAX_BYTES + 1) },
      body: "{}",
    });
    expect((await relayLinkDataRequest(oversized, target, { fetchImpl })).status).toBe(413);
    expect(calls).toBe(0);
  });

  test("returns a retryable JSON 503 when the tunnel is refused", async () => {
    const key = "ocx_data_secret_should_not_escape";
    const response = await relayLinkDataRequest(relayRequest({
      method: "POST",
      headers: { "X-OpenCodex-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ input: "private" }),
    }), target, {
      fetchImpl: (async () => { throw new Error("connection refused"); }) as typeof fetch,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    const body = await response.text();
    expect(body).not.toContain(key);
    expect(body).not.toContain("private");
  });

  test("applies hub response caps to non-SSE responses", async () => {
    const response = await relayLinkDataRequest(relayRequest({ method: "POST" }), target, {
      fetchImpl: (async () => new Response("too large", {
        headers: { "Content-Length": String(HUB_RELAY_RESPONSE_BODY_MAX_BYTES + 1) },
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
          expect(ms).toBe(LINK_RELAY_SSE_IDLE_TIMEOUT_MS);
          fireIdle = callback;
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

  test("relays POST /v1/responses through a real machine listener socket", async () => {
    let received: { method: string; path: string; host: string | null; key: string | null; body: string } | undefined;
    const hub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        received = {
          method: req.method,
          path: new URL(req.url).pathname + new URL(req.url).search,
          host: req.headers.get("host"),
          key: req.headers.get("x-opencodex-api-key"),
          body: await req.text(),
        };
        return Response.json({ relayed: true });
      },
    });
    servers.push(hub);
    const machine = startMachineListener(0, { state: linkConnection(hub.port) });
    servers.push(machine);
    const response = await fetch(new URL("/v1/responses?trace=1", machine.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenCodex-API-Key": "ocx_data_link" },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ relayed: true });
    expect(received).toEqual({
      method: "POST", path: "/v1/responses?trace=1", host: `127.0.0.1:${hub.port}`,
      key: "ocx_data_link", body: JSON.stringify({ input: "hello" }),
    });
    expect((await fetch(new URL("/v1/unknown", machine.url))).status).toBe(404);
    expect((await fetch(new URL("/api/machine/hub-relay/api/config", machine.url))).status).toBe(404);
  });
});
