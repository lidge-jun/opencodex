# 010 Phase 1 Core Client: Grok Reset Coupons

This document specifies the exact diff-level implementation PRD for Phase 1 of Grok Reset Coupons support in OpenCodex.

---

## 1. Architectural Context and Decisions

### 1.1 Upstream Verification Facts
- **Endpoint A (Read):** `POST https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets` with empty protobuf message payload (`0` bytes in gRPC-Web data frame).
- **Endpoint B (Redeem):** `POST https://grok.com/prod_mc_billing.ConsumerUiSvc/RedeemReset` with protobuf message field 1 = `token_id` (wire type 2, length-delimited string). Probing with a synthetic token identifier returns HTTP 200 with trailer `grpc-status: 3` and trailer message `redeem_reset(), Invalid token_id`. Probing invalid method names returns `grpc-status: 12` (UNIMPLEMENTED).
- **Transport Framing:** gRPC-Web binary framing. Request headers:
  - `Content-Type: application/grpc-web+proto`
  - `X-Grpc-Web: 1`
  - 5-byte envelope prefix per frame: `flag` (1 byte, `0x00` = data, `0x80` = trailer) + `length` (4 bytes, unsigned big-endian 32-bit integer).
  - Plain `application/json` POST requests return HTTP 200 with an empty `application/grpc` body. Binary gRPC-Web framing is strictly mandatory.
- **Authentication Headers:**
  - `Authorization: Bearer <xai OIDC access token>`
  - `X-XAI-Token-Auth: xai-grok-cli` (key at `src/providers/xai-transport.ts:34`, value at `src/providers/xai-transport.ts:54`, from `XAI_GROK_COMPATIBILITY.headers.tokenAuth`).
  - No browser cookies or session cookies required.
- **Protobuf Wire Schema:**
  - `GetRemainingResetsResponse`:
    - Field 10 (wire type 2): repeated `ConsumerResetToken`.
    - Nested `ConsumerResetToken`:
      - Field 10 (wire type 2): `tokenId` (string).
      - Field 20 (wire type 2): `validityStart` (`Timestamp` submessage with field 1 varint `seconds`).
      - Field 30 (wire type 2): `validityEnd` (`Timestamp` submessage with field 1 varint `seconds`).
  - `RedeemResetRequest`:
    - Field 1 (wire type 2): `tokenId` (string).
  - `RedeemResetResponse`:
    - Empty message or success descriptor framed by gRPC status code `0` in trailers.

### 1.2 Architect Decisions
- **D1:** Core client modules reside in `src/grok/grpc-web.ts`, `src/grok/reset-coupons.ts`, and `src/grok/reset-coupon-ledger.ts`.
- **D2:** Zero external dependencies for protobuf or gRPC-Web. Minimal self-contained varint / length-delimited codec and 5-byte framing parser using standard Web API typed arrays (`Uint8Array`, `DataView`).
- **D3:** Management routes (`GET /api/grok/reset-coupons` and `POST /api/grok/reset-coupons/consume`) wire via lazy route dispatch mirroring Codex reset-credit patterns.
- **D4:** CLI subcommand `grok-reset-coupons` in `src/cli/account-auth.ts` requires `--yes` confirmation when `--consume` is passed, validating operation IDs.
- **D5:** Test suites in `tests/providers/xai/grok-reset-coupons.test.ts`, explicitly mapped to `providers/xai` tier in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.

---

## 2. Repo Seams & Anchor Points

