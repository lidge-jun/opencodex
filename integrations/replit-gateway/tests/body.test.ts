import { describe, expect, test } from "bun:test";
import { parseStrictContentLength, readBoundedBody, createRelayHandoffRequest } from "../src/body";

describe("parseStrictContentLength", () => {
  test("accepts decimal integers", () => {
    expect(parseStrictContentLength("0")).toEqual({ ok: true, length: 0 });
    expect(parseStrictContentLength("1024")).toEqual({ ok: true, length: 1024 });
  });

  test("rejects exponent notation", () => {
    expect(parseStrictContentLength("1e9").ok).toBe(false);
  });

  test("rejects negative values", () => {
    expect(parseStrictContentLength("-1").ok).toBe(false);
  });

  test("rejects trailing junk", () => {
    expect(parseStrictContentLength("1000junk").ok).toBe(false);
    expect(parseStrictContentLength("1.5").ok).toBe(false);
  });

  test("treats absent header as unknown length", () => {
    expect(parseStrictContentLength(null)).toEqual({ ok: true, length: null });
  });
});

describe("readBoundedBody", () => {
  test("reads a body within the limit", async () => {
    const req = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      body: '{"model":"gpt-4o"}',
      headers: { "content-type": "application/json" },
    });
    const result = await readBoundedBody(req, 1024);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.body)).toBe('{"model":"gpt-4o"}');
    }
  });

  test("rejects bodies that exceed the limit while streaming", async () => {
    const req = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      body: "x".repeat(2048),
    });
    const result = await readBoundedBody(req, 1024);
    expect(result).toEqual({ ok: false, category: "request_too_large" });
  });

  test("rejects chunked bodies without content-length that exceed the limit", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(2048)));
        controller.close();
      },
    });
    const req = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    const result = await readBoundedBody(req, 1024);
    expect(result).toEqual({ ok: false, category: "request_too_large" });
  });
});

describe("createReplayableRequest", () => {
  test("rebuilds a request with the same method and bounded body", async () => {
    const original = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"gpt-4o"}',
    });
    const body = new TextEncoder().encode('{"model":"gpt-4o"}');
    const replay = createRelayHandoffRequest(original, body);
    expect(replay.method).toBe("POST");
    expect(await replay.text()).toBe('{"model":"gpt-4o"}');
  });
});
