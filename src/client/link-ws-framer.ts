import { randomBytes } from "node:crypto";

/**
 * The client side of RFC 6455 framing for the Home leg of a link WebSocket (design T4 3.3). The Home
 * leg runs on the socket the relay-auth preflight authenticated, so no WebSocket client that opens its
 * own connection can be used, and Bun's built-in `ws` module exposes no framer. This file implements the
 * full client state machine the design requires instead:
 *
 * - RSV bits zero; opcodes 0, 1, 2, 8, 9 and 10 only;
 * - control frames of at most 125 bytes and never fragmented;
 * - continuation frames only inside a message, and a new data frame only outside one;
 * - minimal length encoding, with the top bit of a 64-bit length zero;
 * - UTF-8 validation of complete text messages and close reasons;
 * - close codes 1000-1003, 1007-1014 and 3000-4999 only (1012-1014 are registered: service restart, try
 *   again later, bad gateway);
 * - client frames masked, server frames refused when masked;
 * - at most the maximum message plus 14 header bytes held (plus one control frame of at most 125 bytes
 *   between fragments): an unfragmented message gets its own buffer,
 *   and the fragments of a fragmented one are written into one reassembly buffer of the maximum size,
 *   dropped once that message is complete, so the two never coexist; at most a bounded number of fragments.
 *
 * A violation throws LinkWsProtocolError with the close code to send. The reader never interprets a
 * message: text is passed on as it arrived.
 */

export type LinkWsFrameEvent =
  | { type: "text"; data: string; bytes: number }
  | { type: "binary"; bytes: number }
  | { type: "ping"; payload: Buffer }
  | { type: "pong"; payload: Buffer }
  | { type: "close"; code: number | null; reason: string };

export type LinkWsProtocolFault = "protocol" | "utf8" | "too_large";

const CLOSE_FOR: Record<LinkWsProtocolFault, 1002 | 1007 | 1009> = { protocol: 1002, utf8: 1007, too_large: 1009 };

export class LinkWsProtocolError extends Error {
  readonly closeCode: 1002 | 1007 | 1009;
  constructor(readonly fault: LinkWsProtocolFault) {
    super("link websocket " + fault + " error");
    this.name = "LinkWsProtocolError";
    this.closeCode = CLOSE_FOR[fault];
  }
}

/** A close code that may appear in a close frame on the wire (1004, 1005, 1006 and 1015 never may). */
export function isWireCloseCode(code: number): boolean {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999));
}

// ignoreBOM: a leading U+FEFF is part of the text and is passed on unchanged.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeUtf8(bytes: Uint8Array): string {
  try { return utf8.decode(bytes); } catch { throw new LinkWsProtocolError("utf8"); }
}

interface Frame { fin: boolean; opcode: number; payload: Buffer; filled: number; fragment: boolean }

export class LinkWsFrameReader {
  private readonly header = Buffer.alloc(14);
  private headerLength = 0;
  private headerNeeded = 2;
  private frame: Frame | null = null;
  /** Reassembly buffer for fragmented messages, allocated once at the maximum message size. */
  private assembly: Buffer | null = null;
  private fragmentCount = 0;
  private fragmentBytes = 0;
  /** Opcode of the message in progress (1 or 2), or 0 outside a message. */
  private messageOpcode = 0;
  private done = false;

  constructor(private readonly limits: { maxMessageBytes: number; maxFragments: number }) {}

  /** True once a close frame was read or a protocol error was thrown; later bytes are ignored. */
  get closed(): boolean { return this.done; }

  /** Payload bytes this reader holds references to right now (the bound is the maximum message plus 14). */
  heldBytes(): number {
    const own = this.frame && !this.frame.fragment ? this.frame.payload.length : 0;
    return (this.assembly?.length ?? 0) + own + this.headerLength;
  }

  /**
   * Feed bytes off the socket; returns every event they complete, in order. Events are appended to
   * `events` as they complete, so a caller that passes its own array still has the events completed
   * before a protocol error when push throws.
   */
  push(chunk: Uint8Array, events: LinkWsFrameEvent[] = []): LinkWsFrameEvent[] {
    let offset = 0;
    try {
      while (offset < chunk.length && !this.done) {
        if (!this.frame) {
          const take = Math.min(this.headerNeeded - this.headerLength, chunk.length - offset);
          this.header.set(chunk.subarray(offset, offset + take), this.headerLength);
          this.headerLength += take;
          offset += take;
          if (this.headerLength < this.headerNeeded) continue;
          if (this.headerNeeded === 2) {
            this.headerNeeded = this.firstTwo();
            if (this.headerLength < this.headerNeeded) continue;
          }
          this.startFrame(events);
          continue;
        }
        const frame = this.frame;
        const take = Math.min(frame.payload.length - frame.filled, chunk.length - offset);
        frame.payload.set(chunk.subarray(offset, offset + take), frame.filled);
        frame.filled += take;
        offset += take;
        if (frame.filled === frame.payload.length) this.endFrame(frame, events);
      }
    } catch (error) {
      this.done = true;
      this.assembly = null;
      this.frame = null;
      throw error;
    }
    return events;
  }

  /** Validate the first two header bytes; returns the full header length. */
  private firstTwo(): number {
    const b0 = this.header[0]!, b1 = this.header[1]!;
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, length7 = b1 & 0x7f;
    if ((b0 & 0x70) !== 0) throw new LinkWsProtocolError("protocol");
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new LinkWsProtocolError("protocol");
    if ((b1 & 0x80) !== 0) throw new LinkWsProtocolError("protocol");
    if (opcode >= 8 && (!fin || length7 > 125)) throw new LinkWsProtocolError("protocol");
    if (opcode === 0 && this.messageOpcode === 0) throw new LinkWsProtocolError("protocol");
    if ((opcode === 1 || opcode === 2) && this.messageOpcode !== 0) throw new LinkWsProtocolError("protocol");
    return 2 + (length7 === 126 ? 2 : length7 === 127 ? 8 : 0);
  }

