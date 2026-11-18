import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { resetTurnStateHandlesForTests } from "../../src/server/turn-state-handles";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * End to end: the proxy obtains a turn-state token from a (mock) ChatGPT Codex WebSocket upstream,
 * hands the client a handle, and maps the handle back when the same client sends it on its next
 * request, over HTTP and over WebSocket. Only the upstream socket is faked; the server, its
 * admission, routing and the client's own sockets are real.
 */

type Listener = (event: unknown) => void;
const sentFrames: Array<Record<string, unknown>> = [];

/** The token the mock upstream issues for a request is derived from its input, so each turn differs. */
const tokenFor = (frame: Record<string, unknown>) => `upstream-turn-${String(frame.input)}`;

class FakeCodexSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(_url: string, _options?: unknown) {
    queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); });
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }
  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>;
    sentFrames.push(frame);
    const id = `resp_${sentFrames.length}`;
    queueMicrotask(() => {
      this.emit("message", { data: JSON.stringify({ type: "codex.response.metadata", headers: { "x-codex-turn-state": tokenFor(frame) } }) });
      this.emit("message", { data: JSON.stringify({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } }) });
      this.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id, object: "response", status: "completed", output: [] } }) });
    });
  }
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
  ref() {}
  unref() {}
}

const RealWebSocket = globalThis.WebSocket;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
const savedEnv: Record<string, string | undefined> = {};
let home = "";

const KEYS = { a: "ocx_data_turn_state_caller_a", b: "ocx_data_turn_state_caller_b" } as const;
const bearer = `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "turn-state-fixture", exp: Math.floor(Date.now() / 1000) + 3600 })}`;

beforeEach(() => {
  for (const key of [...PROXY_ENV_KEYS, "OPENCODEX_HOME"]) savedEnv[key] = process.env[key];
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), "ocx-turn-state-e2e-"));
  process.env.OPENCODEX_HOME = home;
  sentFrames.length = 0;
  resetTurnStateHandlesForTests();
  // Only the ChatGPT Codex upstream socket is faked; the test's own client sockets are real.
  globalThis.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args) {
      return String(args[0]).startsWith("wss://chatgpt.com/") ? new FakeCodexSocket(String(args[0]), args[1]) : Reflect.construct(target, args);
    },
  });
  saveFixtureConfig();
});

/** A loopback proxy admits every local caller as one session; a public bind admits each key as its own caller. */
function saveFixtureConfig(hostname?: string): void {
  saveConfig({
    port: 0, defaultProvider: "openai", websockets: true, ...(hostname ? { hostname } : {}),
    apiKeys: [
      { id: "caller-a", name: "caller a", key: KEYS.a, createdAt: "2026-11-03T00:00:00.000Z" },
      { id: "caller-b", name: "caller b", key: KEYS.b, createdAt: "2026-11-03T00:00:00.000Z" },
    ],
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
  } as unknown as OcxConfig);
}

afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(home);
});

/** One HTTP turn; returns the turn-state value the client received. */
async function httpTurn(server: { url: URL }, caller: keyof typeof KEYS, input: string, turnState?: string): Promise<string | null> {
  const response = await fetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: bearer, "x-opencodex-api-key": KEYS[caller],
      ...(turnState ? { "x-codex-turn-state": turnState } : {}),
    },
    body: JSON.stringify({ model: "gpt-5.5", input, stream: true }),
  });
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toContain("response.completed");
  return response.headers.get("x-codex-turn-state");
}

