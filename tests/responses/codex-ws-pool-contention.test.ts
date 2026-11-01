import { afterEach, expect, test } from "bun:test";
import { setCodexWsReuseAcrossTurns } from "../../src/config/codex-ws-reuse-setting";
import { CODEX_RESPONSES_HTTP_URL, prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { CodexWsPool, codexWsReuseIdentity } from "../../src/server/responses/codex-ws-pool";
import { planCodexWsDial } from "../../src/server/responses/ws-upstream";
import { setCodexWsIncrementalUpload, prepareIncrementalFrame, completeIncrementalFrame } from "../../src/server/responses/codex-ws-incremental";

class Socket extends EventTarget {
  static all: Socket[] = [];
  readyState = 0;
  constructor(readonly url: string) {
    super();
    Socket.all.push(this);
    queueMicrotask(() => {
      if (this.readyState === 0) {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }
    });
  }
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  ref() {}
  unref() {}
}

const realWebSocket = globalThis.WebSocket;
const headers = {
  authorization: "Bearer fixture-token",
  "chatgpt-account-id": "fixture-account",
  "thread-id": "fixture-thread",
};

function frame(turn: string, model = "fixture-model"): string {
  return JSON.stringify({
    model,
    stream: true,
    input: "hello",
    client_metadata: { thread_id: "fixture-thread", turn_id: turn },
  });
}

function identity(turn: string, model = "fixture-model", authorization = headers.authorization, caller?: string) {
  return codexWsReuseIdentity(CODEX_RESPONSES_HTTP_URL, { ...headers, authorization }, frame(turn, model), undefined, undefined, caller);
}

const pools: CodexWsPool[] = [];

afterEach(() => {
  setCodexWsIncrementalUpload(false);
  setCodexWsReuseAcrossTurns(false);
  for (const pool of pools) pool.dispose();
  pools.length = 0;
  for (const socket of Socket.all) socket.close();
  Socket.all = [];
  globalThis.WebSocket = realWebSocket;
});

for (const scenario of [{ name: "four idle minutes", releaseAt: 0, nextAt: 240_000 },
  { name: "twenty-one minutes of socket age", releaseAt: 1_140_000, nextAt: 1_260_000 }]) {
  test(`completed input remains incremental after ${scenario.name}`, async () => {
    setCodexWsIncrementalUpload(true);
    setCodexWsReuseAcrossTurns(true);
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    let now = 0;
    const retained = new CodexWsPool({ now: () => now });
    pools.push(retained);
    const key = identity("turn-a", "fixture-model", headers.authorization, "fixture-caller")!;
    const first = retained.acquire(key, CODEX_RESPONSES_HTTP_URL, headers)!;
    await opened();
    const input = [{ role: "user", content: "context ".repeat(32_768) }];
    const body = { type: "response.create", model: "fixture-model", input, store: false };
    const plan = prepareIncrementalFrame(first, JSON.stringify(body), "fixture-caller")!;
    const output = [{ type: "message", role: "assistant", content: "acknowledged" }];
    completeIncrementalFrame(plan, { id: "resp-retained", status: "completed", output });
    now = scenario.releaseAt;
    first.release("resp-retained");
    now = scenario.nextAt;
    const next = retained.acquire(key, CODEX_RESPONSES_HTTP_URL, headers)!;
    expect(next).toBe(first);
    const full = JSON.stringify({ ...body, input: [...input, ...output, { role: "user", content: "next" }] });
    const delta = prepareIncrementalFrame(next, full, "fixture-caller")!;
    expect(delta.delta).toBe(true);
    expect(delta.sentBytes).toBeLessThan(delta.fullBytes / 100);
    expect(JSON.parse(delta.frameText).input).toEqual([{ role: "user", content: "next" }]);
  });
}

test("incremental sockets still expire after ten idle minutes or fifty minutes of age", async () => {
  setCodexWsIncrementalUpload(true);
  setCodexWsReuseAcrossTurns(true);
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  for (const timing of [{ releaseAt: 0, nextAt: 600_001 }, { releaseAt: 2_940_000, nextAt: 3_000_001 }]) {
    let now = 0;
    const retained = new CodexWsPool({ now: () => now });
    pools.push(retained);
    const key = identity("turn-a", "fixture-model", headers.authorization, "fixture-caller")!;
    const first = retained.acquire(key, CODEX_RESPONSES_HTTP_URL, headers)!;
    await opened();
    now = timing.releaseAt;
    first.release("resp-expiring");
    now = timing.nextAt;
    expect(retained.acquire(key, CODEX_RESPONSES_HTTP_URL, headers)).not.toBe(first);
    expect(first.closed).toBe(true);
  }
});

test("real loopback exchanges send fewer bytes after an idle gap without extra creates", async () => {
  setCodexWsIncrementalUpload(true);
  setCodexWsReuseAcrossTurns(true);
  globalThis.WebSocket = realWebSocket;
  async function run(oldDeadlines: boolean) {
    let now = 0;
    let connections = 0;
    const bytes: number[] = [];
    const creates: Record<string, unknown>[] = [];
    const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch(req, server) { return server.upgrade(req) ? undefined : new Response(null, { status: 400 }); },
      websocket: {
        open() { connections++; },
        message(ws, raw) {
          bytes.push(Buffer.byteLength(String(raw)));
          creates.push(JSON.parse(String(raw)));
          const id = `resp-loopback-${creates.length}`;
          ws.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } }));
          ws.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output,
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }));
        },
      },
    });
    const retained = new CodexWsPool({ now: () => now,
      ...(oldDeadlines ? { idleMs: 180_000, maxAgeMs: 1_200_000 } : {}) });
    const input: unknown[] = [{ role: "user", content: "retained context ".repeat(16_384) }];
    const key = identity("turn-a", "fixture-model", headers.authorization, "fixture-caller")!;
    try {
      for (let turn = 0; turn < 2; turn++) {
        if (turn) { now = 240_000; input.push(...output, { role: "user", content: "next" }); }
        const init: RequestInit = { method: "POST", signal: AbortSignal.timeout(3000), headers,
          body: JSON.stringify({ model: "fixture-model", stream: true, input, store: false }) };
        const prepared = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, init)!;
        const session = retained.acquire(key, `ws://127.0.0.1:${server.port}`, prepared.headers)!;
        const plan = prepareIncrementalFrame(session, prepared.frameText, "fixture-caller")!;
        const response = await codexWsExchange({ session, url: CODEX_RESPONSES_HTTP_URL, init,
          prepared: { ...prepared, frameText: plan.frameText }, incrementalPlan: plan,
          sseFallback: (() => { throw new Error("unexpected HTTP fallback"); }) as typeof fetch,
          bunVersion: Bun.version });
        const body = await response.text();
        expect(body.includes("response.completed")).toBe(true);
      }
      expect(creates.length).toBe(2);
      return { bytes, connections, lastInputCount: (creates[1]!.input as unknown[]).length };
    } finally { retained.dispose(); server.stop(true); }
  }
  const before = await run(true);
  const after = await run(false);
  expect(before.connections).toBe(2);
  expect(after.connections).toBe(1);
  expect(after.lastInputCount).toBe(1);
  expect(after.bytes[1]!).toBeLessThan(before.bytes[1]! / 100);
  console.log(JSON.stringify({ uploadRetentionLoopback: { before, after } }));
});

