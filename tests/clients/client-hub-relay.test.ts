import { describe, expect, spyOn, test } from "bun:test";
import * as hubRelay from "../../src/client/hub-relay";
import {
  HUB_RELAY_REQUEST_BODY_MAX_BYTES,
  HUB_RELAY_RESPONSE_BODY_MAX_BYTES,
  HUB_RELAY_DEFAULT_TIMEOUT_MS,
  HUB_RELAY_EXPECTED_TARGET_HEADER,
  relayHubManagementRequest,
  validateHubRelayRequestHeaders,
} from "../../src/client/hub-relay";

const scoped = { token: "ocx_hub_relay_" + "s".repeat(43), keyId: "fixture-enrollment", proof: "fixture-proof", at: "1780000000000" };
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
  test("refreshes a serving client's lease through a passive HEAD and cancels on stop", async () => {
    let tick!: () => Promise<void>;
    let disposed = false;
    let calls = 0;
    let received: { url: string; method?: string } | undefined;
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    let aborted = false;
    const refresh = hubRelay.startHubRelayLeaseRefresh(target.managementUrl, () => scoped, {
      schedule(run: () => Promise<void>) {
        tick = run;
        return () => { disposed = true; };
      },
      fetchImpl: (async (input, init) => {
        calls++;
        received = { url: String(input), method: init?.method };
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); }, { once: true });
          begin();
        });
      }) as typeof fetch,
    });
    try {
      const pending = tick();
      await started;
      await tick();
      expect(calls).toBe(1);
      expect(received).toEqual({ url: "https://hub.example.test/api/hub-relay/read/api/codex-auth/active", method: "HEAD" });
      refresh.stop();
      await pending;
      await tick();
      expect({ disposed, aborted, calls }).toEqual({ disposed: true, aborted: true, calls: 1 });
    } finally { if (!disposed) refresh.stop(); }
  });

  test("a matching expected target reaches the hub and the internal header is stripped", async () => {
    let captured: { url: string; headers: Headers } | null = null;
    const response = await relayHubManagementRequest(
      relayRequest("/api/codex-auth/accounts", { headers: { [HUB_RELAY_EXPECTED_TARGET_HEADER]: "https://hub.example.test" } }),
      "/api/codex-auth/accounts",
      target,
      { fetchImpl: (async (input, init) => {
        captured = { url: String(input), headers: new Headers(init?.headers) };
        return Response.json({ ok: true });
      }) as typeof fetch },
    );
    expect(response.status).toBe(200);
    expect(captured!.url).toBe("https://hub.example.test/api/hub-relay/read/api/codex-auth/accounts");
    expect(captured!.headers.get(HUB_RELAY_EXPECTED_TARGET_HEADER)).toBeNull();
  });

  test("a mismatched expected target is refused before the body is read or forwarded", async () => {
    let forwarded = 0;
    const request = new Request("http://127.0.0.1:10100/api/machine/hub-relay/opencodex-session", {
      method: "POST",
      headers: {
        Origin: target.browserOrigin,
        "Content-Type": "application/json",
        [HUB_RELAY_EXPECTED_TARGET_HEADER]: "https://other.example.test",
      },
      body: JSON.stringify({ next: true }),
    });
    const response = await relayHubManagementRequest(request, "/opencodex-session", target, {
      fetchImpl: (async () => { forwarded += 1; return Response.json({ ok: true }); }) as typeof fetch,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "target_changed" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(forwarded).toBe(0);
    expect(request.bodyUsed).toBe(false);
  });

  test("duplicate, combined, malformed and oversized expected targets are refused", async () => {
    for (const value of [
      "https://hub.example.test, https://other.example.test",
      "https://hub.example.test/path",
      "https://user:pass@hub.example.test",
      `https://${"a".repeat(600)}.example.test`,
      "not-a-url",
    ]) {
      const response = await relayHubManagementRequest(
        relayRequest("/api/codex-auth/accounts", { headers: { [HUB_RELAY_EXPECTED_TARGET_HEADER]: value } }),
        "/api/codex-auth/accounts",
        target,
        { fetchImpl: (async () => Response.json({ ok: true })) as typeof fetch },
      );
      expect(response.status).toBe(400);
    }
  });

  test("forwarding uses the target snapshot captured at call time", async () => {
    const mutable = { ...target };
    let capturedUrl = "";
    const response = await relayHubManagementRequest(
      relayRequest("/api/codex-auth/accounts", { headers: { [HUB_RELAY_EXPECTED_TARGET_HEADER]: "https://hub.example.test" } }),
      "/api/codex-auth/accounts",
      mutable,
      { fetchImpl: (async (input) => {
        mutable.managementUrl = "https://other.example.test";
        capturedUrl = String(input);
        return Response.json({ ok: true });
      }) as typeof fetch },
    );
    expect(response.status).toBe(200);
    expect(capturedUrl).toBe("https://hub.example.test/api/hub-relay/read/api/codex-auth/accounts");
  });

  test("stamps the scoped credential and enrollment proof for an admitted local administrator", async () => {
    // The listener has already admitted the local administrator.
    let captured: { headers: Headers } | null = null;
    const response = await relayHubManagementRequest(
      new Request("http://127.0.0.1:10100/api/codex-auth/accounts"),
      "/api/codex-auth/accounts",
      { managementUrl: "https://hub.example.test", browserOrigin: "" },
      {
        readCredential: () => scoped,
        fetchImpl: (async (_input, init) => {
          captured = { headers: new Headers(init?.headers) };
          return Response.json({ accounts: [] });
        }) as typeof fetch,
      },
    );
    expect(response.status).toBe(200);
    expect(captured!.headers.get("x-opencodex-api-key")).toBe(scoped.token);
    expect(captured!.headers.get("x-opencodex-hub-enrollment-id")).toBe(scoped.keyId);
    expect(captured!.headers.get("x-opencodex-hub-enrollment-proof")).toBe(scoped.proof);
    expect(captured!.headers.get("x-opencodex-hub-proof-time")).toBe(scoped.at);
    expect(captured!.headers.get("origin")).toBeNull();
    expect(captured!.headers.get("x-opencodex-gui-origin")).toBeNull();
    expect(captured!.headers.get("x-opencodex-csrf-token")).toBeNull();
  });

  test("refuses a missing relay credential without forwarding the local administrator's token", async () => {
    let upstreamCalls = 0;
    const response = await relayHubManagementRequest(
      new Request("http://127.0.0.1:10100/api/codex-auth/accounts", {
        headers: { "x-opencodex-api-key": `ocx_admin_${"l".repeat(43)}` },
      }),
      "/api/codex-auth/accounts",
      target,
      {
        readCredential: () => null,
        fetchImpl: (async () => {
          upstreamCalls++;
          return Response.json({ unexpected: true });
        }) as typeof fetch,
      },
    );
    expect({ status: response.status, upstreamCalls }).toEqual({ status: 401, upstreamCalls: 0 });
  });

  test("passes through a browser's own hub credential without requesting stored authority", async () => {
    let captured: Headers | null = null;
    await relayHubManagementRequest(relayRequest("/api/usage"), "/api/usage", target, {
      fetchImpl: (async (_input, init) => {
        captured = new Headers(init?.headers);
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    expect(captured!.get("x-opencodex-api-key")).toBe("ocx_session_hub");
  });

  test("replaces this machine's own admin token, which the hub does not know", async () => {
    // The CLI attaches the LOCAL config home's admin token. It is meaningless upstream, so a
    // naive "caller already sent one" check would leave it in place and the hub would 401.
    let captured: Headers | null = null;
    await relayHubManagementRequest(
      new Request("http://127.0.0.1:10100/api/codex-auth/accounts", {
        headers: { "x-opencodex-api-key": `ocx_admin_${"l".repeat(43)}` },
      }),
      "/api/codex-auth/accounts",
      { managementUrl: "https://hub.example.test", browserOrigin: "" },
      {
        readCredential: () => scoped,
        fetchImpl: (async (_input, init) => {
          captured = new Headers(init?.headers);
          return Response.json({ accounts: [] });
        }) as typeof fetch,
      },
    );
    expect(captured!.get("x-opencodex-api-key")).toBe(scoped.token);
    expect(captured!.get("origin")).toBeNull();
  });

  test("reaches the Hub for a CLI without a browser Origin", async () => {
    let captured: Headers | null = null;
    const response = await relayHubManagementRequest(
      new Request("http://127.0.0.1:18100/api/codex-auth/accounts"),
      "/api/codex-auth/accounts",
      { managementUrl: "https://hub.example.test", browserOrigin: "" },
      {
        readCredential: () => scoped,
        fetchImpl: (async (_input, init) => {
          captured = new Headers(init?.headers);
          return Response.json({ accounts: [] });
        }) as typeof fetch,
      },
    );
    expect(response.status).toBe(200);
    expect(captured!.get("origin")).toBeNull();
  });

  test.each([
    ["POST", "/api/github/star"],
    ["POST", "/api/github/st%61r"],
    ["GET", "/api/system"],
    ["GET", "/api/system/health"],
    ["POST", "/api/system/restart"],
    ["GET", "/api/keys"],
    ["POST", "/api/keys/reveal"],
    ["POST", "/api/keys/rotate/commit"],
    ["GET", "/api/key-providers"],
    ["GET", "/api/providers/keys"],
    ["POST", "/api/providers/keychain"],
    ["POST", "/api/session/remember"],
    ["PUT", "/api/telemetry"],
    ["POST", "/api/telemetry/profile"],
  ])("refuses %s %s before it reaches the hub", async (method, path) => {
    let upstreamCalls = 0;
    const response = await relayHubManagementRequest(
      relayRequest(path, { method, headers: { Origin: target.browserOrigin } }), path, target, {
        fetchImpl: (async () => {
          upstreamCalls++;
          return Response.json({ unexpected: true });
        }) as typeof fetch,
      },
    );
    expect({ status: response.status, upstreamCalls }).toEqual({ status: 404, upstreamCalls: 0 });
  });

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
    expect(captured!.url).toBe("https://hub.example.test/api/hub-relay/read/api/usage?range=all");
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
      const response = await relayHubManagementRequest(relayRequest("/api/codex-auth/accounts"), suffix, target, { fetchImpl });
      expect(response.status).toBe(404);
    }
    expect(calls).toBe(0);
  });

  test("rejects redirects, request and response overflow, and timeout without exposing bodies", async () => {
    const redirected = await relayHubManagementRequest(relayRequest("/api/codex-auth/accounts"), "/api/codex-auth/accounts", target, {
      fetchImpl: (async () => new Response(null, { status: 302, headers: { Location: "https://evil.example" } })) as typeof fetch,
    });
    expect(redirected.status).toBe(502);

    const oversizedRequest = relayRequest("/opencodex-session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(HUB_RELAY_REQUEST_BODY_MAX_BYTES + 1) },
      body: "{}",
    });
    let calls = 0;
    expect((await relayHubManagementRequest(oversizedRequest, "/opencodex-session", target, {
      fetchImpl: (async () => { calls += 1; return new Response(); }) as typeof fetch,
    })).status).toBe(413);
    expect(calls).toBe(0);

    const oversizedResponse = await relayHubManagementRequest(relayRequest("/api/codex-auth/accounts"), "/api/codex-auth/accounts", target, {
      fetchImpl: (async () => new Response("x", { headers: { "Content-Length": String(HUB_RELAY_RESPONSE_BODY_MAX_BYTES + 1) } })) as typeof fetch,
    });
    expect(oversizedResponse.status).toBe(502);

    const timedOut = await relayHubManagementRequest(relayRequest("/api/codex-auth/accounts"), "/api/codex-auth/accounts", target, {
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
    const response = await relayHubManagementRequest(relayRequest("/api/codex-auth/accounts"), "/api/codex-auth/accounts", target, {
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

  test("refuses account event streams before the upstream request", async () => {
    let calls = 0;
    const path = "/api/accounts/events";
    const response = await relayHubManagementRequest(relayRequest(path), path, target, {
      fetchImpl: (async () => { calls++; return new Response(); }) as typeof fetch,
    });
    expect({ status: response.status, calls }).toEqual({ status: 404, calls: 0 });
  });

  test.each([
    ["/api/codex-auth/accounts", "GET", 200, "application/json"],
    ["/api/usage", "GET", 200, "text/event-stream"],
    ["/api/usage", "GET", 401, "application/json"],
    ["/opencodex-session", "POST", 200, "text/html"],
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

  test("relay has a handshake deadline and a streamed response body cap", async () => {
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let handshakeStarted!: () => void;
    const started = new Promise<void>(resolve => { handshakeStarted = resolve; });
    try {
      const pending = relayHubManagementRequest(relayRequest("/api/usage"), "/api/usage", target, {
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
    const response = await relayHubManagementRequest(relayRequest("/api/usage"), "/api/usage", target, {
      fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(HUB_RELAY_RESPONSE_BODY_MAX_BYTES + 1)); },
        cancel() { cancelled = true; },
      }), { headers: { "Content-Type": "application/json" } })) as typeof fetch,
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
      const response = await relayHubManagementRequest(relayRequest("/api/codex-auth/accounts", { signal: browser.signal }), "/api/codex-auth/accounts", target, {
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
