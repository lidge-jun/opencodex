import { isDeepStrictEqual } from "node:util";
import { MuseMspError } from "./connection";
import type { MuseCapturedCall } from "./capture-server";
import type { MuseToolResult } from "./tool-result";

interface ExpectedCall {
  name: string;
  args: Record<string, unknown>;
  result: Promise<MuseToolResult>;
  timer: ReturnType<typeof setTimeout>;
}

/** Matches the capture-only MCP invocation to an already validated MSP approval. */
export class MuseCaptureRendezvous {
  private readonly expected = new Map<string, ExpectedCall>();
  private closed = false;
  private readonly shutdown = new AbortController();

  expect(call: MuseCapturedCall, result: Promise<MuseToolResult>): void {
    if (this.closed) throw new MuseMspError("closed");
    if (!call || typeof call.callId !== "string" || !call.callId || Buffer.byteLength(call.callId) > 512 ||
        typeof call.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(call.name) ||
        !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments) ||
        this.expected.has(call.callId) || this.expected.size >= 16) throw new MuseMspError("invalid_capture_expectation");
    let args: Record<string, unknown>;
    try {
      const serialized = JSON.stringify(call.arguments);
      if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error();
      args = JSON.parse(serialized);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
    } catch { throw new MuseMspError("invalid_capture_expectation"); }
    const timer = setTimeout(() => this.remove(call.callId), 300_000);
    timer.unref?.();
    const entry = { name: call.name, args, result, timer };
    this.expected.set(call.callId, entry);
    // A timed-out result may settle before the MCP process reaches tools/call.
    void result.then(() => {}, () => { if (this.expected.get(call.callId) === entry) this.remove(call.callId); });
  }

  async accept(call: MuseCapturedCall, signal: AbortSignal): Promise<string> {
    if (this.closed || signal.aborted) throw new MuseMspError("capture_unavailable");
    const expected = this.expected.get(call.callId);
    if (!expected || expected.name !== call.name || !isDeepStrictEqual(expected.args, call.arguments)) {
      throw new MuseMspError("capture_unavailable");
    }
    this.remove(call.callId);
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new MuseMspError("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      this.shutdown.signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || this.closed) abort();
    });
    try {
      const result = await Promise.race([expected.result, cancelled]);
      if (result.callId !== call.callId || typeof result.output !== "string") throw new MuseMspError("capture_unavailable");
      return result.output;
    } finally { signal.removeEventListener("abort", abort); this.shutdown.signal.removeEventListener("abort", abort); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.shutdown.abort();
    for (const id of this.expected.keys()) this.remove(id);
  }

  private remove(id: string): void {
    const entry = this.expected.get(id);
    if (entry) { clearTimeout(entry.timer); this.expected.delete(id); }
  }
}
