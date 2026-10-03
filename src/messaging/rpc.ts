import { MessageBudget } from "./budget";
import { localSocket, type LocalSocket } from "./socket";
import { isRecord, isThreadId, LocalMessagingError, type LocalMetadataClient, type LocalThread } from "./types";

type Method = "initialize" | "thread/loaded/list" | "thread/read";
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Read-only metadata RPC; there is intentionally no turn/session/queue mutation method. */
export class LocalMessageRpc implements LocalMetadataClient {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly abort: () => void;

  /** Bind connection failure and operation cancellation to all pending metadata requests. */
  private constructor(private readonly socket: LocalSocket, private readonly budget: MessageBudget,
    private readonly rpcTimeoutMs: number) {
    this.abort = () => this.close(budget.signal.reason);
    socket.onmessage = event => this.receive(event.data);
    socket.onerror = socket.onclose = () => this.close();
    budget.signal.addEventListener("abort", this.abort, { once: true });
    if (budget.signal.aborted) this.abort();
  }

  /** Connect and initialize an existing local daemon within budget; never start or repair one. */
  static async connect(url: string, budget: MessageBudget, rpcTimeoutMs = 10_000): Promise<LocalMessageRpc> {
    budget.throwIfEnded();
    if (!Number.isInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0 || rpcTimeoutMs > 10_000) {
      throw new LocalMessagingError("invalid_budget", "RPC timeout must be between 1 and 10000 milliseconds.");
    }
    const socket = localSocket(url);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          budget.signal.removeEventListener("abort", abort);
          socket.onopen = socket.onerror = socket.onclose = null;
        };
        const abort = () => { cleanup(); reject(budget.signal.reason); };
        const timer = setTimeout(() => {
          cleanup(); reject(new LocalMessagingError("daemon_unavailable", "Local Codex connection timed out; no daemon was started."));
        }, budget.remainingMs(rpcTimeoutMs));
        budget.signal.addEventListener("abort", abort, { once: true });
        socket.onopen = () => { cleanup(); resolve(); };
        socket.onerror = socket.onclose = () => {
          cleanup(); reject(new LocalMessagingError("daemon_unavailable", "Cannot connect to the existing local Codex daemon."));
        };
        if (budget.signal.aborted) abort();
      });
    } catch (error) { socket.terminate(); throw error; }
    const rpc = new LocalMessageRpc(socket, budget, rpcTimeoutMs);
    try {
      const result = await rpc.request("initialize", {
        clientInfo: { name: "opencodex_message", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      if (!isRecord(result)) throw rpc.invalidMetadata();
      budget.throwIfEnded();
      socket.send(JSON.stringify({ method: "initialized", params: {} }));
      return rpc;
    } catch (error) { rpc.close(); throw error; }
  }

  /** Read up to 50 loaded UUIDs, rejecting malformed IDs and unbounded pagination cursors. */
  async loadedPage(cursor?: string): Promise<{ data: string[]; nextCursor: string | null }> {
    const raw = await this.request("thread/loaded/list", { limit: 50, ...(cursor ? { cursor } : {}) });
    if (!isRecord(raw) || !Array.isArray(raw.data) || raw.data.length > 50 || !raw.data.every(isThreadId)
      || (raw.nextCursor !== undefined && raw.nextCursor !== null
        && (typeof raw.nextCursor !== "string" || !raw.nextCursor || raw.nextCursor.length > 4096))) {
      throw this.invalidMetadata();
    }
    return { data: raw.data, nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : null };
  }

  /** Validate one exact thread and project ID/name/status only, without requesting turns. */
  async readThread(id: string): Promise<LocalThread> {
    if (!isThreadId(id)) throw new LocalMessagingError("invalid_selector", "A valid Codex thread ID is required.");
    const raw = await this.request("thread/read", { threadId: id, includeTurns: false });
    const thread = isRecord(raw) ? raw.thread : null;
    if (!isRecord(thread) || thread.id !== id || (thread.name !== undefined && thread.name !== null
      && (typeof thread.name !== "string" || thread.name.length > 4096)) || !isRecord(thread.status)
      || !["idle", "active", "systemError", "notLoaded"].includes(String(thread.status.type))) {
      throw this.invalidMetadata();
    }
    return { id, name: typeof thread.name === "string" ? thread.name : null, status: thread.status.type as LocalThread["status"] };
  }

  /** Idempotently reject pending work, remove handlers and terminate only this connection. */
  close(error: Error = new LocalMessagingError("daemon_unavailable", "Local Codex connection closed.")): void {
    if (this.closed) return;
    this.closed = true;
    this.budget.signal.removeEventListener("abort", this.abort);
    this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.socket.terminate();
  }

  /** Fail closed on malformed metadata without including the daemon's response in the error. */
  private invalidMetadata(): LocalMessagingError {
    const error = new LocalMessagingError("invalid_metadata", "Codex returned invalid local session metadata.");
    this.close(error);
    return error;
  }

  /** Issue one whitelisted metadata RPC with bounded concurrency and timeout. */
  private request(method: Method, params: Record<string, unknown>): Promise<unknown> {
    this.budget.throwIfEnded();
    if (this.closed) throw new LocalMessagingError("daemon_unavailable", "Local Codex connection is closed.");
    if (this.pending.size >= 4) throw new LocalMessagingError("rpc_limit", "Local Codex metadata concurrency limit exceeded.");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new LocalMessagingError("rpc_timeout", "Local Codex metadata request timed out.")),
        this.budget.remainingMs(this.rpcTimeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch { this.close(); }
    });
  }

  /** Settle matching bounded RPC frames; ignore notifications and sanitize remote errors. */
  private receive(data: unknown): void {
    try {
      if (typeof data !== "string" || Buffer.byteLength(data) > 1024 * 1024) throw new Error();
      const raw: unknown = JSON.parse(data);
      if (!isRecord(raw)) throw new Error();
      if (typeof raw.method === "string" && raw.id === undefined) return;
      if (typeof raw.id !== "number" || !Number.isSafeInteger(raw.id)
        || Object.hasOwn(raw, "result") === Object.hasOwn(raw, "error")) throw new Error();
      const pending = this.pending.get(raw.id);
      if (!pending) return;
      this.pending.delete(raw.id);
      clearTimeout(pending.timer);
      if (Object.hasOwn(raw, "error")) pending.reject(new LocalMessagingError("rpc_rejected", "Codex rejected the local metadata request."));
      else pending.resolve(raw.result);
    } catch { this.close(new LocalMessagingError("invalid_metadata", "Codex returned an invalid or oversized RPC frame.")); }
  }
}
