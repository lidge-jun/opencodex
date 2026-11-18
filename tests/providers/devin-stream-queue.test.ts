import { expect, spyOn, test } from "bun:test";
import { streamChatEvents, type CloudChatEvent } from "../../src/adapters/devin/cloud-direct/chat";
import { encodeString, frameConnectStream } from "../../src/adapters/devin/cloud-direct/wire";

function trailer() {
  return Buffer.from([2, 0, 0, 0, 2, 123, 125]);
}

async function collect(wire: Buffer, chunkBytes: number) {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === wire.length) { controller.close(); return; }
      const end = Math.min(wire.length, offset + chunkBytes);
      controller.enqueue(wire.subarray(offset, end));
      offset = end;
    },
  }, { highWaterMark: 0 });
  const before = process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
  process.env.OPENCODEX_DEVIN_SEND_USER_JWT = "0";
  try {
    const events: CloudChatEvent[] = [];
    for await (const event of streamChatEvents({
      apiKey: "devin-session-token$header.payload.signature",
      modelUid: "swe-1-7", messages: [], catalog: null,
      executor: (async () => new Response(body)) as typeof fetch,
    })) events.push(event);
    return events;
  } finally {
    if (before === undefined) delete process.env.OPENCODEX_DEVIN_SEND_USER_JWT;
    else process.env.OPENCODEX_DEVIN_SEND_USER_JWT = before;
  }
}

test("Devin fragmented frame drains use bounded queue-prefix removals", async () => {
  const text = "x".repeat(64 * 1024);
  const wire = Buffer.concat([frameConnectStream(encodeString(3, text), false), trailer()]);
  const shift = Array.prototype.shift;
  const splice = Array.prototype.splice;
  const copyWithin = Array.prototype.copyWithin;
  let removals = 0;
  let discardedChunkSlots = 0;
  const shifting = spyOn(Array.prototype, "shift").mockImplementation(function () {
    if (Buffer.isBuffer(this[0])) removals++;
    return Reflect.apply(shift, this, []);
  });
  const splicing = spyOn(Array.prototype, "splice").mockImplementation(function (...args: Parameters<typeof splice>) {
    const prefix = args[0] === 0 && args[1] && Buffer.isBuffer(this[0]);
    const removed = Reflect.apply(splice, this, args);
    if (prefix) { removals++; discardedChunkSlots += removed.length; }
    return removed;
  });
  const copying = spyOn(Array.prototype, "copyWithin").mockImplementation(function (...args: Parameters<typeof copyWithin>) {
    if (args[0] === 0 && args[1] > 0 && Buffer.isBuffer(this[0])) removals++;
    return Reflect.apply(copyWithin, this, args);
  });
  let events: CloudChatEvent[];
  try { events = await collect(wire, 4); }
  finally { shifting.mockRestore(); splicing.mockRestore(); copying.mockRestore(); }
  expect(events.filter(event => event.kind === "text").map(event => event.text)).toEqual([text]);
  expect(removals).toBeLessThanOrEqual(8);
  expect(discardedChunkSlots).toBe(0);
});

for (const chunkBytes of [1, 3, 5, 7, 17, 65536]) {
  test(`Devin queue retains frame order and partial heads across ${chunkBytes}-byte reads`, async () => {
    const wire = Buffer.concat([
      frameConnectStream(encodeString(3, "한글 😀"), false),
      frameConnectStream(Buffer.alloc(0), false),
      frameConnectStream(encodeString(3, "compressed 끝"), true),
      trailer(),
    ]);
    const events = await collect(wire, chunkBytes);
    expect(events.filter(event => event.kind === "text").map(event => event.text)).toEqual(["한글 😀", "compressed 끝"]);
  });
}
