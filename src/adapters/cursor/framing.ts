export const CONNECT_FRAME_HEADER_BYTES = 5;
export const CONNECT_FLAG_COMPRESSED = 0x01;
export const CONNECT_FLAG_END_STREAM = 0x02;
export const MAX_CONNECT_FRAME_PAYLOAD_BYTES = 0xffffffff;

export type ConnectFrameErrorCode =
  | "invalid_offset"
  | "invalid_flags"
  | "payload_too_large"
  | "frame_incomplete";

export interface ConnectFrame {
  flags: number;
  payload: Uint8Array;
  compressed: boolean;
  endStream: boolean;
}

export interface DecodedConnectFrame {
  frame: ConnectFrame;
  readBytes: number;
}

export interface DecodedConnectFrames {
  frames: ConnectFrame[];
  remainder: Uint8Array;
}

interface CopyReservation {
  commitRetained(): void;
  release(): void;
}

interface InspectedConnectFrame {
  flags: number;
  length: number;
  payloadStart: number;
  readBytes: number;
}

export class ConnectFrameError extends Error {
  constructor(
    public readonly code: ConnectFrameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectFrameError";
  }
}

export function isConnectFrameCompressed(flags: number): boolean {
  return (flags & CONNECT_FLAG_COMPRESSED) === CONNECT_FLAG_COMPRESSED;
}

export function isConnectFrameEndStream(flags: number): boolean {
  return (flags & CONNECT_FLAG_END_STREAM) === CONNECT_FLAG_END_STREAM;
}

