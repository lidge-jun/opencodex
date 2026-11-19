/**
 * Handler-level coverage for the connection-owned replay scope on the V2
 * plaintext path. A Design-B loopback install admits WebSocket callers with no
 * credential (auth-cors.ts:748), so the upgrade mints a per-socket replay scope
 * (src/responses/state/connection-scope.ts) that backfills the replay owner key
 * — only while the socket lives, only for the handshake thread.
 *
 * These cases pass the minted scope through HandleResponsesOptions.replayScope
 * the same way the /v1/responses upgrade does; the real-socket end-to-end proof
 * lives in response-replay-connection-scope-ws.test.ts.
 *
 *   A. unidentified loopback WS, same scope + thread: first send 200, continuation 200.
 *   B. cross-connection scope, HTTP transport, forged thread, released/expired/forged
 *      handle: the continuation keeps the explicit previous_response_not_found 400.
 *   C. a keyed caller keeps the durable path even with a scope attached; a scope
 *      cannot read a keyed entry and a fresh child task on a new connection is fine.
 *   D. routed provider (SWE/Argon-style delegation target) and the combo path replay
 *      on the same scope; the minted key never leaves the process.
 *   Every step counts upstream sends so a refusal can never create duplicate billing.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses";
import {
  clearResponseStateForTests, responseStateMetrics, sweepExpiredResponseStates,
  mintConnectionReplayScope, connectionReplayScopeOwnerKey, releaseConnectionReplayScope,
  type ConnectionReplayScope,
} from "../../src/responses/state";
import { CONNECTION_REPLAY_SCOPE_TTL_MS } from "../../src/responses/state/connection-scope";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const originalCatalog = process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;
let release: () => void;
let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-conn-scope-req-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = "fresh";
  clearResponseStateForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCatalog === undefined) delete process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE;
  else process.env.OPENCODEX_APP_SERVER_CATALOG_STATE_OVERRIDE = originalCatalog;
  try { release(); } finally {
    try { clearResponseStateForTests(); } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  }
});

const LOOPBACK = { kind: "loopback", source: "loopback" } as const satisfies DataPlaneAdmission;

function config(mode: "v1" | "v2-plaintext", opts: { keyed?: boolean; combo?: boolean } = {}): OcxConfig {
  return {
    defaultProvider: "native", multiAgentMode: mode,
    providers: {
      native: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward", upstreamWebsocket: false,
        fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch },
      // Routed delegation target: a SWE/Argon-style second provider with its own upstream.
      swe: { adapter: "openai-responses", baseUrl: "https://swe-fixture.invalid/v1", authMode: "key",
        apiKey: "swe-fixture-key", models: ["argon-1"], fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch },
    },
    ...(opts.keyed ? { apiKeys: [{ id: "a", key: "synthetic-a" }, { id: "b", key: "synthetic-b" }] } : {}),
    ...(opts.combo ? { combos: { owned: { strategy: "failover", targets: [{ provider: "native", model: "gpt-5.6-sol" }] } } } : {}),
  } as OcxConfig;
}

function request(opts: { previous?: string; key?: string; own?: string; parent?: string; model?: string; omitStore?: boolean }): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json",
      ...(opts.key ? { "x-opencodex-api-key": opts.key } : {}),
      ...(opts.own ? { "thread-id": opts.own } : {}),
      ...(opts.parent ? { "x-codex-parent-thread-id": opts.parent } : {}) },
    body: JSON.stringify({ model: opts.model ?? "native/gpt-5.6-sol", ...(opts.omitStore ? {} : { store: false }), stream: true,
      ...(opts.previous ? { previous_response_id: opts.previous } : {}),
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "synthetic public request" }] }],
      tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent",
        parameters: { type: "object", properties: { message: { type: "string", encrypted: true } } } }] }],
    }),
  });
}

let responseCounter = 0;
function upstream(): { sent: string[]; urls: string[] } {
  const sent: string[] = [];
  const urls: string[] = [];
  globalThis.fetch = (async (url, init) => {
    sent.push(String(init?.body));
    urls.push(String(url));
    responseCounter += 1;
    // A routed openai-responses provider streams: answer it with SSE, while the canonical
    // forward path keeps the proven JSON shape.
    if (String(url).includes("swe-fixture.invalid")) {
      const id = "resp-conn-" + responseCounter;
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
    return Response.json({ id: "resp-conn-" + responseCounter, status: "completed",
      output: responseCounter === 1 ? [{ type: "function_call", call_id: "synthetic-call", namespace: "collaboration-optimize",
        name: "start_delegated_task", arguments: JSON.stringify({ message: "SYNTHETIC_PRIVATE_TASK" }), encrypted_function_args: [] }] : [] });
  }) as typeof fetch;
  return { sent, urls };
}

async function send(
  cfg: OcxConfig,
  opts: Parameters<typeof request>[0],
  transport?: "websocket",
  scope?: ConnectionReplayScope,
) {
  const response = await handleResponses(request(opts), cfg, { model: "", provider: "" }, {
    admission: LOOPBACK, inboundWire: "responses",
    ...(transport ? { inboundTransport: transport } : {}),
    ...(scope ? { replayScope: scope } : {}),
  });
  const bodyText = await response.text();
  let code: unknown = null;
  try { code = (JSON.parse(bodyText).error ?? {}).code ?? null; } catch { /* stream */ }
  return { status: response.status, code, body: bodyText };
}

