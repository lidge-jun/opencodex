import { describe, expect, test } from "bun:test";
import {
  encodeClientClose, encodeClientFrame, encodeClientText, isWireCloseCode, LinkWsFrameReader, LinkWsProtocolError, type LinkWsFrameEvent,
} from "../../src/client/link-ws-framer";

// Lane T6: the client framer of the link WebSocket's Home leg (design T4 3.3). Every rule of the
// state machine the design lists has a case here; server frames are built by hand, unmasked.

const LIMITS = { maxMessageBytes: 1024, maxFragments: 4 };

function serverFrame(opcode: number, payload: Buffer | string, options: { fin?: boolean; rsv?: number; mask?: boolean; lengthForm?: 16 | 64 } = {}): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const b0 = (options.fin === false ? 0 : 0x80) | ((options.rsv ?? 0) << 4) | opcode;
  const maskBit = options.mask ? 0x80 : 0;
  let head: Buffer;
  if (options.lengthForm === 16 || (!options.lengthForm && body.length >= 126 && body.length <= 0xffff)) {
    head = Buffer.from([b0, maskBit | 126, body.length >> 8, body.length & 0xff]);
  } else if (options.lengthForm === 64 || body.length > 0xffff) {
    head = Buffer.alloc(10); head[0] = b0; head[1] = maskBit | 127; head.writeBigUInt64BE(BigInt(body.length), 2);
  } else head = Buffer.from([b0, maskBit | body.length]);
  if (!options.mask) return Buffer.concat([head, body]);
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([head, mask, Buffer.from(body.map((byte, i) => byte ^ mask[i & 3]!))]);
}

function read(...chunks: Buffer[]): LinkWsFrameEvent[] {
  const reader = new LinkWsFrameReader(LIMITS);
  return chunks.flatMap(chunk => reader.push(chunk));
}

function fault(...chunks: Buffer[]): number {
  try { read(...chunks); } catch (error) { if (error instanceof LinkWsProtocolError) return error.closeCode; throw error; }
  return 0;
}

function closePayload(code: number, reason = ""): Buffer {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason)); payload.writeUInt16BE(code, 0); payload.write(reason, 2); return payload;
}