1. `src/oauth/xai.ts:369`: `refreshXaiToken(refreshToken, signal)` — token refresher for expired xAI access tokens.
2. `src/oauth/index.ts:248-251`: Central provider registry entry binding `xai` token refresh callback.
3. `src/oauth/index.ts:613`: `getValidAccessSnapshotForAccount(provider, accountId, opts)` — returns fresh access token, auto-refreshing under lock when expired.
4. `src/oauth/store.ts:864`: `listAccounts(provider)` — lists stored accounts for provider `xai`.
5. `src/oauth/store.ts:890`: `getAccountCredentialWithStatus` — retrieves account credential and validity status.
6. `src/oauth/store.ts:923`: `captureOAuthAccountSelection("xai")` — active account selection context.
7. `src/providers/xai-transport.ts:28-56`: `XAI_GROK_COMPATIBILITY` header definitions (`tokenAuth: "x-xai-token-auth"`, value `"xai-grok-cli"`).
8. `src/grok/*.ts`: Grok domain modules (`catalog.ts`, `effort.ts`, `inject.ts`, `status.ts`, `sync.ts`).
9. `scripts/test-layout/layout.json:694-704`: Test layout map registering `grok-*.test.ts` suites under `providers/xai`.
10. `tests/fixtures/test-layout-expected.json:528-538`: Snapshot fixture for test layout verification.
11. `src/server/management/route-registry.ts:94,102,127-140`: Route table definitions for reset credits and Grok APIs.
12. `src/server/management-api.ts:140-144`: Lazy dispatch pattern `handleQuotaResetRoutesOnDemand` (namespace guard at 141, dynamic `import()` at 142, dispatch-chain entry at 243); `:383` is the `/api/codex-auth/` prefix dispatch.
13. `openManualResetCreditOperation` is defined at `src/codex/reset-credit-operation-ledger.ts:1191`; `src/codex/auth-api.ts:2605-2647` is the consume-route call site for the journaled read and consume handlers.
14. `src/codex/reset-credit-auto-redeem.ts:71-105`: Crash-safe disk journal pattern using `atomicWriteFile`.
15. `src/codex/reset-credit-recovery.ts:40`: UUID operation ID validation regex and type guard.
16. `src/cli/account-auth.ts:275-302`: CLI reset-credits command execution pattern.
17. `src/cli/account.ts:62,358-360`: Account command line options parser.
18. `src/cli/registry.ts:224,236`: CLI route registry.

---

## 3. Protobuf Wire Encoding and Decoding Specification

### 3.1 Field Table

| Message | Field Number | Field Name | Wire Type | Wire Type ID | Representation |
|:---|:---:|:---|:---|:---:|:---|
| `RedeemResetRequest` | 1 | `tokenId` | Length-delimited | 2 | UTF-8 encoded string |
| `GetRemainingResetsResponse` | 10 | `tokens` | Length-delimited | 2 | Repeated `ConsumerResetToken` submessage |
| `ConsumerResetToken` | 10 | `tokenId` | Length-delimited | 2 | UTF-8 encoded string |
| `ConsumerResetToken` | 20 | `validityStart` | Length-delimited | 2 | `google.protobuf.Timestamp` submessage |
| `ConsumerResetToken` | 30 | `validityEnd` | Length-delimited | 2 | `google.protobuf.Timestamp` submessage |
| `Timestamp` | 1 | `seconds` | Varint | 0 | 64-bit varint (Unix epoch seconds) |
| `Timestamp` | 2 | `nanos` | Varint | 0 | 32-bit varint (fractional nanoseconds, optional) |

### 3.2 Wire Tag Calculation
Tag = `(field_number << 3) | wire_type`:
- `RedeemResetRequest.tokenId` (Field 1, Wire Type 2): `(1 << 3) | 2 = 10` (`0x0a`).
- `GetRemainingResetsResponse.tokens` (Field 10, Wire Type 2): `(10 << 3) | 2 = 82` (`0x52`).
- `ConsumerResetToken.tokenId` (Field 10, Wire Type 2): `(10 << 3) | 2 = 82` (`0x52`).
- `ConsumerResetToken.validityStart` (Field 20, Wire Type 2): `(20 << 3) | 2 = 162` (`0xa2, 0x01`).
- `ConsumerResetToken.validityEnd` (Field 30, Wire Type 2): `(30 << 3) | 2 = 242` (`0xf2, 0x01`).
- `Timestamp.seconds` (Field 1, Wire Type 0): `(1 << 3) | 0 = 8` (`0x08`).

---

## 4. File-by-File Implementation Plan

### 4.1 File 1: `src/grok/grpc-web.ts` (NEW)

#### Exact Exported Signatures
```typescript
export interface GrpcWebTrailer {
  status: number;
  statusMessage?: string;
  metadata: Record<string, string>;
}

export interface DecodedGrpcWebResponse {
  messages: Uint8Array[];
  status: number;
  statusMessage?: string;
  trailers?: GrpcWebTrailer;
}

export class GrpcWebError extends Error {
  readonly status: number;
  readonly statusMessage: string;
  constructor(status: number, statusMessage: string);
}

export function encodeGrpcWebEnvelope(message: Uint8Array): Uint8Array;
export function decodeGrpcWebResponse(bytes: Uint8Array): DecodedGrpcWebResponse;
export function parseGrpcWebTrailers(bytes: Uint8Array): GrpcWebTrailer;
```

