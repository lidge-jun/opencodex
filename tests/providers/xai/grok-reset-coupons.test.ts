import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeGrpcWebResponse,
  encodeGrpcWebEnvelope,
  GrpcWebError,
  parseGrpcWebTrailers,
} from "../../../src/grok/grpc-web";
import {
  getGrokRemainingResets,
  decodeGetRemainingResetsResponse,
  decodeVarint,
  encodeRedeemResetRequest,
  encodeVarint,
  GROK_GET_REMAINING_RESETS_ENDPOINT,
  GROK_REDEEM_RESET_ENDPOINT,
  redeemGrokResetCoupon,
} from "../../../src/grok/reset-coupons";
import {
  grokCouponJournalPath,
  openGrokResetCouponOperation,
  recordGrokResetCouponSettlement,
} from "../../../src/grok/reset-coupon-ledger";

describe("grok reset coupons", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "grok-coupons-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips grpc-web data framing and parses trailers", () => {
    const payload = new TextEncoder().encode("test-payload-bytes");
    const dataEnvelope = encodeGrpcWebEnvelope(payload);

    expect(dataEnvelope[0]).toBe(0x00);
    const view = new DataView(dataEnvelope.buffer, dataEnvelope.byteOffset, 5);
    expect(view.getUint32(1, false)).toBe(payload.length);

    const trailerPayload = new TextEncoder().encode("grpc-status:0\r\ngrpc-message:ok\r\n");
    const trailerEnvelope = new Uint8Array(5 + trailerPayload.length);
    trailerEnvelope[0] = 0x80;
    const trailerView = new DataView(trailerEnvelope.buffer, trailerEnvelope.byteOffset, 5);
    trailerView.setUint32(1, trailerPayload.length, false);
    trailerEnvelope.set(trailerPayload, 5);

    const combined = new Uint8Array(dataEnvelope.length + trailerEnvelope.length);
    combined.set(dataEnvelope, 0);
    combined.set(trailerEnvelope, dataEnvelope.length);

    const decoded = decodeGrpcWebResponse(combined);
    expect(decoded.messages.length).toBe(1);
    expect(new TextDecoder().decode(decoded.messages[0])).toBe("test-payload-bytes");
    expect(decoded.status).toBe(0);
    expect(decoded.statusMessage).toBe("ok");
  });

  it("decodes captured live-shape GetRemainingResetsResponse fixture", () => {
    // Construct protobuf binary:
    // Field 10 (tokens):
    //   Field 10 (tokenId): "token_live_abc123"
    //   Field 20 (validityStart): Field 1 (seconds): 1726110000
    //   Field 30 (validityEnd): Field 1 (seconds): 1728788400
    const buildTimestamp = (sec: number) => {
      const secTag = (1 << 3) | 0; // field 1, varint
      const secBytes = encodeVarint(sec);
      const out = new Uint8Array(1 + secBytes.length);
      out[0] = secTag;
      out.set(secBytes, 1);
      return out;
    };

    const buildToken = (tokenId: string, startSec: number, endSec: number) => {
      const idBytes = new TextEncoder().encode(tokenId);
      const idTag = (10 << 3) | 2;
      const idLen = encodeVarint(idBytes.length);

      const startBytes = buildTimestamp(startSec);
      const startTag = (20 << 3) | 2;
      const startLen = encodeVarint(startBytes.length);

      const endBytes = buildTimestamp(endSec);
      const endTag = (30 << 3) | 2;
      const endLen = encodeVarint(endBytes.length);

      const totalLen =
        1 + idLen.length + idBytes.length +
        encodeVarint(startTag).length + startLen.length + startBytes.length +
        encodeVarint(endTag).length + endLen.length + endBytes.length;

      const out = new Uint8Array(totalLen);
      let offset = 0;
      out[offset++] = idTag;
      out.set(idLen, offset);
      offset += idLen.length;
      out.set(idBytes, offset);
      offset += idBytes.length;

      const startTagBytes = encodeVarint(startTag);
      out.set(startTagBytes, offset);
      offset += startTagBytes.length;
      out.set(startLen, offset);
      offset += startLen.length;
      out.set(startBytes, offset);
      offset += startBytes.length;

      const endTagBytes = encodeVarint(endTag);
      out.set(endTagBytes, offset);
      offset += endTagBytes.length;
      out.set(endLen, offset);
      offset += endLen.length;
      out.set(endBytes, offset);
      offset += endBytes.length;

      return out;
    };

    const tokenSub = buildToken("token_live_abc123", 1726110000, 1728788400);
    const topTag = (10 << 3) | 2;
    const topLen = encodeVarint(tokenSub.length);
    const responsePayload = new Uint8Array(1 + topLen.length + tokenSub.length);
    responsePayload[0] = topTag;
    responsePayload.set(topLen, 1);
    responsePayload.set(tokenSub, 1 + topLen.length);

    const tokens = decodeGetRemainingResetsResponse(responsePayload);
    expect(tokens.length).toBe(1);
    expect(tokens[0].tokenId).toBe("token_live_abc123");
    expect(tokens[0].validityStart).toBe(new Date(1726110000 * 1000).toISOString());
    expect(tokens[0].validityEnd).toBe(new Date(1728788400 * 1000).toISOString());
  });

  it("rejects oversized and truncated protobuf lengths", () => {
    const oversizedLength = new Uint8Array([0x52, 0x80, 0x80, 0x80, 0x80, 0x08]);
    expect(() => decodeGetRemainingResetsResponse(oversizedLength)).toThrow(
      "Invalid protobuf length-delimited field",
    );

    expect(() => decodeVarint(new Uint8Array([0x80]), 0)).toThrow("Truncated protobuf varint");
  });

  it("rejects protobuf varints beyond the JavaScript safe integer range", () => {
    const maxSafe = decodeVarint(encodeVarint(BigInt(Number.MAX_SAFE_INTEGER)), 0);
    expect(maxSafe.value).toBe(Number.MAX_SAFE_INTEGER);

    const unsafeVarint = encodeVarint(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(() => decodeVarint(unsafeVarint, 0)).toThrow(
      "Protobuf varint exceeds JavaScript safe integer range",
    );

    const unsafeLength = new Uint8Array(1 + unsafeVarint.length);
    unsafeLength[0] = 0x52; // field 10, wire type 2
    unsafeLength.set(unsafeVarint, 1);
    expect(() => decodeGetRemainingResetsResponse(unsafeLength)).toThrow(
      "Protobuf varint exceeds JavaScript safe integer range",
    );
  });

  it("rejects an overlong varint whose continuation bytes carry no payload", () => {
    // The safe-integer guard cannot bound the length on its own: a continuation byte with no
    // payload bits contributes a part of zero, which is a safe integer, so twenty 0x80 bytes
    // followed by 0x00 decoded as a valid zero. An overlong zero length is what turns a
    // malformed body into an empty coupon list reported as success.
    const overlongZero = new Uint8Array([...new Array(20).fill(0x80), 0x00]);
    expect(() => decodeVarint(overlongZero, 0)).toThrow("Overlong protobuf varint");

    // The bound is a protocol limit, not a value limit: a ten-byte varint carrying real
    // payload still fails for its value, which is the guard above it.
    const tenBytePayload = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    expect(() => decodeVarint(tenBytePayload, 0)).toThrow(
      "Protobuf varint exceeds JavaScript safe integer range",
    );

    // A legal single-byte zero is unaffected.
    expect(decodeVarint(new Uint8Array([0x00]), 0)).toEqual({ value: 0, bytesRead: 1 });
  });

  it("fails the read rather than returning coupons decoded from a malformed response", async () => {
    // Field 10, wire type 2, declaring 127 bytes when none follow. This is the shape the
    // bounds check exists for, asserted where the callers actually consume it: both routes in
    // src/server/management/grok-coupon-routes.ts wrap getGrokRemainingResets in try/catch and
    // answer 502, so the read must throw rather than hand them a tokenId recovered from a
    // short subarray.
    const malformed = new Uint8Array([0x52, 0x7f]);
    const mockFetch: typeof globalThis.fetch = async () => {
      const data = encodeGrpcWebEnvelope(malformed);
      const trailer = new TextEncoder().encode("grpc-status:0\r\n");
      const trailerEnvelope = new Uint8Array(5 + trailer.length);
      trailerEnvelope[0] = 0x80;
      new DataView(trailerEnvelope.buffer).setUint32(1, trailer.length, false);
      trailerEnvelope.set(trailer, 5);
      const body = new Uint8Array(data.length + trailerEnvelope.length);
      body.set(data, 0);
      body.set(trailerEnvelope, data.length);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/grpc-web+proto" },
      });
    };

    await expect(getGrokRemainingResets({ accessToken: "mock-access-token-12345", fetchFn: mockFetch }))
      .rejects.toThrow("Invalid protobuf length-delimited field");
  });

  it("asserts auth headers and tokenAuth compatibility header on request", async () => {
    let capturedHeaders: Headers | undefined;
    let capturedBody: Uint8Array | undefined;

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      capturedHeaders = new Headers(init?.headers);
      if (init?.body instanceof Uint8Array) {
        capturedBody = init.body;
      }
      const emptyTrailer = new TextEncoder().encode("grpc-status:0\r\ngrpc-message:\r\n");
      const envelope = new Uint8Array(5 + emptyTrailer.length);
      envelope[0] = 0x80;
      new DataView(envelope.buffer).setUint32(1, emptyTrailer.length, false);
      envelope.set(emptyTrailer, 5);

      return new Response(envelope, {
        status: 200,
        headers: { "content-type": "application/grpc-web+proto" },
      });
    };

    await getGrokRemainingResets({
      accessToken: "mock-access-token-12345",
      fetchFn: mockFetch,
    });

    expect(capturedHeaders?.get("authorization")).toBe("Bearer mock-access-token-12345");
    expect(capturedHeaders?.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(capturedHeaders?.get("x-grpc-web")).toBe("1");
    expect(capturedHeaders?.get("content-type")).toBe("application/grpc-web+proto");
    expect(capturedBody).toBeDefined();
    expect(capturedBody?.[0]).toBe(0x00); // gRPC-Web data frame prefix
  });

  it("surfaces grpc-status 3 error on invalid token redemption", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      const trailer = new TextEncoder().encode("grpc-status:3\r\ngrpc-message:redeem_reset()%2C%20Invalid%20token_id\r\n");
      const envelope = new Uint8Array(5 + trailer.length);
      envelope[0] = 0x80;
      new DataView(envelope.buffer).setUint32(1, trailer.length, false);
      envelope.set(trailer, 5);

      return new Response(envelope, {
        status: 200,
        headers: { "content-type": "application/grpc-web+proto" },
      });
    };

    let thrown: unknown;
    try {
      await redeemGrokResetCoupon({
        accessToken: "test-token",
        tokenId: "invalid_id_999",
        fetchFn: mockFetch,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GrpcWebError);
    const grpcErr = thrown as GrpcWebError;
    expect(grpcErr.status).toBe(3);
    expect(grpcErr.statusMessage).toContain("Invalid token_id");
  });

  it("handles crash-safe ledger open and idempotent replay", () => {
    const ledgerPath = grokCouponJournalPath(tempDir);

    const first = openGrokResetCouponOperation({
      accountId: "acc-123",
      tokenId: "tok-456",
      operationId: "op-uuid-1",
    }, undefined, ledgerPath);
    expect(first.kind).toBe("execute");

    recordGrokResetCouponSettlement({
      operationId: "op-uuid-1",
      tokenId: "tok-456",
      code: "redeemed",
      status: "success",
    }, undefined, ledgerPath);

    // Re-opening the same settled operationId replays the durable outcome
    const replay = openGrokResetCouponOperation({
      accountId: "acc-123",
      tokenId: "tok-456",
      operationId: "op-uuid-1",
    }, undefined, ledgerPath);
    expect(replay.kind).toBe("replay");
    expect(replay.code).toBe("redeemed");
    expect(replay.settledAt).toBeDefined();
  });

  it("refreshes token on 401 when integrated with refresh provider stub", async () => {
    let callCount = 0;
    let tokenUsed = "";

    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      callCount++;
      const headers = new Headers(init?.headers);
      tokenUsed = headers.get("authorization") || "";

      if (callCount === 1) {
        return new Response("Unauthorized", { status: 401 });
      }

      const emptyTrailer = new TextEncoder().encode("grpc-status:0\r\n");
      const envelope = new Uint8Array(5 + emptyTrailer.length);
      envelope[0] = 0x80;
      new DataView(envelope.buffer).setUint32(1, emptyTrailer.length, false);
      envelope.set(emptyTrailer, 5);

      return new Response(envelope, {
        status: 200,
        headers: { "content-type": "application/grpc-web+proto" },
      });
    };

    // Retry harness mimicking getValidAccessSnapshotForAccount wrapper
    let activeToken = "expired-token";
    const executeWithRetry = async () => {
      try {
        return await getGrokRemainingResets({ accessToken: activeToken, fetchFn: mockFetch });
      } catch (err: any) {
        if (err.message.includes("401")) {
          activeToken = "refreshed-fresh-token";
          return await getGrokRemainingResets({ accessToken: activeToken, fetchFn: mockFetch });
        }
        throw err;
      }
    };

    const res = await executeWithRetry();
    expect(res).toEqual({ tokens: [] });
    expect(callCount).toBe(2);
    expect(tokenUsed).toBe("Bearer refreshed-fresh-token");
  });
});
