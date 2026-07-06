import { describe, expect, test } from "bun:test";
import { cancelBodyOnAbort } from "../src/lib/abort";

function bodyWithCancelSpy(): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { /* never resolves; only cancel settles it */ },
    cancel() { cancelled = true; },
  });
  return { body, cancelled: () => cancelled };
}

describe("cancelBodyOnAbort", () => {
  test("cancels the body when the signal aborts", async () => {
    const { body, cancelled } = bodyWithCancelSpy();
    const ac = new AbortController();
    cancelBodyOnAbort(body, ac.signal);
    expect(cancelled()).toBe(false);
    ac.abort(new DOMException("superseded", "AbortError"));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled()).toBe(true);
  });

  test("cancels immediately when the signal is already aborted", async () => {
    const { body, cancelled } = bodyWithCancelSpy();
    const ac = new AbortController();
    ac.abort(new DOMException("already", "AbortError"));
    cancelBodyOnAbort(body, ac.signal);
    await Promise.resolve();
    expect(cancelled()).toBe(true);
  });

  test("detach() prevents cancellation on the normal path", async () => {
    const { body, cancelled } = bodyWithCancelSpy();
    const ac = new AbortController();
    const detach = cancelBodyOnAbort(body, ac.signal);
    detach();
    ac.abort(new DOMException("late", "AbortError"));
    await Promise.resolve();
    expect(cancelled()).toBe(false);
    await body.cancel().catch(() => {});
  });

  test("no-ops when body or signal is missing", () => {
    expect(() => cancelBodyOnAbort(null, new AbortController().signal)).not.toThrow();
    const { body } = bodyWithCancelSpy();
    expect(() => cancelBodyOnAbort(body, undefined)).not.toThrow();
    void body.cancel().catch(() => {});
  });
});
