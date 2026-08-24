import { isCyberPolicyCode, isCyberPolicyMessage } from "../lib/errors";

export const MAX_CLIENT_SSE_FRAME_BYTES = 4 * 1024 * 1024;

const LF_LF = Uint8Array.of(10, 10);
const LF_CR_LF = Uint8Array.of(10, 13, 10);
const CR_LF_LF = Uint8Array.of(13, 10, 10);
const CR_LF_CR_LF = Uint8Array.of(13, 10, 13, 10);

export class SseFrameTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`upstream SSE frame exceeded ${maxBytes} bytes`);
    this.name = "SseFrameTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export class SseFrameCountLimitError extends Error {
  readonly maxFrames: number;

  constructor(maxFrames: number) {
    super(`upstream SSE chunk exceeded ${maxFrames} frame limit`);
    this.name = "SseFrameCountLimitError";
    this.maxFrames = maxFrames;
  }
}

export type BoundedSseFrame = {
  block: Uint8Array;
  delimiter: Uint8Array;
};

/**
 * Classify the bytes at `index` as an SSE block delimiter.
 *
 * Returns the delimiter length in bytes, `0` when `index` does not start a
 * delimiter, and `undefined` when more bytes are required to decide.
 */
function delimiterLengthAt(
  index: number,
  length: number,
  byteAt: (index: number) => number,
): number | undefined {
  const first = byteAt(index);
  if (first === 10) {
    if (index + 1 >= length) return undefined;
    const second = byteAt(index + 1);
    if (second === 10) return 2;
    if (second !== 13) return 0;
    if (index + 2 >= length) return undefined;
    return byteAt(index + 2) === 10 ? 3 : 0;
  }
  if (first !== 13) return 0;
  if (index + 1 >= length) return undefined;
  if (byteAt(index + 1) !== 10) return 0;
  if (index + 2 >= length) return undefined;
  const third = byteAt(index + 2);
  if (third === 10) return 3;
  if (third !== 13) return 0;
  if (index + 3 >= length) return undefined;
  return byteAt(index + 3) === 10 ? 4 : 0;
}

function delimiterBytesAt(
  index: number,
  delimiterLength: number,
  byteAt: (index: number) => number,
): Uint8Array {
  if (delimiterLength === 2) return LF_LF;
  if (delimiterLength === 4) return CR_LF_CR_LF;
  return byteAt(index) === 10 ? LF_CR_LF : CR_LF_LF;
}

function copyRange(
  start: number,
  end: number,
  tailLength: number,
  previousTail: Uint8Array,
  chunk: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(end - start);
  for (let index = start; index < end; index += 1) {
    out[index - start] = index < tailLength
      ? previousTail[index]!
      : chunk[index - tailLength]!;
  }
  return out;
}

/**
 * True when a complete SSE block already commits a Responses terminal event.
 *
 * Framing errors in bytes *after* such a block must not retroactively turn an
 * already-completed/failed/incomplete model turn into a transport failure. This
 * helper is used only on the exceptional path, so decoding/JSON parsing has no
 * cost on ordinary framing.
 */
