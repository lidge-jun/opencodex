import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { writeServiceApiTokenFile } from "../../src/lib/service-secrets";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../../src/server/auth-cors";
import {
  loadVoiceRelayCredential,
  startVoiceRelay,
  VOICE_RELAY_BODY_MAX_BYTES,
  voiceRelayWebSocketRouteAllowed,
  type VoiceRelayCredential,
} from "../../src/client/voice-relay";
import type { OcxClientConnectionConfig } from "../../src/types";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const servers: Array<{ stop(force?: boolean): void | Promise<void> }> = [];
const previousHome = process.env.OPENCODEX_HOME;
const NATIVE_OAUTH_BEARER = ["Bearer", "native-oauth-access-token"].join(" ");

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.stop(true);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});

function connected(serverUrl: string, token = "ocx_data_fixture-secret"): VoiceRelayCredential {
  const connection: OcxClientConnectionConfig = {
    serverUrl,
    managementUrl: serverUrl,
    managementTransport: "direct",
    selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "fixture-key",
    tokenFingerprint: "fixture-fingerprint",
    protocolVersion: 1,
    connectedAt: "2026-09-08T00:00:00.000Z",
    catalogFingerprint: "fixture-catalog",
    priorCatalog: "",
    catalogSyncedAt: "2026-09-08T00:00:00.000Z",
  };
  return { connection, token };
}

function ws(url: string, headers: Record<string, string> = {}): WebSocket {
  return new WebSocket(url, { headers } as unknown as string[]);
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket open timeout")), 5_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("websocket open failed")); }, { once: true });
  });
}

function message(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), 5_000);
    socket.addEventListener("message", event => {
      clearTimeout(timer);
      resolve(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
    }, { once: true });
  });
}

function rawMessage(socket: WebSocket): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), 5_000);
    socket.addEventListener("message", event => { clearTimeout(timer); resolve(event.data as string | ArrayBuffer); }, { once: true });
  });
}

function liveForwardingGuard(headers: Headers, config: ReturnType<typeof getDefaultConfig>): Response | null {
  try {
    validateForwardAdmissionCredential(headers, config);
    return null;
  } catch (error) {
    if (error instanceof ForwardAdmissionCredentialError) {
      return Response.json({ error: { type: "authentication_error", message: error.message } }, { status: 401 });
    }
    throw error;
  }
}

