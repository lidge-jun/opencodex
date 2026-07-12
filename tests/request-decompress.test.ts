import { describe, expect, test } from "bun:test";
import {
  DecompressedBodyTooLargeError,
  decodeRequestBody,
  MAX_DECOMPRESSED_BODY_BYTES,
  readJsonRequestBody,
  UnsupportedContentEncodingError,
} from "../src/server/request-decompress";

const PAYLOAD = { model: "gpt-5.5", input: "hello", stream: true };
const PAYLOAD_BYTES = new TextEncoder().encode(JSON.stringify(PAYLOAD));

describe("decodeRequestBody", () => {
  test("passes identity and absent encodings through untouched", () => {
    expect(decodeRequestBody(PAYLOAD_BYTES, null)).toBe(PAYLOAD_BYTES);
    expect(decodeRequestBody(PAYLOAD_BYTES, "")).toBe(PAYLOAD_BYTES);
    expect(decodeRequestBody(PAYLOAD_BYTES, "identity")).toBe(PAYLOAD_BYTES);
  });

  test("allows identity bodies exactly at the shared byte cap", () => {
    const exact = new Uint8Array(MAX_DECOMPRESSED_BODY_BYTES);
    expect(decodeRequestBody(exact, "identity")).toBe(exact);
    expect(decodeRequestBody(exact, null)).toBe(exact);
  });

  test("rejects identity bodies over the shared byte cap", () => {
    const over = new Uint8Array(MAX_DECOMPRESSED_BODY_BYTES + 1);
    expect(() => decodeRequestBody(over, "identity")).toThrow(DecompressedBodyTooLargeError);
    expect(() => decodeRequestBody(over, null)).toThrow(DecompressedBodyTooLargeError);
  });

  test("round-trips zstd (the codex enable_request_compression encoding)", () => {
    const compressed = Bun.zstdCompressSync(PAYLOAD_BYTES);
    expect(new TextDecoder().decode(decodeRequestBody(compressed, "zstd"))).toBe(JSON.stringify(PAYLOAD));
  });

  test("round-trips gzip and x-gzip", () => {
    const compressed = Bun.gzipSync(PAYLOAD_BYTES);
    expect(new TextDecoder().decode(decodeRequestBody(compressed, "gzip"))).toBe(JSON.stringify(PAYLOAD));
    expect(new TextDecoder().decode(decodeRequestBody(compressed, "x-gzip"))).toBe(JSON.stringify(PAYLOAD));
  });

  test("round-trips deflate", () => {
    const compressed = Bun.deflateSync(PAYLOAD_BYTES);
    expect(new TextDecoder().decode(decodeRequestBody(compressed, "deflate"))).toBe(JSON.stringify(PAYLOAD));
  });

  test("is case/whitespace tolerant on the encoding token", () => {
    const compressed = Bun.zstdCompressSync(PAYLOAD_BYTES);
    expect(new TextDecoder().decode(decodeRequestBody(compressed, "  ZSTD "))).toBe(JSON.stringify(PAYLOAD));
  });

  test("rejects unknown and multi-codings instead of guessing", () => {
    expect(() => decodeRequestBody(PAYLOAD_BYTES, "br")).toThrow(UnsupportedContentEncodingError);
    expect(() => decodeRequestBody(PAYLOAD_BYTES, "zstd, gzip")).toThrow(UnsupportedContentEncodingError);
  });

  test("throws on garbage compressed input", () => {
    expect(() => decodeRequestBody(new TextEncoder().encode("not zstd"), "zstd")).toThrow();
  });

  test("caps decompressed size", () => {
    // A highly compressible body larger than the cap after inflation.
    const big = new Uint8Array(MAX_DECOMPRESSED_BODY_BYTES + 1024);
    const compressed = Bun.zstdCompressSync(big);
    expect(() => decodeRequestBody(compressed, "zstd")).toThrow(DecompressedBodyTooLargeError);
  });

  test("aborts DURING inflation via maxOutputLength — activation per codec (injected cap)", () => {
    // Review finding (PR #96): the cap must fire inside zlib, not after full allocation.
    // A small injected cap keeps the test cheap while exercising the exact
    // ERR_BUFFER_TOO_LARGE -> DecompressedBodyTooLargeError path.
    const CAP = 1024;
    const inflates64k = new Uint8Array(64 * 1024);
    expect(() => decodeRequestBody(Bun.zstdCompressSync(inflates64k), "zstd", CAP)).toThrow(DecompressedBodyTooLargeError);
    expect(() => decodeRequestBody(Bun.gzipSync(inflates64k), "gzip", CAP)).toThrow(DecompressedBodyTooLargeError);
    expect(() => decodeRequestBody(Bun.deflateSync(inflates64k), "deflate", CAP)).toThrow(DecompressedBodyTooLargeError);
  });

  test("injected cap still admits bodies within the limit", () => {
    const CAP = 1024 * 1024;
    const compressed = Bun.zstdCompressSync(PAYLOAD_BYTES);
    expect(new TextDecoder().decode(decodeRequestBody(compressed, "zstd", CAP))).toBe(JSON.stringify(PAYLOAD));
  });

  test("decodes image-heavy bodies that exceed the old 64MB cap (regression)", () => {
    // The reported "Invalid JSON body" failure: ~12 screenshots inflate past the former 64MB cap.
    // 100MB is over the old limit and under the current one, so it must now decode.
    const OLD_CAP = 64 * 1024 * 1024;
    const between = new Uint8Array(OLD_CAP + 36 * 1024 * 1024); // ~100MB, < MAX_DECOMPRESSED_BODY_BYTES
    expect(between.byteLength).toBeGreaterThan(OLD_CAP);
    expect(between.byteLength).toBeLessThan(MAX_DECOMPRESSED_BODY_BYTES);
    const compressed = Bun.zstdCompressSync(between);
    expect(decodeRequestBody(compressed, "zstd").byteLength).toBe(between.byteLength);
  });
});

