import { describe, expect, test } from "bun:test";
import { sanitizePassthroughHeaders } from "../../src/server";

describe("passthrough header sanitization (RC5 / F4)", () => {
  test("content-type: text/event-stream survives sanitization", () => {
    const sanitized = sanitizePassthroughHeaders(new Headers({
      "content-type": "text/event-stream; charset=utf-8",
      "content-encoding": "gzip",
      "content-length": "4096",
      "x-request-id": "req_abc",
    }));
    expect(sanitized.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(sanitized.has("content-encoding")).toBe(false);
    expect(sanitized.has("content-length")).toBe(false);
    expect(sanitized.get("x-request-id")).toBe("req_abc");
  });

  test("hop-by-hop and stale framing headers are dropped, telemetry preserved", () => {
    const sanitized = sanitizePassthroughHeaders(new Headers({
      "transfer-encoding": "chunked",
      "connection": "keep-alive",
      "te": "trailers",
      "upgrade": "websocket",
      "openai-processing-ms": "812",
      "x-ratelimit-remaining-tokens": "29000",
    }));
    for (const h of ["transfer-encoding", "connection", "te", "upgrade"]) {
      expect(sanitized.has(h)).toBe(false);
    }
    expect(sanitized.get("openai-processing-ms")).toBe("812");
    expect(sanitized.get("x-ratelimit-remaining-tokens")).toBe("29000");
  });

  test("sensitive upstream cookies are not relayed", () => {
    const sanitized = sanitizePassthroughHeaders(new Headers({
      "set-cookie": "session=secret; HttpOnly",
      "set-cookie2": "legacy=secret",
      "content-type": "text/event-stream",
    }));

    expect(sanitized.has("set-cookie")).toBe(false);
    expect(sanitized.has("set-cookie2")).toBe(false);
    expect(sanitized.get("content-type")).toBe("text/event-stream");
  });
});
