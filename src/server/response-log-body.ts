/** Bounds diagnostic retention, never the bytes delivered to the caller. */
export const MAX_RESPONSE_LOG_INSPECTION_BYTES = 32 * 1024 * 1024;
export const MAX_NON_JSON_ERROR_INSPECTION_BYTES = 8 * 1024;
const INSPECTION_BLOCK_BYTES = 64 * 1024;

export type ResponseLogBodyEnd = "eof" | "read_error" | "cancel";

export interface ResponseLogBodyOptions {
  json: boolean;
  inspect: (text: string) => void;
  finalize: (reason: ResponseLogBodyEnd) => void;
  /** Internal test seam; this is not a provider-controlled limit. */
  maxInspectionBytes?: number;
}

/** Fixed-size blocks bound both retained bytes and per-chunk bookkeeping. */
class ResponseLogInspection {
  private blocks: Uint8Array[] = [];
  private bytes = 0;
  private overflowed = false;

  constructor(private readonly json: boolean, private readonly limit: number) {}

  append(chunk: Uint8Array): void {
    if (this.overflowed || chunk.byteLength === 0) return;
    if (this.json && chunk.byteLength > this.limit - this.bytes) {
      // A JSON prefix is not an authoritative response. Drop it immediately,
      // without either truncating the delivery stream or retaining later bytes.
      this.overflowed = true;
      this.dispose();
      return;
    }
    let remaining = Math.min(chunk.byteLength, this.limit - this.bytes);
    let offset = 0;
    while (remaining > 0) {
      const blockOffset = this.bytes % INSPECTION_BLOCK_BYTES;
      if (blockOffset === 0) {
        this.blocks.push(new Uint8Array(Math.min(INSPECTION_BLOCK_BYTES, this.limit - this.bytes)));
      }
      const block = this.blocks[this.blocks.length - 1]!;
      const length = Math.min(remaining, block.byteLength - blockOffset);
      block.set(chunk.subarray(offset, offset + length), blockOffset);
      this.bytes += length;
      offset += length;
      remaining -= length;
    }
  }

  text(reason: ResponseLogBodyEnd): string | undefined {
    // Even a syntactically valid JSON prefix must not update usage/model
    // metadata when the transport did not reach EOF.
    if (this.json && (reason !== "eof" || this.overflowed)) return undefined;
    const combined = new Uint8Array(this.bytes);
    let offset = 0;
    for (const block of this.blocks) {
      const length = Math.min(block.byteLength, this.bytes - offset);
      combined.set(block.subarray(0, length), offset);
      offset += length;
    }
    return new TextDecoder().decode(combined);
  }

  dispose(): void {
    this.blocks.length = 0;
    this.bytes = 0;
  }
}

/** Optional diagnostics must not change the response's transport outcome. */
function bestEffort(callback: () => void): void {
  try {
    callback();
  } catch {
    return;
  }
}

/**
 * Forward one upstream read per downstream pull, with bounded side inspection.
 * EOF, read failure and cancellation each finalize at most once. Cancellation
 * does not await the upstream cancel promise: one branch of a tee can otherwise
 * wait for a sibling that the same caller intends to consume or cancel later.
 */
export function createBoundedResponseLogBody(
  body: ReadableStream<Uint8Array>,
  options: ResponseLogBodyOptions,
): ReadableStream<Uint8Array> {
  const limit = options.maxInspectionBytes ?? (options.json
    ? MAX_RESPONSE_LOG_INSPECTION_BYTES
    : MAX_NON_JSON_ERROR_INSPECTION_BYTES);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Response log inspection limit must be a non-negative safe integer");
  }
  const inspection = new ResponseLogInspection(options.json, limit);
  const reader = body.getReader();
  let ended = false;
  let inspectionFailed = false;

  const release = () => bestEffort(() => reader.releaseLock());
  const finish = (reason: ResponseLogBodyEnd) => {
    if (ended) return;
    ended = true; // Set before callbacks or a pending read resumes.
    try {
      if (!inspectionFailed) {
        bestEffort(() => {
          const text = inspection.text(reason);
          if (text !== undefined) options.inspect(text);
        });
      }
    } finally {
      inspection.dispose();
      bestEffort(() => options.finalize(reason));
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ended) return;
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        if (ended) return; // Cancellation owns its pending-read settlement.
        finish("read_error");
        release();
        controller.error(error);
        return;
      }
      if (ended) return;
      if (result.done) {
        finish("eof");
        release();
        controller.close();
        return;
      }
      if (!inspectionFailed) {
        try {
          inspection.append(result.value);
        } catch {
          inspectionFailed = true;
          inspection.dispose();
        }
      }
      // Do not decode/re-encode transport bytes, including malformed UTF-8.
      controller.enqueue(result.value);
    },
    cancel(reason) {
      finish("cancel");
      bestEffort(() => { void reader.cancel(reason).catch(() => undefined); });
      release();
    },
  }, { highWaterMark: 0 });
}
