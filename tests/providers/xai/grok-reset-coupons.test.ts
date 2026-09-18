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
