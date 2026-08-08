import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { resetMainCodexAccountIdentityTrackingForTests } from "../src/codex/account-lifecycle";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import { clearMainAccountInfoCache } from "../src/codex/main-account-cache";
import { clearAccountQuota, updateAccountQuota } from "../src/codex/quota";
import { clearThreadAccountMap } from "../src/codex/routing";
import { saveConfig } from "../src/config";
import { handleNativeProfileAPI } from "../src/codex/native-profile-api";
import { CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE } from "../src/codex/auth-context";
import type { NativeProfileManager } from "../src/codex/native-profile-manager";
import { waitForNativeMainStartupGate } from "../src/codex/native-profile-startup";
import { startServer } from "../src/server";
import {
  acquireNativeMainProfileDrain,
  getNativeMainProfileRequestCount,
  resetLifecycleDrainStateForTests,
} from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
let opencodexHome = "";
let codexHome = "";

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-main-drain-server-"));
  codexHome = mkdtempSync(join(tmpdir(), "ocx-main-drain-codex-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  process.env.CODEX_HOME = codexHome;
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "main-access", account_id: "main-account" } }),
  );
  clearAccountQuota();
  clearThreadAccountMap();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetLifecycleDrainStateForTests();
  clearAccountQuota();
  clearThreadAccountMap();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  if (opencodexHome) rmSync(opencodexHome, { recursive: true, force: true });
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

