import { describe, expect, test } from "bun:test";
import {
  checkOutboundBodySize,
  DEFAULT_MAX_UPSTREAM_BODY_BYTES,
  describeOutboundBodyRefusal,
} from "../src/server/responses/outbound-body-guard";

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

describe("checkOutboundBodySize", () => {
  test("admits a small body without running image diagnostics", () => {
    const body = JSON.stringify({ input: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] });
    const result = checkOutboundBodySize(body, utf8Bytes(body) + 1);

    expect(result).toEqual({
      admitted: true,
      bytes: utf8Bytes(body),
      limit: utf8Bytes(body) + 1,
      imageCount: 0,
      imageBytes: 0,
    });
  });

  test("refuses by real UTF-8 byte length", () => {
    const body = JSON.stringify({ input: "界" });
    const result = checkOutboundBodySize(body, body.length);

    expect(result.admitted).toBe(false);
    expect(result.bytes).toBe(utf8Bytes(body));
    expect(result.bytes).toBeGreaterThan(body.length);
  });

  test("counts nested data-URI images by approximate decoded size", () => {
    const body = JSON.stringify({
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AAAAAAAA" },
          { type: "input_image", image_url: "data:image/jpeg;base64,AAAA" },
        ],
      }],
    });
    const result = checkOutboundBodySize(body, 1);

    expect(result.imageCount).toBe(2);
    expect(result.imageBytes).toBe(Math.floor((8 * 3) / 4) + Math.floor((4 * 3) / 4));
  });

  test("counts remote images without attributing their remote bytes", () => {
    const body = JSON.stringify({ input: [{ type: "input_image", image_url: "https://example.test/image.png" }] });
    const result = checkOutboundBodySize(body, 1);

    expect(result.imageCount).toBe(1);
    expect(result.imageBytes).toBe(0);
  });

  test("a malformed data URI degrades to zero decoded bytes", () => {
    const body = JSON.stringify({ input: [{ type: "input_image", image_url: "data:image/png;base64" }] });
    const result = checkOutboundBodySize(body, 1);

    expect(result.imageCount).toBe(1);
    expect(result.imageBytes).toBe(0);
  });

  test("an unparseable oversized body still refuses", () => {
    const result = checkOutboundBodySize("{not-json", 1);

    expect(result.admitted).toBe(false);
    expect(result.imageCount).toBe(0);
    expect(result.imageBytes).toBe(0);
  });

  test("zero disables the guard before measuring or scanning a large body", () => {
    const result = checkOutboundBodySize("x".repeat(20 * 1024 * 1024), 0);

    expect(result).toEqual({ admitted: true, bytes: 0, limit: 0, imageCount: 0, imageBytes: 0 });
  });

  test("an undefined limit uses the default", () => {
    const result = checkOutboundBodySize("{}", undefined);

    expect(result.admitted).toBe(true);
    expect(result.limit).toBe(DEFAULT_MAX_UPSTREAM_BODY_BYTES);
  });

  test("admits the exact boundary and refuses one byte over it", () => {
    expect(checkOutboundBodySize("1234", 4).admitted).toBe(true);
    expect(checkOutboundBodySize("12345", 4).admitted).toBe(false);
  });
});

test("describeOutboundBodyRefusal is actionable without token-limit wording or body excerpts", () => {
  const message = describeOutboundBodyRefusal({
    admitted: false,
    bytes: 16 * 1024 * 1024,
    limit: 15 * 1024 * 1024,
    imageCount: 11,
    imageBytes: 15 * 1024 * 1024,
  }, "context window / too many tokens");

  expect(message).toContain("16.0 MB");
  expect(message).toContain("15.0 MB");
  expect(message).toContain("11 input_image items");
  expect(message).toContain("Start a new session or compact the conversation");
  expect(message).not.toContain("context window");
  expect(message).not.toContain("context length");
  expect(message).not.toContain("too many tokens");
  expect(message).not.toContain("data:image");
});
