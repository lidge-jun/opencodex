import { describe, expect, test } from "bun:test";
import {
  cursorRetryDelayMs,
  isRetryableCursorError,
  runCursorTurnWithRetry,
} from "../src/adapters/cursor/transport-retry";
import type { CursorRunRequest, CursorServerMessage } from "../src/adapters/cursor/types";
import type { CursorTransport } from "../src/adapters/cursor/transport";

const request = {} as CursorRunRequest;

function transport(opts: {
  events?: CursorServerMessage[];
  throwAfter?: number;
  error?: unknown;
  committed?: boolean;
}): CursorTransport {
  return {
    async *run() {
      const events = opts.events ?? [];
      for (let i = 0; i < events.length; i++) {
        if (opts.throwAfter !== undefined && i === opts.throwAfter) throw opts.error;
        yield events[i]!;
      }
      if (opts.throwAfter !== undefined && opts.throwAfter >= events.length) throw opts.error;
    },
    writeClient() {},
    close() {},
    requestCommitted: () => opts.committed ?? false,
  };
}

describe("isRetryableCursorError", () => {
  test("retries clearly transient pre-commit failures", () => {
    expect(isRetryableCursorError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isRetryableCursorError(new Error("connect ECONNREFUSED 1.2.3.4:443"))).toBe(true);
    expect(isRetryableCursorError(new Error("Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM (GOAWAY)"))).toBe(true);
    expect(isRetryableCursorError(new Error("Cursor gRPC error unavailable"))).toBe(true);
    expect(isRetryableCursorError(new Error("Cursor transport timed out before first response"))).toBe(true);
  });

  test("does not retry auth/invalid-request/ambiguous errors", () => {
    expect(isRetryableCursorError(new Error("Cursor authentication failed: unauthorized"))).toBe(false);
    expect(isRetryableCursorError(new Error("Cursor invalid request: bad model"))).toBe(false);
    expect(isRetryableCursorError(new Error("some unknown failure"))).toBe(false);
  });

  test("does not retry rate limits or expected client-tool cancels", () => {
    expect(isRetryableCursorError(new Error("Cursor rate limit exceeded: resource_exhausted"))).toBe(false);
    expect(isRetryableCursorError(Object.assign(new Error("Stream closed with error code NGHTTP2_CANCEL"), { code: "ERR_HTTP2_STREAM_ERROR" }))).toBe(false);
  });
});

describe("cursorRetryDelayMs", () => {
  test("grows with attempt and stays capped", () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const delay = cursorRetryDelayMs(attempt);
      expect(delay).toBeGreaterThan(0);
      // exp value is capped at CURSOR_RETRY_MAX_MS (2000); jitter (0.8–1.2x) can push the final
      // delay up to 2400, matching kiro-retry's behavior where jitter applies after the cap.
      expect(delay).toBeLessThanOrEqual(2_400);
    }
  });
});

describe("runCursorTurnWithRetry", () => {
  test("retries a transient pre-commit failure and succeeds on the next attempt", async () => {
    let calls = 0;
    const events: CursorServerMessage[] = [];
    await runCursorTurnWithRetry(
      () => {
        calls++;
        if (calls === 1) return transport({ throwAfter: 0, error: new Error("connect ECONNREFUSED"), committed: false });
        return transport({ events: [{ type: "text", text: "ok" }], committed: true });
      },
      { provider: { adapter: "cursor" } },
      request,
      undefined,
      message => events.push(message),
    );
    expect(calls).toBe(2);
    expect(events).toEqual([{ type: "text", text: "ok" }]);
  });

  test("does NOT retry once an event was emitted (no duplicate turn)", async () => {
    let calls = 0;
    const events: CursorServerMessage[] = [];
    await expect(runCursorTurnWithRetry(
      () => {
        calls++;
        // Emits one event, then throws a transient error mid-stream.
        return transport({ events: [{ type: "text", text: "partial" }], throwAfter: 1, error: new Error("read ECONNRESET"), committed: true });
      },
      { provider: { adapter: "cursor" } },
      request,
      undefined,
      message => events.push(message),
    )).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(1);
    expect(events).toEqual([{ type: "text", text: "partial" }]);
  });

  test("does NOT retry when the run request was committed to the wire", async () => {
    let calls = 0;
    await expect(runCursorTurnWithRetry(
      () => { calls++; return transport({ throwAfter: 0, error: new Error("connect ECONNREFUSED"), committed: true }); },
      { provider: { adapter: "cursor" } },
      request,
      undefined,
      () => {},
    )).rejects.toThrow("ECONNREFUSED");
    expect(calls).toBe(1);
  });

  test("does NOT retry a non-retryable error", async () => {
    let calls = 0;
    await expect(runCursorTurnWithRetry(
      () => { calls++; return transport({ throwAfter: 0, error: new Error("Cursor authentication failed"), committed: false }); },
      { provider: { adapter: "cursor" } },
      request,
      undefined,
      () => {},
    )).rejects.toThrow("authentication failed");
    expect(calls).toBe(1);
  });

  test("respects a pre-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort("stop");
    let calls = 0;
    await expect(runCursorTurnWithRetry(
      () => { calls++; return transport({ events: [] }); },
      { provider: { adapter: "cursor" } },
      request,
      ac.signal,
      () => {},
    )).rejects.toBeDefined();
    expect(calls).toBe(0);
  });
});
