import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import {
  issueTurnStateHandle, resetTurnStateHandlesForTests, resolveTurnStateHandle,
  translateInboundTurnState, translateInboundTurnStateMetadata,
} from "../../src/server/turn-state-handles";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// An upstream token with no recognizable prefix.
const UPSTREAM_TOKEN = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const HANDLE = /^ocx-ts-[0-9a-f]{32}$/;

beforeEach(() => resetTurnStateHandlesForTests());

describe("turn-state handles", () => {
  test("a handle is proxy-generated, stable per token, and maps back", () => {
    const handle = issueTurnStateHandle(UPSTREAM_TOKEN);
    expect(handle).toMatch(HANDLE);
    expect(handle).not.toContain(UPSTREAM_TOKEN);
    expect(issueTurnStateHandle(UPSTREAM_TOKEN)).toBe(handle);
    // Normalizing an already issued handle again does not chain a second handle.
    expect(issueTurnStateHandle(handle)).toBe(handle);
    expect(resolveTurnStateHandle(handle)).toBe(UPSTREAM_TOKEN);
    expect(issueTurnStateHandle("other-token")).not.toBe(handle);
  });

  test("unknown and expired handles resolve to nothing; other values pass unchanged", () => {
    const now = Date.now();
    const handle = issueTurnStateHandle(UPSTREAM_TOKEN, now);
    expect(resolveTurnStateHandle("ocx-ts-" + "0".repeat(32), now)).toBeUndefined();
    expect(resolveTurnStateHandle(handle, now + 7 * 60 * 60 * 1000)).toBeUndefined();
    expect(resolveTurnStateHandle("raw-upstream-token", now)).toBe("raw-upstream-token");
  });

  test("the map is bounded: the oldest handle is evicted first", () => {
    const first = issueTurnStateHandle("token-0");
    for (let i = 1; i <= 4096; i++) issueTurnStateHandle(`token-${i}`);
    expect(resolveTurnStateHandle(first)).toBeUndefined();
    expect(resolveTurnStateHandle(issueTurnStateHandle("token-4096"))).toBe("token-4096");
  });

  test("inbound headers and WebSocket frame metadata are translated in place", () => {
    const handle = issueTurnStateHandle(UPSTREAM_TOKEN);
    const headers = new Headers({ "x-codex-turn-state": handle });
    translateInboundTurnState(headers);
    expect(headers.get("x-codex-turn-state")).toBe(UPSTREAM_TOKEN);
    const unknown = new Headers({ "x-codex-turn-state": "ocx-ts-" + "f".repeat(32) });
    translateInboundTurnState(unknown);
    expect(unknown.has("x-codex-turn-state")).toBe(false);
    const frame: Record<string, unknown> = { type: "response.create", client_metadata: { "x-codex-turn-state": handle, other: "kept" } };
    translateInboundTurnStateMetadata(frame);
    expect(frame.client_metadata).toEqual({ "x-codex-turn-state": UPSTREAM_TOKEN, other: "kept" });
    const stale: Record<string, unknown> = { client_metadata: { "x-codex-turn-state": "ocx-ts-" + "a".repeat(32) } };
    translateInboundTurnStateMetadata(stale);
    expect(stale.client_metadata).toEqual({});
  });
});

describe("the server translates a handle before forwarding", () => {
  const originalFetch = globalThis.fetch;
  const previousHome = process.env.OPENCODEX_HOME;
  let home = "";
  let forwarded: Array<string | null> = [];
  let forwardedBodies: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-turn-state-"));
    process.env.OPENCODEX_HOME = home;
    forwarded = [];
    forwardedBodies = [];
    saveConfig({
      port: 0, defaultProvider: "openai", websockets: true,
      // HTTP/SSE upstream, so the fixture never opens a real WebSocket.
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", upstreamWebsocket: false } },
    } as unknown as OcxConfig);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  const bearer = () => `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "turn-state-fixture", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  function captureUpstream(server: { url: URL }): void {
    const local = new URL(server.url).origin;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(local)) return originalFetch(input, init);
      forwarded.push(new Headers(input instanceof Request ? input.headers : init?.headers).get("x-codex-turn-state"));
      if (typeof init?.body === "string") forwardedBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      const completed = { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", output: [] } };
      return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
  }

  test.each([
    ["a live handle", () => issueTurnStateHandle(UPSTREAM_TOKEN), UPSTREAM_TOKEN],
    ["an unknown handle", () => "ocx-ts-" + "b".repeat(32), null],
    ["a raw token", () => "raw-upstream-token", "raw-upstream-token"],
  ])("%s", async (_name, inbound, expected) => {
    const server = startServer(0);
    captureUpstream(server);
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-turn-state": inbound(), authorization: bearer() },
        body: JSON.stringify({ model: "gpt-5.5", input: "hi", stream: true }),
      });
      await response.text();
      // Non-vacuous: the request reached the upstream before its header is checked.
      expect(forwarded.length).toBeGreaterThan(0);
      expect(forwarded[0]).toBe(expected);
    } finally {
      await server.stop(true);
    }
  });

  test("a WebSocket client's upgrade header and frame metadata are both translated", async () => {
    const server = startServer(0);
    captureUpstream(server);
    const upgradeHandle = issueTurnStateHandle(UPSTREAM_TOKEN);
    const frameHandle = issueTurnStateHandle("frame-upstream-token");
    try {
      const ws = new WebSocket(new URL("/v1/responses", server.url).href.replace(/^http/, "ws"), {
        headers: { "x-codex-turn-state": upgradeHandle, authorization: bearer() },
      } as unknown as string[]);
      const terminal = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no terminal frame")), 10_000);
        ws.onmessage = event => { if (String(event.data).includes("response.completed")) { clearTimeout(timer); resolve(); } };
        ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket error")); };
      });
      await new Promise<void>(resolve => { ws.onopen = () => resolve(); });
      ws.send(JSON.stringify({ type: "response.create", model: "gpt-5.5", input: "hi", client_metadata: { "x-codex-turn-state": frameHandle } }));
      await terminal;
      ws.close();
      expect(forwarded.length).toBeGreaterThan(0);
      expect(forwarded[0]).toBe(UPSTREAM_TOKEN);
      expect((forwardedBodies[0]?.client_metadata as Record<string, unknown> | undefined)?.["x-codex-turn-state"]).toBe("frame-upstream-token");
      expect(JSON.stringify(forwardedBodies)).not.toContain("ocx-ts-");
    } finally {
      await server.stop(true);
    }
  });
});
