import { describe, expect, test } from "bun:test";
import { deflateRawSync, deflateSync } from "node:zlib";
import {
  DecompressedBodyTooLargeError,
  decodeRequestBody,
  describeInboundBodyRefusal,
  MAX_DECOMPRESSED_BODY_BYTES,
  MAX_CONFIGURABLE_INBOUND_BODY_BYTES,
  MIN_CONFIGURABLE_INBOUND_BODY_BYTES,
  readBoundedJsonRequestBody,
  readJsonRequestBody,
  resolveInboundBodyLimitBytes,
  UnsupportedContentEncodingError,
} from "../../src/server/request-decompress";
import { MANAGEMENT_JSON_BODY_MAX_BYTES } from "../../src/server/management/body";
import { handleManagementAPI } from "../../src/server/management-api";
import { decodeRequestErrorResponse } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";

const PAYLOAD = { model: "gpt-5.5", input: "hello", stream: true };
const PAYLOAD_BYTES = new TextEncoder().encode(JSON.stringify(PAYLOAD));

async function captureBodyTooLarge(run: () => unknown): Promise<DecompressedBodyTooLargeError> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof DecompressedBodyTooLargeError)) throw error;
    return error;
  }
  throw new Error("Expected body admission to reject");
}

async function expectBodyLimitResponse(error: DecompressedBodyTooLargeError, message: string): Promise<void> {
  expect(error.message).toBe(message);
  expect(message.length).toBeLessThan(200);
  // The thrown message carries measurement provenance for the log; the client-facing message
  // is the operator-directed one, and the two are deliberately not the same string (#3573).
  const clientMessage = describeInboundBodyRefusal(error);
  for (const label of ["responses", "responses-compact"]) {
    const response = decodeRequestErrorResponse(error, label);
    expect(response.status).toBe(413);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toEqual({
      error: { message: clientMessage, type: "invalid_request_error", code: "inbound_body_too_large" },
    });
  }
}

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

