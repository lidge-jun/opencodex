import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { codexWebSocketAdmissionMetrics, MAX_TRACKED_CODEX_WEBSOCKETS } from "../../src/codex/websocket-registry";
import {
  clearResponseStateForTests, clearResponseStateMemoryForTests, RESPONSE_TTL_MS,
  responseStateMetrics, sweepExpiredResponseStates,
} from "../../src/responses/state";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const MODEL = "fixture/capacity-model";
const REPLAY_API_KEY = "synthetic-capacity-replay-owner";
const OTHER_REPLAY_API_KEY = "synthetic-capacity-other-owner";
type Frame = Record<string, any>;
type Client = { socket: WebSocket; frames: Frame[]; closed?: CloseEvent; error?: Event };
let home: string;
let codex: IsolatedCodexHome;
let proxy: ReturnType<typeof startServer> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let finishStream: (() => void) | undefined;
let upstreamRequests = 0;
let upstreamCancellations = 0;
let heldUpstreamSignal: AbortSignal | undefined;
const upstreamBodies: Frame[] = [];
const upstreamHeaders: Headers[] = [];
const clients: Client[] = [];
const refusedHandshakes = new Map<string, { status: number; retryAfter: string | null }>();
let closeReleaseDelayMs = 0;

async function until(condition: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await Bun.sleep(2);
  }
}

