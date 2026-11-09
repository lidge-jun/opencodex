import { timingSafeEqual } from "node:crypto";
import { MuseMspError } from "./connection";

export interface MuseToolResult {
  callId: string;
  output: string;
}

/**
 * One captured MCP call awaiting a client-owned result. The caller must supply an
 * unguessable request-owner secret and bind it to its authenticated request context.
 * This object never executes tools and never decides client authorization itself.
 */
export class MusePendingToolResult {
  private settled = false;
  private committing = false;
  private readonly secret: Buffer;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort: () => void;
  private resolve!: (result: MuseToolResult) => void;
  private reject!: (error: Error) => void;
  readonly result: Promise<MuseToolResult>;

  constructor(
    private readonly callId: string,
    ownerSecret: string,
    private readonly options: { timeoutMs: number; signal?: AbortSignal; maxOutputBytes?: number },
  ) {
    const max = options.maxOutputBytes ?? 4 * 1024 * 1024;
    if (!callId || Buffer.byteLength(callId) > 512 || !/^[0-9a-f]{64}$/.test(ownerSecret) ||
        !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
        !Number.isSafeInteger(max) || max < 1 || max > 16 * 1024 * 1024) {
      throw new MuseMspError("invalid_pending_tool");
    }
    this.secret = Buffer.from(ownerSecret, "hex");
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.abort = () => this.fail("cancelled");
    this.timer = setTimeout(() => this.fail("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
  }

  /** Validate without consuming; asynchronous steering must never accept an unowned result. */
  validate(ownerSecret: string, result: MuseToolResult): void {
    if (this.settled || this.committing) throw new MuseMspError("tool_result_settled");
    if (typeof ownerSecret !== "string" || !/^[0-9a-f]{64}$/.test(ownerSecret) ||
        !timingSafeEqual(this.secret, Buffer.from(ownerSecret, "hex"))) throw new MuseMspError("unowned_tool_result");
    if (!result || result.callId !== this.callId || typeof result.output !== "string" ||
        Buffer.byteLength(result.output) > (this.options.maxOutputBytes ?? 4 * 1024 * 1024)) {
      throw new MuseMspError("invalid_tool_result");
    }
  }

  /** Invalid submissions do not consume the pending result. */
  submit(ownerSecret: string, result: MuseToolResult, beforeCommit?: (result: Readonly<MuseToolResult>) => void): void {
    this.validate(ownerSecret, result);
    // A dispatch fence may refuse after validation and before the result becomes visible.
    this.committing = true;
    try { beforeCommit?.(Object.freeze({ callId: this.callId, output: result.output })); } finally { this.committing = false; }
    if (this.settled) throw new MuseMspError("tool_result_settled");
    this.settled = true; this.cleanup();
    this.resolve({ callId: this.callId, output: result.output });
  }

  close(): void { this.fail("closed"); }

  private fail(code: string): void {
    if (this.settled) return;
    this.settled = true; this.cleanup(); this.reject(new MuseMspError(code));
  }

  private cleanup(): void {
    clearTimeout(this.timer); this.options.signal?.removeEventListener("abort", this.abort); this.secret.fill(0);
  }
}
