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

describe("runCursorTurnWithRetry — transport close ordering (WP180)", () => {
  function orderedTransport(
    log: string[],
    n: number,
    opts: { fail?: boolean; closeDelayMs?: number; closeError?: unknown; events?: CursorServerMessage[] },
  ): CursorTransport {
    return {
      async *run() {
        log.push(`run${n}`);
        for (const event of opts.events ?? []) yield event;
        if (opts.fail) throw new Error("connect ECONNREFUSED");
      },
      writeClient() {},
      async close() {
        if (opts.closeDelayMs) await new Promise(resolve => setTimeout(resolve, opts.closeDelayMs));
        log.push(`close${n}`);
        if (opts.closeError) throw opts.closeError;
      },
      requestCommitted: () => false,
    };
  }

  test("a failed attempt closes (even a slow close) before the next transport is constructed", async () => {
    const log: string[] = [];
    let calls = 0;
    await runCursorTurnWithRetry(
      () => {
        calls++;
        log.push(`make${calls}`);
        if (calls === 1) return orderedTransport(log, 1, { fail: true, closeDelayMs: 30 });
        return orderedTransport(log, 2, { events: [{ type: "text", text: "ok" }] });
      },
      { provider: { adapter: "cursor" } },
      request,
      undefined,
      () => {},
    );
    expect(log).toEqual(["make1", "run1", "close1", "make2", "run2", "close2"]);
  });

  test("a throwing close on the failed attempt neither masks the error nor kills the retry", async () => {
    const log: string[] = [];
    let calls = 0;
    const events: CursorServerMessage[] = [];
    await runCursorTurnWithRetry(
      () => {
        calls++;
        log.push(`make${calls}`);
        if (calls === 1) return orderedTransport(log, 1, { fail: true, closeError: new Error("close exploded") });
        return orderedTransport(log, 2, { events: [{ type: "text", text: "ok" }] });
      },
      { provider: { adapter: "cursor" } },
      request,
      undefined,
      message => events.push(message),
    );
    // Retry proceeded despite close1 throwing, and the turn succeeded.
    expect(log).toEqual(["make1", "run1", "close1", "make2", "run2", "close2"]);
    expect(events).toEqual([{ type: "text", text: "ok" }]);
  });

  test("a throwing close on the success path never replaces the run outcome", async () => {
    const log: string[] = [];
    const events: CursorServerMessage[] = [];
    await runCursorTurnWithRetry(
      () => orderedTransport(log, 1, { events: [{ type: "text", text: "done" }], closeError: new Error("cleanup failed") }),
      { provider: { adapter: "cursor" } },
      request,
      undefined,
      message => events.push(message),
    );
    expect(events).toEqual([{ type: "text", text: "done" }]);
  });

  test("retry exhaustion closes every transport exactly once and propagates the final error", async () => {
    const log: string[] = [];
    let calls = 0;
    await expect(runCursorTurnWithRetry(
      () => {
        calls++;
        log.push(`make${calls}`);
        return orderedTransport(log, calls, { fail: true });
      },
      { provider: { adapter: "cursor" } },
      request,
      undefined,
      () => {},
    )).rejects.toThrow("ECONNREFUSED");

    const closes = log.filter(entry => entry.startsWith("close"));
    const makes = log.filter(entry => entry.startsWith("make"));
    expect(makes.length).toBe(calls);
    // Every transport closed exactly once — the guard prevents double-close.
    expect(closes).toEqual(makes.map(m => m.replace("make", "close")));
    // Ordering held on every round: closeN before makeN+1.
    for (let n = 1; n < calls; n++) {
      expect(log.indexOf(`close${n}`)).toBeLessThan(log.indexOf(`make${n + 1}`));
    }
  });

  test("abort during the backoff (after the pre-sleep close) propagates without a second close", async () => {
    const log: string[] = [];
    const ac = new AbortController();
    let calls = 0;
    const pending = runCursorTurnWithRetry(
      () => {
        calls++;
        log.push(`make${calls}`);
        return orderedTransport(log, calls, { fail: true });
      },
      { provider: { adapter: "cursor" } },
      request,
      ac.signal,
      () => {},
    );
    // Let attempt 1 fail and enter the backoff, then abort mid-sleep.
    await new Promise(resolve => setTimeout(resolve, 20));
    ac.abort("stop");
    await expect(pending).rejects.toBeDefined();
    // Attempt 1 closed exactly once; no second transport was ever made.
    expect(log).toEqual(["make1", "run1", "close1"]);
  });

  test("close settles BEFORE the backoff timer is even scheduled", async () => {
    // Spy on setTimeout: the implementation's only timer here is the backoff sleep.
    // Under the old close-after-sleep shape the timer is scheduled first, so the log
    // would read [.., run1, sleep-scheduled, close1-start, ..] and this test fails.
    const log: string[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = ((fn: Parameters<typeof setTimeout>[0], ms?: number, ...rest: unknown[]) => {
      log.push("sleep-scheduled");
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout;
    globalThis.setTimeout = spy;
    try {
      let calls = 0;
      await runCursorTurnWithRetry(
        () => {
          calls++;
          log.push(`make${calls}`);
          return {
            async *run(): AsyncGenerator<CursorServerMessage> {
              log.push(`run${calls}`);
              if (calls === 1) throw new Error("connect ECONNREFUSED");
              yield { type: "text", text: "ok" } as CursorServerMessage;
            },
            writeClient() {},
            async close() {
              log.push(`close${calls}-start`);
              // Yield a microtask so an interleaved timer scheduling would be visible.
              await Promise.resolve();
              log.push(`close${calls}-end`);
            },
            requestCommitted: () => false,
          } satisfies CursorTransport;
        },
        { provider: { adapter: "cursor" } },
        request,
        undefined,
        () => {},
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    // close1 fully settled before the backoff timer was scheduled; make2 came after.
    expect(log.indexOf("close1-end")).toBeGreaterThan(-1);
    expect(log.indexOf("sleep-scheduled")).toBeGreaterThan(log.indexOf("close1-end"));
    expect(log.indexOf("make2")).toBeGreaterThan(log.indexOf("sleep-scheduled"));
  });

  test("a throwing close never replaces the TERMINAL run error", async () => {
    // Final (non-retryable) attempt: run throws a distinctive error AND its close
    // throws a different one — the rejection must stay the run error.
    const log: string[] = [];
    let closeCalls = 0;
    await expect(runCursorTurnWithRetry(
      () => {
        log.push("make1");
        return {
          async *run(): AsyncGenerator<CursorServerMessage> {
            log.push("run1");
            throw new Error("Cursor authentication failed: terminal-run-error");
          },
          writeClient() {},
          async close() {
            closeCalls++;
            throw new Error("cleanup-error");
          },
          requestCommitted: () => false,
        } satisfies CursorTransport;
      },
      { provider: { adapter: "cursor" } },
      request,
      undefined,
      () => {},
    )).rejects.toThrow("terminal-run-error");
    expect(closeCalls).toBe(1);
  });
});