#### Before / After Code
**Before:** File does not exist.

**After:**
```typescript
/**
 * Minimal, zero-dependency gRPC-Web binary framing encoder and decoder.
 * Supports 5-byte header prefix: 0x00 data frames, 0x80 trailer frames.
 */

export interface GrpcWebTrailer {
  status: number;
  statusMessage?: string;
  metadata: Record<string, string>;
}

export interface DecodedGrpcWebResponse {
  messages: Uint8Array[];
  status: number;
  statusMessage?: string;
  trailers?: GrpcWebTrailer;
}

export class GrpcWebError extends Error {
  readonly status: number;
  readonly statusMessage: string;

  constructor(status: number, statusMessage: string) {
    super(`gRPC-Web call failed with status ${status}: ${statusMessage}`);
    this.name = "GrpcWebError";
    this.status = status;
    this.statusMessage = statusMessage;
  }
}

const FRAME_DATA = 0x00;
const FRAME_TRAILER = 0x80;
const HEADER_SIZE = 5;

/**
 * Encodes a protobuf payload into a single gRPC-Web binary data frame (flag 0x00).
 */
export function encodeGrpcWebEnvelope(message: Uint8Array): Uint8Array {
  const envelope = new Uint8Array(HEADER_SIZE + message.length);
  envelope[0] = FRAME_DATA;
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  view.setUint32(1, message.length, false); // Big-endian u32
  envelope.set(message, HEADER_SIZE);
  return envelope;
}

/**
 * Parses ASCII key-value lines from a gRPC-Web trailer frame payload.
 */
export function parseGrpcWebTrailers(bytes: Uint8Array): GrpcWebTrailer {
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = text.split(/\r?\n/);
  const metadata: Record<string, string> = {};
  let status = 0;
  let statusMessage: string | undefined;

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    metadata[key] = value;
    if (key === "grpc-status") {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        status = parsed;
      }
    } else if (key === "grpc-message") {
      try {
        statusMessage = decodeURIComponent(value);
      } catch {
        statusMessage = value;
      }
    }
  }

  return { status, statusMessage, metadata };
}

/**
 * Decodes a contiguous gRPC-Web binary stream into data messages and trailing metadata.
 */
export function decodeGrpcWebResponse(bytes: Uint8Array): DecodedGrpcWebResponse {
  const messages: Uint8Array[] = [];
  let offset = 0;
  let trailer: GrpcWebTrailer | undefined;

  while (offset + HEADER_SIZE <= bytes.length) {
    const flag = bytes[offset];
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, HEADER_SIZE);
    const length = view.getUint32(1, false);
    const frameStart = offset + HEADER_SIZE;
    const frameEnd = frameStart + length;

    if (frameEnd > bytes.length) {
      throw new Error(`Incomplete gRPC-Web frame at offset ${offset}: expected ${length} bytes, got ${bytes.length - frameStart}`);
    }

    const payload = bytes.subarray(frameStart, frameEnd);

    if (flag === FRAME_DATA) {
      messages.push(payload);
    } else if (flag === FRAME_TRAILER) {
      trailer = parseGrpcWebTrailers(payload);
    }

    offset = frameEnd;
  }

  const finalStatus = trailer ? trailer.status : 0;
  const finalMessage = trailer?.statusMessage;

  return {
    messages,
    status: finalStatus,
    statusMessage: finalMessage,
    trailers: trailer,
  };
}
```

#### Acceptance Criteria & Verifier
- **Acceptance Criteria:**
  1. `encodeGrpcWebEnvelope(bytes)` writes `0x00` at index 0, length in big-endian u32 at indices 1-4, and copies input payload starting at index 5.
  2. `decodeGrpcWebResponse(bytes)` parses multiple 0x00 frames and extracts 0x80 trailer frame with parsed `grpc-status` and `grpc-message`.
  3. Throws descriptive error on truncated payload frames.
- **Verifier Command:**
  ```bash
  bun test tests/providers/xai/grok-reset-coupons.test.ts
  ```

---

### 4.2 File 2: `src/grok/reset-coupons.ts` (NEW)

