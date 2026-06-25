# 140.30 — Phase 3: amazon-bedrock (new adapter + SigV4 + eventstream, HARD)

> One PABCD pass. NEW adapter. **Establishes the shared AWS eventstream decoder + SigV4 signer**
> (reused by Phase 40 kiro). Grounded in jawcode (cites are jawcode paths).

---

## Goal

Stream Bedrock **ConverseStream** (Claude/etc. on AWS) through opencodex — porting SigV4 auth and the
AWS binary **eventstream** decoder, both with **zero `@aws-sdk/*` deps** (jawcode is pure WebCrypto/TS).

## What we port (jawcode)

- **SigV4** (`aws-sigv4.ts:104-218`): `signRequest` → signed headers (host, x-amz-date, x-amz-content-sha256, authorization, ±x-amz-security-token); HMAC signing-key chain (kSecret→kDate→kRegion→kService→kSigning); WebCrypto `sha256Hex`/`hmac`; RFC-3986 canonicalization.
- **Credential chain** (`aws-credentials.ts:50-496`, zero `@aws-sdk`): env keys → `~/.aws/credentials`+`config` INI (SSO) → SSO portal fetch + `~/.aws/sso/cache` → `credential_process` → EC2 IMDSv2. Cache per (profile,region) + 60s skew.
- **EventStream decoder** (`aws-eventstream.ts:43-185`) — **the shared module**: big-endian framing `[total_len u32][headers_len u32][prelude_crc][headers][payload][msg_crc]`; `crc32` (poly 0xEDB88320), `decodeMessage` (CRC-checked), `async* decodeEventStream` (chunk-boundary stitching).
- **ConverseStream builder** (`amazon-bedrock.ts:204-256,570-810`): messages → WireMessage; tool results batched into one user msg (`:662-696`); thinking config `{type:"enabled",budget_tokens,display:"summarized"}`; **thinking-signature edge case** — only `anthropic.claude*` keep `signature`, else demote to `[Thinking]: text` (`:631-651`).
- **Endpoint:** `POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse-stream`, `Accept: application/vnd.amazon.eventstream`.

## opencodex fit

- **NEW** `src/adapters/bedrock.ts` (`createBedrockAdapter`): `buildRequest` (ConverseStream + SigV4-sign) + `parseStream` (eventstream → `AdapterEvent`).
- **NEW shared** `src/lib/aws-auth.ts` (SigV4 + credential chain) and `src/lib/eventstream-decoder.ts` (the decoder — **40 reuses this**).
- **Dispatch:** add `case "bedrock"` in `resolveAdapter` (`server.ts:186`).
- **Config:** `awsRegion?`, `awsProfile?` (no `apiKey` — creds from env/`~/.aws`/SSO/IMDS). Models: ~119 seed.
- **Event bridge:** `contentBlockStart/Delta` text→`text_delta`, toolUse→`tool_call_start`/`tool_call_delta`, `reasoningContent.text`→`thinking_delta`, signature→capture-not-emit, `contentBlockStop`(tool)→`tool_call_end`, `messageStop`→stopReason, `metadata`→usage.

## Sub-steps (this PABCD pass)

1. **A:** port `aws-eventstream.ts` → `src/lib/eventstream-decoder.ts`; unit-test CRC32 (`"123456789"→0xcbf43926`) + frame decode + multi-chunk stitch.
2. **A:** port SigV4 + credential chain → `src/lib/aws-auth.ts`; unit-test signature vs jawcode golden (fixed date).
3. **B:** `createBedrockAdapter` — ConverseStream builder (tool batching, thinking-signature demotion) + the eventstream→AdapterEvent bridge; wire `resolveAdapter`.
4. **C:** mocked Converse stream → AdapterEvent sequence + usage; SigV4 unit; existing adapters green; `tsc`/`bun test`.

## Risks

| Risk | Mitigation |
|------|------------|
| SigV4 mismatch → silent 403 | fixed-date unit test vs jawcode golden hex |
| thinking-signature corruption (multi-turn) | port demote-to-text for non-Anthropic exactly (`:631-651`); test both |
| CRC / chunk-boundary decode error | port CRC table verbatim; test known vectors + stitched frames |
| tool-result ordering | batch consecutive toolResults into one user msg (`:662-696`) |
| credentials unresolved (silent) | test env/profile/SSO/IMDS paths; log credential source in debug |

## Verify (minimal proof)

Converse stream against `us.anthropic.claude-*` + a SigV4 unit test (`02:218`).

## Depends-on / enables

- **Depends-on:** none (can run parallel with Phase 10 — disjoint files).
- **Enables:** `src/lib/eventstream-decoder.ts` reused by **Phase 40 (kiro)** — kiro cannot `parseStream` until this ships.
