import { describe, expect, test } from "bun:test";
import { consumeForInspection } from "../src/server";

// Regression for issue #44: native-passthrough turns are inspected on a teed background stream.
// Codex disconnects the instant it finishes reading, so the inspection stream is frequently
// aborted. The cancel path must finalize (onCancel) and release the turn (onDone) instead of
// silently dropping the /api/logs entry.

function pendingStream(): ReadableStream<Uint8Array> {
  // A stream whose read never resolves on its own — only reader.cancel() (via abort) ends it.
  return new ReadableStream<Uint8Array>({ start() {}, pull() { /* never enqueue/close */ } });
}

function closingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
}

const tick = () => new Promise(r => setTimeout(r, 5));

describe("consumeForInspection cancel finalization (#44)", () => {
  test("already-aborted signal → onCancel + onDone fire, onTerminal does not", () => {
    const ac = new AbortController();
    ac.abort();
    let terminal = 0, cancel = 0, done = 0;
    consumeForInspection(pendingStream(), () => terminal++, ac.signal, () => done++, undefined, () => cancel++);
    expect(cancel).toBe(1);
    expect(done).toBe(1);
    expect(terminal).toBe(0);
  });

  test("mid-drain abort → onCancel + onDone fire, onTerminal suppressed", async () => {
    const ac = new AbortController();
    let terminal = 0, cancel = 0, done = 0;
    consumeForInspection(pendingStream(), () => terminal++, ac.signal, () => done++, undefined, () => cancel++);
    ac.abort();
    await tick();
    expect(cancel).toBe(1);
    expect(done).toBe(1);
    expect(terminal).toBe(0);
  });

  test("clean close without a terminal payload → onTerminal(incomplete), not a cancel", async () => {
    let terminalStatus: string | null = null;
    let cancel = 0, done = 0;
    consumeForInspection(closingStream(), s => { terminalStatus = s; }, undefined, () => done++, undefined, () => cancel++);
    await tick();
    expect(terminalStatus).toBe("incomplete");
    expect(cancel).toBe(0);
    expect(done).toBe(1);
  });
});