#### Exact Exported Signatures
```typescript
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

export function encodeVarint(value: number | bigint): Uint8Array;
export function decodeVarint(bytes: Uint8Array, offset: number): { value: number; bytesRead: number };
export function encodeRedeemResetRequest(tokenId: string): Uint8Array;
export function decodeGetRemainingResetsResponse(payload: Uint8Array): GrokResetCoupon[];
export function getGrokRemainingResets(options: GetRemainingResetsOptions): Promise<{ tokens: GrokResetCoupon[] }>;
export function redeemGrokResetCoupon(options: RedeemResetOptions): Promise<RedeemResetResult>;
```

#### Before / After Code
**Before:** File does not exist.

**After:**
```typescript
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
  const emptyBody = encodeGrpcWebEnvelope(new Uint8Array(0));

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
  const envelope = encodeGrpcWebEnvelope(protoMessage);

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
```

#### Acceptance Criteria & Verifier
- **Acceptance Criteria:**
  1. `getGrokRemainingResets` issues POST with `Content-Type: application/grpc-web+proto`, `X-Grpc-Web: 1`, `Authorization: Bearer <token>`, and `x-xai-token-auth: xai-grok-cli`.
  2. Protobuf decoder correctly parses field 10 repeated `GrokResetCoupon` tokens with `tokenId` and ISO-string `validityStart`/`validityEnd` (epoch seconds are kept internally as `validityStartSeconds`/`validityEndSeconds` only during decode).
  3. `redeemGrokResetCoupon` encodes field 1 string `token_id` in a 5-byte envelope and surfaces `GrpcWebError` on non-zero gRPC statuses (e.g. status 3 invalid token).
- **Verifier Command:**
  ```bash
  bun test tests/providers/xai/grok-reset-coupons.test.ts
  ```

---

### 4.3 File 3: `src/grok/reset-coupon-ledger.ts` (NEW)

#### Exact Exported Signatures
```typescript
export type GrokResetCouponOperationKind = "execute" | "replay" | "identity-mismatch" | "capacity";

export interface GrokResetCouponOperationIdentity {
  accountId: string;
  tokenId?: string;
  operationId: string;
}

export interface GrokResetCouponOperationRecord {
  kind: GrokResetCouponOperationKind;
  operationId: string;
  accountId?: string;
  tokenId?: string;
  code?: string;
  settledAt?: number;
}

export function grokCouponJournalPath(customDir?: string): string;
export function openGrokResetCouponOperation(identity: GrokResetCouponOperationIdentity, now?: number, journalPath?: string): GrokResetCouponOperationRecord;
export function recordGrokResetCouponSettlement(settlement: { operationId: string; tokenId?: string; code: string; status: "success" | "failed" }, now?: number, journalPath?: string): void;
```

#### Before / After Code
**Before:** File does not exist.

