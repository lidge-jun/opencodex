import { describe, expect, test } from "bun:test";
import { passthroughHeaderOptions, sanitizePassthroughHeaders } from "../../src/server";

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

describe("codex safety-buffering hint headers", () => {
  const upstream = () => new Headers({
    "content-type": "text/event-stream",
    "x-codex-safety-buffering-enabled": "true",
    "X-Codex-Safety-Buffering-Faster-Model": "gpt-5.6-luna",
    "x-codex-primary-used-percent": "12",
    "openai-model": "gpt-6-astra",
  });

  test("forwarded verbatim by default and when the option is off", () => {
    for (const options of [undefined, {}, { dropCodexSafetyBufferingHeaders: false }]) {
      const sanitized = sanitizePassthroughHeaders(upstream(), options);
      expect(sanitized.get("x-codex-safety-buffering-enabled")).toBe("true");
      expect(sanitized.get("x-codex-safety-buffering-faster-model")).toBe("gpt-5.6-luna");
    }
  });

  test("dropped case-insensitively when opted in, other x-codex headers survive", () => {
    const sanitized = sanitizePassthroughHeaders(upstream(), { dropCodexSafetyBufferingHeaders: true });
    expect(sanitized.has("x-codex-safety-buffering-enabled")).toBe(false);
    expect(sanitized.has("x-codex-safety-buffering-faster-model")).toBe(false);
    expect(sanitized.get("x-codex-primary-used-percent")).toBe("12");
    expect(sanitized.get("openai-model")).toBe("gpt-6-astra");
    expect(sanitized.get("content-type")).toBe("text/event-stream");
  });

  test("passthroughHeaderOptions only enables the drop on an explicit true", () => {
    expect(passthroughHeaderOptions({})).toEqual({ dropCodexSafetyBufferingHeaders: false });
    expect(passthroughHeaderOptions({ dropCodexSafetyBufferingHeaders: false }))
      .toEqual({ dropCodexSafetyBufferingHeaders: false });
    expect(passthroughHeaderOptions({ dropCodexSafetyBufferingHeaders: true }))
      .toEqual({ dropCodexSafetyBufferingHeaders: true });
  });
});