function sse(event: Frame): Uint8Array {
  return new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-ws-capacity-"));
  process.env.OPENCODEX_HOME = home;
  clearResponseStateMemoryForTests();
  codex = installIsolatedCodexHome("ocx-ws-capacity-codex-");
  upstreamRequests = 0;
  upstreamCancellations = 0;
  heldUpstreamSignal = undefined;
  upstreamBodies.length = 0;
  upstreamHeaders.length = 0;
  finishStream = undefined;
  refusedHandshakes.clear();
  closeReleaseDelayMs = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error("Capacity fixture forbids external requests");
    }
    if (url.port === String(upstream?.port) && String(init?.body).includes("hold-fixture-stream")) {
      heldUpstreamSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  upstream = Bun.serve({
    // Only proxy cancellation may end a held response; Bun's default idle timeout must not.
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const body = await request.json() as Frame;
      upstreamRequests++;
      upstreamBodies.push(body);
      upstreamHeaders.push(request.headers);
      const id = `resp_capacity_${upstreamRequests}`;
      const tool = JSON.stringify(body.input).includes("request-fixture-tool");
      const hold = JSON.stringify(body.input).includes("hold-fixture-stream");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse({ type: "response.created", response: { id, status: "in_progress", output: [] } }));
          const output = tool
            ? [{ type: "function_call", id: "fc_capacity", call_id: "call_capacity", name: "fixture_tool", arguments: "{}" }]
            : [{ type: "message", id: "msg_capacity", role: "assistant", content: [{ type: "output_text", text: "capacity fixture completed" }] }];
          const finish = () => {
            if (tool) controller.enqueue(sse({ type: "response.output_item.done", output_index: 0, item: output[0] }));
            controller.enqueue(sse({ type: "response.completed", response: { id, status: "completed", output,
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
            controller.close();
          };
          if (hold) finishStream = finish; else finish();
        },
        cancel() { upstreamCancellations++; },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  saveConfig({
    port: 0, hostname: "127.0.0.1", codexAutoStart: false, websockets: true,
    apiKeys: [
      { id: "capacity-replay-owner", key: REPLAY_API_KEY, name: "Replay owner", createdAt: "2026-10-01T00:00:00.000Z" },
      { id: "capacity-other-owner", key: OTHER_REPLAY_API_KEY, name: "Other owner", createdAt: "2026-10-01T00:00:00.000Z" },
    ],
    defaultProvider: "fixture", providers: { fixture: {
      adapter: "openai-responses", baseUrl: `${upstream.url}v1`, apiKey: "sk-capacity-fixture", upstreamWebsocket: false,
      allowPrivateNetwork: true, statelessResponses: true,
    } },
  } as OcxConfig);
  expect(codexWebSocketAdmissionMetrics().active).toBe(0);
  // Observe actual upgrade refusals; delay only the fixture close callback in the delayed row.
  const originalServe = Bun.serve;
  const serveSpy = spyOn(Bun, "serve").mockImplementation(((options: any) => originalServe({
    ...options,
    async fetch(request: Request, server: any) {
      const response = await options.fetch(request, server);
      const attempt = new URL(request.url).searchParams.get("capacity-attempt");
      if (attempt !== null && response) refusedHandshakes.set(attempt,
        { status: response.status, retryAfter: response.headers.get("retry-after") });
      return response;
    },
    websocket: { ...options.websocket, close(...args: any[]) {
      if (closeReleaseDelayMs) setTimeout(() => options.websocket.close(...args), closeReleaseDelayMs);
      else options.websocket.close(...args);
    } },
  })) as typeof Bun.serve);
  try { proxy = startServer(0); } finally { serveSpy.mockRestore(); }
});

afterEach(async () => {
  try {
    for (const client of clients) client.socket.close();
    await proxy?.stop(true);
    await upstream?.stop(true);
    await until(() => codexWebSocketAdmissionMetrics().active === 0, "all socket reservations released");
  } finally {
    clients.length = 0;
    proxy = undefined;
    upstream = undefined;
    globalThis.fetch = originalFetch;
    clearResponseStateForTests();
    codex.restore();
    removeTreeWithRetry(home);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  }
});

async function connect(headers?: Record<string, string>, retriesRemaining = MAX_TRACKED_CODEX_WEBSOCKETS): Promise<Client> {
  const url = new URL("/v1/responses", proxy!.url);
  url.protocol = "ws:";
  const attempt = String(clients.length);
  url.searchParams.set("capacity-attempt", attempt);
  const client: Client = { socket: new WebSocket(url, { headers }), frames: [] };
  clients.push(client);
  client.socket.addEventListener("message", event => client.frames.push(JSON.parse(String(event.data))));
  client.socket.addEventListener("close", event => { client.closed = event; });
  client.socket.addEventListener("error", event => { client.error = event; });
  await until(() => client.socket.readyState === WebSocket.OPEN || Boolean(client.error || client.closed), "socket handshake");
  if (client.socket.readyState !== WebSocket.OPEN) {
    expect(refusedHandshakes.get(attempt)).toEqual({ status: 503, retryAfter: "1" });
    await until(() => codexWebSocketAdmissionMetrics().active < MAX_TRACKED_CODEX_WEBSOCKETS,
      "reclaimed socket releases admission before retry");
    expect(retriesRemaining).toBeGreaterThan(0);
    return connect(headers, retriesRemaining - 1);
  }
  return client;
}

async function fill(): Promise<Client[]> {
  const opened: Client[] = [];
  for (let i = 0; i < MAX_TRACKED_CODEX_WEBSOCKETS; i++) opened.push(await connect());
  return opened;
}

async function exchange(client: Client, fields: Frame, terminal = "response.completed"): Promise<Frame> {
  const start = client.frames.length;
  client.socket.send(JSON.stringify({ type: "response.create", model: MODEL, input: "fixture input", ...fields }));
  await until(() => client.frames.slice(start).some(frame => frame.type === terminal || frame.type === "error")
    || Boolean(client.closed), `socket ${terminal}`);
  const result = client.frames.slice(start).find(frame => frame.type === terminal || frame.type === "error");
  expect(result?.type).toBe(terminal);
  return result!;
}

function expectBounded(): void {
  const metrics = codexWebSocketAdmissionMetrics();
  expect(metrics.active).toBe(MAX_TRACKED_CODEX_WEBSOCKETS);
  expect(metrics.peak).toBe(MAX_TRACKED_CODEX_WEBSOCKETS);
  expect(metrics.releaseMisses).toBe(0);
}

test.each([0, 20])("the 129th handshake reclaims the least recently used idle socket and reconnects cleanly; close delay=%s", async delay => {
  closeReleaseDelayMs = delay;
  const opened = await fill();
  expect(opened.every(client => client.socket.readyState === WebSocket.OPEN)).toBe(true);
  await exchange(opened[0]!, { generate: false });
  expect(upstreamRequests).toBe(0);
  const replacement = await connect();
  await until(() => Boolean(opened[1]!.closed), "least recently used idle socket closed");
  expect(opened[1]!.closed?.code).toBe(1001);
  if (delay) expect([...refusedHandshakes.values()].some(response => response.status === 503)).toBe(true);
  expect(opened[0]!.socket.readyState).toBe(WebSocket.OPEN);
  expectBounded();
  await exchange(replacement, { input: "fresh request after capacity recovery" });
  expect(upstreamRequests).toBe(1);
  const reconnected = await connect();
  await exchange(reconnected, { input: "resubmitted full conversation" });
  expect(upstreamRequests).toBe(2);
  expectBounded();
}, 15_000);

test("concurrent handshakes replace idle sockets without over-admitting or leaking leases", async () => {
  const opened = await fill();
  const added = await Promise.all(Array.from({ length: 16 }, () => connect()));
  await until(() => opened.filter(client => client.closed).length === 16, "all reclaimed clients closed");
  expect(opened.slice(0, 16).every(client => client.closed?.code === 1001)).toBe(true);
  expect(opened.slice(16).every(client => client.socket.readyState === WebSocket.OPEN)).toBe(true);
  expect(added.every(client => client.socket.readyState === WebSocket.OPEN)).toBe(true);
  expectBounded();
}, 15_000);

test("capacity pressure preserves a streaming response until it completes", async () => {
  const opened = await fill();
  await exchange(opened[0]!, { input: "hold-fixture-stream" }, "response.created");
  // Refresh every idle socket so the busy connection is the oldest by activity too.
  for (const client of opened.slice(1)) await exchange(client, { generate: false });
  await connect();
  await until(() => Boolean(opened[1]!.closed), "oldest eligible idle socket closed");
  expect(opened[0]!.socket.readyState).toBe(WebSocket.OPEN);
  finishStream!();
  await until(() => opened[0]!.frames.some(frame => frame.type === "response.completed"), "protected stream completes");
  expect(opened[0]!.frames.some(frame => frame.type === "error")).toBe(false);
  expectBounded();
}, 15_000);

test("client tool execution stays protected, and all-busy saturation keeps the 503 refusal", async () => {
  const opened = await fill();
  for (const client of opened) {
    await exchange(client, { input: "request-fixture-tool", tools: [{ type: "function", name: "fixture_tool",
      parameters: { type: "object", properties: {} } }] });
  }
  const rejectedBefore = codexWebSocketAdmissionMetrics().rejected;
  const response = await fetch(new URL("/v1/responses", proxy!.url), { headers: {
    connection: "upgrade", upgrade: "websocket", "sec-websocket-version": "13",
    "sec-websocket-key": Buffer.from("capacity-fixture").toString("base64"),
  } });
  expect(response.status).toBe(503);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(await response.text()).toContain("Codex WebSockets capacity reached");
  expect(codexWebSocketAdmissionMetrics().rejected).toBe(rejectedBefore + 1);
  expect(opened.every(client => client.socket.readyState === WebSocket.OPEN)).toBe(true);
  await exchange(opened[0]!, { input: [{ type: "function_call_output", call_id: "call_capacity", output: "fixture tool result" }] });
  await connect();
  await until(() => Boolean(opened[0]!.closed), "completed tool workflow becomes reclaimable");
  expect(opened.slice(1).every(client => client.socket.readyState === WebSocket.OPEN)).toBe(true);
  expectBounded();
}, 20_000);

test.each([false, true])("disconnect releases admission and allows a fresh request; abrupt=%s", async abrupt => {
  const baseline = codexWebSocketAdmissionMetrics();
  const client = await connect();
  expect(codexWebSocketAdmissionMetrics().active).toBe(baseline.active + 1);
  if (abrupt) {
    await exchange(client, { input: "hold-fixture-stream" }, "response.created");
    expect(heldUpstreamSignal).toBeDefined();
    expect(heldUpstreamSignal!.aborted).toBe(false);
    // Bun's client API terminates the real TCP connection without a closing handshake.
    client.socket.terminate();
  } else client.socket.close(1000, "fixture normal disconnect");
  await until(() => codexWebSocketAdmissionMetrics().active === baseline.active,
    "disconnected socket releases its reservation", 10_000);
  await until(() => Boolean(client.closed), "client observes close", 10_000);
  expect(client.closed?.code).toBe(abrupt ? 1006 : 1000);
  const replacement = await connect();
  await exchange(replacement, { input: "fresh request after disconnect" });
  expect(upstreamRequests).toBe(abrupt ? 2 : 1);
  replacement.socket.close();
  await until(() => codexWebSocketAdmissionMetrics().active === baseline.active, "replacement reservation released");
  expect(codexWebSocketAdmissionMetrics().releaseMisses).toBe(baseline.releaseMisses);
  // Eager relay preserves a real terminal during its existing 15-second discard-drain.
  // Socket admission and the replacement request must recover before that separate cleanup.
  if (abrupt) {
    await until(() => heldUpstreamSignal!.aborted, "abandoned upstream request aborted", 20_000);
    await until(() => upstreamCancellations === 1, "upstream observed request cancellation");
  }
}, 25_000);

test("failed HTTP upgrade releases its reservation before the next handshake", async () => {
  const baseline = codexWebSocketAdmissionMetrics();
  const response = await fetch(new URL("/v1/responses", proxy!.url), { headers: {
    connection: "upgrade", upgrade: "websocket", "sec-websocket-version": "13",
    // Missing Sec-WebSocket-Key reaches Bun's unsuccessful upgrade after reservation.
  } });
  expect(response.status).toBe(426);
  expect(await response.text()).toContain("WebSocket upgrade failed");
  expect(codexWebSocketAdmissionMetrics()).toMatchObject({ active: baseline.active,
    admitted: baseline.admitted + 1, rejected: baseline.rejected, releaseMisses: baseline.releaseMisses });
  const replacement = await connect();
  await exchange(replacement, { input: "fresh request after failed handshake" });
  expect(upstreamRequests).toBe(1);
  expect(codexWebSocketAdmissionMetrics().active).toBe(baseline.active + 1);
});

test.each([false, true])("stateless continuation after capacity reclamation preserves full history; expired=%s", async expired => {
  const headers = { "x-opencodex-api-key": REPLAY_API_KEY, "thread-id": "capacity-replay-thread" };
  const original = await connect(headers);
  const firstInput = { role: "user", content: [{ type: "input_text", text: "Remember the fixture number 47." }] };
  const first = await exchange(original, { input: [firstInput], store: false });
  const previousId = first.response.id;
  expect(typeof previousId).toBe("string");
  expect(previousId.length).toBeGreaterThan(0);
  await until(() => responseStateMetrics().count === 1, "first response retains real continuation state");
  for (let i = 1; i < MAX_TRACKED_CODEX_WEBSOCKETS; i++) await connect();
  const reconnected = await connect(headers);
  await until(() => original.closed?.code === 1001, "socket holding the response ID reclaimed");
  if (expired) {
    expect(sweepExpiredResponseStates(Date.now() + RESPONSE_TTL_MS + 60_000)).toBe(1);
    expect(responseStateMetrics().count).toBe(0);
  }
  const delta = { role: "user", content: [{ type: "input_text", text: "Use that number in the next answer." }] };
  const outcome = await exchange(reconnected, { previous_response_id: previousId, input: [delta], store: false },
    expired ? "error" : "response.completed");
  if (expired) {
    expect(outcome).toMatchObject({ type: "error", status: 400, error: { code: "previous_response_not_found" } });
    expect(upstreamRequests).toBe(1); // Never forward the delta without its missing prefix.
    await exchange(reconnected, { input: [firstInput, ...first.response.output, delta], store: false });
  }
  expect(upstreamRequests).toBe(2); // One initial response and one complete continuation, without a duplicate execution.
  expect(upstreamBodies[1]!.previous_response_id).toBeUndefined();
  expect(upstreamBodies[1]!.input).toHaveLength(3);
  expect(upstreamBodies[1]!.input).toMatchObject([firstInput,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "capacity fixture completed" }] }, delta]);
  for (const forwarded of upstreamHeaders) {
    expect(forwarded.has("x-opencodex-api-key")).toBe(false);
    expect(forwarded.get("authorization")).toBe("Bearer sk-capacity-fixture");
    expect([...forwarded.values()].some(value => value.includes(REPLAY_API_KEY))).toBe(false);
  }
  expectBounded();
}, 15_000);