**After:**
```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";

export type GrokResetCouponOperationKind = "execute" | "replay" | "identity-mismatch" | "capacity";

export interface GrokResetCouponOperationIdentity {
  accountId: string;
  tokenId?: string;
  operationId: string;
}

export interface GrokResetCouponOperationRecord {
  kind: GrokResetCouponOperationKind;
  operationId: string;
  accountId?: string;
  tokenId?: string;
  code?: string;
  settledAt?: number;
}

interface GrokResetCouponOperationState {
  accountId: string;
  tokenId?: string;
  status: "open" | "settled" | "failed";
  code?: string;
  createdAt: number;
  updatedAt: number;
}

interface GrokResetCouponLedger {
  version: 1;
  operations: Record<string, GrokResetCouponOperationState>;
}

export function grokCouponJournalPath(customDir?: string): string {
  const dir = customDir ?? getConfigDir();
  return join(dir, "grok-reset-coupon-ledger.json");
}

function readGrokCouponLedger(filePath: string): GrokResetCouponLedger {
  if (!existsSync(filePath)) {
    return { version: 1, operations: {} };
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as GrokResetCouponLedger;
    return parsed && parsed.version === 1 && parsed.operations && typeof parsed.operations === "object"
      ? parsed
      : { version: 1, operations: {} };
  } catch {
    return { version: 1, operations: {} };
  }
}

function writeGrokCouponLedger(filePath: string, ledger: GrokResetCouponLedger, now = Date.now()): void {
  // Prune settled/failed operations older than 30 days to avoid unbounded growth
  const retentionCutoff = now - 30 * 24 * 60 * 60_000;
  ledger.operations = Object.fromEntries(
    Object.entries(ledger.operations).filter(
      ([, op]) => op.status === "open" || op.updatedAt > retentionCutoff,
    ),
  );
  atomicWriteFile(filePath, JSON.stringify(ledger, null, 2));
}

const MAX_GROK_RESET_COUPON_OPERATION_IDS = 256;

export function openGrokResetCouponOperation(
  identity: GrokResetCouponOperationIdentity,
  now = Date.now(),
  journalPath?: string,
): GrokResetCouponOperationRecord {
  const filePath = journalPath ?? grokCouponJournalPath();
  const ledger = readGrokCouponLedger(filePath);

  if (Object.keys(ledger.operations).length >= MAX_GROK_RESET_COUPON_OPERATION_IDS) {
    return { kind: "capacity", operationId: identity.operationId };
  }

  const existing = ledger.operations[identity.operationId];
  if (existing) {
    if (existing.accountId !== identity.accountId) {
      return { kind: "identity-mismatch", operationId: identity.operationId };
    }
    if (existing.status !== "open") {
      // Durably settled already: replay the recorded outcome instead of
      // trusting upstream idempotency for an irreversible spend.
      return {
        kind: "replay",
        operationId: identity.operationId,
        accountId: existing.accountId,
        tokenId: existing.tokenId,
        code: existing.code,
        settledAt: existing.updatedAt,
      };
    }
    return {
      kind: "execute",
      operationId: identity.operationId,
      accountId: existing.accountId,
      tokenId: existing.tokenId,
    };
  }

  ledger.operations[identity.operationId] = {
    accountId: identity.accountId,
    ...(identity.tokenId === undefined ? {} : { tokenId: identity.tokenId }),
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  writeGrokCouponLedger(filePath, ledger, now);
  return {
    kind: "execute",
    operationId: identity.operationId,
    accountId: identity.accountId,
    tokenId: identity.tokenId,
  };
}

export function recordGrokResetCouponSettlement(
  settlement: { operationId: string; tokenId?: string; code: string; status: "success" | "failed" },
  now = Date.now(),
  journalPath?: string,
): void {
  const filePath = journalPath ?? grokCouponJournalPath();
  const ledger = readGrokCouponLedger(filePath);
  const existing = ledger.operations[settlement.operationId];
  if (!existing) return;

  existing.status = settlement.status === "success" ? "settled" : "failed";
  existing.code = settlement.code;
  if (settlement.tokenId !== undefined) existing.tokenId = settlement.tokenId;
  existing.updatedAt = now;

  writeGrokCouponLedger(filePath, ledger, now);
}

```

#### Acceptance Criteria & Verifier
- **Acceptance Criteria:**
  1. Ledger uses `atomicWriteFile` ensuring durability without partial-write corruption.
  2. `openGrokResetCouponOperation` returns `"execute"` for a new or still-open operation, `"replay"` with the recorded outcome for an already-settled operation, `"identity-mismatch"` when the `operationId` belongs to another account, and `"capacity"` when the ledger is full — the Codex-mirror result kinds of `openManualResetCreditOperation` (`src/codex/reset-credit-operation-ledger.ts:1191-1207`; call-site pattern at `src/codex/auth-api.ts:2616-2641`).
  3. `recordGrokResetCouponSettlement` durably records the final outcome so later opens replay it.
- **Verifier Command:**
  ```bash
  bun test tests/providers/xai/grok-reset-coupons.test.ts
  ```

---

### 4.4 File 4: `scripts/test-layout/layout.json` (MODIFY)

#### Exact Changes
Add `"grok-reset-coupons.test.ts": "providers/xai"` into the JSON map under the `providers/xai` section.

#### Before / After Code
**Before (lines 694-706):**
```json
    "grok-attribution.test.ts": "providers/xai",
    "grok-config-inject.test.ts": "providers/xai",
    "grok-effort-inject.test.ts": "providers/xai",
    "grok-lifecycle.test.ts": "providers/xai",
    "grok-management-api.test.ts": "providers/xai",
    "grok-models-effort-list.test.ts": "providers/xai",
    "grok-orphan-adoption.test.ts": "providers/xai",
    "grok-selection.test.ts": "providers/xai",
    "grok-status.test.ts": "providers/xai",
    "grok-sync.test.ts": "providers/xai",
    "grok-writer-boundary.test.ts": "providers/xai",
    "gui-api-error.test.ts": "gui",
```

