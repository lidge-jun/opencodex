import { describe, expect, test } from "bun:test";
import { decodeEventStream, encodeMessage } from "../../src/lib/eventstream-decoder";

describe("EventStream cancellation settlement", () => {
  test("consumer return releases the reader while transport cancellation is pending", async () => {
    let finish!: () => void;
    const pendingCancel = new Promise<void>(resolve => { finish = resolve; });
    let cancelCalls = 0;
    const source = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(encodeMessage({}, new Uint8Array([42]))); },
      cancel() { cancelCalls++; return pendingCancel; },
    });
    const iterator = decodeEventStream(source);
    expect((await iterator.next()).value?.payload).toEqual(new Uint8Array([42]));
    const returned = iterator.return(undefined).then(() => true);
    try {
      expect(await Promise.race([returned, Bun.sleep(100).then(() => false)])).toBe(true);
      expect(cancelCalls).toBe(1);
      expect(source.locked).toBe(false);
    } finally { finish(); await returned; }
  });
  test("observes a rejecting cancellation without masking the decode error", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([0, 0, 0, 1])); },
      cancel() { return Promise.reject(new Error("transport cancellation failed")); },
    });
    const iterator = decodeEventStream(source);
    await expect(iterator.next()).rejects.toThrow("below minimum");
    expect(source.locked).toBe(false);
  });
});