describe("native main profile scoped server admission", () => {
  test("HTTP and Responses WebSocket keep Direct live while main Pool frames are rejected", async () => {
    let upstreamRequests = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("chatgpt.com/backend-api/codex/responses")) {
        upstreamRequests += 1;
        return new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const saveMode = (codexAccountMode: "direct" | "pool") => saveConfig({
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      websockets: true,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode,
        },
      },
      codexAccounts: [],
      activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
      autoSwitchThreshold: 0,
    } as OcxConfig);
    const waitForFrame = (ws: WebSocket, needle: string) => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`websocket timeout waiting for ${needle}`)), 2_000);
      const onMessage = (event: MessageEvent) => {
        const text = typeof event.data === "string" ? event.data : "";
        if (!text.includes(needle)) return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(text);
      };
      ws.addEventListener("message", onMessage);
    });

    saveMode("direct");
    let server: ReturnType<typeof startServer> | undefined = startServer(0);
    const drain = acquireNativeMainProfileDrain("test-switch");
    expect(drain).not.toBeNull();
    try {
      const directHttp = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: true }),
      });
      expect(directHttp.status).toBe(200);
      await directHttp.text();

      const wsUrl = new URL("/v1/responses", server.url);
      wsUrl.protocol = "ws:";
      const directWs = new WebSocket(wsUrl, { headers: { authorization: "Bearer caller-token" } } as unknown as string[]);
      await new Promise<void>((resolve, reject) => {
        directWs.addEventListener("open", () => resolve(), { once: true });
        directWs.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
      });
      const directTerminal = waitForFrame(directWs, "response.completed");
      directWs.send(JSON.stringify({ type: "response.create", model: "gpt-test", input: "hello" }));
      await directTerminal;
      directWs.close();
      await server.stop(true);
      server = undefined;

      saveMode("pool");
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 1, 1);
      server = startServer(0);
      await waitForNativeMainStartupGate();
      const mainHttp = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
      });
      expect(mainHttp.status).toBe(503);
      expect(mainHttp.headers.get("retry-after")).toBe("1");

      const mainWsUrl = new URL("/v1/responses", server.url);
      mainWsUrl.protocol = "ws:";
      const mainWs = new WebSocket(mainWsUrl, { headers: { authorization: "Bearer caller-token" } } as unknown as string[]);
      await new Promise<void>((resolve, reject) => {
        mainWs.addEventListener("open", () => resolve(), { once: true });
        mainWs.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
      });
      const mainRejected = waitForFrame(mainWs, CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE);
      mainWs.send(JSON.stringify({ type: "response.create", model: "gpt-test", input: "hello" }));
      expect(await mainRejected).toContain("503");
      mainWs.close();

      expect(upstreamRequests).toBe(2);
    } finally {
      drain?.release();
      await server?.stop(true);
    }
  });

  test("Live/Realtime sideband retains main ownership while Direct and non-main Pool continue", async () => {
    let upstreamConnections = 0;
    let upstreamCloses = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
          return new Response("upgrade failed", { status: 500 });
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open() { upstreamConnections += 1; },
        message(ws, message) { ws.send(`echo:${String(message)}`); },
        close() { upstreamCloses += 1; },
      },
    });
    const waitUntil = async (condition: () => boolean): Promise<void> => {
      const deadline = Date.now() + 2_000;
      while (!condition() && Date.now() < deadline) await Bun.sleep(10);
    };
    const liveProvider = (codexAccountMode: "direct" | "pool") => ({
      adapter: "openai-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward" as const,
      codexAccountMode,
    });
    const saveMode = (codexAccountMode: "direct" | "pool", activeCodexAccountId: string) => saveConfig({
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: { openai: liveProvider(codexAccountMode) },
      activeCodexAccountId,
      autoSwitchThreshold: 0,
      codexAccounts: activeCodexAccountId === "pool-a"
        ? [
            { id: "main", email: "main@example.test", isMain: true },
            { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool-account" },
          ]
        : [],
      experimentalRealtimeWsBaseUrl: upstream.url.toString(),
    } as OcxConfig);
    const connectEcho = async (
      server: ReturnType<typeof startServer>,
      path: string,
      headers: Record<string, string> = {},
    ): Promise<WebSocket> => {
      const url = new URL(path, server.url);
      url.protocol = "ws:";
      const ws = new WebSocket(url, { headers } as unknown as string[]);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("sideband echo timeout")), 5_000);
        ws.addEventListener("open", () => ws.send("ping"), { once: true });
        ws.addEventListener("message", event => {
          if (String(event.data) !== "echo:ping") return;
          clearTimeout(timer);
          resolve();
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("sideband websocket error"));
        }, { once: true });
      });
      return ws;
    };
    const closeSocket = async (ws: WebSocket): Promise<number> => {
      if (ws.readyState === WebSocket.CLOSED) return getNativeMainProfileRequestCount();
      let requestCountAtDownstreamClose = -1;
      const closed = new Promise<void>(resolve => ws.addEventListener("close", () => {
        requestCountAtDownstreamClose = getNativeMainProfileRequestCount();
        resolve();
      }, { once: true }));
      ws.close();
      await closed;
      await waitUntil(() => getNativeMainProfileRequestCount() === 0);
      return requestCountAtDownstreamClose;
    };
    const handshakeStatus = (server: ReturnType<typeof startServer>, path: string) => new Promise<number>((resolve, reject) => {
      const url = new URL(path, server.url);
      const request = httpRequest({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
      }, response => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("upgrade", (_response, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.on("error", reject);
      request.end();
    });
    const switchRequest = () => new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });
    let switches = 0;
    const manager = { switch: async () => { switches += 1; return { ok: true }; } } as unknown as NativeProfileManager;
    let server: ReturnType<typeof startServer> | undefined;
    let client: WebSocket | undefined;
    try {
      saveMode("pool", MAIN_CODEX_ACCOUNT_ID);
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 1, 1);
      server = startServer(0);
      await waitForNativeMainStartupGate();
      client = await connectEcho(server, "/v1/live/main-pre-fence");
      expect(getNativeMainProfileRequestCount()).toBe(1);
      const blocked = await handleNativeProfileAPI(
        switchRequest(),
        new URL("http://localhost/api/native-main-profiles/switch"),
        {} as OcxConfig,
        { manager, drainTimeoutMs: 0 },
      );
      expect(blocked?.status).toBe(409);
      expect(switches).toBe(0);
      // The proxy must still own native-main at the downstream close boundary,
      // then release only after the mock authenticated upstream closes.
      expect(await closeSocket(client)).toBe(1);
      client = undefined;
      await waitUntil(() => upstreamCloses >= 1);
      expect(upstreamCloses).toBe(1);
      expect(getNativeMainProfileRequestCount()).toBe(0);
      const afterClose = await handleNativeProfileAPI(
        switchRequest(),
        new URL("http://localhost/api/native-main-profiles/switch"),
        {} as OcxConfig,
        { manager, drainTimeoutMs: 0 },
      );
      expect(afterClose?.status).toBe(200);
      expect(switches).toBe(1);

      const mainDrain = acquireNativeMainProfileDrain("new-main-sideband");
      expect(mainDrain).not.toBeNull();
      expect(await handshakeStatus(server, "/v1/realtime?call_id=main-post-fence")).toBe(503);
      expect(upstreamConnections).toBe(1);
      mainDrain?.release();
      await server.stop(true);
      server = undefined;

      saveMode("direct", MAIN_CODEX_ACCOUNT_ID);
      server = startServer(0);
      const directDrain = acquireNativeMainProfileDrain("direct-sideband");
      const directToken = fakeChatGptJwt({ chatgpt_account_id: "direct-account" });
      client = await connectEcho(server, "/v1/live/direct", {
        authorization: `Bearer ${directToken}`,
        "chatgpt-account-id": "direct-account",
      });
      expect(getNativeMainProfileRequestCount()).toBe(0);
      directDrain?.release();
      await closeSocket(client);
      client = undefined;
      await server.stop(true);
      server = undefined;

      saveCodexAccountCredential("pool-a", {
        accessToken: "pool-access",
        refreshToken: "pool-refresh",
        expiresAt: Date.now() + 3_600_000,
        chatgptAccountId: "pool-account",
      });
      updateAccountQuota("pool-a", 1, 1);
      saveMode("pool", "pool-a");
      server = startServer(0);
      const poolDrain = acquireNativeMainProfileDrain("pool-sideband");
      client = await connectEcho(server, "/v1/realtime/calls/pool");
      expect(getNativeMainProfileRequestCount()).toBe(0);
      poolDrain?.release();
      await closeSocket(client);
      client = undefined;
      expect(upstreamConnections).toBe(3);
    } finally {
      if (client) await closeSocket(client).catch(() => {});
      await server?.stop(true);
      await upstream.stop(true);
    }
  });

  test("uncooperative Live sideband keeps main ownership through close fallback and switch timeout", async () => {
    class UncooperativeUpstream extends EventTarget {
      readyState = WebSocket.CONNECTING;
      closeCalls = 0;

      open(): void {
        this.readyState = WebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      }

      send(): void {}

      close(): void {
        this.closeCalls += 1;
        this.readyState = WebSocket.CLOSING;
      }

      finishClose(): void {
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "test cleanup" }));
      }
    }

    saveConfig({
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
      autoSwitchThreshold: 0,
      codexAccounts: [],
      experimentalRealtimeWsBaseUrl: "ws://uncooperative.invalid/",
    } as OcxConfig);
    updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 1, 1);

    let upstream: UncooperativeUpstream | undefined;
    let switches = 0;
    const manager = {
      switch: async () => {
        switches += 1;
        return { ok: true };
      },
    } as unknown as NativeProfileManager;
    const server = startServer(0, {
      liveSidebandWebSocketFactory: () => {
        upstream = new UncooperativeUpstream();
        queueMicrotask(() => upstream?.open());
        return upstream as unknown as WebSocket;
      },
    });
    await waitForNativeMainStartupGate();
    const url = new URL("/v1/live/uncooperative", server.url);
    url.protocol = "ws:";
    const client = new WebSocket(url);

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("sideband websocket open timeout")), 2_000);
        client.addEventListener("open", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        client.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("sideband websocket failed to open"));
        }, { once: true });
      });
      await Bun.sleep(0);
      expect(upstream?.readyState).toBe(WebSocket.OPEN);
      expect(getNativeMainProfileRequestCount()).toBe(1);

      await new Promise<void>(resolve => {
        client.addEventListener("close", () => resolve(), { once: true });
        client.close();
      });
      await Bun.sleep(1_100);
      expect(upstream?.closeCalls).toBe(2);
      expect(upstream?.readyState).toBe(WebSocket.CLOSING);
      expect(getNativeMainProfileRequestCount()).toBe(1);

      const blocked = await handleNativeProfileAPI(
        new Request("http://localhost/api/native-main-profiles/switch", {
          method: "POST",
          body: JSON.stringify({ target: "target", confirmedStopped: true }),
        }),
        new URL("http://localhost/api/native-main-profiles/switch"),
        {} as OcxConfig,
        { manager, drainTimeoutMs: 75 },
      );
      expect(blocked?.status).toBe(409);
      expect(switches).toBe(0);
      expect(getNativeMainProfileRequestCount()).toBe(1);

      upstream?.finishClose();
      await Bun.sleep(0);
      expect(getNativeMainProfileRequestCount()).toBe(0);
      upstream?.finishClose();
      expect(getNativeMainProfileRequestCount()).toBe(0);
    } finally {
      upstream?.finishClose();
      await server.stop(true);
    }
  });
});
