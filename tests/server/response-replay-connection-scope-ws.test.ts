/**
 * Real-socket proof for the connection-owned replay scope. A Design-B loopback
 * install (no config.apiKeys) admits /v1/responses WebSocket upgrades without a
 * credential; the production serve-options.ts upgrade mints a per-socket scope
 * (loopback admission AND no resolvable context principal), the shared
 * websocket handler passes it to the pipeline per frame, and the close hook
 * releases it before cancelling the turn.
 *
 * Driven over a real Bun.serve upgrade and a real WebSocket client so the
 * binding that matters — same socket replays, any other authority does not —
 * is exercised at the transport boundary, not behind a mock. Upstream calls go
 * to a counting fixture; a refusal must never dispatch (no duplicate billing).
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdmittedHttpTurn } from "../../src/server/admitted-http-turn";
import { clearResponseStateForTests, connectionReplayScopeOwnerKey, responseStateMetrics, type ConnectionReplayScope } from "../../src/responses/state";
import { getAdapterDefinition } from "../../src/adapters/registry";
import { adapterNeedsForcedContinuation, adapterNeedsToolCallContinuation } from "../../src/server/responses/core-replay";
import { createServeOptions, type ServeOptionsContext } from "../../src/server/index/serve-options";
import { type WsData } from "../../src/server/ws-bridge";
import { type DataPlaneAdmission } from "../../src/server/auth-cors";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const originalCatalog = process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;
const LOOPBACK = { kind: "loopback", source: "loopback" } as const satisfies DataPlaneAdmission;
let release: () => void;
let home: string;
let previousHome: string | undefined;
let server: ReturnType<typeof Bun.serve<WsData>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-conn-scope-ws-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = "fresh";
  clearResponseStateForTests();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalCatalog === undefined) delete process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;
  else process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = originalCatalog;
  try {
    for (const ws of sockets.splice(0)) { try { ws.close(); } catch { /* already closed */ } }
    try { if (server) await server.stop(true); } finally { server = null; release(); }
  } finally {
    try { clearResponseStateForTests(); } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  }
});

function config(): OcxConfig {
  return {
    hostname: "127.0.0.1", defaultProvider: "native", multiAgentMode: "v2-plaintext", websockets: true,
    providers: {
      native: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward", upstreamWebsocket: false,
        fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch },
      swe: { adapter: "openai-responses", baseUrl: "https://swe-fixture.invalid/v1", authMode: "key",
        apiKey: "swe-fixture-key", models: ["argon-1"], fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch },
    },
    // No apiKeys: the Design-B shape. Every loopback request is admitted without a
    // credential, so resolveContextPrincipal finds nothing and the upgrade mints a scope.
  } as OcxConfig;
}

let responseCounter = 0;
const sent: string[] = [];
function upstream(): void {
  responseCounter = 0;
  sent.length = 0;
  globalThis.fetch = (async (_url, init) => {
    sent.push(String(init?.body));
    responseCounter += 1;
    // A routed openai-responses provider streams: answer it with SSE, while the canonical
    // forward path keeps the proven JSON shape.
    if (String(_url).includes("swe-fixture.invalid")) {
      const id = "resp-ws-" + responseCounter;
      const completed = responseCounter === 1
        // Routed adapters fail closed on undeclared client tools (responses-undeclared-
        // tool-guard.ts), so the routed turn calls the tool this request declared.
        ? [{ type: "function_call", call_id: "synthetic-call", namespace: "collaboration",
            name: "spawn_agent", arguments: JSON.stringify({ message: "SYNTHETIC_PRIVATE_TASK" }), encrypted_function_args: [] }]
        : [{ type: "message", id: "msg-routed", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "routed reply", annotations: [] }] }];
      const sse = "event: response.created\ndata: " + JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } }) + "\n\n"
        + "event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: completed,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }) + "\n\n";
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ id: "resp-ws-" + responseCounter, status: "completed",
      output: responseCounter === 1 ? [{ type: "function_call", call_id: "synthetic-call", namespace: "collaboration-optimize",
        name: "start_delegated_task", arguments: JSON.stringify({ message: "SYNTHETIC_PRIVATE_TASK" }), encrypted_function_args: [] }] : [] });
  }) as typeof fetch;
}

