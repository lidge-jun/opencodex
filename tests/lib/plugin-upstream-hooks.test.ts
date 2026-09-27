import { afterEach, expect, test } from "bun:test";
import {
  hasUpstreamRewriters,
  registerUpstreamRewriter,
  resetUpstreamRewritersForTests,
  rewriteUpstream,
  rewriteUpstreamRecord,
  rewriteWebSocketDial,
} from "../../src/plugins/upstream-hooks";
import { sendWithConnectionPolicy } from "../../src/server/responses/fetch-helpers";
import { planCodexWsDial } from "../../src/server/responses/ws-upstream";
import { codexWsReuseIdentity } from "../../src/server/responses/codex-ws-pool";
import { CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";

afterEach(() => resetUpstreamRewritersForTests());

test("with no plugin registered the send is returned untouched and unallocated", () => {
  const headers = new Headers({ authorization: "Bearer x" });
  const result = rewriteUpstream("https://api.example.com/v1/responses", headers, "http");
  expect(hasUpstreamRewriters()).toBe(false);
  expect(result.url).toBe("https://api.example.com/v1/responses");
  expect(result.headers).toBe(headers);
});

test("a rewriter can redirect the URL and add headers while keeping credentials", () => {
  registerUpstreamRewriter("sidecar", target => {
    const original = new URL(target.url);
    target.url = `http://127.0.0.1:8787${original.pathname}`;
    target.headers.set("x-sidecar-upstream", original.origin);
  });
  const result = rewriteUpstream("https://api.example.com/v1/responses", { authorization: "Bearer x" }, "http");
  const headers = new Headers(result.headers);
  expect(result.url).toBe("http://127.0.0.1:8787/v1/responses");
  expect(headers.get("x-sidecar-upstream")).toBe("https://api.example.com");
  expect(headers.get("authorization")).toBe("Bearer x");
});

test("rewriters see the transport and run in registration order", () => {
  const seen: string[] = [];
  registerUpstreamRewriter("first", target => { seen.push(`first:${target.transport}`); target.url += "?a"; });
  registerUpstreamRewriter("second", target => { seen.push(`second:${target.transport}`); target.url += "&b"; });
  const result = rewriteUpstreamRecord("wss://chatgpt.com/backend-api/codex/responses", { "x-k": "v" }, "websocket");
  expect(seen).toEqual(["first:websocket", "second:websocket"]);
  expect(result.url).toBe("wss://chatgpt.com/backend-api/codex/responses?a&b");
  expect(result.headers["x-k"]).toBe("v");
});

test("a throwing rewriter is disabled and never breaks the send", () => {
  let calls = 0;
  registerUpstreamRewriter("broken", () => { calls += 1; throw new Error("boom"); });
  const originalError = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 3; i += 1) {
      expect(rewriteUpstream("https://api.example.com/v1/messages", undefined, "http").url)
        .toBe("https://api.example.com/v1/messages");
    }
  } finally {
    console.error = originalError;
  }
  expect(calls).toBe(1);
});

test("a throwing rewriter logs only a bounded category", () => {
  const marker = "private upstream error marker";
  registerUpstreamRewriter(marker, () => { throw new Error(marker); });
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    rewriteUpstream("https://api.example.com/v1/messages", { authorization: `Bearer ${marker}` }, "http");
  } finally {
    console.error = originalError;
  }
  expect(lines).toEqual(["[opencodex] plugin upstream rewriter disabled: plugin_exception"]);
  expect(lines.join(" ")).not.toContain(marker);
});

