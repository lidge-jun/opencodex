import type { ServerWebSocket } from "bun";
import type { WsData } from "../server/ws-bridge";
import { createAdmissionGate, type AdmissionMetrics, type AdmissionReservation } from "../lib/admission";
import { CodexWebSocketActivity } from "./websocket-activity";

export const MAX_TRACKED_CODEX_WEBSOCKETS = 128;
const websocketGate = createAdmissionGate("codex_websockets", MAX_TRACKED_CODEX_WEBSOCKETS);
const admittedSockets = new Set<ServerWebSocket<WsData>>();

function reclaimOldestIdleSocket(): void {
  let oldest: ServerWebSocket<WsData> | undefined;
  for (const ws of admittedSockets) {
    const activity = ws.data.responsesActivity;
    if (!activity?.idle || ws.data.nativeControl || ws.readyState !== 1 || ws.getBufferedAmount() !== 0) continue;
    if (!oldest || activity.lastUsed < oldest.data.responsesActivity!.lastUsed) oldest = ws;
  }
  if (!oldest) return;
  // Fence late frames before closing. Only the actual close callback releases admission.
  oldest.data.responsesActivity!.closing = true;
  try {
    oldest.close(1001, "Idle Responses connection reclaimed");
  } catch {
    // A failed/delayed close never manufactures a free slot or retries another victim.
    if (oldest.readyState === 1) oldest.data.responsesActivity!.closing = false;
  }
}

export function tryReserveCodexWebSocket(): AdmissionReservation<ServerWebSocket<WsData>> | null {
  if (websocketGate.metrics().active >= MAX_TRACKED_CODEX_WEBSOCKETS) reclaimOldestIdleSocket();
  const gateLease = websocketGate.tryAcquire();
  if (!gateLease) return null;
  let socket: ServerWebSocket<WsData> | undefined;
  let active = true;
  return {
    bind(value) {
      if (!active || socket) return;
      socket = value;
      socket.data.responsesActivity = new CodexWebSocketActivity();
      admittedSockets.add(socket);
    },
    release() {
      if (!active) return;
      active = false;
      if (socket) admittedSockets.delete(socket);
      socket = undefined;
      gateLease.release();
    },
  };
}

export function codexWebSocketAdmissionMetrics(): AdmissionMetrics {
  return websocketGate.metrics();
}

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