test.each([
  ["different caller", { "x-opencodex-api-key": OTHER_REPLAY_API_KEY, "thread-id": "owned-thread" }],
  ["different own thread", { "x-opencodex-api-key": REPLAY_API_KEY, "thread-id": "other-thread" }],
  ["parent thread only", { "x-opencodex-api-key": REPLAY_API_KEY, "x-codex-parent-thread-id": "owned-thread" }],
  ["no caller key", { "thread-id": "owned-thread" }],
] as const)("real WebSocket ingress refuses owned continuation for %s despite body identity claims", async (_label, headers) => {
  const original = await connect({ "x-opencodex-api-key": REPLAY_API_KEY, "thread-id": "owned-thread" });
  const first = await exchange(original, { input: "private owner history", store: false });
  await until(() => responseStateMetrics().count === 1, "owner response is retained");
  const intruder = await connect(headers);
  const denied = await exchange(intruder, {
    previous_response_id: first.response.id, input: "untrusted delta",
    "thread-id": "owned-thread", "x-opencodex-api-key": REPLAY_API_KEY,
    replayPrincipal: { clientPrincipalId: "claimed-principal" },
    admission: { kind: "configured", keyId: "capacity-replay-owner", contextPrincipalId: "claimed-principal" },
  }, "error");
  expect(denied).toMatchObject({ status: 400, error: { code: "previous_response_not_found" } });
  expect(upstreamRequests).toBe(1);
  // Refusal does not consume or rebind the original owner's retained state.
  await exchange(original, { previous_response_id: first.response.id, input: "authorized delta", store: false });
  expect(upstreamRequests).toBe(2);
  expect(JSON.stringify(upstreamBodies[1]!.input)).toContain("private owner history");
});