// Drive the production upgrade route and frame handler. Only unrelated server
// lifecycle dependencies are stubbed; scope issuance and propagation are real.
function startScopeServer(cfg: OcxConfig, captured?: { scope?: ConnectionReplayScope }): void {
  const options = createServeOptions({
    config: cfg, deps: {}, ingressForServer: () => "public",
    packageTreeIntegrity: { status: () => ({ ok: true }) },
    managementApiDeps: {}, inboundBodyLimitBytes: 1024 * 1024,
    runAdmittedHttpTurn: createAdmittedHttpTurn(() => 1024 * 1024, () => Response.json({ error: "fixture busy" }, { status: 503 })),
  } as unknown as ServeOptionsContext);
  server = Bun.serve<WsData>({
    ...options, hostname: "127.0.0.1", port: 0,
    fetch(req, srv) {
      // Observe the production route's upgrade data without issuing any authority here.
      const observingServer = new Proxy(srv, { get(target, property) {
        if (property === "upgrade") return (request: Request, upgrade: { data: WsData }) => {
          if (captured) captured.scope = upgrade.data.replayScope;
          return target.upgrade(request, upgrade);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      return options.fetch(req, observingServer);
    },
  });
}

function wsUrl(): string {
  return new URL("/v1/responses", server!.url).href.replace("http:", "ws:");
}

async function openSocket(threadId: string, key?: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl(), { headers: { "thread-id": threadId,
    ...(key ? { "x-opencodex-api-key": key } : {}) } } as unknown as string[]);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket open deadline")), 4000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket failed")); };
  });
  return ws;
}

type Frame = Record<string, unknown>;
function turn(ws: WebSocket, frame: Frame): Promise<Frame[]> {
  const messages: Frame[] = [];
  return new Promise<Frame[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("turn deadline")), 8000);
    ws.onmessage = event => {
      const data = JSON.parse(String(event.data)) as Frame;
      messages.push(data);
      if (data.type === "error" || typeof data.type === "string" && data.type.startsWith("response.")) {
        if (data.type === "error" || data.type === "response.completed" || data.type === "response.failed" || data.type === "response.incomplete") {
          clearTimeout(timer);
          resolve(messages);
        }
      }
    };
    ws.send(JSON.stringify(frame));
  });
}

function create(previous?: string, model = "native/gpt-5.6-sol"): Frame {
  return { type: "response.create", model, store: false, stream: true,
    ...(previous ? { previous_response_id: previous } : {}),
    input: previous
      ? [{ type: "function_call_output", call_id: "synthetic-call", output: "synthetic tool result" }]
      : [{ type: "message", role: "user", content: [{ type: "input_text", text: "synthetic public request" }] }],
    tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent",
      parameters: { type: "object", properties: { message: { type: "string", encrypted: true } } } }] }] };
}

