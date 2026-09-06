import { describe, expect, spyOn, test } from "bun:test";
import {
  HUB_RELAY_REQUEST_BODY_MAX_BYTES,
  HUB_RELAY_RESPONSE_BODY_MAX_BYTES,
  HUB_RELAY_DEFAULT_TIMEOUT_MS,
  relayHubManagementRequest,
  validateHubRelayRequestHeaders,
} from "../../src/client/hub-relay";

const target = { managementUrl: "https://hub.example.test", browserOrigin: "http://127.0.0.1:10100" };

function relayRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:10100/api/machine/hub-relay${path}`, {
    ...init,
    headers: {
      Origin: target.browserOrigin,
      "X-OpenCodex-API-Key": "ocx_session_hub",
      "X-OpenCodex-GUI-Origin": target.browserOrigin,
      "X-OpenCodex-CSRF-Token": "hub-csrf",
      "X-OpenCodex-Machine-Session": "ocx_session_machine",
      "X-OpenCodex-Machine-GUI-Origin": target.browserOrigin,
      "X-OpenCodex-Machine-CSRF-Token": "machine-csrf",
      Cookie: "private=1",
      Forwarded: "for=192.0.2.1",
      Connection: "keep-alive",
      ...init.headers,
    },
  });
}

describe("fixed-target hub management relay", () => {
  test("raw header validation rejects CL/TE ambiguity, duplicate lengths, upgrade, and CRLF", () => {
    for (const headers of [
      [["Content-Length", "1"], ["Transfer-Encoding", "chunked"]],
      [["Content-Length", "1"], ["Content-Length", "2"]],
      [["Content-Length", "1, 2"]],
      [["Upgrade", "websocket"]],
      [["X-Test", "ok\r\ninjected: yes"]],
    ] as const) expect(validateHubRelayRequestHeaders(headers).ok).toBe(false);
    const valid = validateHubRelayRequestHeaders([["Connection", "X-OpenCodex-API-Key"], ["X-OpenCodex-API-Key", "session"]]);
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.connectionNamed.has("x-opencodex-api-key")).toBe(true);
  });

  test("forwards only to the configured hub and strips machine, cookie, forwarding, and hop headers", async () => {
    let captured: { url: string; headers: Headers } | null = null;
    const response = await relayHubManagementRequest(relayRequest("/api/usage?range=all"), "/api/usage?range=all", target, {
      fetchImpl: (async (input, init) => {
        captured = { url: String(input), headers: new Headers(init?.headers) };
        return Response.json({ ok: true }, { headers: { "Set-Cookie": "hub=secret", Connection: "close", ETag: "v1" } });
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(captured!.url).toBe("https://hub.example.test/api/usage?range=all");
    expect(captured!.headers.get("x-opencodex-api-key")).toBe("ocx_session_hub");
    for (const header of ["x-opencodex-machine-session", "cookie", "forwarded", "connection", "host"]) {
      expect(captured!.headers.get(header)).toBeNull();
    }
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("etag")).toBe("v1");
  });

  test("POST pairing reaches only /opencodex-session and forwards browser Origin verbatim", async () => {
    let captured: { url: string; method: string; origin: string | null } | null = null;
    const request = relayRequest("/opencodex-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant: `ocx_pair_${"a".repeat(43)}` }),
    });
    const response = await relayHubManagementRequest(request, "/opencodex-session", target, {
      fetchImpl: (async (input, init) => {
        captured = { url: String(input), method: String(init?.method), origin: new Headers(init?.headers).get("origin") };
        return new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
      }) as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(captured).toEqual({ url: "https://hub.example.test/opencodex-session", method: "POST", origin: target.browserOrigin });
  });

  test("rejects traversal, authority, encoded separator, and caller-host variants before outbound I/O", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response(); }) as typeof fetch;
    for (const suffix of [
      "//evil.example/api/config",
      "/api/../opencodex-session",
      "/api/%2e%2e/opencodex-session",
      "/api/%2f%2fevil.example/config",
      "/api/%5cevil",
      "https://evil.example/api/config",
      "/v1/models",
      "/opencodex-session?host=evil.example",
    ]) {
      const response = await relayHubManagementRequest(relayRequest("/api/config"), suffix, target, { fetchImpl });
      expect(response.status).toBe(404);
    }
    expect(calls).toBe(0);
  });

  test("rejects redirects, request and response overflow, and timeout without exposing bodies", async () => {
    const redirected = await relayHubManagementRequest(relayRequest("/api/config"), "/api/config", target, {
      fetchImpl: (async () => new Response(null, { status: 302, headers: { Location: "https://evil.example" } })) as typeof fetch,
    });
    expect(redirected.status).toBe(502);

    const oversizedRequest = relayRequest("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(HUB_RELAY_REQUEST_BODY_MAX_BYTES + 1) },
      body: "{}",
    });
    let calls = 0;
    expect((await relayHubManagementRequest(oversizedRequest, "/api/config", target, {
      fetchImpl: (async () => { calls += 1; return new Response(); }) as typeof fetch,
    })).status).toBe(413);
    expect(calls).toBe(0);

    const oversizedResponse = await relayHubManagementRequest(relayRequest("/api/config"), "/api/config", target, {
      fetchImpl: (async () => new Response("x", { headers: { "Content-Length": String(HUB_RELAY_RESPONSE_BODY_MAX_BYTES + 1) } })) as typeof fetch,
    });
    expect(oversizedResponse.status).toBe(502);

    const timedOut = await relayHubManagementRequest(relayRequest("/api/config"), "/api/config", target, {
      timeoutMs: 5,
      fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      })) as typeof fetch,
    });
    expect(timedOut.status).toBe(502);
  });

  test("strips response headers nominated by Connection and propagates browser cancellation", async () => {
    let cancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("first")); },
      cancel() { cancelled = true; },
    });
    const response = await relayHubManagementRequest(relayRequest("/api/config"), "/api/config", target, {
      fetchImpl: (async () => new Response(upstreamBody, {
        headers: { "Content-Type": "application/json", Connection: "ETag", ETag: "secret-validator" },
      })) as typeof fetch,
    });
    expect(response.headers.get("etag")).toBeNull();
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  test("established account SSE outlives the handshake deadline and still cancels on client abort", async () => {
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const browser = new AbortController();
    let upstreamSignal!: AbortSignal;
    let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await relayHubManagementRequest(relayRequest("/api/accounts/events", { signal: browser.signal }), "/api/accounts/events", target, {
        fetchImpl: (async (_input, init) => {
          upstreamSignal = init!.signal!;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { upstreamController = controller; controller.enqueue(new TextEncoder().encode("event: ready\n\n")); },
            cancel() { cancelled = true; },
          }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
        }) as typeof fetch,
      });
      expect(timeout).toHaveBeenCalledWith(HUB_RELAY_DEFAULT_TIMEOUT_MS);
      reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      deadline.abort(new DOMException("Handshake deadline", "TimeoutError"));
      expect(upstreamSignal.aborted).toBe(false);
      expect(cancelled).toBe(false);
      upstreamController.enqueue(new TextEncoder().encode("event: account-selection\n\n"));
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("account-selection");
      const pending = reader.read();
      browser.abort();
      await pending.catch(() => undefined);
      expect(upstreamSignal.aborted).toBe(true);
      expect(cancelled).toBe(true);
    } finally {
      await reader?.cancel().catch(() => undefined);
      browser.abort();
      timeout.mockRestore();
    }
  });

  test.each([
    ["/api/config", "GET", 200, "application/json"],
    ["/api/config", "GET", 200, "text/event-stream"],
    ["/api/accounts/events", "POST", 200, "text/event-stream"],
    ["/api/accounts/events", "GET", 201, "text/event-stream"],
    ["/api/accounts/events", "GET", 401, "text/event-stream"],
    ["/api/accounts/events", "GET", 200, "application/json"],
    ["/api/accounts/events", "GET", 200, "text/event-streamish"],
    ["/api/accounts/events?other=1", "GET", 200, "text/event-stream"],
  ] as const)("relay keeps the total deadline for %s %s %i %s", async (path, method, status, contentType) => {
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let upstreamSignal!: AbortSignal;
    let cancelled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await relayHubManagementRequest(relayRequest(path, { method }), path, target, {
        fetchImpl: (async (_input, init) => {
          upstreamSignal = init!.signal!;
          return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), {
            status, headers: { "Content-Type": contentType },
          });
        }) as typeof fetch,
      });
      reader = response.body!.getReader();
      const pending = reader.read();
      deadline.abort(new DOMException("Total deadline", "TimeoutError"));
      await pending.catch(() => undefined);
      expect(upstreamSignal.aborted).toBe(true);
      expect(cancelled).toBe(true);
    } finally {
      await reader?.cancel().catch(() => undefined);
      timeout.mockRestore();
    }
  });

  test("selection SSE still has a handshake deadline and a response body cap", async () => {
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let handshakeStarted!: () => void;
    const started = new Promise<void>(resolve => { handshakeStarted = resolve; });
    try {
      const pending = relayHubManagementRequest(relayRequest("/api/accounts/events"), "/api/accounts/events", target, {
        fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
          handshakeStarted();
        })) as typeof fetch,
      });
      await started;
      deadline.abort(new DOMException("Handshake deadline", "TimeoutError"));
      expect((await pending).status).toBe(502);
    } finally { timeout.mockRestore(); }

    let cancelled = false;
    const response = await relayHubManagementRequest(relayRequest("/api/accounts/events"), "/api/accounts/events", target, {
      fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(HUB_RELAY_RESPONSE_BODY_MAX_BYTES + 1)); },
        cancel() { cancelled = true; },
      }), { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch,
    });
    await expect(response.arrayBuffer()).rejects.toThrow("response body too large");
    expect(cancelled).toBe(true);
  });

  test.each(["complete", "cancel"] as const)("relay detaches deadline and client listeners after body %s", async disposition => {
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const browser = new AbortController();
    let upstreamSignal!: AbortSignal;
    try {
      const response = await relayHubManagementRequest(relayRequest("/api/config", { signal: browser.signal }), "/api/config", target, {
        fetchImpl: (async (_input, init) => {
          upstreamSignal = init!.signal!;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { if (disposition === "complete") controller.close(); },
          }), { headers: { "Content-Type": "application/json" } });
        }) as typeof fetch,
      });
      if (disposition === "complete") await response.text();
      else await response.body!.cancel();
      deadline.abort();
      browser.abort();
      expect(upstreamSignal.aborted).toBe(false);
    } finally { timeout.mockRestore(); }
  });
});
