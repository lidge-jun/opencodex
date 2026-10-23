/**
 * Wire codec for the Step Agent SDK stdio protocol (`step --sdk-stdio`).
 *
 * The transport is deliberately separated from the session so both halves stay testable without a
 * process: this module owns framing and envelope validation, `session.ts` owns the process, request
 * correlation and reverse-request dispatch.
 *
 * Framing is a 4-byte big-endian length prefix followed by UTF-8 JSON. This is NOT the same protocol
 * as `step --mode rpc`, which is newline-delimited JSONL — mixing the two is the single easiest way
 * to build a host that writes frames nobody answers.
 */

export const STEP_PROTOCOL_NAME = "step-agent-sdk" as const;
export const STEP_PROTOCOL_VERSION = 1 as const;
export const STEP_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const STEP_LENGTH_PREFIX_BYTES = 4;

/** The runtime rejects a length prefix below this; a smaller value can never carry `{}`. */
const STEP_MIN_FRAME_BYTES = 2;

export type StepFrameKind = "request" | "response" | "event";

export interface StepProtocolErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
}

export interface StepFrame {
  readonly protocol: typeof STEP_PROTOCOL_NAME;
  readonly version: number;
  readonly kind: StepFrameKind;
  readonly id: string;
  readonly method?: string;
  readonly replyTo?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly sequence?: number;
  readonly payload?: unknown;
  readonly error?: StepProtocolErrorPayload;
}

export type StepProtocolViolationCode =
  | "PROTOCOL_VIOLATION"
  | "FRAME_TOO_LARGE"
  | "FRAME_TOO_SMALL"
  | "INCOMPLETE_FRAME"
  | "INVALID_UTF8"
  | "INVALID_JSON";

/**
 * A framing or envelope failure the host must surface rather than swallow.
 *
 * The Step runtime answers a malformed frame with nothing at all, so a peer that keeps writing
 * after a decode failure waits forever. Callers turn this into a terminal error and tear the session
 * down instead of retrying into silence.
 */
export class StepProtocolViolation extends Error {
  readonly code: StepProtocolViolationCode;

  constructor(message: string, code: StepProtocolViolationCode = "PROTOCOL_VIOLATION") {
    super(message);
    this.name = "StepProtocolViolation";
    this.code = code;
  }
}

const FRAME_KINDS: ReadonlySet<string> = new Set(["request", "response", "event"]);

/**
 * Runtime envelope guard.
 *
 * Unknown protocol versions pass deliberately: the runtime negotiates `initialize.protocolRange`,
 * so a newer peer has to be able to offer a range before this host learns what it speaks.
 */
export function isStepFrame(value: unknown): value is StepFrame {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  if (
    frame.protocol !== STEP_PROTOCOL_NAME ||
    typeof frame.version !== "number" ||
    !Number.isSafeInteger(frame.version) ||
    frame.version < 1 ||
    typeof frame.kind !== "string" ||
    !FRAME_KINDS.has(frame.kind) ||
    typeof frame.id !== "string" ||
    frame.id.length === 0
  ) {
    return false;
  }
  if (frame.kind === "request" || frame.kind === "event") {
    if (typeof frame.method !== "string" || frame.method.trim().length === 0) return false;
    return (
      frame.kind === "request" ||
      (typeof frame.sequence === "number" &&
        Number.isSafeInteger(frame.sequence) &&
        frame.sequence >= 0)
    );
  }
  if (typeof frame.replyTo !== "string" || frame.replyTo.trim().length === 0) return false;
  if (frame.payload !== undefined && frame.error !== undefined) return false;
  return frame.error === undefined || isStepProtocolErrorPayload(frame.error);
}

function isStepProtocolErrorPayload(value: unknown): value is StepProtocolErrorPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const error = value as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
}

function assertMaxFrameBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > STEP_MAX_FRAME_BYTES) {
    throw new StepProtocolViolation("maxFrameBytes must be a positive bounded integer");
  }
}

function assertEnvelope(frame: StepFrame): void {
  // The ambiguous-response case is checked first so it keeps its own diagnostic: the generic guard
  // below rejects it too, and reporting only that would send a caller looking for a malformed
  // envelope instead of the contract violation they actually wrote.
  if (frame.kind === "response" && frame.payload !== undefined && frame.error !== undefined) {
    throw new StepProtocolViolation("response frame cannot contain both payload and error");
  }
  if (!isStepFrame(frame)) {
    throw new StepProtocolViolation("frame is not a valid Step protocol envelope");
  }
}