/** One WebSocket turn per frame on a single connection; returns the handle each metadata frame carried. */
async function wsTurns(server: { url: URL }, caller: keyof typeof KEYS, turns: Array<{ input: string; turnState?: string }>): Promise<Array<string | undefined>> {
  const ws = new WebSocket(new URL("/v1/responses", server.url).href.replace(/^http/, "ws"), {
    headers: { authorization: bearer, "x-opencodex-api-key": KEYS[caller] },
  } as unknown as string[]);
  const handles: Array<string | undefined> = [];
  let resolveTurn: (() => void) | undefined;
  let current: string | undefined;
  ws.onmessage = event => {
    const frame = JSON.parse(String(event.data)) as { type?: string; headers?: Record<string, string> };
    if (frame.type === "codex.response.metadata") current = frame.headers?.["x-codex-turn-state"];
    if (frame.type === "response.completed") { handles.push(current); current = undefined; resolveTurn?.(); }
  };
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("websocket error")); });
  for (const turn of turns) {
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no terminal frame")), 10_000);
      resolveTurn = () => { clearTimeout(timer); resolve(); };
    });
    ws.send(JSON.stringify({ type: "response.create", model: "gpt-5.5", input: turn.input,
      ...(turn.turnState ? { client_metadata: { "x-codex-turn-state": turn.turnState } } : {}) }));
    await done;
  }
  ws.close();
  return handles;
}

const forwardedTurnState = (index: number) => (sentFrames[index]?.client_metadata as Record<string, unknown> | undefined)?.["x-codex-turn-state"];

describe("a turn-state handle obtained from an upstream response is redeemed on the next request", () => {
  test("HTTP: the handle in the response header maps back to the upstream token", async () => {
    const server = startServer(0);
    try {
      const handle = await httpTurn(server, "a", "first");
      // Non-vacuous: the upstream answered and the client received a handle, not the token.
      expect(sentFrames).toHaveLength(1);
      expect(handle).toMatch(/^ocx-ts-[0-9a-f]{32}$/);
      expect(handle).not.toContain("upstream-turn");
      await httpTurn(server, "a", "second", handle!);
      expect(sentFrames).toHaveLength(2);
      expect(forwardedTurnState(1)).toBe("upstream-turn-first");
    } finally { await server.stop(true); }
  });

  test("WebSocket: the handle in the relayed metadata frame maps back to the upstream token", async () => {
    const server = startServer(0);
    try {
      const [first] = await wsTurns(server, "a", [{ input: "first" }]);
      expect(sentFrames).toHaveLength(1);
      expect(first).toMatch(/^ocx-ts-[0-9a-f]{32}$/);
      await wsTurns(server, "a", [{ input: "second", turnState: first }]);
      expect(sentFrames).toHaveLength(2);
      expect(forwardedTurnState(1)).toBe("upstream-turn-first");
    } finally { await server.stop(true); }
  });

  test("two concurrent callers each redeem only their own handle", async () => {
    // API keys admit as distinct callers only where admission is required, which a public bind makes it.
    saveFixtureConfig("0.0.0.0");
    const server = startServer(0);
    const warn = spyOn(console, "warn");
    try {
      const [handleA, handleB] = await Promise.all([httpTurn(server, "a", "turn-a"), httpTurn(server, "b", "turn-b")]);
      expect(sentFrames).toHaveLength(2);
      expect(handleA).toMatch(/^ocx-ts-[0-9a-f]{32}$/);
      expect(handleB).toMatch(/^ocx-ts-[0-9a-f]{32}$/);
      expect(handleA).not.toBe(handleB);
      // Concurrently: each caller redeems its own handle, and caller b presents caller a's handle too.
      await Promise.all([
        httpTurn(server, "a", "next-a", handleA!),
        httpTurn(server, "b", "next-b", handleB!),
        httpTurn(server, "b", "stolen-by-b", handleA!),
      ]);
      expect(sentFrames).toHaveLength(5);
      const byInput = new Map(sentFrames.map(frame => [String(frame.input), (frame.client_metadata as Record<string, unknown> | undefined)?.["x-codex-turn-state"]]));
      expect(byInput.get("next-a")).toBe("upstream-turn-turn-a");
      expect(byInput.get("next-b")).toBe("upstream-turn-turn-b");
      expect(byInput.get("stolen-by-b")).toBeUndefined();
      expect(warn.mock.calls.map(call => String(call[0])).some(text => text.includes("turn_state_binding_mismatch"))).toBe(true);
      expect(warn.mock.calls.flat().map(String).join("\n")).not.toContain("upstream-turn");
    } finally {
      warn.mockRestore();
      await server.stop(true);
    }
  });
});