describe("link WebSocket client framer: reading server frames", () => {
  test("a text message arrives whole, whatever the chunking, and is passed on unchanged", () => {
    const frame = serverFrame(1, '{"type":"response.created","x":"\u00e9"}');
    expect(read(frame)).toEqual([{ type: "text", data: '{"type":"response.created","x":"\u00e9"}', bytes: frame.length - 2 }]);
    const bytes = [...frame].map(byte => Buffer.from([byte]));
    expect(read(...bytes)).toEqual(read(frame));
  });

  test("several frames coalesced in one chunk each produce their event, in order", () => {
    const events = read(Buffer.concat([serverFrame(1, "a"), serverFrame(9, "p"), serverFrame(1, "b")]));
    expect(events.map(event => event.type)).toEqual(["text", "ping", "text"]);
  });

  test("a fragmented message with an interleaved ping is reassembled", () => {
    const events = read(serverFrame(1, "he", { fin: false }), serverFrame(9, "x"), serverFrame(0, "ll", { fin: false }), serverFrame(0, "o"));
    expect(events).toEqual([{ type: "ping", payload: Buffer.from("x") }, { type: "text", data: "hello", bytes: 5 }]);
  });

  test("16-bit and 64-bit lengths are read; non-minimal encodings and a set top bit are protocol errors", () => {
    const reader = new LinkWsFrameReader({ maxMessageBytes: 70_000, maxFragments: 4 });
    expect(reader.push(serverFrame(1, "x".repeat(200)))[0]).toMatchObject({ type: "text", bytes: 200 });
    expect(reader.push(serverFrame(1, "y".repeat(66_000)))[0]).toMatchObject({ type: "text", bytes: 66_000 });
    expect(fault(serverFrame(1, "short", { lengthForm: 16 }))).toBe(1002);
    expect(fault(serverFrame(1, "short", { lengthForm: 64 }))).toBe(1002);
    const topBit = Buffer.from([0x81, 127, 0x80, 0, 0, 0, 0, 0, 0, 1]);
    expect(fault(topBit)).toBe(1002);
    // A 64-bit length with a non-zero high word is far over any limit: refused before a byte is held.
    expect(fault(Buffer.from([0x81, 127, 0, 0, 0, 1, 0, 0, 0, 1]))).toBe(1009);
  });

  test("RSV bits, unknown opcodes and masked server frames are protocol errors", () => {
    expect(fault(serverFrame(1, "a", { rsv: 4 }))).toBe(1002);
    expect(fault(serverFrame(3, "a"))).toBe(1002);
    expect(fault(serverFrame(11, "a"))).toBe(1002);
    expect(fault(serverFrame(1, "a", { mask: true }))).toBe(1002);
  });

  test("control frames over 125 bytes or fragmented are protocol errors", () => {
    expect(fault(serverFrame(9, "x".repeat(126)))).toBe(1002);
    expect(fault(serverFrame(9, "x", { fin: false }))).toBe(1002);
    expect(fault(serverFrame(8, closePayload(1000), { fin: false }))).toBe(1002);
  });

  test("a continuation outside a message, or a new message inside one, is a protocol error", () => {
    expect(fault(serverFrame(0, "a"))).toBe(1002);
    expect(fault(serverFrame(1, "a", { fin: false }), serverFrame(1, "b"))).toBe(1002);
    expect(fault(serverFrame(1, "a", { fin: false }), serverFrame(2, "b"))).toBe(1002);
  });

  test("invalid UTF-8 in a complete text message is 1007, even when a character is split across fragments it is accepted", () => {
    expect(fault(serverFrame(1, Buffer.from([0xc3, 0x28])))).toBe(1007);
    const e = Buffer.from("\u00e9", "utf8");
    expect(read(serverFrame(1, e.subarray(0, 1), { fin: false }), serverFrame(0, e.subarray(1)))).toEqual([{ type: "text", data: "\u00e9", bytes: 2 }]);
  });

  test("a message over the limit is 1009 before its payload is held, also across fragments and by fragment count", () => {
    expect(fault(Buffer.from([0x81, 126, 0x04, 0x01]))).toBe(1009);
    expect(fault(serverFrame(1, "x".repeat(600), { fin: false }), serverFrame(0, "y".repeat(600)))).toBe(1009);
    expect(fault(...["a", "b", "c", "d"].map(part => serverFrame(part === "a" ? 1 : 0, part, { fin: false })), serverFrame(0, "e"))).toBe(1009);
    expect(read(...["a", "b", "c"].map(part => serverFrame(part === "a" ? 1 : 0, part, { fin: false })), serverFrame(0, "d"))).toEqual([{ type: "text", data: "abcd", bytes: 4 }]);
  });

  test("close frames: code and reason, empty, one byte, codes that may not appear on the wire, and a bad reason", () => {
    expect(read(serverFrame(8, closePayload(4401, "link revoked")))).toEqual([{ type: "close", code: 4401, reason: "link revoked" }]);
    expect(read(serverFrame(8, Buffer.alloc(0)))).toEqual([{ type: "close", code: null, reason: "" }]);
    expect(fault(serverFrame(8, Buffer.from([3])))).toBe(1002);
    for (const code of [999, 1004, 1005, 1006, 1015, 2999, 5000]) expect(fault(serverFrame(8, closePayload(code)))).toBe(1002);
    for (const code of [1012, 1013, 1014]) expect(read(serverFrame(8, closePayload(code)))).toEqual([{ type: "close", code, reason: "" }]);
    expect(fault(serverFrame(8, Buffer.concat([closePayload(1000), Buffer.from([0xff])])))).toBe(1007);
  });

  test("nothing is read after a close frame or a protocol error", () => {
    const reader = new LinkWsFrameReader(LIMITS);
    expect(reader.push(Buffer.concat([serverFrame(8, closePayload(1000)), serverFrame(1, "late")]))).toEqual([{ type: "close", code: 1000, reason: "" }]);
    expect(reader.closed).toBe(true);
    expect(reader.push(serverFrame(1, "later"))).toEqual([]);
  });

  test("a binary message is reported by size only", () => {
    expect(read(serverFrame(2, Buffer.from([1, 2, 3])))).toEqual([{ type: "binary", bytes: 3 }]);
  });

  test("a leading U+FEFF in a text message or a close reason is kept as sent", () => {
    expect(read(serverFrame(1, "\ufeffbom"))).toEqual([{ type: "text", data: "\ufeffbom", bytes: 6 }]);
    expect(read(serverFrame(8, closePayload(1000, "\ufeffr")))).toEqual([{ type: "close", code: 1000, reason: "\ufeffr" }]);
  });

  test("a fragmented message at exactly the limit is reassembled in place, and the reader is reused for the next one", () => {
    const reader = new LinkWsFrameReader({ maxMessageBytes: 1024, maxFragments: 8 });
    const parts = ["a".repeat(400), "b".repeat(400), "c".repeat(224)];
    const frames = parts.map((part, i) => serverFrame(i === 0 ? 1 : 0, part, { fin: i === parts.length - 1 }));
    expect(reader.push(Buffer.concat(frames))).toEqual([{ type: "text", data: parts.join(""), bytes: 1024 }]);
    expect(reader.push(Buffer.concat([serverFrame(1, "x", { fin: false }), serverFrame(0, "y")]))).toEqual([{ type: "text", data: "xy", bytes: 2 }]);
    expect(reader.push(serverFrame(1, "z".repeat(1024)))).toEqual([{ type: "text", data: "z".repeat(1024), bytes: 1024 }]);
  });

  test("after a fragmented message, a near-limit message in progress holds no more than the maximum plus its header", () => {
    const reader = new LinkWsFrameReader({ maxMessageBytes: 1024, maxFragments: 8 });
    reader.push(Buffer.concat([serverFrame(1, "a".repeat(600), { fin: false }), serverFrame(0, "b".repeat(400))]));
    expect(reader.heldBytes()).toBe(0);
    const big = serverFrame(1, "c".repeat(1020));
    reader.push(big.subarray(0, big.length - 10));
    expect(reader.heldBytes()).toBeLessThanOrEqual(1024 + 14);
    expect(reader.push(big.subarray(big.length - 10))).toEqual([{ type: "text", data: "c".repeat(1020), bytes: 1020 }]);
    // Mid-fragmented message: the reassembly buffer is the only payload held.
    reader.push(serverFrame(1, "d".repeat(500), { fin: false }));
    expect(reader.heldBytes()).toBe(1024);
  });
});

