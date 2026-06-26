import { describe, expect, test } from "bun:test";
import {
  CONNECT_FLAG_COMPRESSED,
  CONNECT_FLAG_END_STREAM,
  ConnectFrameError,
  decodeConnectFrame,
  decodeConnectFrames,
  encodeConnectFrame,
  isConnectFrameCompressed,
  isConnectFrameEndStream,
  tryDecodeConnectFrame,
} from "../src/adapters/cursor/framing";

const bytes = (...values: number[]) => new Uint8Array(values);

function expectFrameError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectFrameError);
    expect((err as ConnectFrameError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ConnectFrameError(${code})`);
}

describe("Cursor Connect envelope framing", () => {
  test("encodes and decodes an uncompressed data frame", () => {
    const encoded = encodeConnectFrame(bytes(0x08, 0x96, 0x01));

    expect(Array.from(encoded)).toEqual([0x00, 0x00, 0x00, 0x00, 0x03, 0x08, 0x96, 0x01]);

    const decoded = decodeConnectFrame(encoded);
    expect(decoded.readBytes).toBe(8);
    expect(decoded.frame.flags).toBe(0);
    expect(decoded.frame.compressed).toBe(false);
    expect(decoded.frame.endStream).toBe(false);
    expect(Array.from(decoded.frame.payload)).toEqual([0x08, 0x96, 0x01]);
  });

  test("interprets compressed and end-stream flags", () => {
    const encoded = encodeConnectFrame(bytes(0x7b, 0x7d), { compressed: true, endStream: true });
    const decoded = decodeConnectFrame(encoded);

    expect(decoded.frame.flags).toBe(CONNECT_FLAG_COMPRESSED | CONNECT_FLAG_END_STREAM);
    expect(decoded.frame.compressed).toBe(true);
    expect(decoded.frame.endStream).toBe(true);
    expect(isConnectFrameCompressed(decoded.frame.flags)).toBe(true);
    expect(isConnectFrameEndStream(decoded.frame.flags)).toBe(true);
  });

  test("ORs boolean flags into explicit flags while preserving unknown bits", () => {
    const encoded = encodeConnectFrame(bytes(0x01), { flags: 0x80, endStream: true });
    const decoded = decodeConnectFrame(encoded);

    expect(decoded.frame.flags).toBe(0x80 | CONNECT_FLAG_END_STREAM);
    expect(decoded.frame.endStream).toBe(true);
  });

  test("decodes multiple frames in order", () => {
    const first = encodeConnectFrame(bytes(0x01));
    const second = encodeConnectFrame(bytes(0x02, 0x03), { endStream: true });
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first, 0);
    combined.set(second, first.length);

    const frames = decodeConnectFrames(combined);
    expect(frames.map(frame => Array.from(frame.payload))).toEqual([[0x01], [0x02, 0x03]]);
    expect(frames.map(frame => frame.endStream)).toEqual([false, true]);
  });

  test("returns null for incomplete header in tryDecodeConnectFrame", () => {
    expect(tryDecodeConnectFrame(bytes(0x00, 0x00, 0x00))).toBeNull();
  });

  test("throws frame_incomplete for incomplete payload in decodeConnectFrame", () => {
    expectFrameError(() => decodeConnectFrame(bytes(0x00, 0x00, 0x00, 0x00, 0x03, 0x01)), "frame_incomplete");
  });

  test("throws frame_incomplete for trailing incomplete frame in decodeConnectFrames", () => {
    const complete = encodeConnectFrame(bytes(0x01));
    const incomplete = bytes(0x00, 0x00, 0x00, 0x00, 0x02, 0xff);
    const combined = new Uint8Array(complete.length + incomplete.length);
    combined.set(complete, 0);
    combined.set(incomplete, complete.length);

    expectFrameError(() => decodeConnectFrames(combined), "frame_incomplete");
  });

  test("throws payload_too_large before allocating oversized frames", () => {
    const huge = { length: 2 ** 32 } as Uint8Array;

    expectFrameError(() => encodeConnectFrame(huge), "payload_too_large");
  });

  test("throws invalid_flags for non-byte flags", () => {
    expectFrameError(() => encodeConnectFrame(bytes(0x01), { flags: 0x100 }), "invalid_flags");
  });

  test("throws invalid_offset for out-of-range offsets", () => {
    expectFrameError(() => decodeConnectFrame(bytes(0x00), 2), "invalid_offset");
    expectFrameError(() => tryDecodeConnectFrame(bytes(0x00), -1), "invalid_offset");
  });
});