test("a rewriter that edits the target and then throws leaves the send unmodified", () => {
  registerUpstreamRewriter("half", target => {
    target.url = "http://127.0.0.1:9/partial";
    target.headers.set("x-partial", "1");
    target.headers.delete("authorization");
    throw new Error("boom");
  });
  let seenByNext: { url: string; partial: string | null; auth: string | null } | undefined;
  registerUpstreamRewriter("next", target => {
    seenByNext = { url: target.url, partial: target.headers.get("x-partial"), auth: target.headers.get("authorization") };
  });
  const originalError = console.error;
  console.error = () => {};
  let result: ReturnType<typeof rewriteUpstream>;
  try {
    result = rewriteUpstream("https://api.example.com/v1/responses", { authorization: "Bearer x" }, "http");
  } finally {
    console.error = originalError;
  }
  const headers = new Headers(result.headers);
  expect(seenByNext).toEqual({ url: "https://api.example.com/v1/responses", partial: null, auth: "Bearer x" });
  expect(result.url).toBe("https://api.example.com/v1/responses");
  expect(headers.get("x-partial")).toBeNull();
  expect(headers.get("authorization")).toBe("Bearer x");
});

test("a WebSocket dial redirected to loopback drops the caller's proxy; other dials keep it", () => {
  const proxy = "http://corp-proxy.example:3128";
  expect(rewriteWebSocketDial("wss://chatgpt.com/backend-api/codex/responses", {}, proxy).proxy).toBe(proxy);

  const off = registerUpstreamRewriter("loopback", target => { target.url = "ws://127.0.0.1:8787/backend-api/codex/responses"; });
  const local = rewriteWebSocketDial("wss://chatgpt.com/backend-api/codex/responses", { a: "1" }, proxy);
  expect(local).toEqual({ url: "ws://127.0.0.1:8787/backend-api/codex/responses", headers: { a: "1" }, proxy: undefined });
  off();

  registerUpstreamRewriter("remote", target => { target.url = "wss://relay.example.com/backend-api/codex/responses"; });
  expect(rewriteWebSocketDial("wss://chatgpt.com/backend-api/codex/responses", {}, proxy).proxy).toBe(proxy);
});

test("the physical HTTP send rewrites once, even through a nested override pass", async () => {
  let calls = 0;
  registerUpstreamRewriter("count", target => {
    calls += 1;
    target.url = target.url.replace("https://api.example.com", "http://127.0.0.1:8787");
    target.headers.set("x-hop", String(calls));
  });
  const seen: Array<{ url: string; hop: string | null }> = [];
  const physical = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({ url: String(input), hop: new Headers(init?.headers).get("x-hop") });
    return new Response("ok");
  }) as typeof fetch;
  // An override that hands the send back to the supplied executor passes through twice.
  const inner = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    sendWithConnectionPolicy(physical, input, init)) as typeof fetch;
  await sendWithConnectionPolicy(inner, "https://api.example.com/v1/responses", { method: "POST" });
  expect(calls).toBe(1);
  expect(seen).toEqual([{ url: "http://127.0.0.1:8787/v1/responses", hop: "1" }]);
});

test("an HTTP send redirected to loopback dials directly, bypassing any proxy", async () => {
  const seen: Array<{ url: string; proxy: unknown }> = [];
  const physical = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({ url: input instanceof Request ? input.url : String(input), proxy: (init as { proxy?: unknown }).proxy });
    return new Response("ok");
  }) as typeof fetch;
  registerUpstreamRewriter("loopback", target => { target.url = target.url.replace("https://api.example.com", "http://127.0.0.1:8787"); });
  await sendWithConnectionPolicy(physical, "https://api.example.com/v1/responses", { method: "POST" });
  resetUpstreamRewritersForTests();
  registerUpstreamRewriter("remote", target => { target.url = target.url.replace("https://api.example.com", "https://relay.example.net"); });
  await sendWithConnectionPolicy(physical, "https://api.example.com/v1/responses", { method: "POST" });
  expect(seen).toEqual([
    { url: "http://127.0.0.1:8787/v1/responses", proxy: false },
    { url: "https://relay.example.net/v1/responses", proxy: undefined },
  ]);
});

