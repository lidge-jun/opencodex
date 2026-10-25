import { describe, expect, spyOn, test } from "bun:test";
import { crc32, decodeEventStream, encodeMessage } from "../../src/lib/eventstream-decoder";

const MiB = 1024 * 1024;

function source(chunks: readonly Uint8Array[], cancelled?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
    cancel: cancelled,
  }, { highWaterMark: 0 });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const messages = [];
  for await (const message of decodeEventStream(body)) messages.push(message);
  return messages;
}

async function observeCopies(work: () => Promise<void>) {
  const stats = { bytes: 0, largestDestination: 0 };
  const concat = Buffer.concat;
  const set = Uint8Array.prototype.set;
  const concatSpy = spyOn(Buffer, "concat").mockImplementation((chunks, length) => {
    stats.bytes += length ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    return concat(chunks, length);
  });
  const setSpy = spyOn(Uint8Array.prototype, "set").mockImplementation(function (
    this: Uint8Array, bytes: ArrayLike<number>, offset?: number,
  ) {
    stats.bytes += bytes.length;
    stats.largestDestination = Math.max(stats.largestDestination, this.byteLength);
    return set.call(this, bytes, offset);
  });
  try {
    await work();
    return stats;
  } finally {
    setSpy.mockRestore();
    concatSpy.mockRestore();
  }
}

function prelude(total: number, headers = 0): Uint8Array {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, total, false);
  view.setUint32(4, headers, false);
  view.setUint32(8, crc32(bytes.subarray(0, 8)), false);
  return bytes;
}

describe("EventStream fragmented frame storage", () => {
  test("copy work stays proportional to a valid frame split into 1 KiB chunks", async () => {
    const frame = encodeMessage({ ":event-type": "fragmented" }, new Uint8Array(MiB).fill(0x61));
    const chunks = Array.from({ length: Math.ceil(frame.length / 1024) }, (_, index) =>
      frame.subarray(index * 1024, Math.min(frame.length, (index + 1) * 1024)));
    const stats = await observeCopies(async () => {
      const messages = await collect(source(chunks));
      expect(messages).toHaveLength(1);
      expect(messages[0]!.headers[":event-type"]).toBe("fragmented");
      expect(messages[0]!.payload).toEqual(new Uint8Array(MiB).fill(0x61));
    });
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.bytes).toBeLessThanOrEqual(frame.length * 4);
  });

  test("complete frames keep their source view without a carry allocation", async () => {
    const frame = encodeMessage({}, new Uint8Array([1, 2, 3]));
    const stats = await observeCopies(async () => {
      const messages = await collect(source([frame]));
      expect(messages[0]!.payload.buffer).toBe(frame.buffer);
      expect(messages[0]!.payload).toEqual(new Uint8Array([1, 2, 3]));
    });
    expect(stats.bytes).toBe(0);
  });

  test("coalesced frames may exceed the per-frame limit in aggregate", async () => {
    const frame = encodeMessage({}, new Uint8Array(8 * MiB).fill(7));
    const joined = Buffer.concat([frame, frame]);
    expect(joined.byteLength).toBeGreaterThan(16 * MiB);
    const messages = await collect(source([joined.subarray(0, 3), joined.subarray(3)]));
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.payload).toEqual(frame.subarray(12, frame.length - 4));
    }
  });

  test("yielded payloads remain stable while later frames reuse chunk boundaries", async () => {
    const first = encodeMessage({ order: "first" }, new Uint8Array(128).fill(11));
    const second = encodeMessage({ order: "second" }, new Uint8Array(4096).fill(22));
    const third = encodeMessage({ order: "third" }, new Uint8Array(32).fill(33));
    const messages = await collect(source([
      first.subarray(0, 13),
      Buffer.concat([first.subarray(13), second.subarray(0, 7)]),
      Buffer.concat([second.subarray(7), third]),
    ]));
    expect(messages.map(message => message.headers.order)).toEqual(["first", "second", "third"]);
    expect(messages.map(message => Array.from(message.payload))).toEqual([
      Array(128).fill(11), Array(4096).fill(22), Array(32).fill(33),
    ]);
  });

  test("frame transitions survive every split, empty chunks and nonzero byte offsets", async () => {
    const joined = Buffer.concat([1, 2, 3].map(value => encodeMessage({ order: String(value) }, new Uint8Array([value]))));
    const padded = new Uint8Array(joined.length + 10);
    padded.set(joined, 5);
    const bytes = padded.subarray(5, 5 + joined.length);
    for (let split = 1; split < bytes.length; split++) {
      const messages = await collect(source([bytes.subarray(0, split), new Uint8Array(), bytes.subarray(split)]));
      expect(messages.map(message => message.headers.order)).toEqual(["1", "2", "3"]);
      expect(messages.map(message => Array.from(message.payload))).toEqual([[1], [2], [3]]);
    }
  });

  test("an oversized split length is rejected before copying the rest of a large chunk", async () => {
    const header = prelude(16 * MiB + 1);
    const tail = new Uint8Array(MiB);
    tail[0] = header[3]!;
    let cancelled = false;
    const body = source([header.subarray(0, 3), tail], () => { cancelled = true; });
    const stats = await observeCopies(async () => {
      await expect(collect(body)).rejects.toThrow(/total length .* exceeds maximum/);
    });
    expect(stats.bytes).toBeLessThanOrEqual(12);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("a split bad prelude CRC is rejected before copying trailing payload bytes", async () => {
    const header = prelude(2 * MiB);
    header[8] ^= 1;
    const tail = new Uint8Array(MiB);
    tail.set(header.subarray(5));
    const stats = await observeCopies(async () => {
      await expect(collect(source([header.subarray(0, 5), tail]))).rejects.toThrow("prelude CRC mismatch");
    });
    expect(stats.bytes).toBeLessThanOrEqual(32);
  });

  test("an impossible header length fails at the prelude without another source read", async () => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(prelude(64, 65));
        else controller.error(new Error("read beyond invalid prelude"));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await expect(collect(body)).rejects.toThrow("headers length exceeds frame payload");
    expect(reads).toBe(1);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  test("a valid maximum-size declaration does not allocate its advertised payload upfront", async () => {
    const failure = new Error("upstream ended after prelude");
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(prelude(16 * MiB));
        else controller.error(failure);
      },
    }, { highWaterMark: 0 });
    const stats = await observeCopies(async () => {
      await expect(collect(body)).rejects.toBe(failure);
    });
    expect(stats.largestDestination).toBeLessThanOrEqual(4096);
    expect(body.locked).toBe(false);
  });

  test.each([3, 8, 12, 20])("EOF after %i bytes retains the truncated-message error", async length => {
    const frame = encodeMessage({}, new Uint8Array(16));
    const body = source([frame.subarray(0, 1), frame.subarray(1, length)]);
    await expect(collect(body)).rejects.toThrow("truncated message at end of stream");
    expect(body.locked).toBe(false);
  });

  test("early consumer return cancels a fragmented stream without pulling its next frame", async () => {
    const frame = encodeMessage({}, new Uint8Array([7]));
    let reads = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        if (reads === 1) controller.enqueue(frame.subarray(0, 5));
        else if (reads === 2) controller.enqueue(frame.subarray(5));
        else controller.error(new Error("unexpected next frame read"));
      },
      cancel() { cancellations++; },
    }, { highWaterMark: 0 });
    const iterator = decodeEventStream(body);
    expect((await iterator.next()).value?.payload).toEqual(new Uint8Array([7]));
    await iterator.return(undefined as never);
    expect(reads).toBe(2);
    expect(cancellations).toBe(1);
    expect(body.locked).toBe(false);
  });
});