function pool(): CodexWsPool {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const created = new CodexWsPool({ waitMs: 40 });
  pools.push(created);
  return created;
}

async function opened(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

test("cross-turn reuse keys on account and thread", () => {
  const first = identity("turn-a");
  const second = identity("turn-b");
  expect(first?.scope).not.toBe(second?.scope);
  setCodexWsReuseAcrossTurns(true);
  const reusedFirst = identity("turn-a");
  const reusedSecond = identity("turn-b");
  expect(reusedFirst?.scope).toBe(reusedSecond?.scope);
  expect(reusedFirst?.key).toBe(reusedSecond?.key);
});

test("a model change keeps both warm sockets when reuse is on", async () => {
  setCodexWsReuseAcrossTurns(true);
  const retained = pool();
  const first = identity("turn-a", "model-a");
  const second = identity("turn-a", "model-b");
  expect(retained.acquire(first!, CODEX_RESPONSES_HTTP_URL, headers)).not.toBeNull();
  expect(retained.acquire(second!, CODEX_RESPONSES_HTTP_URL, headers)).not.toBeNull();
  expect(retained.snapshot().size).toBe(2);
  expect(Socket.all).toHaveLength(2);
});

test("an authorization change retires the previous socket", async () => {
  setCodexWsReuseAcrossTurns(true);
  const retained = pool();
  const firstIdentity = identity("turn-a", "model-a", "Bearer first-token");
  const secondIdentity = identity("turn-a", "model-a", "Bearer second-token");
  const first = retained.acquire(firstIdentity!, CODEX_RESPONSES_HTTP_URL, headers);
  await opened();
  retained.acquire(secondIdentity!, CODEX_RESPONSES_HTTP_URL, headers);
  first!.release("response-1");
  expect(retained.snapshot().size).toBe(1);
});

test("a busy socket is waited on before a throwaway dial", async () => {
  setCodexWsReuseAcrossTurns(true);
  const retained = pool();
  const id = identity("turn-a")!;
  const first = retained.acquire(id, CODEX_RESPONSES_HTTP_URL, headers);
  await opened();
  let finished = false;
  const waiting = retained.acquireWaiting(id, CODEX_RESPONSES_HTTP_URL, headers, undefined).then(session => {
    finished = true;
    return session;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(Socket.all).toHaveLength(1);
  first!.release("response-1");
  expect(await waiting).toBe(first);
});

test("the wait queue is FIFO, depth limited, and abortable", async () => {
  setCodexWsReuseAcrossTurns(true);
  const retained = pool();
  const id = identity("turn-a")!;
  const first = retained.acquire(id, CODEX_RESPONSES_HTTP_URL, headers);
  await opened();
  const controller = new AbortController();
  const aborted = retained.acquireWaiting(id, CODEX_RESPONSES_HTTP_URL, headers, undefined, controller.signal);
  controller.abort();
  expect(await aborted).toBeNull();
  const queued = [
    retained.acquireWaiting(id, CODEX_RESPONSES_HTTP_URL, headers, undefined),
    retained.acquireWaiting(id, CODEX_RESPONSES_HTTP_URL, headers, undefined),
  ];
  expect(await retained.acquireWaiting(id, CODEX_RESPONSES_HTTP_URL, headers, undefined)).toBeNull();
  first!.release("response-1");
  expect(await queued[0]).toBe(first);
  expect(Socket.all).toHaveLength(1);
});

test("the admitted caller scopes pooled sockets, including queued acquisition", async () => {
  setCodexWsReuseAcrossTurns(true);
  const retained = pool();
  const alice = identity("turn-a", "fixture-model", headers.authorization, "principal:alice")!;
  const bob = identity("turn-b", "fixture-model", headers.authorization, "principal:bob")!;
  const unidentified = identity("turn-c")!;
  expect(identity("turn-z", "fixture-model", headers.authorization, "principal:alice")!.key).toBe(alice.key);
  expect(new Set([alice.scope, bob.scope, unidentified.scope]).size).toBe(3);
  expect(new Set([alice.key, bob.key, unidentified.key]).size).toBe(3);
  const held = retained.acquire(alice, CODEX_RESPONSES_HTTP_URL, headers);
  await opened();
  // Another caller on the same credential, account and thread never queues for, or receives,
  // the first caller's socket; it gets its own connection at once.
  const other = await retained.acquireWaiting(bob, CODEX_RESPONSES_HTTP_URL, headers, undefined);
  expect(other).not.toBeNull();
  expect(other).not.toBe(held);
  const anonymous = await retained.acquireWaiting(unidentified, CODEX_RESPONSES_HTTP_URL, headers, undefined);
  expect(anonymous).not.toBeNull();
  expect(anonymous).not.toBe(held);
  expect(anonymous).not.toBe(other);
  const same = retained.acquireWaiting(alice, CODEX_RESPONSES_HTTP_URL, headers, undefined);
  held!.release("response-1");
  expect(await same).toBe(held);
  expect(Socket.all).toHaveLength(3);
  expect(retained.snapshot().size).toBe(3);
});

test("reuse drops turn headers from the handshake", () => {
  const ws = "wss://chatgpt.com/backend-api/codex/responses";
  const kept = planCodexWsDial(ws, { "x-codex-turn-state": "original", authorization: "Bearer t" }, undefined, {});
  expect(kept?.headers["x-codex-turn-state"]).toBe("original");
  setCodexWsReuseAcrossTurns(true);
  const stripped = planCodexWsDial(ws, { "x-codex-turn-state": "original", authorization: "Bearer t" }, undefined, {});
  expect(stripped?.headers["x-codex-turn-state"]).toBeUndefined();
  expect(stripped?.headers.authorization).toBe("Bearer t");
});
