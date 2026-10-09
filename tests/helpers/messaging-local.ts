import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { writeTestTempOwner } from "../../scripts/test-temp";
import { localDaemonEndpoint } from "../../src/messaging/socket";
import { removeTreeWithRetry } from "./remove-tree";

export const LOCAL_TARGET = "00000000-0000-4000-8000-000000000002";
export const LOCAL_OTHER = "00000000-0000-4000-8000-000000000003";
export const NO_REPLY = Symbol("no-reply");
export interface LocalCall { id?: number; method: string; params: Record<string, unknown> }

/** Explicit RPC rejection for native-client failure tests, distinct from fixture-handler failure. */
export class LocalFixtureRpcError {
  /** Supply an isolated fixture error; native output must never expose it in wrapper receipts. */
  constructor(readonly code: number, readonly message: string) {}
}

/** Return schema-valid native thread metadata with private fields the wrapper must omit. */
export function localFixtureThread(id = LOCAL_TARGET, name: string | null = "recipient") {
  return { id, name, status: { type: "idle" }, cwd: "/fixture", turns: [], preview: "must not be exposed",
    modelProvider: "openai", createdAt: 1, updatedAt: 1, source: "cli", path: null, cliVersion: "fixture", ephemeral: false };
}

/** Strict, isolated Unix fixture: unknown/lifecycle RPCs fail rather than receive a fake success. */
export function localMessagingFixture(handler?: (call: LocalCall) => unknown | Promise<unknown>) {
  // Unix-only fixture. The wrapped runner nests TMPDIR sandboxes, making the
  // canonical control-socket suffix too long for native clients. A short unique
  // root retains explicit ownership/cleanup and the repository stale-root marker.
  const root = mkdtempSync(join("/tmp", "opencodex-test-"));
  writeTestTempOwner(root);
  const codexHome = join(root, "codex");
  const socketDir = join(codexHome, "app-server-control");
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const calls: LocalCall[] = [];
  const failures: string[] = [];
  const tasks = new Set<Promise<void>>();
  const sockets = new Set<Bun.ServerWebSocket<{ initialized: boolean }>>();
  let activeConnections = 0;
  let connectionCount = 0;
  let closing = false;
  const server = Bun.serve<{ initialized: boolean }>({
    unix: join(socketDir, "app-server-control.sock"),
    fetch(req, runtime) {
      if (runtime.upgrade(req, { data: { initialized: false } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) { connectionCount++; activeConnections++; sockets.add(ws); },
      close(ws) { activeConnections--; sockets.delete(ws); },
      message(ws, message) {
        const task = (async () => {
          const raw = JSON.parse(String(message));
          const call: LocalCall = { id: raw.id, method: raw.method, params: raw.params ?? {} };
          calls.push(call);
          if (call.method === "initialized" && raw.id === undefined) { ws.data.initialized = true; return; }
          const allowed = ["initialize", "thread/loaded/list", "thread/read", "thread/queue/add"];
          if (!allowed.includes(call.method) || (call.method !== "initialize" && !ws.data.initialized)) {
            failures.push(call.method);
            ws.send(JSON.stringify({ id: raw.id, error: { code: -32601, message: "Unexpected fixture RPC" } }));
            return;
          }
          let result = await handler?.(call);
          if (result === NO_REPLY) return;
          if (result === undefined) {
            if (call.method === "initialize") result = { userAgent: "fixture", platformFamily: "unix", platformOs: "linux", codexHome };
            else if (call.method === "thread/loaded/list") result = { data: [LOCAL_TARGET], nextCursor: null };
            else if (call.method === "thread/read") result = { thread: localFixtureThread(String(call.params.threadId)) };
            else result = { queuedSubmission: { id: "fixture-submission", input: call.params.input, clientUserMessageId: call.params.clientUserMessageId } };
          }
          if (!closing && ws.readyState === 1) ws.send(JSON.stringify(result instanceof LocalFixtureRpcError
            ? { id: raw.id, error: { code: result.code, message: result.message } } : { id: raw.id, result }));
        })().catch(() => { failures.push("fixture_handler_failure"); });
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      },
    },
  });
  let closePromise: Promise<void> | undefined;
  return { root, codexHome, ...localDaemonEndpoint(codexHome), calls, failures,
    get activeConnections() { return activeConnections; },
    get connectionCount() { return connectionCount; },
    closeConnections() { for (const socket of sockets) socket.close(); },
    broadcast(frame: string | Uint8Array) { for (const socket of sockets) socket.send(frame); },
    close(): Promise<void> {
      return closePromise ??= (async () => {
        closing = true;
        await server.stop(true);
        await Promise.allSettled([...tasks]);
        removeTreeWithRetry(root);
      })();
    },
  };
}
