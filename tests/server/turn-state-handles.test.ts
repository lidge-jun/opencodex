import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import {
  issueTurnStateHandle, noteTurnStateCaller, redeemOutboundTurnState, resetTurnStateHandlesForTests,
  resolveTurnStateHandle, runTurnStateCallerScope, TURN_STATE_MISMATCH_NOTICE, turnStateBinding,
} from "../../src/server/turn-state-handles";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// An upstream token with no recognizable prefix.
const UPSTREAM_TOKEN = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const HANDLE = /^ocx-ts-[0-9a-f]{32}$/;

beforeEach(() => resetTurnStateHandlesForTests());

/** The binding the proxy computes for a send with these outbound headers, under a given caller. */
function bindingFor(caller: { kind: string; keyId?: string }, provider: string, headers: Headers): string {
  return runTurnStateCallerScope(() => {
    noteTurnStateCaller(caller);
    return turnStateBinding(provider, headers);
  });
}

describe("turn-state handles", () => {
  test("a handle is proxy-generated, stable per token and binding, and maps back only under its binding", () => {
    const handle = issueTurnStateHandle(UPSTREAM_TOKEN, "send-a");
    expect(handle).toMatch(HANDLE);
    expect(handle).not.toContain(UPSTREAM_TOKEN);
    expect(issueTurnStateHandle(UPSTREAM_TOKEN, "send-a")).toBe(handle);
    expect(issueTurnStateHandle(handle, "send-a")).toBe(handle);
    expect(issueTurnStateHandle(UPSTREAM_TOKEN, "send-b")).not.toBe(handle);
    expect(resolveTurnStateHandle(handle, "send-a")).toEqual({ value: UPSTREAM_TOKEN });
    expect(resolveTurnStateHandle(handle, "send-b")).toEqual({ dropped: "mismatch" });
  });

  test("unknown and expired handles resolve to nothing; other values pass unchanged", () => {
    const now = Date.now();
    const handle = issueTurnStateHandle(UPSTREAM_TOKEN, "send-a", now);
    expect(resolveTurnStateHandle("ocx-ts-" + "0".repeat(32), "send-a", now)).toEqual({ dropped: "unknown" });
    expect(resolveTurnStateHandle(handle, "send-a", now + 7 * 60 * 60 * 1000)).toEqual({ dropped: "unknown" });
    expect(resolveTurnStateHandle("raw-upstream-token", "send-a", now)).toEqual({ value: "raw-upstream-token" });
  });

  test("the map is bounded: the oldest handle is evicted first", () => {
    const first = issueTurnStateHandle("token-0", "send-a");
    for (let i = 1; i <= 4096; i++) issueTurnStateHandle(`token-${i}`, "send-a");
    expect(resolveTurnStateHandle(first, "send-a")).toEqual({ dropped: "unknown" });
  });

  test("the binding covers caller, provider and account, and differs when any of them does", () => {
    const headers = new Headers({ "chatgpt-account-id": "account-a", authorization: "Bearer a" });
    const base = bindingFor({ kind: "loopback" }, "openai", headers);
    expect(bindingFor({ kind: "loopback" }, "openai", headers)).toBe(base);
    expect(bindingFor({ kind: "configured", keyId: "key-1" }, "openai", headers)).not.toBe(base);
    expect(bindingFor({ kind: "loopback" }, "other", headers)).not.toBe(base);
    expect(bindingFor({ kind: "loopback" }, "openai", new Headers({ "chatgpt-account-id": "account-b" }))).not.toBe(base);
    // Without an account id the outbound credential stands in for the account.
    expect(bindingFor({ kind: "loopback" }, "openai", new Headers({ authorization: "Bearer a" })))
      .not.toBe(bindingFor({ kind: "loopback" }, "openai", new Headers({ authorization: "Bearer b" })));
    expect(base).not.toContain("account-a");
  });

  test("an outbound send is translated only for a handle with the same binding", () => {
    const handle = issueTurnStateHandle(UPSTREAM_TOKEN, "send-a");
    const init = { headers: { "x-codex-turn-state": handle }, body: JSON.stringify({ client_metadata: { "x-codex-turn-state": handle, keep: "1" } }) };
    const same = redeemOutboundTurnState(init, "send-a")!;
    expect(new Headers(same.headers).get("x-codex-turn-state")).toBe(UPSTREAM_TOKEN);
    expect(JSON.parse(same.body as string).client_metadata).toEqual({ "x-codex-turn-state": UPSTREAM_TOKEN, keep: "1" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const other = redeemOutboundTurnState(init, "send-b")!;
      expect(new Headers(other.headers).has("x-codex-turn-state")).toBe(false);
      expect(JSON.parse(other.body as string).client_metadata).toEqual({ keep: "1" });
      expect(warn.mock.calls.map(call => String(call[0]))).toEqual([TURN_STATE_MISMATCH_NOTICE]);
      expect(TURN_STATE_MISMATCH_NOTICE).not.toContain("ocx-ts-");
    } finally { warn.mockRestore(); }
    // A send without a handle is returned as is, bytes and all.
    const plain = { headers: { "x-codex-turn-state": "raw" }, body: "{\"a\":1}" };
    expect(redeemOutboundTurnState(plain, "send-a")).toBe(plain);
  });
});

describe("the server redeems a handle only for the same caller, provider and account", () => {
  const originalFetch = globalThis.fetch;
  const previousHome = process.env.OPENCODEX_HOME;
  let home = "";
  let forwarded: Array<{ headers: Headers; body?: Record<string, unknown> }> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-turn-state-"));
    process.env.OPENCODEX_HOME = home;
    forwarded = [];
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

  const bearer = `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "turn-state-fixture", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  function captureUpstream(server: { url: URL }): void {
    const local = new URL(server.url).origin;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(local)) return originalFetch(input, init);
      forwarded.push({
        headers: new Headers(input instanceof Request ? input.headers : init?.headers),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
      });
      const completed = { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", output: [] } };
      return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
  }
  async function post(server: { url: URL }, turnState?: string): Promise<void> {
    const response = await originalFetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearer, ...(turnState ? { "x-codex-turn-state": turnState } : {}) },
      body: JSON.stringify({ model: "gpt-5.5", input: "hi", stream: true }),
    });
    await response.text();
  }
  async function frame(server: { url: URL }, turnState: string): Promise<void> {
    const ws = new WebSocket(new URL("/v1/responses", server.url).href.replace(/^http/, "ws"), {
      headers: { "x-codex-turn-state": turnState, authorization: bearer },
    } as unknown as string[]);
    const terminal = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no terminal frame")), 10_000);
      ws.onmessage = event => { if (String(event.data).includes("response.completed")) { clearTimeout(timer); resolve(); } };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket error")); };
    });
    await new Promise<void>(resolve => { ws.onopen = () => resolve(); });
    ws.send(JSON.stringify({ type: "response.create", model: "gpt-5.5", input: "hi", client_metadata: { "x-codex-turn-state": turnState } }));
    await terminal;
    ws.close();
  }

  // Each case issues a handle under the binding of the first (handle-free) send, or a variation of it.
  const CASES: Array<[string, (headers: Headers) => string, string | null]> = [
    ["same caller, provider and account", headers => bindingFor({ kind: "loopback" }, "openai", headers), UPSTREAM_TOKEN],
    ["another account", headers => {
      const other = new Headers(headers);
      if (other.has("chatgpt-account-id")) other.set("chatgpt-account-id", "other-account"); else other.set("authorization", "Bearer other");
      return bindingFor({ kind: "loopback" }, "openai", other);
    }, null],
    ["another provider", headers => bindingFor({ kind: "loopback" }, "other-provider", headers), null],
    ["another caller", headers => bindingFor({ kind: "configured", keyId: "other-key" }, "openai", headers), null],
  ];

  for (const transport of ["HTTP", "WebSocket"] as const) {
    for (const [name, binding, expected] of CASES) {
      test(`${transport}: ${name}`, async () => {
        const server = startServer(0);
        captureUpstream(server);
        const warn = spyOn(console, "warn");
        try {
          await post(server);
          expect(forwarded.length).toBe(1);
          const handle = issueTurnStateHandle(UPSTREAM_TOKEN, binding(forwarded[0]!.headers));
          if (transport === "HTTP") await post(server, handle); else await frame(server, handle);
          // Non-vacuous: the second send reached the upstream before its turn state is checked.
          expect(forwarded.length).toBe(2);
          const sent = forwarded[1]!;
          expect(sent.headers.get("x-codex-turn-state")).toBe(expected);
          if (transport === "WebSocket") {
            const metadata = (sent.body?.client_metadata ?? {}) as Record<string, unknown>;
            expect(metadata["x-codex-turn-state"]).toBe(expected ?? undefined);
          }
          expect(JSON.stringify({ headers: [...sent.headers], body: sent.body })).not.toContain("ocx-ts-");
          const notices = warn.mock.calls.map(call => String(call[0])).filter(text => text.includes("turn_state_binding_mismatch"));
          expect(notices.length > 0).toBe(expected === null);
          expect(warn.mock.calls.flat().map(String).join("\n")).not.toContain(handle);
        } finally {
          warn.mockRestore();
          await server.stop(true);
        }
      });
    }
  }
});
