import { randomBytes } from "node:crypto";
import { MuseMspError } from "./connection";
import { MusePendingToolResult, type MuseToolResult } from "./tool-result";

interface PendingEntry {
  pending: MusePendingToolResult;
  upstreamCallId: string;
  historyDigest: string;
}

/** Process-local, bounded ownership of tool results for parked Muse sessions. */
export class MusePendingRegistry {
  private readonly entries = new Map<string, PendingEntry>();
  private closed = false;

  constructor(private readonly maxEntries = 64) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024) throw new MuseMspError("invalid_registry_limit");
  }

  /** The history digest must be computed by the caller from the validated response prefix. */
  register(owner: string, upstreamCallId: string, historyDigest: string, options: { timeoutMs: number; signal?: AbortSignal }): {
    clientCallId: string; result: Promise<MuseToolResult>;
  } {
    if (this.closed) throw new MuseMspError("closed");
    if (!/^[0-9a-f]{64}$/.test(historyDigest) || !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 || options.timeoutMs > 300_000) throw new MuseMspError("invalid_pending_tool");
    if (options.signal?.aborted) throw new MuseMspError("cancelled");
    if (this.entries.size >= this.maxEntries) throw new MuseMspError("too_many_pending_tools");
    let clientCallId = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      clientCallId = `msp_${randomBytes(24).toString("hex")}`;
      if (!this.entries.has(clientCallId)) break;
      clientCallId = "";
    }
    if (!clientCallId) throw new MuseMspError("call_id_unavailable");
    const pending = new MusePendingToolResult(upstreamCallId, owner, options);
    const entry: PendingEntry = { pending, upstreamCallId, historyDigest };
    this.entries.set(clientCallId, entry);
    const remove = () => { if (this.entries.get(clientCallId) === entry) this.entries.delete(clientCallId); };
    void pending.result.then(remove, remove);
    return { clientCallId, result: pending.result };
  }

  /** The owner and digest are independently derived for each authenticated continuation. */
  validate(owner: string, clientCallId: string, historyDigest: string, output: string): void {
    const entry = this.entries.get(clientCallId);
    if (!entry || entry.historyDigest !== historyDigest) throw new MuseMspError("unavailable_tool_result");
    entry.pending.validate(owner, {callId:entry.upstreamCallId,output});
  }

  /** The owner and digest are independently derived for each authenticated continuation. */
  submit(owner: string, clientCallId: string, historyDigest: string, output: string, beforeCommit?: (result: Readonly<MuseToolResult>) => void): void {
    const entry = this.entries.get(clientCallId);
    if (!entry || entry.historyDigest !== historyDigest) throw new MuseMspError("unavailable_tool_result");
    try { entry.pending.submit(owner, { callId: entry.upstreamCallId, output }, beforeCommit); }
    catch (error) {
      if (error instanceof MuseMspError && (error.code === "unowned_tool_result" || error.code === "tool_result_settled")) {
        throw new MuseMspError("unavailable_tool_result");
      }
      throw error;
    }
    this.entries.delete(clientCallId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.entries.values()]; this.entries.clear();
    for (const entry of pending) entry.pending.close();
  }
}