describe("link WebSocket client framer: writing client frames", () => {
  function unmask(frame: Buffer): { fin: boolean; opcode: number; payload: Buffer; masked: boolean } {
    let length = frame[1]! & 0x7f, offset = 2;
    if (length === 126) { length = frame.readUInt16BE(2); offset = 4; } else if (length === 127) { length = Number(frame.readBigUInt64BE(2)); offset = 10; }
    const mask = frame.subarray(offset, offset + 4);
    const payload = Buffer.from(frame.subarray(offset + 4, offset + 4 + length).map((byte, i) => byte ^ mask[i & 3]!));
    return { fin: (frame[0]! & 0x80) !== 0, opcode: frame[0]! & 0x0f, payload, masked: (frame[1]! & 0x80) !== 0 };
  }

  test("every client frame is masked, and the payload round-trips at each length form", () => {
    for (const size of [0, 5, 125, 126, 65_535, 65_536, 200_000]) {
      const text = "z".repeat(size);
      const decoded = unmask(encodeClientText(text));
      expect(decoded).toMatchObject({ fin: true, opcode: 1, masked: true });
      expect(decoded.payload.toString("utf8")).toBe(text);
    }
  });

  test("a fresh mask per frame", () => {
    const a = encodeClientText("same"), b = encodeClientText("same");
    expect(a.subarray(2, 6).equals(b.subarray(2, 6)) && a.subarray(2, 6).equals(encodeClientText("same").subarray(2, 6))).toBe(false);
  });

  test("close frames carry a wire-valid code; others are sent without one; reasons are cut on a character boundary", () => {
    expect(unmask(encodeClientClose(1001, "going away")).payload).toEqual(closePayload(1001, "going away"));
    expect(unmask(encodeClientClose(1006)).payload.length).toBe(0);
    expect(unmask(encodeClientClose()).payload.length).toBe(0);
    const reason = unmask(encodeClientClose(1000, "\u00e9".repeat(100))).payload.subarray(2);
    expect(reason.length).toBeLessThanOrEqual(123);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(reason)).not.toThrow();
  });

  test("a given mask is used as given", () => {
    const frame = encodeClientFrame(1, Buffer.from("ab"), Buffer.from([0, 0, 0, 0]));
    expect([...frame]).toEqual([0x81, 0x82, 0, 0, 0, 0, 0x61, 0x62]);
  });

  test("wire close codes", () => {
    expect([1000, 1003, 1007, 1011, 1012, 1013, 1014, 3000, 4999].every(isWireCloseCode)).toBe(true);
    expect([999, 1004, 1005, 1006, 1015, 2999, 5000, 1000.5].some(isWireCloseCode)).toBe(false);
  });
});