export function encodeConnectFrame(
  payload: Uint8Array,
  options: { flags?: number; compressed?: boolean; endStream?: boolean } = {},
): Uint8Array {
  if (payload.length > MAX_CONNECT_FRAME_PAYLOAD_BYTES) {
    throw new ConnectFrameError("payload_too_large", `Connect frame payload too large: ${payload.length}`);
  }

  let flags = options.flags ?? 0;
  assertByte(flags, "invalid_flags", `Connect frame flags must be a byte: ${flags}`);
  if (options.compressed) flags |= CONNECT_FLAG_COMPRESSED;
  if (options.endStream) flags |= CONNECT_FLAG_END_STREAM;

  const frame = new Uint8Array(CONNECT_FRAME_HEADER_BYTES + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    .setUint32(1, payload.length, false);
  frame.set(payload, CONNECT_FRAME_HEADER_BYTES);
  return frame;
}

export function tryDecodeConnectFrame(
  input: Uint8Array,
  offset = 0,
  maxPayloadBytes = MAX_CONNECT_FRAME_PAYLOAD_BYTES,
  reservePayloadCopy?: (bytes: number) => CopyReservation | undefined,
): DecodedConnectFrame | null {
  assertOffset(input, offset);
  const inspected = inspectConnectFrame(input, offset, maxPayloadBytes);
  if (!inspected) return null;
  const payloadEnd = inspected.payloadStart + inspected.length;
  const reservation = reservePayloadCopy?.(inspected.length);
  let payload: Uint8Array;
  try {
    payload = input.slice(inspected.payloadStart, payloadEnd);
    reservation?.commitRetained();
  } catch (error) {
    reservation?.release();
    throw error;
  }
  return {
    frame: {
      flags: inspected.flags,
      payload,
      compressed: isConnectFrameCompressed(inspected.flags),
      endStream: isConnectFrameEndStream(inspected.flags),
    },
    readBytes: inspected.readBytes,
  };
}

export function decodeConnectFrame(input: Uint8Array, offset = 0): DecodedConnectFrame {
  const decoded = tryDecodeConnectFrame(input, offset);
  if (!decoded) {
    throw new ConnectFrameError("frame_incomplete", "Incomplete Connect frame");
  }
  return decoded;
}

export function decodeConnectFrames(input: Uint8Array): ConnectFrame[] {
  const frames: ConnectFrame[] = [];
  let offset = 0;
  while (offset < input.length) {
    const decoded = decodeConnectFrame(input, offset);
    frames.push(decoded.frame);
    offset += decoded.readBytes;
  }
  return frames;
}

export function decodeAvailableConnectFrames(
  input: Uint8Array,
  maxPayloadBytes = MAX_CONNECT_FRAME_PAYLOAD_BYTES,
  availableFrameSlots = Number.POSITIVE_INFINITY,
  reservePayloadCopy?: (bytes: number) => CopyReservation | undefined,
): DecodedConnectFrames {
  const planned: Array<InspectedConnectFrame & { reservation?: CopyReservation }> = [];
  let offset = 0;
  let remainderReservation: CopyReservation | undefined;
  try {
    while (offset < input.length && planned.length < availableFrameSlots) {
      const inspected = inspectConnectFrame(input, offset, maxPayloadBytes);
      if (!inspected) break;
      const reservation = reservePayloadCopy?.(inspected.length);
      planned.push({ ...inspected, reservation });
      offset += inspected.readBytes;
    }
    const remainderBytes = offset === input.length ? 0 : bufferedPayloadBytes(input, offset);
    remainderReservation = reservePayloadCopy?.(remainderBytes);

    // Keep every reservation transient until every batch allocation succeeds. A later admission
    // failure can then roll the entire batch back without needing ownership of unreturned frames.
    const frames = planned.map(({ flags, length, payloadStart }) => {
      const payload = input.slice(payloadStart, payloadStart + length);
      return {
        flags,
        payload,
        compressed: isConnectFrameCompressed(flags),
        endStream: isConnectFrameEndStream(flags),
      };
    });
    const remainder = offset === input.length ? new Uint8Array() : input.slice(offset);
    for (const entry of planned) entry.reservation?.commitRetained();
    remainderReservation?.commitRetained();
    return { frames, remainder };
  } catch (error) {
    for (const entry of planned) entry.reservation?.release();
    remainderReservation?.release();
    throw error;
  }
}

/**
 * Cursor-based sibling of decodeAvailableConnectFrames for callers that keep
 * their own raw backlog: consumes complete frames from the FRONT of `input`
 * and reports how many bytes were consumed (headers included) instead of
 * materializing a remainder copy, and hands payload VIEWS (not copies) back so
 * the caller can transfer the already-charged bytes to the frame lifecycle
 * instead of reserving a second copy. The caller advances its own cursor by
 * `consumedBytes` and never pays an O(backlog) copy per drain.
 */
export function consumeConnectFrames(
  input: Uint8Array,
  maxPayloadBytes = MAX_CONNECT_FRAME_PAYLOAD_BYTES,
  availableFrameSlots = Number.POSITIVE_INFINITY,
): { frames: ConnectFrame[]; consumedBytes: number } {
  const planned: InspectedConnectFrame[] = [];
  let offset = 0;
  while (offset < input.length && planned.length < availableFrameSlots) {
    const inspected = inspectConnectFrame(input, offset, maxPayloadBytes);
    if (!inspected) break;
    planned.push(inspected);
    offset += inspected.readBytes;
  }
  // Zero-copy handoff for large payloads: VIEWS into the caller's backlog
  // buffer (safe: append-only at its end, compaction/growth replace the
  // buffer, a consumed region is never mutated in place). Small payloads are
  // COPIED instead — a small view would pin the whole backlog buffer (up to
  // 32 MiB) alive while the frame waits in the work queue.
  const COPY_PIN_THRESHOLD_BYTES = 64 * 1024;
  const frames = planned.map(({ flags, length, payloadStart }) => ({
    flags,
    payload: length <= COPY_PIN_THRESHOLD_BYTES
      ? input.slice(payloadStart, payloadStart + length)
      : input.subarray(payloadStart, payloadStart + length),
    compressed: isConnectFrameCompressed(flags),
    endStream: isConnectFrameEndStream(flags),
  }));
  return { frames, consumedBytes: offset };
}

function inspectConnectFrame(
  input: Uint8Array,
  offset: number,
  maxPayloadBytes: number,
): InspectedConnectFrame | null {
  if (input.length - offset < CONNECT_FRAME_HEADER_BYTES) return null;
  const view = new DataView(input.buffer, input.byteOffset + offset, input.byteLength - offset);
  const flags = view.getUint8(0);
  const length = view.getUint32(1, false);
  if (length > maxPayloadBytes) {
    throw new ConnectFrameError("payload_too_large", `Connect frame payload too large: ${length}`);
  }
  const readBytes = CONNECT_FRAME_HEADER_BYTES + length;
  if (input.length - offset < readBytes) return null;
  return { flags, length, payloadStart: offset + CONNECT_FRAME_HEADER_BYTES, readBytes };
}

function bufferedPayloadBytes(input: Uint8Array, start: number): number {
  let offset = start;
  let payloadBytes = 0;
  while (input.byteLength - offset >= CONNECT_FRAME_HEADER_BYTES) {
    const length = new DataView(input.buffer, input.byteOffset + offset, input.byteLength - offset).getUint32(1, false);
    const available = Math.min(length, input.byteLength - offset - CONNECT_FRAME_HEADER_BYTES);
    payloadBytes += available;
    if (available < length) break;
    offset += CONNECT_FRAME_HEADER_BYTES + length;
  }
  return payloadBytes;
}

function assertOffset(input: Uint8Array, offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > input.length) {
    throw new ConnectFrameError("invalid_offset", `Invalid Connect frame offset: ${offset}`);
  }
}

function assertByte(value: number, code: ConnectFrameErrorCode, message: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new ConnectFrameError(code, message);
  }
}
