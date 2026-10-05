/**
 * Minimal RFC 6455 framing for the ChatGPT desktop intercept's WebSocket relay.
 *
 * The listener hands WebSocket upgrades to Bun's server-side stack on the client side,
 * so only the upstream side needs hand-rolled framing: parse the upstream's (unmasked)
 * frames off the tunnel socket, and encode the client's messages as masked frames back.
 *
 * Frames larger than WEBSOCKET_MAX_FRAME_BYTES are treated as a protocol violation and
 * end the relay rather than being buffered indefinitely: the buffer model is "concatenate
 * everything the socket has given us", so a runaway length field would otherwise grow
 * memory until the connection is torn down. Voice/dictation audio frames are small
 * (a few KB at most), far under this ceiling.
 */

export const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const WEBSOCKET_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const WsOpcode = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export type WsOpcode = (typeof WsOpcode)[keyof typeof WsOpcode];

export interface WsFrame {
  opcode: WsOpcode;
  fin: boolean;
  payload: Buffer;
}

/**
 * Parse as many complete frames as `chunk` (plus anything left over from previous
 * chunks) yields. Returns the frames parsed and, when the byte stream ends in a
 * protocol violation (bad RSV/opcode bits, oversize length, or a masked server frame),
 * the reason; the caller tears the relay down when it is non-null. Nothing about the
 * parse is retryable, so a violation discards the remaining buffer.
 */
export function parseWsFrames(chunk: Buffer, pending: Buffer): { frames: WsFrame[]; violation: string | null; rest: Buffer } {
  const buffer = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
  const frames: WsFrame[] = [];
  let offset = 0;
  while (true) {
    const header = parseFrameHeader(buffer, offset);
    if (header.error !== null) return { frames, violation: header.error, rest: EMPTY };
    if (!header.complete) return { frames, violation: null, rest: buffer.subarray(offset) };
    const { opcode, fin, length, mask, payloadStart } = header;
    let payload = buffer.subarray(payloadStart, payloadStart + length);
    if (mask !== null) payload = unmask(payload, mask);
    frames.push({ opcode, fin, payload: Buffer.from(payload) });
    offset = payloadStart + length;
  }
}

const EMPTY = Buffer.alloc(0);

interface WsFrameHeader {
  opcode: WsOpcode;
  fin: boolean;
  length: number;
  mask: Buffer | null;
  payloadStart: number;
  complete: boolean;
  error: string | null;
}

function parseFrameHeader(buffer: Buffer, offset: number): WsFrameHeader {
  if (buffer.length < offset + 2) return INCOMPLETE;
  const b0 = buffer[offset]!;
  const b1 = buffer[offset + 1]!;
  const rsv = b0 & 0x70;
  if (rsv !== 0) return violation("RSV bits set without a negotiated extension");
  const opcode = b0 & 0x0f;
  const known = opcode === WsOpcode.CONTINUATION || opcode === WsOpcode.TEXT || opcode === WsOpcode.BINARY
    || opcode === WsOpcode.CLOSE || opcode === WsOpcode.PING || opcode === WsOpcode.PONG;
  if (!known) return violation("unknown opcode");
  const control = opcode >= WsOpcode.CLOSE;
  if (control && (b0 & 0x80) === 0) return violation("control frame without FIN");
  const fin = (b0 & 0x80) !== 0;
  // Upstream here is the server role: its frames are unmasked per RFC 6455 §5.1. A masked
  // frame is still parsed rather than rejected -- the relay's job is to pass bytes, not to
  // police the server -- but only the unmasked shape is expected in practice.
  const masked = (b1 & 0x80) !== 0;
  let length = b1 & 0x7f;
  let cursor = offset + 2;
  if (control && length > 0x7d) return violation("control frame payload over 125 bytes");
  if (length === 126) {
    if (buffer.length < cursor + 2) return INCOMPLETE;
    length = buffer.readUInt16BE(cursor);
    cursor += 2;
  } else if (length === 127) {
    if (buffer.length < cursor + 8) return INCOMPLETE;
    const big = buffer.readBigUInt64BE(cursor);
    if (big > BigInt(WEBSOCKET_MAX_FRAME_BYTES)) return violation("frame exceeds the relay's size ceiling");
    length = Number(big);
    cursor += 8;
  }
  if (length > WEBSOCKET_MAX_FRAME_BYTES) return violation("frame exceeds the relay's size ceiling");
  const mask: Buffer | null = masked
    ? (buffer.length < cursor + 4 ? null : buffer.subarray(cursor, cursor + 4))
    : null;
  if (masked) {
    if (mask === null) return INCOMPLETE;
    cursor += 4;
  }
  if (buffer.length < cursor + length) return INCOMPLETE;
  return { opcode, fin, length, mask, payloadStart: cursor, complete: true, error: null };
}

const INCOMPLETE: WsFrameHeader = { opcode: 0, fin: false, length: 0, mask: null, payloadStart: 0, complete: false, error: null };

function violation(reason: string): WsFrameHeader {
  return { opcode: 0, fin: false, length: 0, mask: null, payloadStart: 0, complete: false, error: reason };
}

function unmask(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! ^ mask[i % 4]!;
  return out;
}

/**
 * Encode a frame. Client-to-server frames are masked as RFC 6455 requires; the tunnel
 * speaks the client role, so `mask` defaults to true and only tests turn it off.
 */
export function encodeWsFrame(opcode: WsOpcode, payload: Buffer, mask = true): Buffer {
  let length: number;
  let extended: Buffer;
  if (payload.length < 126) {
    length = payload.length;
    extended = EMPTY;
  } else if (payload.length <= 0xffff) {
    length = 126;
    extended = Buffer.alloc(2);
    extended.writeUInt16BE(payload.length);
  } else {
    length = 127;
    extended = Buffer.alloc(8);
    extended.writeBigUInt64BE(BigInt(payload.length));
  }
  const b0 = Buffer.from([0x80 | opcode]);
  const b1 = Buffer.from([(mask ? 0x80 : 0) | length]);
  if (!mask) return Buffer.concat([b0, b1, extended, payload]);
  const key = randomMask();
  return Buffer.concat([b0, b1, extended, key, unmask(payload, key)]);
}

function randomMask(): Buffer {
  const key = Buffer.alloc(4);
  crypto.getRandomValues(key);
  return key;
}