**After:**
```json
    "grok-attribution.test.ts": "providers/xai",
    "grok-config-inject.test.ts": "providers/xai",
    "grok-effort-inject.test.ts": "providers/xai",
    "grok-lifecycle.test.ts": "providers/xai",
    "grok-management-api.test.ts": "providers/xai",
    "grok-models-effort-list.test.ts": "providers/xai",
    "grok-orphan-adoption.test.ts": "providers/xai",
    "grok-reset-coupons.test.ts": "providers/xai",
    "grok-selection.test.ts": "providers/xai",
    "grok-status.test.ts": "providers/xai",
    "grok-sync.test.ts": "providers/xai",
    "grok-writer-boundary.test.ts": "providers/xai",
    "gui-api-error.test.ts": "gui",
```

#### Acceptance Criteria & Verifier
- **Acceptance Criteria:** `layout.json` parses as valid JSON with alphabetical key ordering preserved.
- **Verifier Command:**
  ```bash
  bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts
  ```

---

### 4.5 File 5: `tests/fixtures/test-layout-expected.json` (MODIFY)

#### Exact Changes
Add `"grok-reset-coupons.test.ts": "providers/xai"` into the snapshot expectation fixture to keep it synchronized with `layout.json`.

#### Before / After Code
**Before (lines 534-540):**
```json
  "grok-orphan-adoption.test.ts": "providers/xai",
  "grok-selection.test.ts": "providers/xai",
  "grok-status.test.ts": "providers/xai",
  "grok-sync.test.ts": "providers/xai",
  "grok-writer-boundary.test.ts": "providers/xai",
  "gui-api-error.test.ts": "gui",
```

**After:**
```json
  "grok-orphan-adoption.test.ts": "providers/xai",
  "grok-reset-coupons.test.ts": "providers/xai",
  "grok-selection.test.ts": "providers/xai",
  "grok-status.test.ts": "providers/xai",
  "grok-sync.test.ts": "providers/xai",
  "grok-writer-boundary.test.ts": "providers/xai",
  "gui-api-error.test.ts": "gui",
```

#### Acceptance Criteria & Verifier
- **Acceptance Criteria:** Test layout verification passes cleanly with zero layout mismatch.
- **Verifier Command:**
  ```bash
  bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts
  ```

---

### 4.6 File 6: `tests/providers/xai/grok-reset-coupons.test.ts` (NEW)

#### Exact Test List
1. **gRPC-Web framing round-trip:** Encodes data payload and decodes response with trailers, verifying flag bytes `0x00` and `0x80`, u32 length prefix, and parsed status.
2. **Decode captured live-shape fixture:** Decodes response bytes mimicking live `GetRemainingResets` response (field 10 tokens, field 10 tokenId, field 20/30 timestamps) and asserts exact parsed `GrokResetCoupon` ISO strings.
3. **Auth header assertions:** Intercepts outgoing HTTP request and verifies presence of `Authorization: Bearer <token>` and `X-XAI-Token-Auth: xai-grok-cli` without cookies.
4. **gRPC-status error surfacing:** Asserts that upstream trailer `grpc-status: 3` and message `redeem_reset(), Invalid token_id` throws `GrpcWebError` with status code 3.
5. **Ledger idempotent replay:** Opens an operation in a temporary test ledger, verifies re-opening a settled operation returns kind `replay`, and records settlement via `recordGrokResetCouponSettlement`.
6. **Refresh-on-401 with stubbed fetch:** Simulates initial 401 response triggering OAuth token refresh and subsequent retry to completion.

#### Before / After Code
**Before:** File does not exist.

**After:**
```typescript
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
```

#### Acceptance Criteria & Verifier
- **Acceptance Criteria:** All 6 test scenarios execute and pass without network connectivity or timeouts.
- **Verifier Command:**
  ```bash
  bun test tests/providers/xai/grok-reset-coupons.test.ts
  ```

---

## 5. Verification Commands Summary

| Action | Target | Command |
|:---|:---|:---|
| Test Unit Suite | `tests/providers/xai/grok-reset-coupons.test.ts` | `bun test tests/providers/xai/grok-reset-coupons.test.ts` |
| Test Layout Check | `scripts/test-layout/layout.json` & fixture | `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` |
| Full Provider Suite | `tests/providers/xai/` | `bun test tests/providers/xai/` |