function isResponsesTerminalFrame(block: Uint8Array): boolean {
  const data: string[] = [];
  for (const line of new TextDecoder().decode(block).split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  if (data.length === 0) return false;
  const payload = data.join("\n");
  if (payload === "[DONE]") return false;
  try {
    const parsed = JSON.parse(payload) as {
      type?: unknown;
      code?: unknown;
      message?: unknown;
      error?: unknown;
      last_error?: unknown;
      response?: { error?: unknown; incomplete_details?: unknown };
    };
    if (parsed.type === "response.completed"
      || parsed.type === "response.failed"
      || parsed.type === "response.incomplete") return true;
    if (parsed.type !== "error") return false;
    // A top-level error is terminal for this boundary only when it carries the
    // same high-confidence cyber-policy evidence used by relay.ts. Ordinary
    // upstream errors remain transport failures and still become a bounded 502.
    const candidates = [
      parsed,
      parsed.error,
      parsed.last_error,
      parsed.response?.error,
      parsed.response?.incomplete_details,
    ];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const record = candidate as { code?: unknown; message?: unknown };
      if (isCyberPolicyCode(typeof record.code === "string" ? record.code : undefined)) return true;
      if (typeof record.message === "string" && isCyberPolicyMessage(record.message)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Byte-bounded SSE block framer for client-facing protocol paths.
 *
 * The delimiter scanner works on raw bytes, so fragmented UTF-8 cannot change
 * accounting and a hostile upstream cannot grow an unterminated JS string
 * without limit. Candidate bytes live in one geometrically grown buffer rather
 * than one allocation per upstream chunk, bounding both bytes and object count.
 * Complete blocks are returned without their delimiter; the exact delimiter
 * bytes are returned separately so callers can relay bytes unchanged.
 */
export class BoundedSseFrameBuffer {
  private readonly maxFrameBytes: number;
  private readonly maxFramesPerFeed: number;
  private delimiterTail: Uint8Array = new Uint8Array(0);
  private candidate: Uint8Array = new Uint8Array(0);
  private candidateBytes = 0;
  private disposed = false;

  constructor(maxFrameBytes = MAX_CLIENT_SSE_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError("maxFrameBytes must be a positive safe integer");
    }
    this.maxFrameBytes = maxFrameBytes;
    // Delimiter-only input otherwise creates an object-amplification path that
    // is independent of candidate bytes. Keep frame count proportional to the
    // configured byte budget while leaving ample room for real Responses events.
    this.maxFramesPerFeed = Math.max(1, Math.ceil(maxFrameBytes / 1024));
  }

  private clear(): void {
    this.delimiterTail = new Uint8Array(0);
    this.candidate = new Uint8Array(0);
    this.candidateBytes = 0;
  }

  private ensureCapacity(requiredBytes: number): void {
    if (this.candidate.byteLength >= requiredBytes) return;
    if (requiredBytes > this.maxFrameBytes) {
      throw new SseFrameTooLargeError(this.maxFrameBytes);
    }
    let capacity = this.candidate.byteLength === 0
      ? Math.min(this.maxFrameBytes, Math.max(requiredBytes, 4096))
      : this.candidate.byteLength;
    while (capacity < requiredBytes) {
      capacity = Math.min(this.maxFrameBytes, Math.max(requiredBytes, capacity * 2));
    }
    const grown = new Uint8Array(capacity);
    if (this.candidateBytes > 0) {
      grown.set(this.candidate.subarray(0, this.candidateBytes));
    }
    this.candidate = grown;
  }

  private retain(slice: Uint8Array): void {
    if (slice.byteLength === 0) return;
    const nextBytes = this.candidateBytes + slice.byteLength;
    if (nextBytes > this.maxFrameBytes) {
      this.clear();
      this.disposed = true;
      throw new SseFrameTooLargeError(this.maxFrameBytes);
    }
    this.ensureCapacity(nextBytes);
    this.candidate.set(slice, this.candidateBytes);
    this.candidateBytes = nextBytes;
  }

  private takeCandidate(): Uint8Array {
    if (this.candidateBytes === 0) return new Uint8Array(0);
    const block = this.candidate.slice(0, this.candidateBytes);
    // Release the working allocation after each complete frame. This avoids
    // retaining a rare multi-MiB frame allocation for the rest of a long-lived
    // stream; normal small-frame allocation remains bounded by feed's frame cap.
    this.candidate = new Uint8Array(0);
    this.candidateBytes = 0;
    return block;
  }

  feed(chunk: Uint8Array): BoundedSseFrame[] {
    if (this.disposed) return [];
    if (chunk.byteLength === 0) return [];

    const frames: BoundedSseFrame[] = [];
    const previousTail = this.delimiterTail;
    this.delimiterTail = new Uint8Array(0);
    const tailLength = previousTail.byteLength;
    const totalLength = tailLength + chunk.byteLength;
    const byteAt = (index: number): number => index < tailLength
      ? previousTail[index]!
      : chunk[index - tailLength]!;
    const retainRange = (start: number, end: number): void => {
      if (end <= start) return;
      if (start < tailLength) {
        this.retain(previousTail.subarray(start, Math.min(end, tailLength)));
      }
      if (end > tailLength) {
        this.retain(chunk.subarray(Math.max(0, start - tailLength), end - tailLength));
      }
    };

    try {
      let index = 0;
      let retainedThrough = 0;
      while (index < totalLength) {
        const delimiterLength = delimiterLengthAt(index, totalLength, byteAt);
        if (delimiterLength === undefined) break;
        if (delimiterLength > 0) {
          if (frames.length >= this.maxFramesPerFeed) {
            this.clear();
            this.disposed = true;
            throw new SseFrameCountLimitError(this.maxFramesPerFeed);
          }
          retainRange(retainedThrough, index);
          const block = this.takeCandidate();
          const delimiter = delimiterBytesAt(index, delimiterLength, byteAt);
          frames.push({ block, delimiter });
          index += delimiterLength;
          retainedThrough = index;
          continue;
        }
        index += 1;
      }

      retainRange(retainedThrough, index);
      if (index < totalLength) {
        this.delimiterTail = copyRange(index, totalLength, tailLength, previousTail, chunk);
      }
      return frames;
    } catch (err) {
      const framingError = err instanceof SseFrameTooLargeError
        || err instanceof SseFrameCountLimitError;
      if (framingError && frames.some(frame => isResponsesTerminalFrame(frame.block))) {
        // A terminal frame is the Responses protocol boundary. Ignore malformed
        // or oversized bytes that occur later in the same upstream chunk rather
        // than retroactively replacing the committed terminal with a 502.
        this.clear();
        this.disposed = true;
        return frames;
      }
      throw err;
    }
  }

  /** Return the final unterminated block bytes and release all retained state. */
  finish(): Uint8Array {
    if (this.disposed) return new Uint8Array(0);
    try {
      this.retain(this.delimiterTail);
      this.delimiterTail = new Uint8Array(0);
      return this.takeCandidate();
    } finally {
      this.clear();
      this.disposed = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
  }
}

export function joinSseFrameBytes(parts: readonly Uint8Array[]): Uint8Array {
  let byteLength = 0;
  for (const part of parts) byteLength += part.byteLength;
  if (byteLength === 0) return new Uint8Array(0);
  if (parts.length === 1 && parts[0]!.byteLength === byteLength) return parts[0]!;
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}
