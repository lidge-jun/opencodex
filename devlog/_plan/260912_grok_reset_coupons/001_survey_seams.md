# Grok Reset Coupons Seam Survey

This document records the architectural survey, upstream API evidence, codebase seams, and system constraints for supporting Grok reset coupons (read and redeem) within OpenCodex.

## 1. Upstream API Evidence

### Endpoints
- **Endpoint A (Read Remaining Resets):** `POST https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets`
  - Request message: Empty protobuf payload (`0` bytes in data frame).
  - Response message: Repeated reset token descriptors.
  - Verification method: Live probe this session via gRPC-Web client against `grok.com`.
- **Endpoint B (Redeem Reset):** `POST https://grok.com/prod_mc_billing.ConsumerUiSvc/RedeemReset`
  - Request protobuf schema: Field 1 (tag 1, wire type 2 = length-delimited string): `token_id`.
  - Verification method: Live probe this session with a synthetic token identifier. Returned HTTP 200 with gRPC trailer `grpc-status: 3` and message `redeem_reset(), Invalid token_id`. Intentionally probing non-existent method names returned `grpc-status: 12` (UNIMPLEMENTED), verifying the method path and service definition.

### Transport & Framing
- **Protocol:** gRPC-Web over HTTP/2 or HTTP/1.1 with binary protobuf serialization.
- **Headers:**
  - `Content-Type: application/grpc-web+proto`
  - `X-Grpc-Web: 1`
  - `Accept: application/grpc-web+proto`
- **Wire Envelope (5-byte header prefix per frame):**
  - Byte 0 (`flag`): `0x00` for data frames, `0x80` for trailers.
  - Bytes 1-4 (`length`): 32-bit unsigned big-endian integer denoting frame payload byte count.
- **Response Structure:**
  - One or more data frames (`flag: 0x00`) carrying serialized protobuf response bytes.
  - Exactly one trailer frame (`flag: 0x80`) containing ASCII header/trailer lines (e.g., `grpc-status:0\r\ngrpc-message:\r\n`).
- **Edge Behavior:**
  - Plain `application/json` POST requests to the RPC endpoint return HTTP 200 with an empty `application/grpc` body. The upstream endpoint strictly requires valid gRPC-Web 5-byte framing and protobuf wire format.
  - Verification method: Live probe this session comparing JSON request vs framed binary request.

### Authentication Headers
- **Verified Header Tuple:**
  - `Authorization: Bearer <xai OIDC access token>`
  - `X-XAI-Token-Auth: xai-grok-cli`
- **Cookie Requirement:** None. No session cookies or browser credentials are required when the bearer token and token-auth header are present.
- **Verification method:** Live probe this session using refreshed xAI OAuth tokens without cookie headers.

### Response Protobuf Field Mapping
Hand-decoded from live payload bytes returned by `GetRemainingResets`:
- **Top-Level Message (`GetRemainingResetsResponse`):**
  - Field 10 (wire type 2, length-delimited): repeated `ConsumerResetToken`
- **Nested Message (`ConsumerResetToken`):**
  - Field 10 (wire type 2, length-delimited string): `tokenId`
  - Field 20 (wire type 2, length-delimited submessage): `validityStart` (`google.protobuf.Timestamp`)
    - Subfield 1 (wire type 0, varint): `seconds` (Unix epoch seconds)
  - Field 30 (wire type 2, length-delimited submessage): `validityEnd` (`google.protobuf.Timestamp`)
    - Subfield 1 (wire type 0, varint): `seconds` (Unix epoch seconds)
- **Observed Live Sample:** Active test account returned 1 token with a 31-day validity span between `validityStart` and `validityEnd`.
- **Verification method:** Live probe this session followed by binary protobuf wire decoding of returned bytes.

---

## 2. Repo Seam Survey

