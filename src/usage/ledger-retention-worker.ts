import { prepareUsageLedgerCompaction } from "./ledger-retention";

interface RunMessage {
  type: "run";
  requestId: string;
  path: string;
  tempPath: string;
  maxBytes: number;
  env?: { OPENCODEX_HOME?: string };
}

/** Validate the fixed-shape message accepted by the retention Worker. */
function isRunMessage(data: unknown): data is RunMessage {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const row = data as Record<string, unknown>;
  return row.type === "run"
    && typeof row.requestId === "string"
    && typeof row.path === "string"
    && typeof row.tempPath === "string"
    && typeof row.maxBytes === "number";
}

declare const self: Worker;

/** Prepare one candidate and return only fixed, path-free failures to the parent. */
self.onmessage = (event: MessageEvent<unknown>) => {
  if (!isRunMessage(event.data)) return;
  const { requestId, path, tempPath, maxBytes, env } = event.data;
  try {
    if (env?.OPENCODEX_HOME) process.env.OPENCODEX_HOME = env.OPENCODEX_HOME;
    const result = prepareUsageLedgerCompaction(path, maxBytes, tempPath);
    self.postMessage({ type: "done", requestId, result });
  } catch {
    // Keep worker errors fixed and path-free: OPENCODEX_HOME may contain user information.
    self.postMessage({ type: "error", requestId, message: "usage_ledger_retention_failed" });
  } finally {
    try {
      (self as unknown as { close?: () => void }).close?.();
    } catch { /* already closing */ }
  }
};
