import { describe, expect, spyOn, test } from "bun:test";
import { releaseResponseBodyBestEffort } from "../../src/lib/upstream-retry";

describe("retry body cancellation timer ownership", () => {
  test.each([false, true])("clears the fallback timer after cancellation (reject=%s)", async reject => {
    const timerSpy = spyOn(globalThis, "setTimeout");
    const clearSpy = spyOn(globalThis, "clearTimeout");
    try {
      await releaseResponseBodyBestEffort(new ReadableStream({
        cancel() { return reject ? Promise.reject(new Error("closed")) : Promise.resolve(); },
      }), undefined, 60_000);
      const timer = timerSpy.mock.results[0]?.value;
      expect(timer).toBeDefined();
      expect(clearSpy).toHaveBeenCalledWith(timer);
    } finally {
      const timers = timerSpy.mock.results.map(r => r.value);
      timerSpy.mockRestore();
      clearSpy.mockRestore();
      for (const timer of timers) clearTimeout(timer);
    }
  });
  test("a pending cancellation is still bounded without a parent signal", async () => {
    let finish!: () => void;
    const cancelled = new Promise<void>(resolve => { finish = resolve; });
    try {
      await releaseResponseBodyBestEffort(new ReadableStream({ cancel: () => cancelled }), undefined, 1);
    } finally { finish(); }
  });
});