### OAuth Refresh Chain & Account Storage
- `src/oauth/xai.ts:369` (`refreshXaiToken(refreshToken, signal)`): Refreshes xAI OIDC OAuth tokens against the authorization server with request abort signaling.
- `src/oauth/index.ts:248-251` (`xai` OAuth provider entry in provider registry): Binds `refresh: refreshXaiToken` into the central OAuth registry map.
- `src/oauth/index.ts:613` (`getValidAccessSnapshotForAccount(provider, accountId, opts)`): Resolves an active token snapshot, automatically performing refresh with store file locking when expired or expiring.
- `src/oauth/store.ts:864` (`listAccounts(provider)`): Enumerates stored accounts for provider `xai`, supporting account discovery and status checks.
- `src/oauth/store.ts:890` (`getAccountCredentialWithStatus`): Retrieves the credential record and token status for a specific account without breaking isolation.
- `src/oauth/store.ts:923` (`captureOAuthAccountSelection("xai")`): Records the chosen account selection state for persistent CLI and server context.

### Header Constants & Transport Defaults
- `src/providers/xai-transport.ts:28-56` (`XAI_GROK_COMPATIBILITY`): Defines xAI and Grok compatibility header constants, specifically `tokenAuth` header key `x-xai-token-auth` and value `xai-grok-cli`.

### Grok Domain Logic
- `src/grok/*.ts`: Core domain modules containing Grok-specific client definitions, error mapping, and billing/quota abstractions.

### Test Layout Registration
- `tests/providers/xai/grok-*.test.ts`: Unit and integration test suites for Grok-specific functionality.
- `scripts/test-layout/layout.json:694-704`: Explicit layout mapping registering Grok test files to their runner tiers.
- `tests/fixtures/test-layout-expected.json`: Snapshot expectation fixture for repository test layout verification that must match `layout.json`.

### Management Route Table & Lazy Dispatch
- `src/server/management/route-registry.ts:94`: Codex reset-credits GET endpoint registration (`/api/codex-auth/reset-credits`).
- `src/server/management/route-registry.ts:102`: Codex reset-credits consume POST endpoint registration (`/api/codex-auth/reset-credits/consume`).
- `src/server/management/route-registry.ts:127-140`: Existing `/api/grok` management route definitions.
- `src/server/management-api.ts:140-144` (`handleQuotaResetRoutesOnDemand`): Lazy dynamic import pattern — namespace guard at 141, dynamic `import()` at 142, dispatch-chain entry at 243 — loading quota/reset route handlers only when matching endpoints are invoked.
- `src/server/management-api.ts:383`: The `/api/codex-auth/` prefix dispatch.

### Codex Reset-Credit Mirror Pattern
- `src/codex/reset-credit-operation-ledger.ts:1191` (`openManualResetCreditOperation` definition): Journaled reset credit operation handler with atomicity, recovery records, and read/consume execution. `src/codex/auth-api.ts:2605-2647` is the consume-route call site.
- `src/codex/reset-credit-recovery.ts:40` (`isCodexResetCreditOperationId`): Operation ID syntax and format validation guard.
- `src/cli/account-auth.ts:275-302` (`resetCredits()`): CLI execution handler enforcing that `--consume` mandates explicit `--yes` confirmation and validates `--operation-id` via the recovery guard.
- `src/cli/account.ts:62,358-360`: Account command parser registering the reset-credits subcommand and argument options.
- `src/cli/registry.ts:224,236`: CLI router and dispatcher table wiring the reset-credits handler.

---

## 3. Constraints & Risks

- **Lab Boundary Invariant:** Core router and server lifecycle modules (`src/router.ts`, `src/server/lifecycle.ts`, and `src/server/responses/core.ts`) must never import from `src/lab`. Any new reset coupon abstraction must remain in production domain modules (`src/grok/`, `src/oauth/`, `src/server/management/`) without leaking experimental lab dependencies.
- **Privacy & Token Leak Prevention:** Authorization tokens, refresh tokens, and raw Bearer headers must never be written to logs, serialized to persistent console output, or returned in unmasked debug messages.
- **Bun-Native Runtime Invariants:** The codebase runs on the Bun runtime. Implementations must use standard Web APIs (`fetch`, `Uint8Array`, `DataView`, `ReadableStream`) or Bun-native primitives; Node-only modules (such as `http2`, `tls`, `stream/promises` specifics) must not be introduced.
- **Branch and Contribution Policy:** All changes and pull requests must target the `dev` branch.
- **Transport Strictness:** Upstream `grok.com` rejects non-framed JSON payloads with empty responses. The gRPC-Web encoder/decoder must handle 5-byte frame prefixes, varint parsing, and trailer parsing robustly without external heavy runtime dependencies.
