import { beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  clearCodexWebSocketRegistry,
  getTrackedCodexWebSocketCountForAccount,
  invalidateCodexWebSocketsForAccount,
  registerCodexWebSocket,
  unregisterCodexWebSocket,
} from "../src/codex/websocket-registry";
import type { WsData } from "../src/server/ws-bridge";

function mockWs(data: WsData): {
  ws: ServerWebSocket<WsData>;
  closed: { code?: number; reason?: string }[];
} {
  const closed: { code?: number; reason?: string }[] = [];
  const ws = {
    data,
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
  } as unknown as ServerWebSocket<WsData>;
  return { ws, closed };
}

describe("codex websocket registry", () => {
  beforeEach(() => {
    clearCodexWebSocketRegistry();
  });

  test("registers only pool-bound websockets", () => {
    const pool = mockWs({
      authContext: {
        kind: "pool",
        accountId: "pool-a",
        generation: 1,
        accessToken: "token",
        chatgptAccountId: "acc",
      },
    });
    const main = mockWs({ authContext: { kind: "main", accountId: null } });

    registerCodexWebSocket(pool.ws);
    registerCodexWebSocket(main.ws);

    expect(getTrackedCodexWebSocketCountForAccount("pool-a")).toBe(1);
    expect(getTrackedCodexWebSocketCountForAccount("main")).toBe(0);
  });

  test("tracks rotation-injected main account websockets under __main__", () => {
    const mainPool = mockWs({
      authContext: {
        kind: "main-pool",
        accountId: "__main__",
        accessToken: "main_token",
        chatgptAccountId: "main_acc",
      },
    });
    const passthroughMain = mockWs({ authContext: { kind: "main", accountId: null } });

    registerCodexWebSocket(mainPool.ws);
    registerCodexWebSocket(passthroughMain.ws);

    expect(getTrackedCodexWebSocketCountForAccount("__main__")).toBe(1);

    unregisterCodexWebSocket(mainPool.ws);
    expect(getTrackedCodexWebSocketCountForAccount("__main__")).toBe(0);
  });

  test("unregister removes tracked socket", () => {
    const pool = mockWs({
      authContext: {
        kind: "pool",
        accountId: "pool-a",
        generation: 1,
        accessToken: "token",
        chatgptAccountId: "acc",
      },
    });

    registerCodexWebSocket(pool.ws);
    unregisterCodexWebSocket(pool.ws);

    expect(getTrackedCodexWebSocketCountForAccount("pool-a")).toBe(0);
  });

  test("invalidation cancels and closes all sockets for the account", () => {
    let cancelled = 0;
    const first = mockWs({
      authContext: {
        kind: "pool",
        accountId: "pool-a",
        generation: 1,
        accessToken: "token-1",
        chatgptAccountId: "acc",
      },
      cancel: () => {
        cancelled += 1;
      },
    });
    const second = mockWs({
      authContext: {
        kind: "pool",
        accountId: "pool-a",
        generation: 1,
        accessToken: "token-2",
        chatgptAccountId: "acc",
      },
      cancel: () => {
        cancelled += 1;
      },
    });

    registerCodexWebSocket(first.ws);
    registerCodexWebSocket(second.ws);

    expect(invalidateCodexWebSocketsForAccount("pool-a")).toBe(2);
    expect(cancelled).toBe(2);
    expect(first.closed).toEqual([{ code: 4001, reason: "Codex account invalidated" }]);
    expect(second.closed).toEqual([{ code: 4001, reason: "Codex account invalidated" }]);
    expect(getTrackedCodexWebSocketCountForAccount("pool-a")).toBe(0);
  });

  test("invalidation does not touch other account sockets", () => {
    const target = mockWs({
      authContext: {
        kind: "pool",
        accountId: "pool-a",
        generation: 1,
        accessToken: "token-a",
        chatgptAccountId: "acc-a",
      },
    });
    const other = mockWs({
      authContext: {
        kind: "pool",
        accountId: "pool-b",
        generation: 1,
        accessToken: "token-b",
        chatgptAccountId: "acc-b",
      },
    });

    registerCodexWebSocket(target.ws);
    registerCodexWebSocket(other.ws);

    expect(invalidateCodexWebSocketsForAccount("pool-a")).toBe(1);
    expect(target.closed).toHaveLength(1);
    expect(other.closed).toHaveLength(0);
    expect(getTrackedCodexWebSocketCountForAccount("pool-b")).toBe(1);
  });
});