test("a revoked captured environment key cannot fall back to another handshake bearer", async () => {
  const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
  try {
    process.env.OPENCODEX_API_AUTH_TOKEN = "synthetic-capacity-environment-owner";
    const headers = { "x-opencodex-api-key": process.env.OPENCODEX_API_AUTH_TOKEN,
      authorization: `Bearer ${OTHER_REPLAY_API_KEY}`, "thread-id": "rotation-thread" };
    const original = await connect(headers);
    const first = await exchange(original, { input: "environment-owned history", store: false });
    const bearerOwner = await connect({ authorization: headers.authorization, "thread-id": headers["thread-id"] });
    const bearerFirst = await exchange(bearerOwner, { input: "other caller history", store: false });
    await until(() => responseStateMetrics().count === 2, "both callers retain separately owned state");
    process.env.OPENCODEX_API_AUTH_TOKEN = "synthetic-capacity-environment-replacement";
    for (const id of [first.response.id, bearerFirst.response.id]) {
      const refused = await exchange(original, { previous_response_id: id, input: "delta after revocation" }, "error");
      expect(refused).toMatchObject({ status: 400, error: { code: "previous_response_not_found" } });
    }
    expect(upstreamRequests).toBe(2);
    const replacement = await connect({ "x-opencodex-api-key": process.env.OPENCODEX_API_AUTH_TOKEN,
      "thread-id": headers["thread-id"] });
    const refused = await exchange(replacement, { previous_response_id: first.response.id, input: "new key delta" }, "error");
    expect(refused).toMatchObject({ status: 400, error: { code: "previous_response_not_found" } });
    expect(upstreamRequests).toBe(2);
    await exchange(replacement, { input: "full conversation after rotation", store: false });
    expect(upstreamRequests).toBe(3);
    expect(upstreamHeaders.every(headers => !headers.has("x-opencodex-api-key"))).toBe(true);
  } finally {
    if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
    else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
  }
});

