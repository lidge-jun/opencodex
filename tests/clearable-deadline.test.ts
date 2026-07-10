import { describe, expect, test } from "bun:test";
import { clearableDeadline } from "../src/lib/abort";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("clearableDeadline", () => {
  test("clear stops the header timer but preserves the parent body-lifetime link", async () => {
    const parent = new AbortController();
    const deadline = clearableDeadline(10, parent.signal);
    deadline.clear();

    await delay(20);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.didExpire()).toBe(false);

    const reason = new DOMException("client closed", "AbortError");
    parent.abort(reason);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(reason);
    expect(deadline.didExpire()).toBe(false);
  });

  test("reports its stable timeout reason when the deadline wins", async () => {
    const parent = new AbortController();
    const deadline = clearableDeadline(5, parent.signal);

    await delay(15);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(deadline.timeoutReason);
    expect(deadline.timeoutReason.name).toBe("TimeoutError");
    expect(deadline.didExpire()).toBe(true);
    deadline.clear();
  });

  test("an already-aborted parent wins without being mislabeled as a deadline", () => {
    const parent = new AbortController();
    const reason = { kind: "superseded" };
    parent.abort(reason);

    const deadline = clearableDeadline(10_000, parent.signal);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBe(reason);
    expect(deadline.didExpire()).toBe(false);
    deadline.clear();
  });
});
