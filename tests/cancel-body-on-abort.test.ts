import { describe, expect, test } from "bun:test";
import { cancelBodyOnAbort } from "../src/lib/abort";
import { readBodyCapped } from "../src/server/live";

function bodyWithCancelSpy(): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { /* never resolves; only cancel settles it */ },
    cancel() { cancelled = true; },
  });
  return { body, cancelled: () => cancelled };
}

describe("readBodyCapped settles the stream when a read throws", () => {
  test("a rejected read propagates and leaves no live reader lock", async () => {
    // Note on what this can and cannot assert: a source whose own `pull()` rejects is errored
    // by the stream machinery itself, which by spec does NOT invoke the source's `cancel()`.
    // So the observable contract here is that the failure propagates to the caller (whose
    // existing classification turns it into 499/504/502) and that the stream is left settled
    // rather than pending. The cancel path added alongside this covers the case where the
    // source is still live — an abort delivered while a read is outstanding.
    let cancelled = false;
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      pull() { return Promise.reject(new Error("upstream reset")); },
      cancel() { cancelled = true; },
    });

    await expect(readBodyCapped(failing, 1024, total => `too large (${total})`)).rejects.toThrow("upstream reset");
    // The stream errored itself, so `cancel()` is not expected to have run.
    expect(cancelled).toBe(false);
    // Locked-and-settled: a second reader is refused, proving no lock was leaked in a state
    // where the body could still be pending.
    expect(() => failing.getReader()).toThrow();
  });

  test("cancelBodyOnAbort cannot settle a body once a reader holds the lock", async () => {
    // The reason readBodyCapped needed its own cancel path. `cancelBodyOnAbort` calls
    // `body.cancel()`, which throws on a locked stream, so once `getReader()` has run the
    // guard alone can no longer settle the body — only the code holding the reader can.
    // This is why the guard is attached BEFORE the read (covering the pre-attach window) and
    // the reader cancels on failure (covering the window after it).
    let cancelled = false;
    const pending = new ReadableStream<Uint8Array>({
      pull() { return new Promise<never>(() => {}); },
      cancel() { cancelled = true; },
    });

    const reader = pending.getReader();
    const ac = new AbortController();
    cancelBodyOnAbort(pending, ac.signal);
    ac.abort(new DOMException("client closed request", "AbortError"));
    await Promise.resolve();
    await Promise.resolve();

    expect(cancelled).toBe(false);

    // The reader itself can still settle it, which is what the new failure path does.
    await reader.cancel(new Error("client closed request"));
    expect(cancelled).toBe(true);
  });

  test("a normal read still returns the buffered payload", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });

    const payload = await readBodyCapped(body, 1024, total => `too large (${total})`);
    expect(payload).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(payload as ArrayBuffer)).toBe("hello");
  });

  test("the byte cap still short-circuits with a 502 rather than throwing", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });

    const payload = await readBodyCapped(body, 8, total => `too large (${total})`);
    expect(payload).toBeInstanceOf(Response);
    expect((payload as Response).status).toBe(502);
  });
});

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