test("same connection replays; a second socket, a reconnect and HTTP all keep the 400", async () => {
  const cfg = config();
  upstream();
  const captured: { scope?: ConnectionReplayScope } = {};
  startScopeServer(cfg, captured);
  const first = await openSocket("own-a");
  expect(captured.scope).toBeDefined();
  const key = connectionReplayScopeOwnerKey(captured.scope)!;
  expect(key).toMatch(/^[a-f0-9]{64}$/);

  const turn1 = await turn(first, create());
  expect(turn1.map(f => f.type)).toContain("response.completed");
  expect(sent).toHaveLength(1);
  // The same socket replays the retained continuation — this is the 400 the fix removes.
  const turn2 = await turn(first, create("resp-ws-1"));
  expect(turn2.map(f => f.type)).toContain("response.completed");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
  expect(sent[1]).toContain("collaboration-optimize");
  // The minted key never appears on the wire or upstream.
  expect(sent.join("")).not.toContain(key);
  expect(JSON.stringify(turn2)).not.toContain(key);

  // The socket is still live and its first ID was just proven replayable. Exercise the
  // actual HTTP ingress without transferring the connection's replay authority.
  const http = await originalFetch(new URL("/v1/responses", server!.url), {
    method: "POST", headers: { "content-type": "application/json", "thread-id": "own-a" },
    body: JSON.stringify({ model: "native/gpt-5.6-sol", store: false, stream: true,
      previous_response_id: "resp-ws-1", input: [] }),
  });
  expect(http.status).toBe(400);
  expect((await http.json()).error.code).toBe("previous_response_not_found");
  expect(sent).toHaveLength(2);

  // A second socket on the same thread mints a different scope: no shared authority.
  const second = await openSocket("own-a");
  const denied = await turn(second, create("resp-ws-1"));
  expect(denied.map(f => f.type)).toContain("error");
  const denial = denied.find(f => f.type === "error")!;
  expect(denial.status).toBe(400);
  expect(JSON.stringify(denial.error)).toContain("previous_response_not_found");
  expect(sent).toHaveLength(2);
  second.close();

  // Closing the owning socket drops the scope; a reconnect cannot replay.
  first.close();
  await new Promise<void>(resolve => { first.onclose = () => resolve(); setTimeout(resolve, 4000); });
  const third = await openSocket("own-a");
  const afterClose = await turn(third, create("resp-ws-1"));
  expect(afterClose.map(f => f.type)).toContain("error");
  expect(sent).toHaveLength(2);
  // But its own fresh task is fine — the boundary is the response id, not the caller.
  const fresh = await turn(third, create());
  expect(fresh.map(f => f.type)).toContain("response.completed");
  expect(sent).toHaveLength(3);

});

test("a routed Responses store:false tool turn replays on the same socket only", async () => {
  const cfg = config();
  upstream();
  startScopeServer(cfg);
  const ws = await openSocket("own-a");
  // Responses passthrough already forces local continuation retention despite
  // store:false. The connection scope confines that existing policy to this socket.
  const first = create(undefined, "swe/argon-1");
  expect(first.store).toBe(false);
  const turn1 = await turn(ws, first);
  expect(turn1.map(f => f.type)).toContain("response.completed");
  const continuation = create("resp-ws-1", "swe/argon-1");
  expect(continuation.store).toBe(false);
  const turn2 = await turn(ws, continuation);
  expect(turn2.map(f => f.type)).toContain("response.completed");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
  expect(sent[1]).toContain("synthetic tool result");
  const foreign = await openSocket("own-a");
  const denied = await turn(foreign, create("resp-ws-1", "swe/argon-1"));
  expect(denied.map(f => f.type)).toContain("error");
  expect(sent).toHaveLength(2);
  // A delegated child's fresh plaintext task has its own connection and own thread.
  const child = await openSocket("child-own-b");
  const fresh = create(undefined, "swe/argon-1");
  fresh.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "SYNTHETIC_CHILD_PLAINTEXT_TASK" }] }];
  expect((await turn(child, fresh)).map(f => f.type)).toContain("response.completed");
  expect(sent).toHaveLength(3);
  expect(sent[2]).toContain("SYNTHETIC_CHILD_PLAINTEXT_TASK");
});

