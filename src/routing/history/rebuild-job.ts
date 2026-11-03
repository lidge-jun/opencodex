/**
 * The indexer's side of one rebuild worker (#6990): spawn it, send the build
 * request, and take it down again. Every exit settles: a worker that errors or
 * exits rejects the pending build. dispose() is bounded; afterExit() runs
 * cleanup only once the thread has really exited, so build files the thread
 * may still hold are never removed under it.
 */

import { spawnWorker } from "../../lib/worker-embed";
import { storageWorkerOsJoinSettleMs } from "../../storage/worker-lifecycle";
import type { UsageLogRevision } from "../../usage/log";
import { RequestHistoryIndexStaleError } from "./ingest";
import type { RebuildWorkerReply, RebuildWorkerRequest } from "./rebuild-protocol";

const CLOSE_TIMEOUT_MS = 5_000;
type WorkerSuccess = Exclude<RebuildWorkerReply, { type: "error" }>;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** True when `promise` settles within `ms`; the timer is cleared either way so it never keeps a process alive. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([promise.then(() => true, () => true), expired]).finally(() => clearTimeout(timer));
}

function errorFromReply(reply: Extract<RebuildWorkerReply, { type: "error" }>): Error {
  if (reply.name === "RequestHistoryIndexStaleError") return new RequestHistoryIndexStaleError(reply.message);
  const error = new Error(reply.message);
  error.name = reply.name;
  return error;
}

export class RebuildWorkerJob {
  private readonly worker: Worker;
  private pending: { resolve: (reply: WorkerSuccess) => void; reject: (error: unknown) => void } | null = null;
  private exited = false;
  private exitedCleanly = false;
  private disposal: Promise<void> | null = null;
  private readonly closed: Promise<void>;

  constructor() {
    this.worker = spawnWorker(new URL("./rebuild-worker.ts", import.meta.url).href, "request-history-rebuild-worker");
    let markClosed!: () => void;
    this.closed = new Promise(resolve => { markClosed = resolve; });
    this.worker.addEventListener("message", (event: MessageEvent<RebuildWorkerReply>) => {
      const pending = this.pending;
      this.pending = null;
      if (!pending) return;
      const reply = event.data;
      if (reply.type === "error") pending.reject(errorFromReply(reply));
      else pending.resolve(reply);
    });
    this.worker.addEventListener("error", (event: Event) => {
      this.fail(new Error((event as ErrorEvent).message || "request-history rebuild worker failed"));
    });
    this.worker.addEventListener("close", () => {
      this.exited = true;
      this.fail(new Error("request-history rebuild worker exited"));
      markClosed();
    }, { once: true });
  }

  private fail(error: unknown): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  private send(request: RebuildWorkerRequest): Promise<WorkerSuccess> {
    if (this.exited || this.disposal) return Promise.reject(new Error("request-history rebuild worker is not running"));
    if (this.pending) return Promise.reject(new Error("request-history rebuild worker is busy"));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(request);
    });
  }

  /** Build the complete private file; resolves with the ingested row count. */
  async build(indexPath: string, buildPath: string, reason: string, revision: UsageLogRevision): Promise<number> {
    const reply = await this.send({ type: "build", indexPath, buildPath, reason, revision });
    if (reply.type !== "built") throw new Error("unexpected request-history build reply");
    return reply.rows;
  }

  /** Scan a read-only connection off-loop; operational errors are not corruption. */
  async check(indexPath: string): Promise<boolean> {
    const reply = await this.send({ type: "check", indexPath });
    if (reply.type !== "checked") throw new Error("unexpected request-history integrity reply");
    return reply.healthy;
  }

  /** Stop the thread; waits a bounded time for it to exit. */
  dispose(): Promise<void> {
    this.disposal ??= this.shutDown();
    return this.disposal;
  }

  /**
   * Dispose, then run `cleanup` once the thread has exited. A thread that
   * overran the bound (blocked in native I/O) gets its cleanup when it does
   * exit; the returned promise does not wait for that.
   */
  async afterExit(cleanup: () => void): Promise<void> {
    await this.dispose();
    if (this.exitedCleanly) {
      cleanup();
      return;
    }
    void this.closed.then(() => delay(storageWorkerOsJoinSettleMs())).then(cleanup).catch(() => undefined);
  }

  private async shutDown(): Promise<void> {
    this.fail(new Error("request-history rebuild worker stopped"));
    try { this.worker.terminate(); } catch { /* already gone */ }
    if (!await settlesWithin(this.closed, CLOSE_TIMEOUT_MS)) return;
    // Bun does not expose the OS thread join; Windows needs this gap before
    // files a terminated thread held can be removed.
    const settleMs = storageWorkerOsJoinSettleMs();
    if (settleMs > 0) await delay(settleMs);
    this.exitedCleanly = true;
  }
}
