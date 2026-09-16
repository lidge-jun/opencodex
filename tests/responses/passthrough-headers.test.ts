import { describe, expect, test } from "bun:test";
import { codexSafetyBufferingFilterOptions, sanitizePassthroughHeaders } from "../../src/server";
import { createSseTerminalOutputBoundary } from "../../src/server/relay";

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
    for (const options of [undefined, {}, { dropCodexSafetyBuffering: false }]) {
      const sanitized = sanitizePassthroughHeaders(upstream(), options);
      expect(sanitized.get("x-codex-safety-buffering-enabled")).toBe("true");
      expect(sanitized.get("x-codex-safety-buffering-faster-model")).toBe("gpt-5.6-luna");
    }
  });

  test("dropped case-insensitively when opted in, other x-codex headers survive", () => {
    const sanitized = sanitizePassthroughHeaders(upstream(), { dropCodexSafetyBuffering: true });
    expect(sanitized.has("x-codex-safety-buffering-enabled")).toBe(false);
    expect(sanitized.has("x-codex-safety-buffering-faster-model")).toBe(false);
    expect(sanitized.get("x-codex-primary-used-percent")).toBe("12");
    expect(sanitized.get("openai-model")).toBe("gpt-6-astra");
    expect(sanitized.get("content-type")).toBe("text/event-stream");
  });

  test("codexSafetyBufferingFilterOptions only enables the drop on an explicit true", () => {
    expect(codexSafetyBufferingFilterOptions({})).toEqual({ dropCodexSafetyBuffering: false });
    expect(codexSafetyBufferingFilterOptions({ dropCodexSafetyBuffering: false }))
      .toEqual({ dropCodexSafetyBuffering: false });
    expect(codexSafetyBufferingFilterOptions({ dropCodexSafetyBuffering: true }))
      .toEqual({ dropCodexSafetyBuffering: true });
  });
});

describe("Codex safety-buffering SSE hints at the client output boundary", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const frames = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"},"safety_buffering":{"retry_model":"gpt-5.6-luna"}}\n\n',
    'event: response.metadata\ndata: {"type":"response.metadata","metadata":{"type":"safety_buffering","retry_model":"gpt-5.6-luna"}}\n\n',
    'event: response.metadata\ndata: {"type":"response.metadata","metadata":{"type":"other","turn":1}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
  ];
  const relay = (options?: { dropCodexSafetyBuffering?: boolean }): string => {
    const boundary = createSseTerminalOutputBoundary(options);
    let out = "";
    for (const frame of frames) out += decoder.decode(boundary.feed(encoder.encode(frame)));
    out += decoder.decode(boundary.finish());
    boundary.dispose();
    return out;
  };

  test("relayed verbatim by default and when the option is off", () => {
    for (const options of [undefined, {}, { dropCodexSafetyBuffering: false }]) {
      expect(relay(options)).toBe(frames.join(""));
    }
  });

  test("metadata event dropped and field stripped when opted in, other events untouched", () => {
    const out = relay({ dropCodexSafetyBuffering: true });
    expect(out).not.toContain("safety_buffering");
    expect(out).not.toContain("gpt-5.6-luna");
    expect(out).toContain('data: {"type":"response.created","response":{"id":"resp_1"}}');
    expect(out).toContain(frames[2]);
    expect(out).toContain(frames[3]);
    expect(out).toContain(frames[4]);
    expect(out.match(/^event: /gm)).toHaveLength(4);
  });
});
