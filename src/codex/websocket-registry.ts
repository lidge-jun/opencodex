import type { ServerWebSocket } from "bun";
import type { WsData } from "../server/ws-bridge";

const socketsByAccount = new Map<string, Set<ServerWebSocket<WsData>>>();

function trackedAccountId(ws: ServerWebSocket<WsData>): string | null {
  const ctx = ws.data.authContext;
  return ctx?.kind === "pool" || ctx?.kind === "main-pool" ? ctx.accountId : null;
}

function addSocketForAccount(accountId: string | null, ws: ServerWebSocket<WsData>): void {
  if (!accountId) return;
  let sockets = socketsByAccount.get(accountId);
  if (!sockets) {
    sockets = new Set();
    socketsByAccount.set(accountId, sockets);
  }
  sockets.add(ws);
}

function removeSocketForAccount(accountId: string | null, ws: ServerWebSocket<WsData>): void {
  if (!accountId) return;
  const sockets = socketsByAccount.get(accountId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) socketsByAccount.delete(accountId);
}

export function registerCodexWebSocket(ws: ServerWebSocket<WsData>): void {
  addSocketForAccount(trackedAccountId(ws), ws);
}

export function unregisterCodexWebSocket(ws: ServerWebSocket<WsData>): void {
  removeSocketForAccount(trackedAccountId(ws), ws);
}

export function updateCodexWebSocketAuthContext(
  ws: ServerWebSocket<WsData>,
  authContext: WsData["authContext"],
): void {
  const before = trackedAccountId(ws);
  removeSocketForAccount(before, ws);
  ws.data.authContext = authContext;
  addSocketForAccount(trackedAccountId(ws), ws);
}

export function invalidateCodexWebSocketsForAccount(accountId: string): number {
  const sockets = socketsByAccount.get(accountId);
  if (!sockets) return 0;
  const snapshot = [...sockets];
  socketsByAccount.delete(accountId);
  for (const ws of snapshot) {
    try {
      ws.data.cancel?.();
    } catch {
      /* ignore cancel callbacks during invalidation */
    }
    try {
      ws.close(4001, "Codex account invalidated");
    } catch {
      /* socket may already be closing */
    }
  }
  return snapshot.length;
}

export function getTrackedCodexWebSocketCountForAccount(accountId: string): number {
  return socketsByAccount.get(accountId)?.size ?? 0;
}

export function clearCodexWebSocketRegistry(): void {
  socketsByAccount.clear();
}
