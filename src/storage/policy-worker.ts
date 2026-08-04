/**
 * Worker-thread entry for storage cleanup policy runs.
 * Keeps archive scan / FS cleanup / SQLite reconcile off the proxy event loop.
 */
import { runStorageCleanupPolicy, type PolicyRunReason } from "./policy";

interface RunMessage {
  type: "run";
  requestId: string;
  reason: PolicyRunReason;
  force?: boolean;
  codexHome?: string;
  busyTimeoutMs?: number;
  /** Test-only: block after loading the start-of-job policy (see holdAfterLoadMs). */
  blockMs?: number;
  /** Env snapshot — Workers may not see parent mutations on all platforms. */
  env?: { CODEX_HOME?: string; OPENCODEX_HOME?: string };
}

function isRunMessage(data: unknown): data is RunMessage {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const o = data as Record<string, unknown>;
  return o.type === "run"
    && typeof o.requestId === "string"
    && (o.reason === "startup" || o.reason === "schedule" || o.reason === "manual");
}

declare const self: Worker;

self.onmessage = (event: MessageEvent<unknown>) => {
  if (!isRunMessage(event.data)) return;
  const { requestId, reason, force, codexHome, busyTimeoutMs, blockMs, env } = event.data;
  try {
    if (env?.CODEX_HOME) process.env.CODEX_HOME = env.CODEX_HOME;
    if (env?.OPENCODEX_HOME) process.env.OPENCODEX_HOME = env.OPENCODEX_HOME;
    const result = runStorageCleanupPolicy({
      reason,
      force: force === true,
      ...(codexHome ? { codexHome } : {}),
      ...(busyTimeoutMs !== undefined ? { busyTimeoutMs } : {}),
      ...(typeof blockMs === "number" && Number.isFinite(blockMs) && blockMs > 0
        ? { holdAfterLoadMs: Math.floor(blockMs) }
        : {}),
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
