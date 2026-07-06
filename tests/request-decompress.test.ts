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
});