describe("readJsonRequestBody", () => {
  test("parses an uncompressed request without touching arrayBuffer path", async () => {
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(PAYLOAD),
    });
    expect(await readJsonRequestBody(req)).toEqual(PAYLOAD);
  });

  test("parses a zstd-compressed request (codex HTTP fallback under Design B)", async () => {
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: Bun.zstdCompressSync(PAYLOAD_BYTES),
    });
    expect(await readJsonRequestBody(req)).toEqual(PAYLOAD);
  });

  test("parses a gzip-compressed request", async () => {
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: Bun.gzipSync(PAYLOAD_BYTES),
    });
    expect(await readJsonRequestBody(req)).toEqual(PAYLOAD);
  });

  test("surfaces UnsupportedContentEncodingError for unknown encodings", async () => {
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "br" },
      body: PAYLOAD_BYTES,
    });
    await expect(readJsonRequestBody(req)).rejects.toBeInstanceOf(UnsupportedContentEncodingError);
  });

  test("surfaces DecompressedBodyTooLargeError (mapped to 413, not a generic 400) for oversized bodies", async () => {
    const big = Bun.zstdCompressSync(new Uint8Array(MAX_DECOMPRESSED_BODY_BYTES + 1024));
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: big,
    });
    await expect(readJsonRequestBody(req)).rejects.toBeInstanceOf(DecompressedBodyTooLargeError);
  });

  test("surfaces DecompressedBodyTooLargeError for oversized identity bodies too", async () => {
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array(MAX_DECOMPRESSED_BODY_BYTES + 1),
    });
    await expect(readJsonRequestBody(req)).rejects.toBeInstanceOf(DecompressedBodyTooLargeError);
  });

  test("preserves SyntaxError for malformed identity JSON", async () => {
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{\"model\":",
    });
    await expect(readJsonRequestBody(req)).rejects.toBeInstanceOf(SyntaxError);
  });

  test("preserves SyntaxError for malformed compressed JSON", async () => {
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: Bun.zstdCompressSync(new TextEncoder().encode("{\"model\":")),
    });
    await expect(readJsonRequestBody(req)).rejects.toBeInstanceOf(SyntaxError);
  });
});
