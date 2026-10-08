import { MessageBudget } from "./budget";
import { localSocket, type LocalSocket } from "./socket";
import { isRecord, isThreadId, LocalMessagingError, type LocalMetadataClient, type LocalThread } from "./types";

type Method = "initialize" | "thread/loaded/list" | "thread/read" | "thread/queue/add";
interface QueueResult {
  status: "not_sent" | "queued" | "unknown";
  error?: { code: string; message: string };
}
/** Only a validated server rejection can establish non-submission after a write. */
class QueueRejection extends LocalMessagingError {}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  method: Method;
}

/** Metadata discovery plus one text-only queue method; no lifecycle/turn/permission mutation. */
export class LocalMessageRpc implements LocalMetadataClient {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly abort: () => void;

  /** Bind connection failure and operation cancellation to all pending requests. */
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

  /** Submit once on this connection; after an accepted write only a correlated reply is definitive. */
  async queueMessage(threadId: string, text: string, messageId: string): Promise<QueueResult> {
    let written = false;
    try {
      if (!isThreadId(threadId) || !isThreadId(messageId) || !text || text.includes("\0")
        || Buffer.byteLength(text) > 32 * 1024) {
        throw new LocalMessagingError("invalid_message", "A bounded text message and UUID correlation are required.");
      }
      const raw = await this.request("thread/queue/add", {
        threadId, input: [{ type: "text", text }], clientUserMessageId: messageId,
      }, () => { written = true; });
      const queued = isRecord(raw) ? raw.queuedSubmission : null;
      if (!isRecord(queued) || typeof queued.id !== "string" || !queued.id || queued.id.length > 4096
        || queued.clientUserMessageId !== messageId || !Array.isArray(queued.input) || queued.input.length !== 1
        || !isRecord(queued.input[0]) || queued.input[0].type !== "text" || queued.input[0].text !== text
        || (queued.input[0].text_elements !== undefined
          && (!Array.isArray(queued.input[0].text_elements) || queued.input[0].text_elements.length !== 0))) {
        throw this.invalidMetadata();
      }
      return { status: "queued" };
    } catch (error) {
      if (error instanceof QueueRejection || !written) {
        return { status: "not_sent", error: error instanceof LocalMessagingError
          ? { code: error.code, message: error.message }
          : { code: "messaging_failed", message: "Local queue submission could not be started." } };
      }
      return { status: "unknown", error: { code: "submission_unknown",
        message: "Local queue submission may have occurred. Do not replay; recipient processing is unknown." } };
    }
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

  /** Issue one whitelisted RPC with bounded concurrency and timeout; record accepted writes. */
  private request(method: Method, params: Record<string, unknown>, onWritten?: () => void): Promise<unknown> {
    this.budget.throwIfEnded();
    if (this.closed || this.socket.readyState !== 1) throw new LocalMessagingError("daemon_unavailable", "Local Codex connection is closed.");
    if (this.pending.size >= 4) throw new LocalMessagingError("rpc_limit", "Local Codex metadata concurrency limit exceeded.");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new LocalMessagingError("rpc_timeout", "Local Codex request timed out.")),
        this.budget.remainingMs(this.rpcTimeoutMs));
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params })); onWritten?.(); } catch { this.close(); }
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
      if (!pending) {
        // During a one-shot submission an uncorrelated response cannot acknowledge our write.
        if ([...this.pending.values()].some(request => request.method === "thread/queue/add")) throw new Error();
        return;
      }
      let rejection: LocalMessagingError | undefined;
      if (Object.hasOwn(raw, "error")) {
        const error = raw.error;
        if (!isRecord(error) || !Number.isSafeInteger(error.code) || typeof error.message !== "string") throw new Error();
        if (pending.method === "thread/queue/add") {
          const unsupported = error.code === -32601 || (error.code === -32600
            && (error.message === "thread/queue/add requires experimentalApi capability"
              || error.message.startsWith("Invalid request: unknown variant `thread/queue/add`")));
          rejection = unsupported
            ? new QueueRejection("unsupported_queue", "Your Codex daemon does not support local queueing (experimental thread/queue/add).")
            : new QueueRejection("queue_rejected", "Codex rejected the local queue submission.");
        } else rejection = new LocalMessagingError("rpc_rejected", "Codex rejected the local metadata request.");
      }
      this.pending.delete(raw.id);
      clearTimeout(pending.timer);
      if (rejection) pending.reject(rejection);
      else pending.resolve(raw.result);
    } catch { this.close(new LocalMessagingError("invalid_metadata", "Codex returned an invalid or oversized RPC frame.")); }
  }
}
