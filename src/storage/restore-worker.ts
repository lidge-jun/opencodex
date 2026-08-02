/**
 * Worker-thread entry for trash restore runs.
 * Keeps file moves and SQLite reconcile off the proxy event loop.
 */
import { restoreTrashEntry, type RestoreResult, type RestoreTestHooks } from "./cleanup";

interface RunMessage {
  type: "run";
  requestId: string;
  trashId: string;
  codexHome?: string;
  busyTimeoutMs?: number;
  /** Test-only: block before restore so responsiveness tests can probe /healthz. */
  blockMs?: number;
  restoreTest?: RestoreTestHooks;
  /** Env snapshot — Workers may not see parent mutations on all platforms. */
  env?: { CODEX_HOME?: string; OPENCODEX_HOME?: string };
}

function isRunMessage(data: unknown): data is RunMessage {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const o = data as Record<string, unknown>;
  return o.type === "run" && typeof o.requestId === "string" && typeof o.trashId === "string";
}

declare const self: Worker;

self.onmessage = async (event: MessageEvent<unknown>) => {
  if (!isRunMessage(event.data)) return;
  const { requestId, trashId, codexHome, busyTimeoutMs, blockMs, restoreTest, env } = event.data;
  try {
    if (env?.CODEX_HOME) process.env.CODEX_HOME = env.CODEX_HOME;
    if (env?.OPENCODEX_HOME) process.env.OPENCODEX_HOME = env.OPENCODEX_HOME;
    if (typeof blockMs === "number" && Number.isFinite(blockMs) && blockMs > 0) {
      await Bun.sleep(Math.floor(blockMs));
    }
    const result = restoreTrashEntry(trashId, {
      ...(codexHome ? { codexHome } : {}),
      ...(busyTimeoutMs !== undefined ? { busyTimeoutMs } : {}),
      ...(restoreTest ? { _test: restoreTest } : {}),
    });
    self.postMessage({ type: "done", requestId, result });
  } catch (err) {
    self.postMessage({
      type: "error",
      requestId,
      message: err instanceof Error ? err.message : "worker_failed",
    });
  } finally {
    // Close from inside the worker so the thread begins exiting before the
    // parent’s terminate() races isolate realm reclaim on Windows.
    try {
      (self as unknown as { close?: () => void }).close?.();
    } catch { /* already closing */ }
  }
};

export type { RestoreResult };
