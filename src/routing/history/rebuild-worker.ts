/**
 * Rebuild worker for the request-history index (#6990).
 *
 * A full rebuild reads the whole ledger and commits every row; one rebuild of
 * a 2.34 GB ledger held the serving event loop for 487 s. This thread does
 * that work instead: it sweeps abandoned builds, creates the private build,
 * ingests the ledger snapshot the refresh recorded, switches it to WAL and
 * closes it. The serving thread then swaps the finished file in.
 */

import { Database } from "bun:sqlite";
import { buildIndexFile, removeAbandonedBuilds } from "./build-file";
import { isHistoryIndexCorruption } from "./sqlite-errors";
import type { RebuildWorkerReply, RebuildWorkerRequest } from "./rebuild-protocol";

declare const self: Worker;

function handle(request: RebuildWorkerRequest): RebuildWorkerReply {
  if (request.type === "check") {
    let handle: Database | undefined;
    try {
      handle = new Database(request.indexPath, { readonly: true });
      handle.exec("PRAGMA busy_timeout = 5000");
      const row = handle.query("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
      return { type: "checked", healthy: row?.quick_check === "ok" };
    } catch (error) {
      if (isHistoryIndexCorruption(error)) return { type: "checked", healthy: false };
      throw error;
    } finally {
      // Release the live index before posting a verdict: the serving thread
      // may immediately replace it, including on Windows.
      handle?.close();
    }
  }
  removeAbandonedBuilds(request.indexPath);
  const rows = buildIndexFile(request.buildPath, request.reason, request.revision);
  return { type: "built", rows };
}

self.onmessage = (event: MessageEvent<RebuildWorkerRequest>) => {
  let reply: RebuildWorkerReply;
  try {
    reply = handle(event.data);
  } catch (error) {
    reply = {
      type: "error",
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  self.postMessage(reply);
};
