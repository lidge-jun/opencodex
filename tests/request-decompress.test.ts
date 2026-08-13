import { describe, expect, test } from "bun:test";
import {
  DecompressedBodyTooLargeError,
  decodeRequestBody,
  MAX_DECOMPRESSED_BODY_BYTES,
  readBoundedJsonRequestBody,
  readJsonRequestBody,
  UnsupportedContentEncodingError,
} from "../src/server/request-decompress";
import { MANAGEMENT_JSON_BODY_MAX_BYTES } from "../src/server/management/body";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

const PAYLOAD = { model: "gpt-5.5", input: "hello", stream: true };
const PAYLOAD_BYTES = new TextEncoder().encode(JSON.stringify(PAYLOAD));

interface TrackedBodyStats {
  pulls: number;
  cancelled: number;
  sentinelPulled: boolean;
}

function trackedBodyStream(
  chunks: readonly Uint8Array[],
  options: {
    sentinel?: Uint8Array;
    cancel?: (reason: unknown) => void | Promise<void>;
  } = {},
): { body: ReadableStream<Uint8Array>; stats: TrackedBodyStats } {
  const pending = [...chunks];
  const stats: TrackedBodyStats = { pulls: 0, cancelled: 0, sentinelPulled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      stats.pulls += 1;
      const chunk = pending.shift();
      if (!chunk) {
        controller.close();
        return;
      }
      if (chunk === options.sentinel) stats.sentinelPulled = true;
      controller.enqueue(chunk);
    },
    cancel(reason) {
      stats.cancelled += 1;
      return options.cancel?.(reason);
    },
  }, { highWaterMark: 0 });
  return { body, stats };
}

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
  test("rejects and cancels declared over-cap bodies before reading", async () => {
    const { body, stats } = trackedBodyStream([PAYLOAD_BYTES]);
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-length": String(MAX_DECOMPRESSED_BODY_BYTES + 1) },
      body,
    });

    await expect(readJsonRequestBody(req)).rejects.toBeInstanceOf(DecompressedBodyTooLargeError);
    expect(stats.pulls).toBe(0);
    expect(stats.cancelled).toBe(1);
  });

  for (const [label, headers] of [
    ["missing Content-Length", { "content-type": "application/json" }],
    ["a lying low Content-Length", { "content-type": "application/json", "content-length": "1" }],
  ] as const) {
    test(`stops and cancels at the wire-byte cap with ${label}`, async () => {
      const sentinel = Uint8Array.of(0x7f);
      const { body, stats } = trackedBodyStream([
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]),
        sentinel,
      ], { sentinel });
      const req = new Request("http://localhost/api/optional", { method: "POST", headers, body });

      await expect(readBoundedJsonRequestBody(req, 5, undefined, { emptyBodyFallback: {} }))
        .rejects.toBeInstanceOf(DecompressedBodyTooLargeError);
      expect(stats).toEqual({ pulls: 2, cancelled: 1, sentinelPulled: false });
    });
  }

  test("accepts an exactly capped fragmented wire body after EOF", async () => {
    const encoded = new TextEncoder().encode('{"x":1}');
    const { body, stats } = trackedBodyStream(Array.from(encoded, byte => Uint8Array.of(byte)));
    const req = new Request("http://localhost/api/optional", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(await readBoundedJsonRequestBody(req, encoded.byteLength)).toEqual({ x: 1 });
    expect(stats.cancelled).toBe(0);
  });

  test("does not await a stream cancellation that never settles", async () => {
    const sentinel = Uint8Array.of(0x7f);
    const { body, stats } = trackedBodyStream([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      sentinel,
    ], {
      sentinel,
      cancel: () => new Promise<void>(() => {}),
    });
    const req = new Request("http://localhost/api/optional", { method: "POST", body });
    const result = readBoundedJsonRequestBody(req, 5).then(
      () => "resolved",
      error => error instanceof DecompressedBodyTooLargeError ? "oversized" : "wrong-error",
    );

    expect(await Promise.race([result, Bun.sleep(250).then(() => "timed-out")])).toBe("oversized");
    expect(stats).toEqual({ pulls: 2, cancelled: 1, sentinelPulled: false });
  });

  test("preserves the original abort reason when cancellation settles a pending read as EOF", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        markStarted();
      },
      cancel() {
        cancelled += 1;
      },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const req = new Request("http://localhost/api/optional", {
      method: "POST",
      body,
      signal: controller.signal,
    });
    const pending = readBoundedJsonRequestBody(req, 5);
    await started;
    const reason = new Error("stop request body read");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cancelled).toBe(1);
  });

  test("management routes reject a lying declaration when the buffered body exceeds 4 MiB", async () => {
    const body = JSON.stringify({ codexAutoStart: "x".repeat(MANAGEMENT_JSON_BODY_MAX_BYTES) });
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": "1", host: "localhost" },
      body,
    });
    const config = { defaultProvider: "mock", providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } } } as OcxConfig;
    const response = await handleManagementAPI(req, new URL(req.url), config);
    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({ error: "request body too large" });
  });

  test("rejects oversized compressed wire bytes without a Content-Length before inflation", async () => {
    const gzipMember = Bun.gzipSync(new TextEncoder().encode(" "));
    const oversizedWireBody = new Uint8Array(gzipMember.byteLength * 100);
    for (let index = 0; index < 100; index++) {
      oversizedWireBody.set(gzipMember, index * gzipMember.byteLength);
    }
    expect(oversizedWireBody.byteLength).toBeGreaterThan(1024);
    const req = new Request("http://localhost/api/optional", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: oversizedWireBody,
    });
    expect(req.headers.get("content-length")).toBeNull();
    await expect(readBoundedJsonRequestBody(req, 1024, undefined, { emptyBodyFallback: {} }))
      .rejects.toBeInstanceOf(DecompressedBodyTooLargeError);
  });

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

  test("returns an explicit fallback only for an empty optional body", async () => {
    const fallback = {};
    const req = new Request("http://localhost/api/optional", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: Bun.gzipSync(new TextEncoder().encode("  \n")),
    });
    expect(await readBoundedJsonRequestBody(req, 1024, undefined, { emptyBodyFallback: fallback }))
      .toBe(fallback);
  });

  test("does not turn malformed JSON into the optional-body fallback", async () => {
    const req = new Request("http://localhost/api/optional", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    await expect(readBoundedJsonRequestBody(req, 1024, undefined, { emptyBodyFallback: {} }))
      .rejects.toBeInstanceOf(SyntaxError);
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
