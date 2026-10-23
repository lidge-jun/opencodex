import { describe, expect, test } from "bun:test";

import {
  encodeStepFrame,
  isStepFrame,
  stepErrorResponse,
  stepRequest,
  stepResponse,
  StepFrameDecoder,
  StepProtocolViolation,
  STEP_LENGTH_PREFIX_BYTES,
  STEP_MAX_FRAME_BYTES,
  STEP_PROTOCOL_NAME,
  STEP_PROTOCOL_VERSION,
  type StepFrame,
} from "../../src/adapters/step-cli/stdio-frames";

function frame(overrides: Partial<StepFrame> = {}): StepFrame {
  return { ...stepRequest("r1", "initialize", { protocolRange: { min: 1, max: 1 } }), ...overrides };
}

describe("Step stdio framing", () => {
  test("encodes a 4-byte big-endian length prefix followed by UTF-8 JSON", () => {
    const encoded = encodeStepFrame(frame());
    expect(encoded.readUInt32BE(0)).toBe(encoded.byteLength - STEP_LENGTH_PREFIX_BYTES);
    const json = JSON.parse(encoded.subarray(STEP_LENGTH_PREFIX_BYTES).toString("utf8"));
    expect(json.protocol).toBe(STEP_PROTOCOL_NAME);
    expect(json.version).toBe(STEP_PROTOCOL_VERSION);
    expect(json.kind).toBe("request");
    expect(json.method).toBe("initialize");
  });

  test("round-trips through the decoder, including a split frame and a second frame in one chunk", () => {
    const first = encodeStepFrame(frame({ id: "a" }));
    const second = encodeStepFrame(frame({ id: "b", method: "runtime.shutdown" }));
    const decoder = new StepFrameDecoder();
    // Split the first frame mid-JSON and glue the second onto the tail: a peer that writes one frame
    // per read is the normal case, not the exception.
    const cut = Math.floor(first.byteLength / 2);
    expect(decoder.push(first.subarray(0, cut))).toEqual([]);
    const frames = decoder.push(Buffer.concat([first.subarray(cut), second]));
    expect(frames.map(f => f.id)).toEqual(["a", "b"]);
  });

  test("rejects a length prefix larger than the frame ceiling without allocating it", () => {
    const decoder = new StepFrameDecoder({ maxFrameBytes: 1024 });
    const hostile = Buffer.alloc(4);
    hostile.writeUInt32BE(0xffff_ffff, 0);
    expect(() => decoder.push(hostile)).toThrow(StepProtocolViolation);
  });

  test("rejects a length prefix below the smallest encodable frame", () => {
    const decoder = new StepFrameDecoder();
    const tooSmall = Buffer.alloc(4);
    tooSmall.writeUInt32BE(1, 0);
    expect(() => decoder.push(tooSmall)).toThrow(StepProtocolViolation);
  });

  test("refuses to encode a frame above the ceiling", () => {
    const huge = frame({ payload: { blob: "x".repeat(STEP_MAX_FRAME_BYTES) } });
    expect(() => encodeStepFrame(huge)).toThrow(StepProtocolViolation);
  });

  test("rejects non-UTF-8 and non-JSON payloads as distinct violations", () => {
    const invalidUtf8 = Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from([0xff, 0xfe])]);
    expect(() => new StepFrameDecoder().push(invalidUtf8)).toThrow(/not valid UTF-8/);
    const invalidJson = Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from("{}")]);
    expect(() => new StepFrameDecoder().push(invalidJson)).toThrow(/not a valid protocol envelope/);
  });

  test("EOF mid-frame is an incomplete-frame violation, not a silent close", () => {
    const encoded = encodeStepFrame(frame());
    const decoder = new StepFrameDecoder();
    decoder.push(encoded.subarray(0, encoded.byteLength - 4));
    expect(() => decoder.end()).toThrow(/trailing bytes of a partial frame/);
  });

  test("accepts an unknown protocol version so initialize can negotiate a range", () => {
    expect(isStepFrame({ protocol: STEP_PROTOCOL_NAME, version: 2, kind: "request", id: "x", method: "m" })).toBe(true);
    expect(isStepFrame({ protocol: "some-other-sdk", version: 1, kind: "request", id: "x", method: "m" })).toBe(false);
  });

  test("requires a monotonic sequence on events and a replyTo on responses", () => {
    expect(isStepFrame({ protocol: STEP_PROTOCOL_NAME, version: 1, kind: "event", id: "e", method: "harness.event" })).toBe(false);
    expect(
      isStepFrame({ protocol: STEP_PROTOCOL_NAME, version: 1, kind: "event", id: "e", method: "harness.event", sequence: 0 }),
    ).toBe(true);
    expect(isStepFrame({ protocol: STEP_PROTOCOL_NAME, version: 1, kind: "response", id: "r" })).toBe(false);
  });

  test("refuses a response carrying both a payload and an error", () => {
    expect(() =>
      encodeStepFrame({
        protocol: STEP_PROTOCOL_NAME,
        version: STEP_PROTOCOL_VERSION,
        kind: "response",
        id: "r",
        replyTo: "q",
        payload: { ok: true },
        error: { code: "X", message: "y" },
      }),
    ).toThrow(/cannot contain both/);
  });

  test("builds response and error envelopes that survive the decoder", () => {
    const decoder = new StepFrameDecoder();
    const ok = stepResponse("q1", { accepted: true });
    const failed = stepErrorResponse("q2", "PROTOCOL_VIOLATION", "bad", true);
    const frames = decoder.push(Buffer.concat([encodeStepFrame(ok), encodeStepFrame(failed)]));
    expect(frames[0]).toMatchObject({ kind: "response", replyTo: "q1", payload: { accepted: true } });
    expect(frames[1]).toMatchObject({ replyTo: "q2", error: { code: "PROTOCOL_VIOLATION", retryable: true } });
  });

  test("an error response's message survives without a payload", () => {
    const decoded = new StepFrameDecoder().push(encodeStepFrame(stepErrorResponse("q", "E", "boom")));
    expect(decoded[0]?.payload).toBeUndefined();
    expect(decoded[0]?.error?.message).toBe("boom");
  });
});
