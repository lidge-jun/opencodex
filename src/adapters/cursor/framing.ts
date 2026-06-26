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

export function tryDecodeConnectFrame(input: Uint8Array, offset = 0): DecodedConnectFrame | null {
  assertOffset(input, offset);
  if (input.length - offset < CONNECT_FRAME_HEADER_BYTES) return null;

  const view = new DataView(input.buffer, input.byteOffset + offset, input.byteLength - offset);
  const flags = view.getUint8(0);
  const length = view.getUint32(1, false);
  const readBytes = CONNECT_FRAME_HEADER_BYTES + length;
  if (input.length - offset < readBytes) return null;

  const payloadStart = offset + CONNECT_FRAME_HEADER_BYTES;
  const payloadEnd = payloadStart + length;
  const payload = input.slice(payloadStart, payloadEnd);
  return {
    frame: {
      flags,
      payload,
      compressed: isConnectFrameCompressed(flags),
      endStream: isConnectFrameEndStream(flags),
    },
    readBytes,
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

export function decodeAvailableConnectFrames(input: Uint8Array): DecodedConnectFrames {
  const frames: ConnectFrame[] = [];
  let offset = 0;
  while (offset < input.length) {
    const decoded = tryDecodeConnectFrame(input, offset);
    if (!decoded) break;
    frames.push(decoded.frame);
    offset += decoded.readBytes;
  }
  return {
    frames,
    remainder: offset === input.length ? new Uint8Array() : input.slice(offset),
  };
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
