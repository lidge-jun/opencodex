import { describe, expect, test } from "bun:test";
import { createLinkedAbortController, isAbortError } from "../src/cancel";

describe("cancellation primitives", () => {
  test("links client abort to upstream controller", () => {
    const client = new AbortController();
    const linked = createLinkedAbortController(client.signal);
    expect(linked.controller.signal.aborted).toBe(false);
    client.abort();
    expect(linked.controller.signal.aborted).toBe(true);
  });

  test("detects abort errors", () => {
    const err = new DOMException("aborted", "AbortError");
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new Error("nope"))).toBe(false);
  });
});
