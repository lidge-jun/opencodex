import { XAI_GROK_COMPATIBILITY } from "../providers/xai-transport";
import {
  decodeGrpcWebResponse,
  encodeGrpcWebEnvelope,
  GrpcWebError,
} from "./grpc-web";

export const GROK_CONSUMER_UI_BASE_URL = "https://grok.com";
export const GROK_GET_REMAINING_RESETS_ENDPOINT =
  "https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets";
export const GROK_REDEEM_RESET_ENDPOINT =
  "https://grok.com/prod_mc_billing.ConsumerUiSvc/RedeemReset";

export interface GrokResetCoupon {
  tokenId: string;
  validityStart: string;
  validityEnd: string;
}

export interface GetRemainingResetsOptions {
  accessToken: string;
  fetchFn?: typeof globalThis.fetch;
  signal?: AbortSignal;
  endpoint?: string;
}

export interface RedeemResetOptions {
  accessToken: string;
  tokenId: string;
  fetchFn?: typeof globalThis.fetch;
  signal?: AbortSignal;
  endpoint?: string;
}

export interface RedeemResetResult {
  success: boolean;
  status: number;
  statusMessage?: string;
}

/**
 * Encodes a 32/64-bit non-negative integer into protobuf varint wire bytes.
 */
export function encodeVarint(value: number | bigint): Uint8Array {
  const bytes: number[] = [];
  let val = BigInt(value);
  while (val >= 0x80n) {
    bytes.push(Number((val & 0x7fn) | 0x80n));
    val >>= 7n;
  }
  bytes.push(Number(val & 0x7fn));
  return new Uint8Array(bytes);
}

/**
 * Decodes a protobuf varint from bytes at offset.
 */
export function decodeVarint(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let result = 0;
  let shift = 0;
  let count = 0;

  while (offset + count < bytes.length) {
    const b = bytes[offset + count];
    count++;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) {
      // For timestamps seconds, JS safe integers suffice.
      break;
    }
  }

  return { value: result, bytesRead: count };
}

/**
 * Encodes RedeemResetRequest protobuf: field 1 (string token_id).
 */
export function encodeRedeemResetRequest(tokenId: string): Uint8Array {
  const tokenBytes = new TextEncoder().encode(tokenId);
  const tag = (1 << 3) | 2; // Field 1, Wire Type 2
  const tagBytes = encodeVarint(tag);
  const lenBytes = encodeVarint(tokenBytes.length);

  const out = new Uint8Array(tagBytes.length + lenBytes.length + tokenBytes.length);
  out.set(tagBytes, 0);
  out.set(lenBytes, tagBytes.length);
  out.set(tokenBytes, tagBytes.length + lenBytes.length);
  return out;
}

/**
 * Decodes a Timestamp submessage (field 1: int64 seconds).
 */
function decodeTimestamp(bytes: Uint8Array): number {
  let offset = 0;
  let seconds = 0;

  while (offset < bytes.length) {
    const { value: tag, bytesRead: tagLen } = decodeVarint(bytes, offset);
    offset += tagLen;
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;

    if (wireType === 0) {
      const { value, bytesRead } = decodeVarint(bytes, offset);
      offset += bytesRead;
      if (fieldNum === 1) seconds = value;
    } else if (wireType === 2) {
      const { value: len, bytesRead } = decodeVarint(bytes, offset);
      offset += bytesRead + len;
    } else {
      break;
    }
  }

  return seconds;
}

/**
 * Decodes a ConsumerResetToken submessage.
 */
function decodeConsumerResetToken(bytes: Uint8Array): GrokResetCoupon | null {
  let offset = 0;
  let tokenId = "";
  let startSec = 0;
  let endSec = 0;

  while (offset < bytes.length) {
    const { value: tag, bytesRead: tagLen } = decodeVarint(bytes, offset);
    offset += tagLen;
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;

    if (wireType === 2) {
      const { value: len, bytesRead: lenRead } = decodeVarint(bytes, offset);
      offset += lenRead;
      const sub = bytes.subarray(offset, offset + len);
      offset += len;

      if (fieldNum === 10) {
        tokenId = new TextDecoder("utf-8").decode(sub);
      } else if (fieldNum === 20) {
        startSec = decodeTimestamp(sub);
      } else if (fieldNum === 30) {
        endSec = decodeTimestamp(sub);
      }
    } else if (wireType === 0) {
      const { bytesRead } = decodeVarint(bytes, offset);
      offset += bytesRead;
    } else {
      break;
    }
  }

  if (!tokenId) return null;

  return {
    tokenId,
    validityStart: startSec > 0 ? new Date(startSec * 1000).toISOString() : "",
    validityEnd: endSec > 0 ? new Date(endSec * 1000).toISOString() : "",
  };
}