test("a surviving bearer keeps per-turn identity resolution ahead of a dropped x-api-key", async () => {
  const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
  try {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    const original = await connect({ authorization: `Bearer ${REPLAY_API_KEY}`, "x-api-key": OTHER_REPLAY_API_KEY,
      "thread-id": "bearer-thread" });
    const first = await exchange(original, { input: "configured bearer history", store: false });
    await until(() => responseStateMetrics().count === 1, "configured bearer response is retained");
    // The same raw bearer now resolves to a different principal under the existing
    // environment-before-configured precedence. No captured holder may freeze it.
    process.env.OPENCODEX_API_AUTH_TOKEN = REPLAY_API_KEY;
    const refused = await exchange(original, { previous_response_id: first.response.id, input: "old owner delta" }, "error");
    expect(refused).toMatchObject({ status: 400, error: { code: "previous_response_not_found" } });
    expect(upstreamRequests).toBe(1);
    const current = await exchange(original, { input: "current environment bearer history", store: false });
    const reconnected = await connect({ authorization: `Bearer ${REPLAY_API_KEY}`, "thread-id": "bearer-thread" });
    await exchange(reconnected, { previous_response_id: current.response.id, input: "current owner delta", store: false });
    expect(upstreamRequests).toBe(3);
    expect(JSON.stringify(upstreamBodies[2]!.input)).toContain("current environment bearer history");
    expect(upstreamHeaders.every(headers => !headers.has("x-api-key"))).toBe(true);
  } finally {
    if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
    else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
  }
});