test("A: unidentified loopback WS same scope and thread replays the continuation", async () => {
  responseCounter = 0;
  const cfg = config("v2-plaintext");
  const { sent } = upstream();
  const scope = mintConnectionReplayScope("own-a")!;
  const first = await send(cfg, { own: "own-a" }, "websocket", scope);
  const second = await send(cfg, { own: "own-a", previous: "resp-conn-1" }, "websocket", scope);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(sent).toHaveLength(2);
  // The continuation reached the upstream with the retained plaintext task expanded.
  expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
  expect(sent[1]).toContain("collaboration-optimize");
  // The minted owner key never leaves the process — not upstream, not to the client.
  const key = connectionReplayScopeOwnerKey(scope)!;
  expect(sent.join("")).not.toContain(key);
  expect(first.body + second.body).not.toContain(key);
});

test("B: every authority boundary keeps the explicit 400", async () => {
  responseCounter = 0;
  const cfg = config("v2-plaintext");
  const { sent } = upstream();
  const scope = mintConnectionReplayScope("own-a")!;
  expect((await send(cfg, { own: "own-a" }, "websocket", scope)).status).toBe(200);
  expect(sent).toHaveLength(1);

  // Another socket minted its own scope: the response id is foreign to it.
  const other = mintConnectionReplayScope("own-a")!;
  const crossConn = await send(cfg, { own: "own-a", previous: "resp-conn-1" }, "websocket", other);
  expect(crossConn.status).toBe(400);
  expect(crossConn.code).toBe("previous_response_not_found");

  // HTTP has no socket, hence no scope: same explicit refusal.
  const httpCont = await send(cfg, { own: "own-a", previous: "resp-conn-1" });
  expect(httpCont.status).toBe(400);
  expect(httpCont.code).toBe("previous_response_not_found");

  // A frame claiming a different own-thread cannot use this socket's scope.
  const forgedThread = await send(cfg, { own: "own-b", previous: "resp-conn-1" }, "websocket", scope);
  expect(forgedThread.status).toBe(400);

  // A literal cast into the option shape holds no issuance record.
  const forged = { ownerKey: connectionReplayScopeOwnerKey(scope), ownThread: "own-a" } as unknown as ConnectionReplayScope;
  const forgedHandle = await send(cfg, { own: "own-a", previous: "resp-conn-1" }, "websocket", forged);
  expect(forgedHandle.status).toBe(400);

  // Closing the socket drops the scope and its entries.
  releaseConnectionReplayScope(scope);
  const afterClose = await send(cfg, { own: "own-a", previous: "resp-conn-1" }, "websocket", scope);
  expect(afterClose.status).toBe(400);

  // No refusal ever dispatched upstream: one send total, no duplicate billing.
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("synthetic public request");
});

