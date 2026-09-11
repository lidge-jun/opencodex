import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fakeChatGptJwt } from "./fake-chatgpt-jwt";

export async function startAstraEffortProxy(nativeWebSocket = false, runtimeRoot?: string) {
  const home = mkdtempSync(join(tmpdir(), "astra-proxy-"));
  const oldEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(OPENAI_|CODEX_|OPENCODEX_)/.test(key) || /^(http|https|all)_proxy$/i.test(key)) delete process.env[key];
  }
  Object.assign(process.env, { HOME: home, USERPROFILE: home, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex"), OPENCODEX_API_AUTH_TOKEN: "fixture-admission", NO_PROXY: "127.0.0.1,localhost" });
  mkdirSync(process.env.OPENCODEX_HOME!, { recursive: true });
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  const realFetch = globalThis.fetch;
  const RealWebSocket = globalThis.WebSocket;
  const captured: Array<{ transport: "http" | "websocket"; compact: boolean; body: any }> = [];
  let serial = 0;
  function events(body: any, transport: "http" | "websocket", compact = false) {
    captured.push({ transport, compact, body });
    const id = `resp_fixture_${++serial}`;
    const output = [{ id: `msg_fixture_${serial}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] }];
    return [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: output[0].id, delta: "OK" },
      { type: "response.output_item.done", output_index: 0, item: output[0] },
      { type: "response.completed", response: { id, object: "response", status: "completed", output, usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 80 } } } },
    ];
  }
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      if (request.headers.get("upgrade") === "websocket" && server.upgrade(request)) return;
      if (request.method !== "POST") return Response.json({});
      const body = await request.json();
      const compact = new URL(request.url).pathname.endsWith("/compact");
      const frames = events(body, "http", compact);
      if (compact) return Response.json({ id: "cmp_fixture", object: "response.compaction", output: [{ type: "compaction", encrypted_content: "synthetic" }] });
      return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
    websocket: { message(ws, data) { for (const event of events(JSON.parse(String(data)), "websocket")) ws.send(JSON.stringify(event)); } },
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === "https://chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return realFetch(new URL(url.pathname.slice("/backend-api/codex".length) || "/", upstream.url), init);
    }
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    return Promise.reject(new Error("Synthetic Astra fixture denies external fetch"));
  }) as typeof fetch;
  globalThis.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args) {
      const url = new URL(String(args[0]));
      if (url.origin === "wss://chatgpt.com") {
        if (!nativeWebSocket) throw new Error("Synthetic HTTP-only upstream");
        const local = new URL("/responses", upstream.url); local.protocol = "ws:";
        return Reflect.construct(target, [local.href, ...args.slice(1)]);
      }
      if (url.hostname !== "127.0.0.1") throw new Error("Synthetic Astra fixture denies external websocket");
      return Reflect.construct(target, args);
    },
  });
  let proxy: Awaited<ReturnType<typeof import("../../src/server")["startServer"]>> | undefined;
  async function stop() {
    try { await proxy?.stop(true); await upstream.stop(true); }
    finally {
      globalThis.fetch = realFetch; globalThis.WebSocket = RealWebSocket;
      for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
      Object.assign(process.env, oldEnv);
      rmSync(home, { recursive: true, force: true });
    }
  }
  try {
    const [{ saveConfig }, { startServer }] = await Promise.all(runtimeRoot
      ? [import(pathToFileURL(join(runtimeRoot, "src/config.ts")).href), import(pathToFileURL(join(runtimeRoot, "src/server/index.ts")).href)]
      : [import("../../src/config"), import("../../src/server")]);
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "openai", openaiProviderTierVersion: 2, websockets: true,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } } });
    proxy = startServer(0);
  } catch (error) { await stop(); throw error; }
  const url = new URL("/v1/responses", proxy!.url);
  function headers(thread: string) {
    return { "content-type": "application/json", "x-opencodex-api-key": "fixture-admission", authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "fixture-account" })}`, "chatgpt-account-id": "fixture-account", "thread-id": thread, "session-id": thread, "x-codex-parent-thread-id": thread };
  }
  async function http(body: unknown, thread: string, compact = false) {
    const response = await realFetch(compact ? `${url}/compact` : url, { method: "POST", headers: headers(thread), body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Synthetic request failed: ${response.status}: ${text.slice(0, 300)}`);
    return compact ? JSON.parse(text) : JSON.parse(text.split("\n").find(line => line.startsWith("data:") && line.includes('"type":"response.completed"'))!.slice(5)).response;
  }
  function websocket(thread: string) {
    const wsUrl = new URL(url); wsUrl.protocol = "ws:";
    const ws = new RealWebSocket(wsUrl, { headers: headers(thread) } as unknown as string[]);
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error("Synthetic websocket open timeout")); }, 10_000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Synthetic websocket open failed")); }, { once: true });
    });
    return { close: () => ws.close(), async turn(body: object) {
      await ready;
      return new Promise<any>((resolve, reject) => {
        const finish = (error?: Error, value?: unknown) => { clearTimeout(timer); ws.removeEventListener("message", onMessage); ws.removeEventListener("close", onClose); error ? reject(error) : resolve(value); };
        const onMessage = (event: MessageEvent) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "response.completed") finish(undefined, frame.response);
          else if (["error", "response.failed"].includes(frame.type)) finish(new Error("Synthetic websocket request failed"));
        };
        const onClose = () => finish(new Error("Synthetic websocket closed before completion"));
        const timer = setTimeout(() => { finish(new Error("Synthetic websocket turn timeout")); ws.close(); }, 10_000);
        ws.addEventListener("message", onMessage); ws.addEventListener("close", onClose, { once: true });
        ws.send(JSON.stringify({ ...body, type: "response.create" }));
      });
    } };
  }
  return { home: join(home, "ocx"), captured, http, websocket, stop };
}