test("a Request input is rewritten too", async () => {
  let seenUrl = "";
  const physical = (async (input: Parameters<typeof fetch>[0]) => {
    seenUrl = input instanceof Request ? input.url : String(input);
    return new Response("ok");
  }) as typeof fetch;
  registerUpstreamRewriter("loopback", target => { target.url = "http://127.0.0.1:8787/v1/messages"; });
  await sendWithConnectionPolicy(physical, new Request("https://api.example.com/v1/messages", { method: "POST", body: "{}" }));
  expect(seenUrl).toBe("http://127.0.0.1:8787/v1/messages");
});

test("the Codex WebSocket reuse identity changes with the dialled destination", () => {
  const headers = { authorization: "Bearer t", "chatgpt-account-id": "acct", "thread-id": "th" };
  const frame = JSON.stringify({ model: "gpt-x", client_metadata: { thread_id: "th", turn_id: "tu" } });
  const direct = codexWsReuseIdentity(CODEX_RESPONSES_HTTP_URL, headers, frame, undefined, "wss://chatgpt.com/backend-api/codex/responses");
  const local = codexWsReuseIdentity(CODEX_RESPONSES_HTTP_URL, headers, frame, undefined, "ws://127.0.0.1:8787/backend-api/codex/responses");
  expect(direct).not.toBeNull();
  expect(local).not.toBeNull();
  expect(local?.key).not.toBe(direct?.key);
});

test("a Codex WebSocket dial resolves its proxy for the rewritten destination", () => {
  const ws = "wss://chatgpt.com/backend-api/codex/responses";
  const envProxy = { HTTPS_PROXY: "http://corp:3128", HTTP_PROXY: "http://plain:8080" };
  expect(planCodexWsDial(ws, {}, "http://corp:3128", envProxy)?.proxy).toBe("http://corp:3128");

  const off = registerUpstreamRewriter("remote-wss", target => { target.url = "wss://relay.example.net/backend-api/codex/responses"; });
  expect(planCodexWsDial(ws, {}, "http://corp:3128", envProxy)?.proxy).toBe("http://corp:3128");
  expect(planCodexWsDial(ws, {}, "http://corp:3128", { ...envProxy, NO_PROXY: "relay.example.net" })?.proxy).toBeUndefined();
  off();

  const offPlain = registerUpstreamRewriter("remote-ws", target => { target.url = "ws://relay.example.net/backend-api/codex/responses"; });
  expect(planCodexWsDial(ws, {}, "http://corp:3128", envProxy)?.proxy).toBe("http://plain:8080");
  offPlain();

  registerUpstreamRewriter("loopback", target => { target.url = "ws://127.0.0.1:8787/backend-api/codex/responses"; });
  expect(planCodexWsDial(ws, {}, "http://corp:3128", envProxy)).toEqual({
    url: "ws://127.0.0.1:8787/backend-api/codex/responses", headers: {}, proxy: undefined,
  });
});

test("a Codex WebSocket rewriter cannot change the per-turn headers carried in the frame", () => {
  registerUpstreamRewriter("turn-headers", target => {
    target.headers.set("x-codex-turn-state", "rewritten");
    target.headers.set("x-codex-turn-metadata", "added");
    target.headers.set("x-sidecar", "1");
  });
  const dial = planCodexWsDial(
    "wss://chatgpt.com/backend-api/codex/responses",
    { "x-codex-turn-state": "original", authorization: "Bearer t" },
    undefined,
    {},
  );
  expect(dial?.headers["x-codex-turn-state"]).toBe("original");
  expect(Object.hasOwn(dial?.headers ?? {}, "x-codex-turn-metadata")).toBe(false);
  expect(dial?.headers["x-sidecar"]).toBe("1");
  expect(dial?.headers.authorization).toBe("Bearer t");
});

test("unregistering removes the rewriter", () => {
  const off = registerUpstreamRewriter("temp", target => { target.url = "http://changed/"; });
  off();
  expect(hasUpstreamRewriters()).toBe(false);
  expect(rewriteUpstream("https://a.example/x", undefined, "http").url).toBe("https://a.example/x");
});