describe("remote hub voice relay", () => {
  test("parser admits exact call routes and gates standalone sessions", () => {
    for (const value of [
      "http://127.0.0.1:10111/v1/live/call_1",
      "http://127.0.0.1:10111/v1/realtime/calls/call-2",
      "http://127.0.0.1:10111/v1/realtime?call_id=call_3",
    ]) expect(voiceRelayWebSocketRouteAllowed(new URL(value))).toBe(true);
    for (const value of [
      "http://127.0.0.1:10111/v1/live",
      "http://127.0.0.1:10111/v1/realtime?model=gpt-realtime",
      "http://127.0.0.1:10111/v1/live/call/extra",
      "http://127.0.0.1:10111/v1/realtime/calls",
      "http://127.0.0.1:10111/v1/liveevil/call_1",
    ]) expect(voiceRelayWebSocketRouteAllowed(new URL(value))).toBe(false);
    expect(voiceRelayWebSocketRouteAllowed(new URL("http://127.0.0.1:10111/v1/live?model=gpt"), true)).toBe(true);
    expect(voiceRelayWebSocketRouteAllowed(new URL("http://127.0.0.1:10111/v1/realtime?model=gpt"), true)).toBe(true);
  });

  test("fake hub receives exact HTTP route, body, protocol header, and connected data credential", async () => {
    const seen: Array<{ path: string; method: string; key: string | null; authorization: string | null; body: string }> = [];
    const hub = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: `${url.pathname}${url.search}`, method: req.method, key: req.headers.get("x-opencodex-api-key"), authorization: req.headers.get("authorization"), body: await req.text() });
        return new Response("answer", { status: 201, headers: { "Content-Type": "application/sdp", "Set-Cookie": "private=1" } });
      },
    });
    servers.push(hub);
    const relay = startVoiceRelay({ port: 0, credential: connected(hub.url.origin), connectionCheck: () => true });
    servers.push({ stop: () => relay.stop() });
    const response = await fetch(`${relay.origin}/v1/realtime/calls?intent=quicksilver`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${relay.port}`,
        Origin: relay.origin,
        Authorization: "Bearer caller-secret",
        "X-OpenCodex-API-Key": "caller-admission",
        "OpenAI-Alpha": "quicksilver=v2",
        "Content-Type": "application/sdp",
      },
      body: "offer",
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("answer");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(seen).toEqual([{
      path: "/v1/realtime/calls?intent=quicksilver", method: "POST",
      key: "ocx_data_fixture-secret", authorization: "Bearer caller-secret", body: "offer",
    }]);
  }, SERVER_BUDGET_MS);

  test("HTTP removes hub admission bearers before the real forwarding guard", async () => {
    const connectedToken = "legacy-connected-token";
    const config = getDefaultConfig();
    config.apiKeys = [{ id: "voice-relay", name: "voice relay", key: connectedToken }];
    const seen: Array<{ authorization: string | null; key: string | null; account: string | null }> = [];
    const hub = Bun.serve({
      port: 0,
      fetch(req) {
        const rejected = liveForwardingGuard(req.headers, config);
        if (rejected) return rejected;
        seen.push({
          authorization: req.headers.get("authorization"),
          key: req.headers.get("x-opencodex-api-key"),
          account: req.headers.get("chatgpt-account-id"),
        });
        return new Response("answer", { status: 201 });
      },
    });
    servers.push(hub);
    const relay = startVoiceRelay({
      port: 0,
      credential: connected(hub.url.origin, connectedToken),
      connectionCheck: () => true,
    });
    servers.push({ stop: () => relay.stop() });

    const admissionBearers = [
      connectedToken,
      `ocx_data_${"a".repeat(40)}`,
      `ocx_admin_${"b".repeat(40)}`,
      `ocx_session_${"c".repeat(40)}`,
      `ocx_${"d".repeat(40)}`,
    ];
    for (const bearer of admissionBearers) {
      const response = await fetch(`${relay.origin}/v1/live`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}` },
        body: "offer",
      });
      expect(response.status).toBe(201);
    }
    const oauth = await fetch(`${relay.origin}/v1/live`, {
      method: "POST",
      headers: { Authorization: NATIVE_OAUTH_BEARER, "ChatGPT-Account-ID": "acct-1" },
      body: "offer",
    });
    expect(oauth.status).toBe(201);
    expect(seen).toEqual([
      ...admissionBearers.map(() => ({ authorization: null, key: connectedToken, account: null })),
      { authorization: NATIVE_OAUTH_BEARER, key: connectedToken, account: "acct-1" },
    ]);
  }, SERVER_BUDGET_MS);

  test("wrong methods, prefix variants, Host, and browser Origin fail before hub I/O", async () => {
    let calls = 0;
    const relay = startVoiceRelay({
      port: 0,
      credential: connected("https://hub.example.test"),
      connectionCheck: () => true,
      fetchImpl: (async () => { calls += 1; return new Response(); }) as typeof fetch,
    });
    servers.push({ stop: () => relay.stop() });
    const request = (path: string, init: RequestInit) => fetch(`${relay.origin}${path}`, init);
    expect((await request("/v1/live", { method: "GET" })).status).toBe(404);
    expect((await request("/v1/liveevil", { method: "POST", body: "x" })).status).toBe(404);
    expect((await request("/v1/realtime/calls/id", { method: "POST", body: "x" })).status).toBe(404);
    expect((await request("/v1/live", { method: "POST", headers: { Host: "evil.example" }, body: "x" })).status).toBe(403);
    expect((await request("/v1/live", { method: "POST", headers: { Origin: "https://evil.example" }, body: "x" })).status).toBe(403);
    expect(calls).toBe(0);
  }, SERVER_BUDGET_MS);

  test("request limit, redirect refusal, connection deadline, and ownership drift are bounded", async () => {
    let calls = 0;
    const relay = startVoiceRelay({
      port: 0,
      credential: connected("https://hub.example.test"),
      connectionCheck: () => true,
      connectTimeoutMs: 10,
      fetchImpl: (async (_input, init) => {
        calls += 1;
        if (calls === 1) return new Response(null, { status: 302, headers: { Location: "https://evil.example" } });
        return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
      }) as typeof fetch,
    });
    servers.push({ stop: () => relay.stop() });
    const tooLarge = await fetch(`${relay.origin}/v1/live`, {
      method: "POST",
      body: new Uint8Array(VOICE_RELAY_BODY_MAX_BYTES + 1),
    });
    expect(tooLarge.status).toBe(413);
    expect(calls).toBe(0);
    expect((await fetch(`${relay.origin}/v1/live`, { method: "POST", body: "x" })).status).toBe(502);
    expect((await fetch(`${relay.origin}/v1/live`, { method: "POST", body: "x" })).status).toBe(504);

    let owned = true;
    const drift = startVoiceRelay({ port: 0, credential: connected("https://hub.example.test"), connectionCheck: () => owned, monitorIntervalMs: 5 });
    servers.push({ stop: () => drift.stop() });
    owned = false;
    expect(await drift.done).toBe("connection_changed");
  }, SERVER_BUDGET_MS);

  test("fake hub WebSocket gets credential, relays frames, rejects Origin, and closes peer", async () => {
    let hubKey: string | null = null;
    let hubAuthorization: string | null = null;
    let hubPath = "";
    let hubClosed = false;
    const hub = Bun.serve({
      port: 0,
      fetch(req, server) {
        hubKey = req.headers.get("x-opencodex-api-key");
        hubAuthorization = req.headers.get("authorization");
        const url = new URL(req.url);
        hubPath = `${url.pathname}${url.search}`;
        if (server.upgrade(req, { data: {} })) return;
        return new Response("upgrade failed", { status: 426 });
      },
      websocket: {
        open(socket) { socket.send("hub-ready"); },
        message(socket, value) {
          if (typeof value === "string") socket.send(`echo:${value}`);
          else socket.send(value);
        },
        close() { hubClosed = true; },
      },
    });
    servers.push(hub);
    const relay = startVoiceRelay({ port: 0, credential: connected(hub.url.origin), connectionCheck: () => true });
    servers.push({ stop: () => relay.stop() });
    const target = relay.origin.replace(/^http/, "ws") + "/v1/live/call_1?token=drop-me&extension=keep";
    const rejected = ws(target, { Origin: "https://evil.example" });
    await expect(opened(rejected)).rejects.toThrow();
    const socket = ws(target, { Origin: relay.origin, Authorization: "Bearer caller-secret" });
    socket.binaryType = "arraybuffer";
    await opened(socket);
    expect(await message(socket)).toBe("hub-ready");
    socket.send("hello");
    expect(await message(socket)).toBe("echo:hello");
    socket.send(Uint8Array.from([0, 127, 128, 255]));
    expect(Array.from(new Uint8Array(await rawMessage(socket) as ArrayBuffer))).toEqual([0, 127, 128, 255]);
    expect(hubKey).toBe("ocx_data_fixture-secret");
    expect(hubAuthorization).toBe("Bearer caller-secret");
    expect(hubPath).toBe("/v1/live/call_1?extension=keep");
    socket.close();
    for (let i = 0; i < 50 && !hubClosed; i += 1) await Bun.sleep(10);
    expect(hubClosed).toBe(true);
  }, SERVER_BUDGET_MS);

  test("WebSocket removes hub admission bearers before the real forwarding guard", async () => {
    const connectedToken = "legacy-connected-token";
    const config = getDefaultConfig();
    config.apiKeys = [{ id: "voice-relay", name: "voice relay", key: connectedToken }];
    const seen: Array<{ authorization: string | null; key: string | null; account: string | null }> = [];
    const hub = Bun.serve({
      port: 0,
      fetch(req, server) {
        const rejected = liveForwardingGuard(req.headers, config);
        if (rejected) return rejected;
        seen.push({
          authorization: req.headers.get("authorization"),
          key: req.headers.get("x-opencodex-api-key"),
          account: req.headers.get("chatgpt-account-id"),
        });
        if (server.upgrade(req, { data: {} })) return;
        return new Response("upgrade failed", { status: 426 });
      },
      websocket: { open(socket) { socket.send("ready"); } },
    });
    servers.push(hub);
    const relay = startVoiceRelay({
      port: 0,
      credential: connected(hub.url.origin, connectedToken),
      connectionCheck: () => true,
    });
    servers.push({ stop: () => relay.stop() });

    const admissionBearers = [
      connectedToken,
      `ocx_data_${"a".repeat(40)}`,
      `ocx_admin_${"b".repeat(40)}`,
      `ocx_session_${"c".repeat(40)}`,
      `ocx_${"d".repeat(40)}`,
    ];
    for (const bearer of admissionBearers) {
      const socket = ws(`${relay.origin.replace(/^http/, "ws")}/v1/live/call_1`, {
        Authorization: `Bearer ${bearer}`,
      });
      await opened(socket);
      expect(await message(socket)).toBe("ready");
      socket.close();
    }
    const oauth = ws(`${relay.origin.replace(/^http/, "ws")}/v1/live/call_1`, {
      Authorization: NATIVE_OAUTH_BEARER,
      "ChatGPT-Account-ID": "acct-1",
    });
    await opened(oauth);
    expect(await message(oauth)).toBe("ready");
    oauth.close();
    expect(seen).toEqual([
      ...admissionBearers.map(() => ({ authorization: null, key: connectedToken, account: null })),
      { authorization: NATIVE_OAUTH_BEARER, key: connectedToken, account: "acct-1" },
    ]);
  }, SERVER_BUDGET_MS);

  test("WebSocket handshake timeout closes a connecting upstream peer", async () => {
    class PendingSocket extends EventTarget {
      readyState = WebSocket.CONNECTING;
      closes = 0;
      terminates = 0;
      send(): void {}
      close(): void { this.closes += 1; this.readyState = WebSocket.CLOSING; }
      terminate(): void { this.terminates += 1; this.readyState = WebSocket.CLOSED; }
    }
    const pending = new PendingSocket();
    const relay = startVoiceRelay({
      port: 0,
      credential: connected("https://hub.example.test"),
      connectionCheck: () => true,
      connectTimeoutMs: 5,
      closeFallbackMs: 5,
      webSocketFactory: () => pending as unknown as WebSocket,
    });
    servers.push({ stop: () => relay.stop() });
    const socket = ws(relay.origin.replace(/^http/, "ws") + "/v1/live/call_1");
    await opened(socket);
    await new Promise<void>(resolve => socket.addEventListener("close", () => resolve(), { once: true }));
    for (let i = 0; i < 50 && pending.terminates === 0; i += 1) await Bun.sleep(2);
    expect(pending.closes).toBeGreaterThan(0);
    expect(pending.terminates).toBeGreaterThan(0);
  }, SERVER_BUDGET_MS);

  test("default credential loader fails closed for missing and mismatched owner state", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-voice-relay-credential-"));
    process.env.OPENCODEX_HOME = home;
    try {
      expect(() => loadVoiceRelayCredential()).toThrow("requires a complete");
      const fixture = connected("https://hub.example.test").connection;
      fixture.tokenFingerprint = createHash("sha256").update("ocx_data_expected-owner").digest("hex");
      fixture.catalogFingerprint = createHash("sha256").update("fixture-catalog").digest("base64url");
      saveConfig({ port: 10100, providers: {}, defaultProvider: "openai", runtimeRole: "client", client: fixture });
      expect(() => loadVoiceRelayCredential()).toThrow("missing or no longer owned");
      writeServiceApiTokenFile("ocx_data_wrong-owner");
      expect(() => loadVoiceRelayCredential()).toThrow("missing or no longer owned");
    } finally {
      removeTreeWithRetry(home);
    }
  });
});