describe("DecompressedBodyTooLargeError", () => {
  test("preserves one- and two-argument constructors without guessing measurement provenance", async () => {
    const legacy = new DecompressedBodyTooLargeError(268435457);
    expect(legacy).toMatchObject({ bytes: 268435457, limit: 268435456, measurement: null });
    await expectBodyLimitResponse(legacy, "Decompressed request body exceeds 268435456 bytes");
    const custom = new DecompressedBodyTooLargeError(6, 5);
    expect(custom).toMatchObject({ bytes: 6, limit: 5, measurement: null });
    await expectBodyLimitResponse(custom, "Decompressed request body exceeds 5 bytes");
  });

  test("keeps untyped categories and non-finite numbers out of the message", async () => {
    const untyped: DecompressedBodyTooLargeError = Reflect.construct(DecompressedBodyTooLargeError, [
      6, 5, "private-header-context window".repeat(100),
    ]);
    expect(untyped.measurement).toBeNull();
    await expectBodyLimitResponse(untyped, "Decompressed request body exceeds 5 bytes");
    for (const bytes of [NaN, Infinity, -Infinity, -1]) {
      const error = new DecompressedBodyTooLargeError(bytes, 5, "declared_wire");
      await expectBodyLimitResponse(error, "Decompressed request body exceeds 5 bytes");
    }
    for (const limit of [NaN, Infinity, -Infinity]) {
      const error = new DecompressedBodyTooLargeError(6, limit, "declared_wire");
      await expectBodyLimitResponse(error, "Decompressed request body exceeds unknown bytes");
    }
    const huge = new DecompressedBodyTooLargeError(Number.MAX_VALUE, 5, "declared_wire");
    await expectBodyLimitResponse(huge,
      "Decompressed request body exceeds 5 bytes [measurement=declared_wire; bytes=1.7976931348623157e+308]");
  });
});

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

  for (const [label, compress] of [["wrapped", deflateSync], ["raw", deflateRawSync], ["Bun raw", Bun.deflateSync]] as const) {
    test(`round-trips ${label} deflate`, () => {
      expect(new TextDecoder().decode(decodeRequestBody(compress(PAYLOAD_BYTES), "deflate"))).toBe(JSON.stringify(PAYLOAD));
    });
  }

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

  test("reports exact identity size at the decoder boundary", async () => {
    for (const encoding of [null, "", "identity"]) {
      const error = await captureBodyTooLarge(() => decodeRequestBody(Uint8Array.of(1, 2, 3, 4, 5, 6), encoding, 5));
      expect(error).toMatchObject({ bytes: 6, limit: 5, measurement: "decoded_exact" });
      await expectBodyLimitResponse(error, "Decompressed request body exceeds 5 bytes [measurement=decoded_exact; bytes=6]");
    }
  });

  test("aborts DURING inflation and reports only a decoded lower bound for every codec", async () => {
    // Review finding (PR #96): the cap must fire inside zlib, not after full allocation.
    // A small injected cap keeps the test cheap while exercising the exact
    // ERR_BUFFER_TOO_LARGE -> DecompressedBodyTooLargeError path.
    const CAP = 1024;
    const inflates64k = new Uint8Array(64 * 1024);
    for (const [encoding, compressed] of [
      ["zstd", Bun.zstdCompressSync(inflates64k)],
      ["gzip", Bun.gzipSync(inflates64k)],
      ["x-gzip", Bun.gzipSync(inflates64k)],
      ["deflate", deflateSync(inflates64k)],
      ["deflate", deflateRawSync(inflates64k)],
      ["deflate", Bun.deflateSync(inflates64k)],
    ] as const) {
      expect(compressed.byteLength).toBeLessThan(CAP);
      // Exercise the streaming reader too: these invalid-JSON bytes must be
      // rejected by inflation before text decoding or JSON parsing.
      const req = new Request("http://localhost/v1/responses/compact", {
        method: "POST", headers: { "content-encoding": encoding }, body: compressed,
      });
      const error = await captureBodyTooLarge(() => readBoundedJsonRequestBody(req, CAP));
      expect(error).toMatchObject({ bytes: 1025, limit: 1024, measurement: "decoded_lower_bound" });
      await expectBodyLimitResponse(error,
        "Decompressed request body exceeds 1024 bytes [measurement=decoded_lower_bound; bytes=1025]");
    }
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

describe("configurable inbound body limit (Issue #3573)", () => {
  test("an unconfigured proxy keeps the 256 MiB default", () => {
    expect(resolveInboundBodyLimitBytes(undefined)).toBe(MAX_DECOMPRESSED_BODY_BYTES);
    expect(resolveInboundBodyLimitBytes(0)).toBe(MAX_DECOMPRESSED_BODY_BYTES);
    // A hand edit the schema degraded, or a config built without the schema at all.
    expect(resolveInboundBodyLimitBytes(-1)).toBe(MAX_DECOMPRESSED_BODY_BYTES);
    expect(resolveInboundBodyLimitBytes(Number.NaN)).toBe(MAX_DECOMPRESSED_BODY_BYTES);
    expect(resolveInboundBodyLimitBytes(Number.POSITIVE_INFINITY)).toBe(MAX_DECOMPRESSED_BODY_BYTES);
  });

  test("the opt-in raises the limit for the 922k-context case", () => {
    // The value #3573 asked for: 512 MiB, which is also the ceiling.
    expect(resolveInboundBodyLimitBytes(512 * 1024 * 1024)).toBe(512 * 1024 * 1024);
    expect(resolveInboundBodyLimitBytes(300 * 1024 * 1024)).toBe(300 * 1024 * 1024);
    expect(resolveInboundBodyLimitBytes(300 * 1024 * 1024)).toBeGreaterThan(MAX_DECOMPRESSED_BODY_BYTES);
  });

  test("the ceiling is a hard bound, not a suggestion", () => {
    // An unbounded inbound cap is a memory DoS: the reader materializes the body several
    // times over, so no configured value may exceed the ceiling.
    for (const requested of [
      MAX_CONFIGURABLE_INBOUND_BODY_BYTES + 1,
      4 * 1024 * 1024 * 1024,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(resolveInboundBodyLimitBytes(requested)).toBe(MAX_CONFIGURABLE_INBOUND_BODY_BYTES);
    }
    expect(MAX_CONFIGURABLE_INBOUND_BODY_BYTES).toBe(512 * 1024 * 1024);
  });

  test("a floor keeps a fat-fingered small value from refusing ordinary turns", () => {
    expect(resolveInboundBodyLimitBytes(1)).toBe(MIN_CONFIGURABLE_INBOUND_BODY_BYTES);
    expect(resolveInboundBodyLimitBytes(1024)).toBe(MIN_CONFIGURABLE_INBOUND_BODY_BYTES);
    expect(resolveInboundBodyLimitBytes(1.9 * 1024 * 1024)).toBe(Math.floor(1.9 * 1024 * 1024));
  });

  test("readJsonRequestBody admits and refuses against the resolved limit, not the default", async () => {
    const body = JSON.stringify(PAYLOAD);
    const request = () => new Request("http://localhost/v1/responses", { method: "POST", body });

    expect(await readJsonRequestBody(request(), undefined, resolveInboundBodyLimitBytes(1024 * 1024)))
      .toEqual(PAYLOAD);

    // Proves the limit is threaded through rather than ignored, without allocating 256 MiB.
    const error = await captureBodyTooLarge(() => readJsonRequestBody(request(), undefined, 8));
    expect(error).toMatchObject({ limit: 8 });
  });

  test("an inbound refusal is distinguishable from the upstream 413 of #4112", async () => {
    const error = new DecompressedBodyTooLargeError(300 * 1024 * 1024, MAX_DECOMPRESSED_BODY_BYTES, "declared_wire");
    const response = decodeRequestErrorResponse(error, "responses");
    expect(response.status).toBe(413);
    const payload = await response.json() as { error: { message: string; code: string } };
    // #4112 classifies the UPSTREAM 413 on this same surface as context_length_exceeded.
    expect(payload.error.code).toBe("inbound_body_too_large");
    expect(payload.error.code).not.toBe("context_length_exceeded");
    // The diagnostic has to say whose limit it is and which key moves it, or the operator
    // cannot tell the two 413s apart or find the lever.
    expect(payload.error.message).toContain("maxInboundBodyBytes");
    expect(payload.error.message).toContain("local proxy limit");
    expect(payload.error.message).toContain("300.0 MB");
    expect(payload.error.message).toContain("256.0 MB");
  });

  test("a lower-bound measurement is not reported as an exact size", () => {
    const exact = new DecompressedBodyTooLargeError(600, 500, "decoded_exact");
    expect(describeInboundBodyRefusal(exact)).not.toContain("at least");
    for (const measurement of ["observed_wire_lower_bound", "decoded_lower_bound"] as const) {
      const lower = new DecompressedBodyTooLargeError(600, 500, measurement);
      expect(describeInboundBodyRefusal(lower)).toContain("at least");
    }
  });

  test("non-finite and untyped inputs stay out of the client-facing diagnostic", () => {
    // Same rule the thrown message already follows: legacy callers can supply anything.
    for (const bytes of [Number.NaN, Infinity, -Infinity, -1, Number.MAX_VALUE]) {
      const message = describeInboundBodyRefusal(new DecompressedBodyTooLargeError(bytes, 500, "declared_wire"));
      expect(message).not.toContain("NaN");
      expect(message).not.toContain("Infinity");
      expect(message).toContain("maxInboundBodyBytes");
    }
    for (const limit of [Number.NaN, Infinity, -Infinity]) {
      const message = describeInboundBodyRefusal(new DecompressedBodyTooLargeError(600, limit, "declared_wire"));
      expect(message).not.toContain("NaN");
      expect(message).not.toContain("Infinity");
      expect(message).toContain("inbound admission limit");
    }
    const untyped: DecompressedBodyTooLargeError = Reflect.construct(DecompressedBodyTooLargeError, [
      600, 500, "private-header-context window".repeat(100),
    ]);
    expect(describeInboundBodyRefusal(untyped)).not.toContain("private-header");
  });
});

describe("readJsonRequestBody", () => {
  test("reports a compressed declaration without reading or echoing request metadata", async () => {
    const { body, stats } = trackedBodyStream([Bun.gzipSync(PAYLOAD_BYTES)]);
    const req = new Request("http://localhost/v1/responses/compact?private-query", {
      method: "POST",
      headers: { "content-length": "00001025", "content-encoding": "gzip", "x-private-marker": "private-header" },
      body,
    });
    const error = await captureBodyTooLarge(() => readBoundedJsonRequestBody(req, 1024));
    expect(error).toMatchObject({ bytes: 1025, limit: 1024, measurement: "declared_wire" });
    await expectBodyLimitResponse(error,
      "Decompressed request body exceeds 1024 bytes [measurement=declared_wire; bytes=1025]");
    expect(stats).toEqual({ pulls: 0, cancelled: 1, sentinelPulled: false });
  });

  test("rejects and cancels declared over-cap bodies before reading", async () => {
    const { body, stats } = trackedBodyStream([PAYLOAD_BYTES]);
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-length": String(MAX_DECOMPRESSED_BODY_BYTES + 1) },
      body,
    });

    const error = await captureBodyTooLarge(() => readJsonRequestBody(req));
    expect(error).toMatchObject({ bytes: 268435457, limit: 268435456, measurement: "declared_wire" });
    await expectBodyLimitResponse(error,
      "Decompressed request body exceeds 268435456 bytes [measurement=declared_wire; bytes=268435457]");
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

      const error = await captureBodyTooLarge(() => readBoundedJsonRequestBody(req, 5, undefined, { emptyBodyFallback: {} }));
      expect(error).toMatchObject({ bytes: 6, limit: 5, measurement: "observed_wire_lower_bound" });
      await expectBodyLimitResponse(error,
        "Decompressed request body exceeds 5 bytes [measurement=observed_wire_lower_bound; bytes=6]");
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
    const error = await captureBodyTooLarge(() => readBoundedJsonRequestBody(req, 1024, undefined, { emptyBodyFallback: {} }));
    expect(error).toMatchObject({ bytes: oversizedWireBody.byteLength, limit: 1024, measurement: "observed_wire_lower_bound" });
    await expectBodyLimitResponse(error,
      `Decompressed request body exceeds 1024 bytes [measurement=observed_wire_lower_bound; bytes=${oversizedWireBody.byteLength}]`);
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