test("B: the original scope and its newer response expire at the handshake deadline", async () => {
  responseCounter = 0;
  const cfg = config("v2-plaintext");
  const { sent } = upstream();
  const deadline = Date.now() + CONNECTION_REPLAY_SCOPE_TTL_MS;
  const scope = mintConnectionReplayScope("own-a", deadline - CONNECTION_REPLAY_SCOPE_TTL_MS)!;
  const clock = spyOn(Date, "now").mockReturnValue(deadline - 60_000);
  try {
    expect((await send(cfg, { own: "own-a" }, "websocket", scope)).status).toBe(200);
    expect(responseStateMetrics().count).toBe(1);
    expect(sweepExpiredResponseStates()).toBe(0);

    clock.mockReturnValue(deadline);
    expect(sweepExpiredResponseStates()).toBe(1);
    expect(responseStateMetrics().count).toBe(0);
    const afterExpiry = await send(cfg, { own: "own-a", previous: "resp-conn-1" }, "websocket", scope);
    expect(afterExpiry.status).toBe(400);
    expect(afterExpiry.code).toBe("previous_response_not_found");
    expect(sent).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
});

for (const closed of [false, true]) test(`B: an in-flight completion retains state only for a live scope (closed=${closed})`, async () => {
  responseCounter = 0;
  const cfg = config("v2-plaintext");
  // Gate the upstream so the turn is provably still in the pipeline when the socket closes.
  const sent: string[] = [];
  let releaseUpstream!: () => void;
  const gate = new Promise<void>(resolve => { releaseUpstream = resolve; });
  globalThis.fetch = (async (_url, init) => {
    sent.push(String(init?.body));
    responseCounter += 1;
    await gate;
    return Response.json({ id: "resp-conn-" + responseCounter, status: "completed",
      output: [{ type: "function_call", call_id: "synthetic-call", namespace: "collaboration-optimize",
        name: "start_delegated_task", arguments: "{}", encrypted_function_args: [] }] });
  }) as typeof fetch;
  const scope = mintConnectionReplayScope("own-a")!;
  const inFlight = send(cfg, { own: "own-a" }, "websocket", scope);
  for (let i = 0; i < 1000 && sent.length === 0; i++) await new Promise(r => setTimeout(r, 1));
  expect(sent).toHaveLength(1);
  if (closed) releaseConnectionReplayScope(scope);
  releaseUpstream();
  expect((await inFlight).status).toBe(200);
  expect(responseStateMetrics().count).toBe(closed ? 0 : 1);
  const reconnect = mintConnectionReplayScope("own-a")!;
  const cont = await send(cfg, { own: "own-a", previous: "resp-conn-1" }, "websocket", reconnect);
  expect(cont.status).toBe(400);
  expect(cont.code).toBe("previous_response_not_found");
  expect(sent).toHaveLength(1);
});

for (const lane of ["direct", "combo-auto", "combo-disabled"] as const) for (const transport of ["websocket", "http"] as const) {
  test(`review boundary: released scoped IDs cannot use a gateway's stored history (${lane}, ${transport})`, async () => {
    responseCounter = 0;
    const cfg = config("v2-plaintext", { combo: lane !== "direct" });
    if (cfg.combos) cfg.combos.owned = {
      strategy: "failover", imageInput: lane === "combo-disabled" ? "disabled" : "auto",
      targets: [{ provider: "swe", model: "argon-1" }],
    };
    const { sent } = upstream();
    const scope = mintConnectionReplayScope("own-a")!;
    const model = lane === "direct" ? "swe/argon-1" : "combo/owned";
    expect((await send(cfg, { own: "own-a", model, omitStore: true }, "websocket", scope)).status).toBe(200);
    expect(responseStateMetrics().count).toBe(1);
    releaseConnectionReplayScope(scope);
    expect(responseStateMetrics().count).toBe(0);
    const reconnect = mintConnectionReplayScope("own-a")!;
    const result = await send(cfg, { own: "own-a", model, previous: "resp-conn-1", omitStore: true },
      transport === "websocket" ? "websocket" : undefined, reconnect);
    expect(result.status).toBe(400);
    expect(result.code).toBe("previous_response_not_found");
    expect(sent).toHaveLength(1);
    const fresh = await send(cfg, { own: "own-a", model, omitStore: true }, "websocket", reconnect);
    expect(fresh.status).toBe(200);
    expect(sent).toHaveLength(2);
  });
}

for (const mode of ["v1", "v2-plaintext"] as const) test(`review boundary: keyed gateway misses require local ownership only in strict mode (${mode})`, async () => {
  responseCounter = 0;
  const cfg = config(mode, { keyed: true });
  const { sent } = upstream();
  const result = await send(cfg, { own: "own-a", key: "synthetic-a", model: "swe/argon-1", previous: "unknown-gateway-id" });
  expect(result.status).toBe(mode === "v2-plaintext" ? 400 : 200);
  expect(sent).toHaveLength(mode === "v2-plaintext" ? 0 : 1);
  if (mode === "v2-plaintext") expect(result.code).toBe("previous_response_not_found");
});

test("C: a keyed caller keeps the durable path even with a scope attached", async () => {
  responseCounter = 0;
  const cfg = config("v2-plaintext", { keyed: true });
  const { sent } = upstream();
  const scope = mintConnectionReplayScope("own-a")!;
  // The credential-derived owner wins: the scope is not consulted, and the stored
  // entry is bound to the key, not the socket.
  const first = await send(cfg, { own: "own-a", key: "synthetic-a" }, "websocket", scope);
  const replay = await send(cfg, { own: "own-a", key: "synthetic-a", previous: "resp-conn-1" }, "websocket", scope);
  expect(first.status).toBe(200);
  expect(replay.status).toBe(200);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
  // The same response id is NOT shared with an unkeyed scope on the same thread —
  // parent and child delegate over different connections and gain no sharing authority.
  const unkeyedScope = mintConnectionReplayScope("own-a")!;
  const crossKey = await send(cfg, { own: "own-a", previous: "resp-conn-1" }, "websocket", unkeyedScope);
  expect(crossKey.status).toBe(400);
  expect(sent).toHaveLength(2);
});

test("C: a fresh plaintext task on a new connection is allowed at the boundary", async () => {
  responseCounter = 0;
  const cfg = config("v2-plaintext");
  const { sent } = upstream();
  const parent = mintConnectionReplayScope("own-a")!;
  expect((await send(cfg, { own: "own-a" }, "websocket", parent)).status).toBe(200);
  // The delegated child's own connection mints its own scope: its fresh task sends
  // normally — only sharing the parent's response id is denied.
  const child = mintConnectionReplayScope("own-b")!;
  expect((await send(cfg, { own: "own-b" }, "websocket", child)).status).toBe(200);
  expect(sent).toHaveLength(2);
});

test("D: a routed provider turn replays on the same connection scope", async () => {
  responseCounter = 0;
  const cfg = config("v2-plaintext");
  const { sent, urls } = upstream();
  const scope = mintConnectionReplayScope("own-a")!;
  // A routed adapter retains only requests that do not suppress storage: store:false
  // retention is an explicit adapter opt-in (core-replay.ts), so this turn stores normally.
  const first = await send(cfg, { own: "own-a", model: "swe/argon-1", omitStore: true }, "websocket", scope);
  const second = await send(cfg, { own: "own-a", previous: "resp-conn-1", model: "swe/argon-1", omitStore: true }, "websocket", scope);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(sent).toHaveLength(2);
  // Both dispatches went to the routed upstream, and the second carried the replay.
  expect(urls[0]).toContain("swe-fixture.invalid");
  expect(urls[1]).toContain("swe-fixture.invalid");
  expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
});

test("D: the combo path replays on the same connection scope", async () => {
  responseCounter = 0;
  const cfg = config("v2-plaintext", { combo: true });
  const { sent } = upstream();
  const scope = mintConnectionReplayScope("own-a")!;
  const first = await send(cfg, { own: "own-a", model: "combo/owned" }, "websocket", scope);
  const second = await send(cfg, { own: "own-a", previous: "resp-conn-1", model: "combo/owned" }, "websocket", scope);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
});

test("v1 mode is unchanged: a scope is ignored and unscoped loopback replay still works", async () => {
  responseCounter = 0;
  const cfg = config("v1");
  const { sent } = upstream();
  const scope = mintConnectionReplayScope("own-a")!;
  expect((await send(cfg, { own: "own-a" }, "websocket", scope)).status).toBe(200);
  const cont = await send(cfg, { own: "own-a", previous: "resp-conn-1" }, "websocket", scope);
  // Legacy behavior: an unidentified loopback continuation still expands without owner
  // binding — the scope changes nothing about the v1 contract.
  expect(cont.status).toBe(200);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toContain("SYNTHETIC_PRIVATE_TASK");
});
