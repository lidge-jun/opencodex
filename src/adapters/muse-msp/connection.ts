import type { Readable, Writable } from "node:stream";

type JsonObject = Record<string, unknown>;

export class MuseMspError extends Error {
  constructor(readonly code: string) {
    super(`Muse MSP: ${code}`);
    this.name = "MuseMspError";
  }
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** Bounded JSON-RPC transport. It owns neither the process nor either stream. */
export class MuseMspConnection {
  private readonly pending = new Map<number, Pending>();
  private readonly serverRequests = new Set<string | number>();
  private buffer = Buffer.alloc(0);
  private buffered = 0;
  private nextId = 1;
  private closed = false;
  private readonly maxLineBytes: number;
  private readonly maxPending: number;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onMessage: (message: JsonObject) => void,
    limits: { maxLineBytes?: number; maxPending?: number } = {},
  ) {
    this.maxLineBytes = limits.maxLineBytes ?? 4 * 1024 * 1024;
    this.maxPending = limits.maxPending ?? 128;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1 ||
        !Number.isSafeInteger(this.maxPending) || this.maxPending < 1) {
      throw new MuseMspError("invalid_limits");
    }
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("error", this.onStreamError);
    output.on("error", this.onStreamError);
  }

  request(method: string, params: JsonObject, options: { signal?: AbortSignal; timeoutMs: number }): Promise<unknown> {
    if (this.closed) return Promise.reject(new MuseMspError("closed"));
    if (!method || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      return Promise.reject(new MuseMspError("invalid_request"));
    }
    if (options.signal?.aborted) return Promise.reject(new MuseMspError("cancelled"));
    if (this.pending.size >= this.maxPending) return Promise.reject(new MuseMspError("too_many_pending"));
    if (!Number.isSafeInteger(this.nextId)) return Promise.reject(new MuseMspError("id_exhausted"));
    const id = this.nextId++;
    let line: string;
    try {
      line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    } catch {
      return Promise.reject(new MuseMspError("invalid_request"));
    }
    if (Buffer.byteLength(line) > this.maxLineBytes) return Promise.reject(new MuseMspError("request_too_large"));
    return new Promise((resolve, reject) => {
      const abort = () => this.rejectPending(id, "cancelled");
      const timer = setTimeout(() => this.rejectPending(id, "timeout"), options.timeoutMs);
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      try {
        this.output.write(line, error => { if (error) this.fail("write_failed"); });
      } catch {
        this.fail("write_failed");
      }
    });
  }

  /** Send an MSP notification such as `initialized` without creating a pending request. */
  notify(method: string, params?: JsonObject): Promise<void> {
    if (this.closed) return Promise.reject(new MuseMspError("closed"));
    if (!method) return Promise.reject(new MuseMspError("invalid_request"));
    let line: string;
    try { line = `${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`; }
    catch { return Promise.reject(new MuseMspError("invalid_request")); }
    if (Buffer.byteLength(line) > this.maxLineBytes) return Promise.reject(new MuseMspError("request_too_large"));
    return new Promise((resolve, reject) => {
      try {
        this.output.write(line, error => {
          if (error) { this.fail("write_failed"); reject(new MuseMspError("write_failed")); }
          else resolve();
        });
      } catch { this.fail("write_failed"); reject(new MuseMspError("write_failed")); }
    });
  }

  /** Acknowledge a server-originated request, such as `approval/request`, exactly once. */
  respond(id: string | number, result: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new MuseMspError("closed"));
    if (!this.serverRequests.has(id)) return Promise.reject(new MuseMspError("unknown_server_request"));
    if (result === undefined) return Promise.reject(new MuseMspError("invalid_response"));
    let line: string;
    try {
      const encoded = JSON.stringify(result);
      if (encoded === undefined) throw new Error();
      line = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${encoded}}\n`;
    }
    catch { return Promise.reject(new MuseMspError("invalid_response")); }
    if (Buffer.byteLength(line) > this.maxLineBytes) return Promise.reject(new MuseMspError("response_too_large"));
    this.serverRequests.delete(id);
    return new Promise((resolve, reject) => {
      try {
        this.output.write(line, error => {
          if (error) { this.fail("write_failed"); reject(new MuseMspError("write_failed")); }
          else resolve();
        });
      } catch { this.fail("write_failed"); reject(new MuseMspError("write_failed")); }
    });
  }

  close(): void { this.fail("closed"); }

  private rejectPending(id: number, code: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id); entry.cleanup(); entry.reject(new MuseMspError(code));
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let offset = 0;
    while (offset < bytes.length && !this.closed) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(offset, end);
      const needed = this.buffered + part.length;
      if (needed > this.maxLineBytes) { this.fail("line_too_large"); return; }
      if (needed > this.buffer.length) {
        const capacity = Math.min(this.maxLineBytes, Math.max(needed, this.buffer.length * 2, 1024));
        const next = Buffer.allocUnsafe(capacity);
        this.buffer.copy(next, 0, 0, this.buffered); this.buffer = next;
      }
      part.copy(this.buffer, this.buffered); this.buffered = needed;
      if (newline < 0) return;
      const line = this.buffer.subarray(0, this.buffered); this.buffered = 0; offset = newline + 1;
      if (line.length === 0 || (line.length === 1 && line[0] === 13)) continue;
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
        const message: unknown = JSON.parse(decoded);
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
        this.dispatch(message as JsonObject);
      } catch {
        this.fail("invalid_message");
      }
    }
  };

  private dispatch(message: JsonObject): void {
    if (message.jsonrpc !== "2.0") throw new Error();
    if (typeof message.method === "string") {
      if (!message.method) throw new Error();
      if ("id" in message) {
        const id = message.id;
        if (!((typeof id === "number" && Number.isSafeInteger(id)) || (typeof id === "string" && id.length > 0)) ||
            this.serverRequests.size >= this.maxPending || this.serverRequests.has(id)) throw new Error();
        this.serverRequests.add(id);
      }
      this.onMessage(message); return;
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) throw new Error();
    const entry = this.pending.get(message.id);
    if (!entry) return; // Late response after cancellation or timeout.
    if (("result" in message) === ("error" in message)) throw new Error();
    this.pending.delete(message.id); entry.cleanup();
    if ("error" in message) entry.reject(new MuseMspError("remote_error"));
    else entry.resolve(message.result);
  }

  private readonly onEnd = (): void => { this.fail(this.buffered ? "truncated_message" : "eof"); };
  private readonly onStreamError = (): void => { this.fail("stream_error"); };

  private fail(code: string): void {
    if (this.closed) return;
    this.closed = true;
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.input.removeListener("error", this.onStreamError);
    this.output.removeListener("error", this.onStreamError);
    this.buffer = Buffer.alloc(0);
    this.buffered = 0;
    this.serverRequests.clear();
    for (const id of this.pending.keys()) this.rejectPending(id, code);
  }
}
