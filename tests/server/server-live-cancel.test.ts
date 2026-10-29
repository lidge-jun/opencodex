/**
 * Client cancellation of a live-sideband join: the admission lease belongs to the upstream
 * transport, so a caller that disconnects while the upstream handshake is pending must not
 * release it before that transport has actually closed. Before any transport exists, the same
 * cancellation must retire the turn at once.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import * as accountStore from "../../src/codex/account-store";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { activeRegistryMetrics } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const TEST_DIR = join(import.meta.dir, ".tmp-server-live-cancel-test");
const DIRECT_CHATGPT_TOKEN = fakeChatGptJwt({ chatgpt_account_id: "acct-123" });
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-live-cancel-codex-");
});

afterEach(() => {
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

/** A sideband upstream that stays CONNECTING and only reaches CLOSED when the test says so. */
class PendingUpstreamSocket {
  private readonly listeners = new Map<string, Array<(event: { code?: number; reason?: string }) => void>>();
  readyState: number = WebSocket.CONNECTING;
  closeCalls = 0;
  private readonly closeRequested = Promise.withResolvers<void>();
  readonly closeRequestedPromise = this.closeRequested.promise;

  addEventListener(type: string, listener: (event: { code?: number; reason?: string }) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: { code?: number; reason?: string }) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry !== listener));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = WebSocket.CLOSING;
    this.closeRequested.resolve();
  }

  finishClose(): void {
    this.readyState = WebSocket.CLOSED;
    for (const listener of this.listeners.get("close") ?? []) listener({ code: 1006, reason: "closed after cancellation" });
  }
}

function forwardConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

function withDeadline<T>(promise: Promise<T>, message: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

test("a client that cancels a pending sideband join keeps admission until the upstream closes", async () => {
  saveConfig(forwardConfig());
  const upstream = new PendingUpstreamSocket();
  const dialed = Promise.withResolvers<void>();
  const server = startServer(0, {
    inspectNativeCodexOwnership: ownedServiceHomeInspection("server-live-cancel fixture"),
    liveSidebandWebSocketFactory: () => {
      dialed.resolve();
      return upstream as unknown as WebSocket;
    },
  });
  const activeTurnsBefore = activeRegistryMetrics().activeTurns.active;
  const client = connect(Number(server.port), "127.0.0.1");
  client.on("error", () => {});
  try {
    await withDeadline(new Promise<void>(resolve => client.once("connect", () => resolve())), "client never connected");
    client.write([
      "GET /v1/realtime?call_id=rtc_cancel_pending_join HTTP/1.1",
      `Host: 127.0.0.1:${server.port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Authorization: Bearer ${DIRECT_CHATGPT_TOKEN}`,
      "ChatGPT-Account-Id: acct-123",
      "OpenAI-Alpha: quicksilver=v2",
      "X-Session-Id: rts_cancel_pending_join",
      "", "",
    ].join("\r\n"));
    await withDeadline(dialed.promise, "sideband join never dialed the upstream");
    expect(activeRegistryMetrics().activeTurns.active).toBe(activeTurnsBefore + 1);

    // The caller goes away while the upstream handshake is still pending.
    client.destroy();
    await withDeadline(upstream.closeRequestedPromise, "cancellation never asked the upstream to close");
    // Give every abort listener and pending continuation a turn to run.
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(upstream.readyState).toBe(WebSocket.CLOSING);
    expect(activeRegistryMetrics().activeTurns.active).toBe(activeTurnsBefore + 1);

    upstream.finishClose();
    await Bun.sleep(0);
    expect(activeRegistryMetrics().activeTurns.active).toBe(activeTurnsBefore);
    upstream.finishClose();
    expect(activeRegistryMetrics().activeTurns.active).toBe(activeTurnsBefore);
  } finally {
    client.destroy();
    upstream.finishClose();
    await server.stop(true);
  }
}, { timeout: 15_000 });

test("a client that cancels during credential resolution releases admission before any dial", async () => {
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
    codexAccounts: [{ id: "pool-cancel", email: "cancel@example.test", isMain: false, chatgptAccountId: "acct-cancel" }],
    activeCodexAccountId: "pool-cancel",
    codexMainAccountHardLock: false,
  } as OcxConfig);
  accountStore.saveCodexAccountCredential("pool-cancel", {
    accessToken: "fixture-expired-access", refreshToken: "fixture-refresh", expiresAt: 0, chatgptAccountId: "acct-cancel",
  });
  // Hold credential preparation open, as a slow token refresh would, without a caller signal.
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<never>();
  const tokenSpy = spyOn(accountStore, "getValidCodexToken").mockImplementation(async () => {
    entered.resolve();
    return held.promise;
  });
  let dials = 0;
  const server = startServer(0, {
    inspectNativeCodexOwnership: ownedServiceHomeInspection("server-live-cancel fixture"),
    liveSidebandWebSocketFactory: () => { dials += 1; throw new Error("a cancelled join must not dial"); },
  });
  const activeTurnsBefore = activeRegistryMetrics().activeTurns.active;
  const client = connect(Number(server.port), "127.0.0.1");
  client.on("error", () => {});
  try {
    await withDeadline(new Promise<void>(resolve => client.once("connect", () => resolve())), "client never connected");
    client.write([
      "GET /v1/realtime?model=gpt-live HTTP/1.1",
      `Host: 127.0.0.1:${server.port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "", "",
    ].join("\r\n"));
    await withDeadline(entered.promise, "credential resolution never started");
    expect(activeRegistryMetrics().activeTurns.active).toBe(activeTurnsBefore + 1);

    client.destroy();
    const deadline = Date.now() + 5_000;
    while (activeRegistryMetrics().activeTurns.active !== activeTurnsBefore && Date.now() < deadline) await Bun.sleep(5);
    expect(activeRegistryMetrics().activeTurns.active).toBe(activeTurnsBefore);
    expect(dials).toBe(0);
  } finally {
    held.reject(new Error("fixture released"));
    client.destroy();
    await server.stop(true);
    tokenSpy.mockRestore();
  }
}, { timeout: 15_000 });