/** Encode one frame as a 4-byte big-endian length prefix followed by UTF-8 JSON. */
export function encodeStepFrame(frame: StepFrame, maxFrameBytes = STEP_MAX_FRAME_BYTES): Buffer {
  assertMaxFrameBytes(maxFrameBytes);
  assertEnvelope(frame);

  let json: string;
  try {
    json = JSON.stringify(frame);
  } catch (error) {
    throw new StepProtocolViolation(
      `frame payload could not be serialized: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_JSON",
    );
  }
  const payload = Buffer.from(json, "utf8");
  if (payload.byteLength > maxFrameBytes) {
    throw new StepProtocolViolation(
      `outgoing frame exceeds max frame size (${payload.byteLength} > ${maxFrameBytes} bytes)`,
      "FRAME_TOO_LARGE",
    );
  }
  const result = Buffer.allocUnsafe(STEP_LENGTH_PREFIX_BYTES + payload.byteLength);
  result.writeUInt32BE(payload.byteLength, 0);
  payload.copy(result, STEP_LENGTH_PREFIX_BYTES);
  return result;
}

/**
 * Incremental decoder for the peer side of the same protocol.
 *
 * Copies only the frame currently being assembled, so a caller may reuse or mutate the chunk it
 * passed in once `push` returns. A length prefix that cannot be trusted throws immediately instead of
 * allocating from an arbitrary 32-bit number.
 */
export class StepFrameDecoder {
  readonly #maxFrameBytes: number;
  readonly #prefix = Buffer.alloc(STEP_LENGTH_PREFIX_BYTES);
  #prefixBytes = 0;
  #payload: Buffer | undefined;
  #payloadBytes = 0;
  #expectedPayloadBytes: number | undefined;
  #closed = false;

  constructor(options?: { readonly maxFrameBytes?: number } | number) {
    const maxFrameBytes = typeof options === "number" ? options : options?.maxFrameBytes;
    assertMaxFrameBytes(maxFrameBytes ?? STEP_MAX_FRAME_BYTES);
    this.#maxFrameBytes = maxFrameBytes ?? STEP_MAX_FRAME_BYTES;
  }

  get hasPendingInput(): boolean {
    return this.#prefixBytes > 0 || this.#expectedPayloadBytes !== undefined;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(chunk: Uint8Array): StepFrame[] {
    if (this.#closed) throw new StepProtocolViolation("frame decoder is closed");
    if (!(chunk instanceof Uint8Array)) {
      throw new StepProtocolViolation("frame decoder input must be a Uint8Array");
    }

    const frames: StepFrame[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.#expectedPayloadBytes === undefined) {
        while (this.#prefixBytes < STEP_LENGTH_PREFIX_BYTES && offset < chunk.byteLength) {
          this.#prefix[this.#prefixBytes] = chunk[offset];
          this.#prefixBytes += 1;
          offset += 1;
        }
        if (this.#prefixBytes < STEP_LENGTH_PREFIX_BYTES) break;

        const length = this.#prefix.readUInt32BE(0);
        if (length < STEP_MIN_FRAME_BYTES) {
          this.#resetCurrentFrame();
          // Its own message and code: reporting an undersized prefix as "exceeds max frame size" sends
          // the operator looking at the ceiling when the real fault is a truncated or unframed stream.
          throw new StepProtocolViolation(
            `incoming frame is shorter than the smallest encodable frame (${length} < ${STEP_MIN_FRAME_BYTES} bytes)`,
            "FRAME_TOO_SMALL",
          );
        }
        if (length > this.#maxFrameBytes) {
          this.#resetCurrentFrame();
          throw new StepProtocolViolation(
            `incoming frame exceeds max frame size (${length} > ${this.#maxFrameBytes} bytes)`,
            "FRAME_TOO_LARGE",
          );
        }
        this.#expectedPayloadBytes = length;
        this.#payload = Buffer.allocUnsafe(length);
        this.#payloadBytes = 0;
      }

      const remainingInput = chunk.byteLength - offset;
      const remainingPayload = this.#expectedPayloadBytes - this.#payloadBytes;
      const copied = Math.min(remainingInput, remainingPayload);
      this.#payload!.set(chunk.subarray(offset, offset + copied), this.#payloadBytes);
      this.#payloadBytes += copied;
      offset += copied;
      if (this.#payloadBytes < this.#expectedPayloadBytes) break;

      const payload = this.#payload!;
      this.#resetCurrentFrame();
      frames.push(this.#decode(payload));
    }
    return frames;
  }

  /** Signal EOF. A trailing prefix or half-read payload is a protocol violation. */
  end(): void {
    if (this.#closed) return;
    if (this.hasPendingInput) {
      const pending = this.#prefixBytes + this.#payloadBytes;
      this.#resetCurrentFrame();
      this.#closed = true;
      throw new StepProtocolViolation(
        `stream ended with ${pending} trailing bytes of a partial frame`,
        "INCOMPLETE_FRAME",
      );
    }
    this.#closed = true;
  }

  #decode(payload: Buffer): StepFrame {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    } catch (error) {
      throw new StepProtocolViolation(
        `frame payload is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
        "INVALID_UTF8",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new StepProtocolViolation(
        `frame payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        "INVALID_JSON",
      );
    }
    if (!isStepFrame(parsed)) {
      throw new StepProtocolViolation("frame payload is not a valid protocol envelope");
    }
    return parsed;
  }

  #resetCurrentFrame(): void {
    this.#prefixBytes = 0;
    this.#payload = undefined;
    this.#payloadBytes = 0;
    this.#expectedPayloadBytes = undefined;
  }
}

/** Build a `request` envelope for a peer-initiated call. */
export function stepRequest(id: string, method: string, payload?: unknown): StepFrame {
  return {
    protocol: STEP_PROTOCOL_NAME,
    version: STEP_PROTOCOL_VERSION,
    kind: "request",
    id,
    method,
    ...(payload === undefined ? {} : { payload }),
  };
}

/** Build a `response` envelope answering the frame with `replyTo`. */
export function stepResponse(replyTo: string, payload?: unknown, id?: string): StepFrame {
  return {
    protocol: STEP_PROTOCOL_NAME,
    version: STEP_PROTOCOL_VERSION,
    kind: "response",
    id: id ?? `r_${replyTo}`,
    replyTo,
    ...(payload === undefined ? {} : { payload }),
  };
}

/** Build a `response` envelope carrying a protocol error instead of a payload. */
export function stepErrorResponse(
  replyTo: string,
  code: string,
  message: string,
  retryable = false,
  id?: string,
): StepFrame {
  return {
    protocol: STEP_PROTOCOL_NAME,
    version: STEP_PROTOCOL_VERSION,
    kind: "response",
    id: id ?? `r_${replyTo}`,
    replyTo,
    error: { code, message, retryable },
  };
}
