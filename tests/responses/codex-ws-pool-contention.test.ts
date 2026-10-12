import { afterEach, expect, test } from "bun:test";
import { setCodexWsReuseAcrossTurns } from "../../src/config/codex-ws-reuse-setting";
import { CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import { CodexWsPool, codexWsReuseIdentity } from "../../src/server/responses/codex-ws-pool";
import { planCodexWsDial } from "../../src/server/responses/ws-upstream";

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

function identity(turn: string, model = "fixture-model", authorization = headers.authorization) {
  return codexWsReuseIdentity(CODEX_RESPONSES_HTTP_URL, { ...headers, authorization }, frame(turn, model));
}

const pools: CodexWsPool[] = [];

afterEach(() => {
  setCodexWsReuseAcrossTurns(false);
  for (const pool of pools) pool.dispose();
  pools.length = 0;
  for (const socket of Socket.all) socket.close();
  Socket.all = [];
  globalThis.WebSocket = realWebSocket;
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

test("reuse drops turn headers from the handshake", () => {
  const ws = "wss://chatgpt.com/backend-api/codex/responses";
  const kept = planCodexWsDial(ws, { "x-codex-turn-state": "original", authorization: "Bearer t" }, undefined, {});
  expect(kept?.headers["x-codex-turn-state"]).toBe("original");
  setCodexWsReuseAcrossTurns(true);
  const stripped = planCodexWsDial(ws, { "x-codex-turn-state": "original", authorization: "Bearer t" }, undefined, {});
  expect(stripped?.headers["x-codex-turn-state"]).toBeUndefined();
  expect(stripped?.headers.authorization).toBe("Bearer t");
});
