import { describe, expect, test } from "bun:test";
import { ConcurrencyLimiter } from "../src/limits";
import { estimateHeaderBytes, isRequestWithinBounds } from "../src/limits";

describe("request and header bounds", () => {
  test("accepts requests within configured limits", () => {
    const req = new Request("https://example.test/v1/models", {
      method: "POST",
      headers: { "content-length": "1024" },
    });
    expect(isRequestWithinBounds(req, {
      maxRequestBytes: 2048,
      maxHeaderBytes: 8192,
    })).toEqual({ ok: true });
  });

  test("rejects oversized content-length", () => {
    const req = new Request("https://example.test/v1/models", {
      method: "POST",
      headers: { "content-length": "999999" },
    });
    expect(isRequestWithinBounds(req, {
      maxRequestBytes: 1024,
      maxHeaderBytes: 8192,
    })).toEqual({ ok: false, category: "request_too_large" });
  });

  test("rejects malformed content-length values", () => {
    for (const value of ["1e9", "1000junk", "1.5", "-1"]) {
      const req = new Request("https://example.test/v1/models", {
        method: "POST",
        headers: { "content-length": value },
      });
      expect(isRequestWithinBounds(req, {
        maxRequestBytes: 1024,
        maxHeaderBytes: 8192,
      })).toEqual({ ok: false, category: "request_too_large" });
    }
  });

  test("rejects POST requests without content-length when a body is required", () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("payload"));
        controller.close();
      },
    });
    const req = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(isRequestWithinBounds(req, {
      maxRequestBytes: 1024,
      maxHeaderBytes: 8192,
      requireContentLengthForBody: true,
    })).toEqual({ ok: false, category: "request_too_large" });
  });

  test("rejects oversized headers", () => {
    const req = new Request("https://example.test/v1/models", {
      headers: { "x-big": "a".repeat(9000) },
    });
    expect(isRequestWithinBounds(req, {
      maxRequestBytes: 1024,
      maxHeaderBytes: 100,
    })).toEqual({ ok: false, category: "headers_too_large" });
  });

  test("estimates header bytes from all header names and values", () => {
    const req = new Request("https://example.test/v1/models", {
      headers: {
        Authorization: "Bearer secret",
        "X-Test": "value",
      },
    });
    expect(estimateHeaderBytes(req)).toBeGreaterThan(10);
  });
});

describe("ConcurrencyLimiter", () => {
  test("limits concurrent acquisitions", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();
    const pending = limiter.acquire();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    release();
    await pending;
    expect(settled).toBe(true);
  });

  test("tryAcquire returns concurrency_limited when saturated", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();
    expect(limiter.tryAcquire()).toEqual({ ok: false, category: "concurrency_limited" });
    release();
    const next = limiter.tryAcquire();
    expect(next.ok).toBe(true);
    if (next.ok) next.release();
  });
});
