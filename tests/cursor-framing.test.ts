import { describe, expect, test } from "bun:test";
import {
  CONNECT_FLAG_COMPRESSED,
  CONNECT_FLAG_END_STREAM,
  ConnectFrameError,
  consumeConnectFrames,
  decodeAvailableConnectFrames,
  decodeConnectFrame,
  decodeConnectFrames,
  encodeConnectFrame,
  isConnectFrameCompressed,
  isConnectFrameEndStream,
  tryDecodeConnectFrame,
} from "../src/adapters/cursor/framing";
import {
  CURSOR_MAX_CONNECT_FRAME_BYTES,
  CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES,
  CURSOR_MAX_PENDING_FRAMES,
  createTranslatorBudget,
} from "../src/lib/translator-budget";

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

  test("decodes available frames and preserves trailing partial frame", () => {
    const complete = encodeConnectFrame(bytes(0x01));
    const partial = encodeConnectFrame(bytes(0x02, 0x03)).slice(0, 6);
    const combined = new Uint8Array(complete.length + partial.length);
    combined.set(complete, 0);
    combined.set(partial, complete.length);

    const decoded = decodeAvailableConnectFrames(combined);
    expect(decoded.frames.map(frame => Array.from(frame.payload))).toEqual([[0x01]]);
    expect(Array.from(decoded.remainder)).toEqual(Array.from(partial));
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

  test("Cursor announced frame over 32 MiB rejects after header before payload allocation", () => {
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(1, CURSOR_MAX_CONNECT_FRAME_BYTES + 1, false);
    let copies = 0;
    expectFrameError(
      () => tryDecodeConnectFrame(header, 0, CURSOR_MAX_CONNECT_FRAME_BYTES, () => {
        copies++;
        return undefined;
      }),
      "payload_too_large",
    );
    expect(copies).toBe(0);
  });

  test("Cursor frame admission admits exactly 32 MiB and rejects 32 MiB plus one before payload allocation", () => {
    const exact = encodeConnectFrame(new Uint8Array(CURSOR_MAX_CONNECT_FRAME_BYTES));
    expect(tryDecodeConnectFrame(exact, 0, CURSOR_MAX_CONNECT_FRAME_BYTES)?.frame.payload.byteLength)
      .toBe(CURSOR_MAX_CONNECT_FRAME_BYTES);
    const overHeader = new Uint8Array(5);
    new DataView(overHeader.buffer).setUint32(1, CURSOR_MAX_CONNECT_FRAME_BYTES + 1, false);
    let copies = 0;
    expectFrameError(
      () => tryDecodeConnectFrame(overHeader, 0, CURSOR_MAX_CONNECT_FRAME_BYTES, () => {
        copies++;
        return undefined;
      }),
      "payload_too_large",
    );
    expect(copies).toBe(0);
  });

  test("Cursor pending-to-frame copy reports a 32 MiB overlap at the 16 MiB live maximum", () => {
    const budget = createTranslatorBudget();
    const encoded = encodeConnectFrame(new Uint8Array(CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES));
    budget.chargeRetained(CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES, { kind: "cursor_transport" });
    const decoded = decodeAvailableConnectFrames(
      encoded,
      CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES,
      1,
      copied => budget.reserveTransient(copied, { kind: "cursor_transport" }),
    );
    expect(decoded.frames).toHaveLength(1);
    expect(budget.snapshot()).toMatchObject({
      currentBytes: CURSOR_MAX_CONNECT_FRAME_BYTES,
      highWaterBytes: CURSOR_MAX_CONNECT_FRAME_BYTES,
    });
    budget.releaseRetained(CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES, { kind: "cursor_transport" });
    expect(budget.snapshot().currentBytes).toBe(CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES);
    budget.dispose();
  });

  test("Cursor batch decode rolls earlier frame reservations back when a later frame is rejected", () => {
    const payloadBytes = 10 * 1024 * 1024;
    const first = encodeConnectFrame(new Uint8Array(payloadBytes));
    const second = encodeConnectFrame(new Uint8Array(payloadBytes));
    const input = new Uint8Array(first.byteLength + second.byteLength);
    input.set(first, 0);
    input.set(second, first.byteLength);
    const budget = createTranslatorBudget();
    budget.chargeRetained(2 * payloadBytes, { kind: "cursor_transport" });

    expect(() => decodeAvailableConnectFrames(
      input,
      CURSOR_MAX_CONNECT_FRAME_BYTES,
      2,
      copied => budget.reserveTransient(copied, { kind: "cursor_transport" }),
    )).toThrow(expect.objectContaining({ code: "translation_buffer_limit" }));
    expect(budget.snapshot().currentBytes).toBe(2 * payloadBytes);

    budget.dispose();
  });

  test("Cursor tiny-frame flood pauses before materializing the 1025th frame", () => {
    const frame = encodeConnectFrame(bytes(1));
    const oversizedHeader = new Uint8Array(5);
    new DataView(oversizedHeader.buffer).setUint32(1, CURSOR_MAX_CONNECT_FRAME_BYTES + 1, false);
    const input = new Uint8Array(frame.byteLength * CURSOR_MAX_PENDING_FRAMES + oversizedHeader.byteLength);
    for (let i = 0; i < CURSOR_MAX_PENDING_FRAMES; i++) input.set(frame, i * frame.byteLength);
    input.set(oversizedHeader, frame.byteLength * CURSOR_MAX_PENDING_FRAMES);

    // Slot admission happens before the next header is decoded. If the 1025th frame were
    // touched early, its deliberately oversized announcement would throw here.
    const decoded = decodeAvailableConnectFrames(input, CURSOR_MAX_CONNECT_FRAME_BYTES, CURSOR_MAX_PENDING_FRAMES);
    expect(decoded.frames).toHaveLength(CURSOR_MAX_PENDING_FRAMES);
    expect(decoded.remainder).toEqual(oversizedHeader);
    expectFrameError(
      () => decodeAvailableConnectFrames(decoded.remainder, CURSOR_MAX_CONNECT_FRAME_BYTES, 1),
      "payload_too_large",
    );
  });
});