/**
 * Decodes GetRemainingResetsResponse protobuf message: field 10 (repeated ConsumerResetToken).
 */
export function decodeGetRemainingResetsResponse(payload: Uint8Array): GrokResetCoupon[] {
  const tokens: GrokResetCoupon[] = [];
  let offset = 0;

  while (offset < payload.length) {
    const { value: tag, bytesRead: tagLen } = decodeVarint(payload, offset);
    offset += tagLen;
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;

    if (wireType === 2) {
      const { value: len, bytesRead: lenRead } = decodeVarint(payload, offset);
      offset += lenRead;
      const sub = payload.subarray(offset, offset + len);
      offset += len;

      if (fieldNum === 10) {
        const token = decodeConsumerResetToken(sub);
        if (token) tokens.push(token);
      }
    } else if (wireType === 0) {
      const { bytesRead } = decodeVarint(payload, offset);
      offset += bytesRead;
    } else {
      break;
    }
  }

  return tokens;
}

function buildGrokHeaders(accessToken: string): Record<string, string> {
  return {
    "Content-Type": "application/grpc-web+proto",
    "X-Grpc-Web": "1",
    "Accept": "application/grpc-web+proto",
    "Authorization": `Bearer ${accessToken}`,
    [XAI_GROK_COMPATIBILITY.headers.tokenAuth]: "xai-grok-cli",
  };
}

/**
 * Reads available Grok reset tokens for the authenticated xAI account.
 */
export async function getGrokRemainingResets(options: GetRemainingResetsOptions): Promise<{ tokens: GrokResetCoupon[] }> {
  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  const endpoint = options.endpoint ?? GROK_GET_REMAINING_RESETS_ENDPOINT;
  // BodyInit requires a plain ArrayBuffer backing store; the encoder's generic
  // Uint8Array<ArrayBufferLike> is not assignable under TS 5.7 lib.dom types.
  const emptyBody = encodeGrpcWebEnvelope(new Uint8Array(0)) as Uint8Array<ArrayBuffer>;

  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: buildGrokHeaders(options.accessToken),
    body: emptyBody,
    signal: options.signal,
  });

  if (!res.ok) {
    throw new Error(`GetRemainingResets HTTP error ${res.status}: ${res.statusText}`);
  }

  const rawBytes = new Uint8Array(await res.arrayBuffer());
  const decoded = decodeGrpcWebResponse(rawBytes);

  if (decoded.status !== 0) {
    throw new GrpcWebError(decoded.status, decoded.statusMessage ?? "Unknown gRPC error");
  }

  if (decoded.messages.length === 0) {
    return { tokens: [] };
  }

  return { tokens: decodeGetRemainingResetsResponse(decoded.messages[0]) };
}

/**
 * Redeems a specific Grok reset token by tokenId.
 */
export async function redeemGrokResetCoupon(options: RedeemResetOptions): Promise<RedeemResetResult> {
  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  const endpoint = options.endpoint ?? GROK_REDEEM_RESET_ENDPOINT;
  const protoMessage = encodeRedeemResetRequest(options.tokenId);
  const envelope = encodeGrpcWebEnvelope(protoMessage) as Uint8Array<ArrayBuffer>;

  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: buildGrokHeaders(options.accessToken),
    body: envelope,
    signal: options.signal,
  });

  if (!res.ok) {
    throw new Error(`RedeemReset HTTP error ${res.status}: ${res.statusText}`);
  }

  const rawBytes = new Uint8Array(await res.arrayBuffer());
  const decoded = decodeGrpcWebResponse(rawBytes);

  if (decoded.status !== 0) {
    throw new GrpcWebError(decoded.status, decoded.statusMessage ?? "Unknown gRPC error");
  }

  return {
    success: true,
    status: decoded.status,
    statusMessage: decoded.statusMessage,
  };
}