  private startFrame(events: LinkWsFrameEvent[]): void {
    const b0 = this.header[0]!, length7 = this.header[1]! & 0x7f;
    const opcode = b0 & 0x0f;
    let length = length7;
    if (length7 === 126) {
      length = this.header.readUInt16BE(2);
      if (length < 126) throw new LinkWsProtocolError("protocol");
    } else if (length7 === 127) {
      const high = this.header.readUInt32BE(2), low = this.header.readUInt32BE(6);
      if ((high & 0x80000000) !== 0) throw new LinkWsProtocolError("protocol");
      length = high * 2 ** 32 + low;
      if (length <= 0xffff) throw new LinkWsProtocolError("protocol");
    }
    if (opcode < 8) {
      if (this.fragmentCount + 1 > this.limits.maxFragments) throw new LinkWsProtocolError("too_large");
      if (this.fragmentBytes + length > this.limits.maxMessageBytes) throw new LinkWsProtocolError("too_large");
    }
    this.headerLength = 0;
    this.headerNeeded = 2;
    const fin = (b0 & 0x80) !== 0;
    // A data frame that is part of a fragmented message lands in the reassembly buffer, after the earlier fragments.
    const fragment = opcode < 8 && (opcode === 0 || !fin);
    let payload: Buffer;
    if (fragment) {
      this.assembly ??= Buffer.allocUnsafe(this.limits.maxMessageBytes);
      payload = this.assembly.subarray(this.fragmentBytes, this.fragmentBytes + length);
    } else payload = Buffer.allocUnsafe(length);
    const frame: Frame = { fin, opcode, payload, filled: 0, fragment };
    this.frame = frame;
    if (length === 0) this.endFrame(frame, events);
  }

  private endFrame(frame: Frame, events: LinkWsFrameEvent[]): void {
    this.frame = null;
    const { opcode, payload } = frame;
    if (opcode === 9) { events.push({ type: "ping", payload }); return; }
    if (opcode === 10) { events.push({ type: "pong", payload }); return; }
    if (opcode === 8) {
      this.done = true;
      if (payload.length === 0) { events.push({ type: "close", code: null, reason: "" }); return; }
      if (payload.length === 1) throw new LinkWsProtocolError("protocol");
      const code = payload.readUInt16BE(0);
      if (!isWireCloseCode(code)) throw new LinkWsProtocolError("protocol");
      events.push({ type: "close", code, reason: decodeUtf8(payload.subarray(2)) });
      return;
    }
    if (opcode !== 0) this.messageOpcode = opcode;
    this.fragmentCount += 1;
    if (frame.fragment) this.fragmentBytes += payload.length;
    if (!frame.fin) return;
    const message = frame.fragment ? this.assembly!.subarray(0, this.fragmentBytes) : payload;
    const messageOpcode = this.messageOpcode;
    // The reassembly buffer goes with its message; `message` keeps it only until it is decoded below.
    if (frame.fragment) this.assembly = null;
    this.fragmentCount = 0;
    this.fragmentBytes = 0;
    this.messageOpcode = 0;
    if (messageOpcode === 1) events.push({ type: "text", data: decodeUtf8(message), bytes: message.length });
    else events.push({ type: "binary", bytes: message.length });
  }
}

/** One masked client frame. The mask is fresh per frame unless a test supplies one. */
export function encodeClientFrame(opcode: number, payload: Uint8Array, mask: Uint8Array = randomBytes(4)): Buffer {
  const length = payload.length;
  const extended = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const headerLength = 2 + extended + 4;
  const out = Buffer.allocUnsafe(headerLength + length);
  out[0] = 0x80 | opcode;
  if (extended === 0) out[1] = 0x80 | length;
  else if (extended === 2) { out[1] = 0x80 | 126; out.writeUInt16BE(length, 2); }
  else { out[1] = 0x80 | 127; out.writeUInt32BE(Math.floor(length / 2 ** 32), 2); out.writeUInt32BE(length >>> 0, 6); }
  out.set(mask.subarray(0, 4), headerLength - 4);
  const m0 = mask[0]!, m1 = mask[1]!, m2 = mask[2]!, m3 = mask[3]!;
  let i = 0;
  for (; i + 3 < length; i += 4) {
    out[headerLength + i] = payload[i]! ^ m0;
    out[headerLength + i + 1] = payload[i + 1]! ^ m1;
    out[headerLength + i + 2] = payload[i + 2]! ^ m2;
    out[headerLength + i + 3] = payload[i + 3]! ^ m3;
  }
  for (; i < length; i += 1) out[headerLength + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

export function encodeClientText(text: string): Buffer {
  return encodeClientFrame(1, Buffer.from(text, "utf8"));
}

/** A close frame; a code that may not appear on the wire is sent without one. The reason is cut to 123 bytes on a character boundary. */
export function encodeClientClose(code?: number, reason = ""): Buffer {
  if (code === undefined || !isWireCloseCode(code)) return encodeClientFrame(8, Buffer.alloc(0));
  let bytes = Buffer.from(reason, "utf8");
  if (bytes.length > 123) {
    let end = 123;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    bytes = bytes.subarray(0, end);
  }
  const payload = Buffer.allocUnsafe(2 + bytes.length);
  payload.writeUInt16BE(code, 0);
  payload.set(bytes, 2);
  return encodeClientFrame(8, payload);
}

export function encodeClientPong(payload: Uint8Array): Buffer {
  return encodeClientFrame(10, payload.subarray(0, 125));
}