describe("consumeConnectFrames (cursor-based, no remainder copy)", () => {
  const frame = (payload: Uint8Array, flags = 0) => {
    const out = new Uint8Array(5 + payload.byteLength);
    out[0] = flags;
    new DataView(out.buffer).setUint32(1, payload.byteLength, false);
    out.set(payload, 5);
    return out;
  };
  const joinBytes = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
    return out;
  };

  test("consumes complete frames and reports raw bytes (headers included)", () => {
    const f1 = frame(bytes(1, 2, 3));
    const f2 = frame(bytes(4, 5));
    const input = joinBytes(f1, f2);
    const decoded = consumeConnectFrames(input);
    expect(decoded.frames).toHaveLength(2);
    // RAW consumed: 5-byte header + payload per frame — a payload-only count
    // would come back 5 short.
    expect(decoded.consumedBytes).toBe(input.byteLength);
    expect([...decoded.frames[0]!.payload]).toEqual([1, 2, 3]);
  });

  test("stops at a trailing partial frame and reports the boundary", () => {
    const f1 = frame(bytes(9, 9, 9));
    const partial = bytes(0, 0, 0); // 3 bytes of a header
    const decoded = consumeConnectFrames(joinBytes(f1, partial));
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.consumedBytes).toBe(f1.byteLength);
  });

  test("stops at a trailing partial header inside the next frame", () => {
    const f1 = frame(bytes(7));
    const declared = new Uint8Array(5);
    new DataView(declared.buffer).setUint32(1, 100, false); // declares 100 payload bytes
    const decoded = consumeConnectFrames(joinBytes(f1, declared, bytes(1, 2)));
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.consumedBytes).toBe(f1.byteLength);
  });

  test("honors the frame-slot limit", () => {
    const input = joinBytes(frame(bytes(1)), frame(bytes(2)), frame(bytes(3)));
    const decoded = consumeConnectFrames(input, undefined, 2);
    expect(decoded.frames).toHaveLength(2);
    expect(decoded.consumedBytes).toBe(frame(bytes(1)).byteLength * 2);
  });

  test("rejects an oversized declared length at header arrival", () => {
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(1, 17 * 1024 * 1024, false);
    expectFrameError(
      () => consumeConnectFrames(header, CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES),
      "payload_too_large",
    );
  });

  test("returns zero consumption for header-only and empty input", () => {
    expect(consumeConnectFrames(new Uint8Array()).consumedBytes).toBe(0);
    expect(consumeConnectFrames(bytes(0, 0)).consumedBytes).toBe(0);
  });
});
