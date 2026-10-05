import { describe, expect, test } from "bun:test";
import { encodeWsFrame, parseWsFrames, WEBSOCKET_MAX_FRAME_BYTES, WsOpcode } from "../../src/chatgpt/desktop-unblock/ws-frame";

describe("ws-frame", () => {
  test("encode+parse roundtrip preserves text frame opcode, FIN and payload", () => {
    const encoded = encodeWsFrame(WsOpcode.TEXT, Buffer.from("hello"));
    // masked client frame: FIN+text, mask bit set, length 5
    expect(encoded[0]).toBe(0x81);
    expect(encoded[1] & 0x80).toBe(0x80);
    const { frames, violation, rest } = parseWsFrames(encoded, Buffer.alloc(0));
    expect(violation).toBeNull();
    expect(rest.length).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe(WsOpcode.TEXT);
    expect(frames[0]!.fin).toBe(true);
    expect(frames[0]!.payload.toString()).toBe("hello");
  });

  test("binary frame with an unmasked server shape parses identically", () => {
    const payload = Buffer.from([1, 2, 3, 254]);
    const encoded = encodeWsFrame(WsOpcode.BINARY, payload, false);
    expect(encoded[1] & 0x80).toBe(0);
    const { frames, violation } = parseWsFrames(encoded, Buffer.alloc(0));
    expect(violation).toBeNull();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe(WsOpcode.BINARY);
    expect(Buffer.from(frames[0]!.payload)).toEqual(payload);
  });

  test("split and coalesced chunks parse through the pending buffer", () => {
    const a = encodeWsFrame(WsOpcode.TEXT, Buffer.from("part-a"));
    const b = encodeWsFrame(WsOpcode.BINARY, Buffer.from([9, 8, 7]), false);
    const joined = Buffer.concat([a, b]);
    // feed it in two awkward cuts
    const cut1 = joined.subarray(0, 3);
    const first = parseWsFrames(cut1, Buffer.alloc(0));
    expect(first.frames).toHaveLength(0);
    expect(first.violation).toBeNull();
    const cut2 = joined.subarray(3, 9);
    // 3+6=9 bytes < 12-byte frame: still incomplete, nothing parsed yet
    const second = parseWsFrames(cut2, first.rest);
    expect(second.frames).toHaveLength(0);
    expect(second.violation).toBeNull();
    const third = parseWsFrames(joined.subarray(9), second.rest);
    expect(third.frames).toHaveLength(2);
    expect(third.violation).toBeNull();
    expect(third.rest.length).toBe(0);
    expect(third.frames[0]!.payload.toString()).toBe("part-a");
    expect(Array.from(third.frames[1]!.payload)).toEqual([9, 8, 7]);
  });

  test("extended length forms parse", () => {
    const medium = Buffer.alloc(300);
    medium.fill(0xab);
    const encoded = encodeWsFrame(WsOpcode.BINARY, medium, false);
    expect(encoded[1] & 0x7f).toBe(126);
    const { frames, violation } = parseWsFrames(encoded, Buffer.alloc(0));
    expect(violation).toBeNull();
    expect(frames[0]!.payload.length).toBe(300);

    const huge = Buffer.alloc(70_000);
    const encodedHuge = encodeWsFrame(WsOpcode.BINARY, huge, false);
    expect(encodedHuge[1] & 0x7f).toBe(127);
    const parsed = parseWsFrames(encodedHuge, Buffer.alloc(0));
    expect(parsed.violation).toBeNull();
    expect(parsed.frames[0]!.payload.length).toBe(70_000);
  });

  test("control frames parse and are capped at 125 bytes", () => {
    const ping = encodeWsFrame(WsOpcode.PING, Buffer.from("hb"), false);
    const { frames } = parseWsFrames(ping, Buffer.alloc(0));
    expect(frames[0]!.opcode).toBe(WsOpcode.PING);

    const oversizedControl = Buffer.from([0x89, 0x7e, 0x00, 0x80]);
    const { violation } = parseWsFrames(oversizedControl, Buffer.alloc(0));
    expect(violation).toBe("control frame payload over 125 bytes");
  });

  test("protocol violations surface as reasons", () => {
    expect(parseWsFrames(Buffer.from([0x81, 0x05]), Buffer.alloc(0)).frames).toHaveLength(0);
    // RSV bit set
    expect(parseWsFrames(Buffer.from([0xc1, 0x00]), Buffer.alloc(0)).violation).toBe(
      "RSV bits set without a negotiated extension",
    );
    // unknown opcode 0x3
    expect(parseWsFrames(Buffer.from([0x83, 0x00]), Buffer.alloc(0)).violation).toBe("unknown opcode");
    // close frame without FIN
    expect(parseWsFrames(Buffer.from([0x08, 0x00]), Buffer.alloc(0)).violation).toBe("control frame without FIN");
    // 64-bit length above the ceiling
    // 64-bit length 0x1_0000_0000 (4 GiB) — beyond the 16 MiB ceiling
    const oversize64 = Buffer.from([0x82, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
    expect(parseWsFrames(oversize64, Buffer.alloc(0)).violation).toBe("frame exceeds the relay's size ceiling");
  });

  test("the size ceiling is a constant tests can reference", () => {
    expect(WEBSOCKET_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
  });
});