test("Devin store:false keeps no local tool replay; client-carried tool history remains usable", async () => {
  const adapterName = "devin";
  const cfg = config();
  cfg.providers.swe!.adapter = adapterName;
  cfg.providers.swe!.models = ["fixture-model"];
  const model = "swe/fixture-model";
  upstream();
  // Use the registered Devin adapter and its real name/policy. Replace only its
  // cloud executor with deterministic events; no Cognition login or network call.
  const definition = getAdapterDefinition("devin")!;
  const originalCreate = definition.create;
  const factory = spyOn(definition, "create").mockImplementation((provider, context) => {
    const adapter = originalCreate(provider, context);
    expect(adapter.name).toBe("devin");
    adapter.runTurn = async (parsed, _incoming, emit) => {
      expect(parsed._rawBody?.store).toBe(false);
      sent.push(JSON.stringify(parsed.context.messages));
      if (sent.length === 1) {
        emit({ type: "tool_call_start", id: "synthetic-call", name: "collaboration.spawn_agent" });
        emit({ type: "tool_call_delta", arguments: JSON.stringify({ message: "SYNTHETIC_PRIVATE_TASK" }) });
        emit({ type: "tool_call_end" });
      } else emit({ type: "text_delta", text: "routed final reply" });
      emit({ type: "done" });
    };
    return adapter;
  });
  try {
    expect(adapterNeedsToolCallContinuation(adapterName)).toBe(false);
    expect(adapterNeedsForcedContinuation(adapterName)).toBe(false);
    const captured: { scope?: ConnectionReplayScope } = {};
    startScopeServer(cfg, captured);
    const ws = await openSocket("own-store-false");
    const first = create(undefined, model);
    expect(first.store).toBe(false);
    const frames = await turn(ws, first);
    const completed = frames.find(frame => frame.type === "response.completed")!;
    expect(completed).toBeDefined();
    const response = completed.response as { id: string; output: unknown[] };
    // Generic adapter WS intentionally publishes an empty id, so Codex carries
    // history rather than chaining a server-stored response on this path.
    expect(response.id).toBe("");
    expect(response.output.some(item => (item as { type?: string }).type === "function_call")).toBe(true);
    expect(sent).toHaveLength(1);
    expect(captured.scope).toBeDefined();
    expect(responseStateMetrics().count).toBe(0);

    const continuation = create("synthetic-unretained-response", model);
    expect(continuation.store).toBe(false);
    // Supplying a made-up id cannot resurrect the unretained tool call and is
    // refused before the stub executor can receive an incomplete history.
    const partial = await turn(ws, continuation);
    expect(partial.find(frame => frame.type === "error")?.status).toBe(400);
    expect(sent).toHaveLength(1);

    // Existing policy still permits a tool continuation when the caller carries
    // the preceding call and result itself, rather than requiring local storage.
    const full = create(undefined, model);
    full.input = [...first.input as unknown[], ...response.output, ...continuation.input as unknown[]];
    const fullFrames = await turn(ws, full);
    expect(fullFrames.map(frame => frame.type)).toContain("response.completed");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
    expect(sent[1]).toContain("synthetic tool result");
    const final = fullFrames.find(frame => frame.type === "response.completed")!.response as { id: string };
    expect(final.id).toBe("");
    expect(responseStateMetrics().count).toBe(0);
  } finally { factory.mockRestore(); }
});

test("a keyed loopback upgrade issues no connection scope and retains durable replay after close", async () => {
  const cfg = config();
  cfg.apiKeys = [{ id: "a", key: "synthetic-a" }];
  upstream();
  const captured: { scope?: ConnectionReplayScope } = {};
  startScopeServer(cfg, captured);
  const first = await openSocket("own-keyed", "synthetic-a");
  expect(captured.scope).toBeUndefined();
  expect((await turn(first, create())).map(f => f.type)).toContain("response.completed");
  const closed = new Promise<void>(resolve => { first.onclose = () => resolve(); });
  first.close();
  await closed;
  const second = await openSocket("own-keyed", "synthetic-a");
  expect(captured.scope).toBeUndefined();
  expect((await turn(second, create("resp-ws-1"))).map(f => f.type)).toContain("response.completed");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
});
