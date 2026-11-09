import { MuseMspError } from "./connection";

type Message = Record<string, unknown>;
type Waiter = {
  matches: (message: Message) => boolean;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** A bounded inbox for notifications which can arrive before an RPC acknowledgement. */
export class MuseMspInbox {
  private readonly queue: Array<{ message: Message; bytes: number }> = [];
  private bytes = 0;
  private waiter: Waiter | undefined;
  private failure: string | undefined;

  constructor(private readonly maxMessages = 256, private readonly maxBytes = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new MuseMspError("invalid_inbox_limits");
    }
  }

  push(message: Message): void {
    if (this.failure) return;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(message)); }
    catch { this.close("invalid_message"); return; }
    if (bytes > this.maxBytes || this.bytes + bytes > this.maxBytes || this.queue.length >= this.maxMessages) {
      this.close("inbox_overflow"); return;
    }
    const waiter = this.waiter;
    if (waiter) {
      let matches: boolean;
      try { matches = waiter.matches(message); }
      catch { this.close("invalid_message"); return; }
      if (matches) {
        this.waiter = undefined; waiter.cleanup(); waiter.resolve(message); return;
      }
    }
    this.queue.push({ message, bytes }); this.bytes += bytes;
  }

  take(matches: (message: Message) => boolean, options: { timeoutMs: number; signal?: AbortSignal }): Promise<Message> {
    if (this.failure) return Promise.reject(new MuseMspError(this.failure));
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) return Promise.reject(new MuseMspError("invalid_request"));
    if (options.signal?.aborted) return Promise.reject(new MuseMspError("cancelled"));
    if (this.waiter) return Promise.reject(new MuseMspError("inbox_busy"));
    let index: number;
    try { index = this.queue.findIndex(entry => matches(entry.message)); }
    catch { this.close("invalid_message"); return Promise.reject(new MuseMspError("invalid_message")); }
    if (index >= 0) {
      const [entry] = this.queue.splice(index, 1);
      this.bytes -= entry!.bytes;
      return Promise.resolve(entry!.message);
    }
    return new Promise((resolve, reject) => {
      const stop = (code: string) => {
        if (this.waiter !== waiter) return;
        this.waiter = undefined; waiter.cleanup(); reject(new MuseMspError(code));
      };
      const abort = () => stop("cancelled");
      const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
      const waiter: Waiter = { matches, resolve, reject, cleanup: () => {
        clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      } };
      this.waiter = waiter;
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }

  close(code = "closed"): void {
    if (this.failure) return;
    this.failure = code; this.queue.length = 0; this.bytes = 0;
    const waiter = this.waiter; this.waiter = undefined;
    if (waiter) { waiter.cleanup(); waiter.reject(new MuseMspError(code)); }
  }
}
