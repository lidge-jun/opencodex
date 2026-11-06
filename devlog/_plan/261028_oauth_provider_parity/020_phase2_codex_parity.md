# 020 — Phase 2 (`wp2`): Codex (ChatGPT) OAuth Installation ID Isolation & Official JSON Token Refresh Parity

- **Work-Phase ID**: `wp2`
- **Depends On**: `wp1` (`010_phase1_claude_parity.md`)
- **Shared Types / Interfaces Used**: `OAuthCredentials` (`src/oauth/types.ts`), `CodexAuthContext` (`src/codex/auth-context.ts`), `ApplyAccountChangeConversationStateScrubArgs` (`src/server/responses/account-change-state.ts:231`)
- **Design Decisions Implemented**: `DEC-03`, `DEC-04`, `DEC-08`

## 1. File Change Map

| Action | File Path | Current Lines / Cap | Responsibility & Change Summary |
|---|---|---:|---|
| `MODIFY` | `src/codex/forward-transport-headers.ts` | 25 / 1999 | Add self-verifying idempotent `deriveCodexAccountInstallationId(chatgptAccountId, callerInstallationId)`, `rewriteTurnMetadataInstallationId(rawMetadata, chatgptAccountId)`, `isolateCodexPoolAccountHeaders(headers, chatgptAccountId)`, and `isolateCodexPoolClientMetadata(body, chatgptAccountId)`. |
| `MODIFY` | `src/adapters/openai-responses/transport.ts` | 99 / 1999 | Add `"version"` to `FORWARD_HEADERS`; call `isolateCodexPoolAccountHeaders` (rewriting `x-codex-installation-id` & `x-codex-turn-metadata` and deleting `x-oai-attestation`) when `_codexAccountOverride` is active. |
| `MODIFY` | `src/codex/auth-context.ts` | 1958 / 1999 | Call `isolateCodexPoolAccountHeaders(selected, ...)` in `materializeCodexUpstreamAuth` (lines 1811, 1841) and `materializeCodexUpstreamAuthAsync` (line 1925) whenever a pool or substituted main credential is materialized. |
| `MODIFY` | `src/adapters/openai-responses/passthrough.ts` | 720 / 1999 | When `isCanonicalOpenAiForwardProvider(provider)` and a pooled/substituted account is active (`(provider as { _codexAccountOverride?: { chatgptAccountId: string } })._codexAccountOverride?.chatgptAccountId`), apply `isolateCodexPoolClientMetadata(finalBody, chatgptAccountId)` so `body.client_metadata["x-codex-installation-id"]` and `body.client_metadata["x-codex-turn-metadata"].installation_id` match the isolated header UUID. |
| `MODIFY` | `src/server/responses/account-change-state.ts` | 313 / 1999 | Delete `x-codex-turn-state` from `body.client_metadata` in `scrubUnportableConversationStateInPlace` and from `args.headers` in `applyAccountChangeConversationStateScrub`; ensure `_stripNativeCompactionEncryptedContent` and `_stripReasoningEncryptedContent` still arm when `encryptedReasoning` is the sole unportable carrier. |
| `MODIFY` | `src/server/responses/core-codex-account.ts` | 1203 / 1999 | Pass `headers: retryHeaders` into `applyAccountChangeConversationStateScrub` at line 919 so in-request pool failover strips `x-codex-turn-state` from the retry headers. |
| `MODIFY` | `src/server/responses/request-prepare.ts` | 1660 / 1999 | Pass `headers: selectedForwardHeaders` into `applyAccountChangeConversationStateScrub` at line 1603. |
| `MODIFY` | `src/oauth/chatgpt.ts` | 284 / 1999 | Update `ORIGINATOR = "codex_cli_rs"` (line 118); update `chatGptTokenRequest` (line 30) to support JSON body (`Content-Type: application/json`, `Accept: application/json`) for `refreshChatGPTToken` while preserving `application/x-www-form-urlencoded` (+ `Accept: application/json`) for `exchangeToken`. |
| `MODIFY` | `src/codex/account-store.ts` | 1520 / 1999 | Switch pool token refresh (line 1378) to `Content-Type: application/json` + `Accept: application/json` with `JSON.stringify({ client_id, grant_type: "refresh_token", refresh_token })`, compose a 30s timeout with `signal`, and use `readBoundedResponseBody` (`maxBytes: 64 * 1024`). |
| `MODIFY` | `src/codex/main-account.ts` | 485 / 1999 | Switch `refreshNativeMainGrant` (line 114) to `Content-Type: application/json` + `Accept: application/json` with JSON body, 30s timeout, and bounded 64KB response read. |
| `MODIFY` | `tests/oauth/chatgpt-oauth.test.ts` | 120 / 1999 | Update and add regression tests for JSON `refreshChatGPTToken`, `ORIGINATOR = "codex_cli_rs"`, and per-account `deriveCodexAccountInstallationId` / `isolateCodexPoolAccountHeaders` / `isolateCodexPoolClientMetadata`. |
| `MODIFY` | `tests/oauth/chatgpt-token-expiry.test.ts` | 235 / 1999 | Update refresh body expectation to JSON `{ client_id, grant_type: "refresh_token", refresh_token }` while keeping form-urlencoded for browser code exchange. |
| `MODIFY` | `tests/oauth/chatgpt-token-boundaries.test.ts` | 190 / 1999 | Verify JSON refresh headers (`Content-Type: application/json`, `Accept: application/json`) and bounded response handling. |

## 2. Field and Option Chains (`PLAN-FIELD-CHAIN-01`)

| Field / Option | 1. Creation | 2. Serialization | 3. Deserialization | 4. Consumers |
|---|---|---|---|---|
| `ApplyAccountChangeConversationStateScrubArgs.headers?: Headers` | Created in `src/server/responses/request-prepare.ts:1603` (`headers: selectedForwardHeaders`) and `src/server/responses/core-codex-account.ts:919` (`headers: retryHeaders`). | Mutates outbound `Headers` by deleting `x-codex-turn-state` when `accountChanged` is true (`src/server/responses/account-change-state.ts:258`). | N/A — in-memory `Headers` instance passed to `buildRequest`. | `applyAccountChangeConversationStateScrub` (`src/server/responses/account-change-state.ts:248-277`) and downstream `buildResponsesTransport` (`src/adapters/openai-responses/transport.ts:40`). |
| `chatGptTokenRequest` `body: URLSearchParams \| Record<string, string>` | Created in `ChatGPTOAuthFlow.exchangeToken` (`URLSearchParams`, `src/oauth/chatgpt.ts:245`) and `refreshChatGPTToken` (`{ client_id, grant_type, refresh_token }`, `src/oauth/chatgpt.ts:278`). | Serialized as `body.toString()` with `Content-Type: application/x-www-form-urlencoded` when `body instanceof URLSearchParams`, or `JSON.stringify(body)` with `Content-Type: application/json` otherwise (`src/oauth/chatgpt.ts:45-52`). | Deserialized by `auth.openai.com/oauth/token` and mock servers in `tests/oauth/chatgpt-token-expiry.test.ts` & `tests/oauth/chatgpt-token-boundaries.test.ts`. | `chatGptTokenRequest` (`src/oauth/chatgpt.ts:30-70`). |

## 3. Bypass & Enforcement Records (`PLAN-BYPASS-NAMED-01`)

| Mechanism | Tier | Executing Surface | Known Bypass Path | Residual Risk | Wording Downgraded? | Final Layer |
|---|---|---|---|---|---|---|
| Per-account `x-codex-installation-id` & `x-codex-turn-metadata.installation_id` isolation | E4 (Runtime transport & auth materializer) | `isolateCodexPoolAccountHeaders` & `isolateCodexPoolClientMetadata` (`src/codex/forward-transport-headers.ts`) | Direct caller-owned mode (`authCtx.kind === "main"` with `substituteMainCredential === false`) intentionally forwards the caller's own bearer and installation ID to that single caller's account. | None for pooled accounts: every `pool`, `main-pool`, and `substituteMainCredential` path runs through `materializeCodexUpstreamAuth` and `buildResponsesTransport`. | Yes — described as "per-account installation ID isolation for pooled and substituted ChatGPT credentials". | `src/codex/auth-context.ts` & `src/adapters/openai-responses/transport.ts` |

## 4. Before / After Diffs (`DIFFLEVEL-ROADMAP-01`)

### 4.1 `src/codex/forward-transport-headers.ts`
```diff
+import { createHmac } from "node:crypto";
+
 /** Native request metadata shared by the HTTP adapter and WS preparation. */
 export const CODEX_RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
 export const CODEX_RESPONSES_LITE_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";
 export const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";
+export const CODEX_INSTALLATION_ID_HEADER = "x-codex-installation-id";
+export const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
+export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
+export const CODEX_ATTESTATION_HEADER = "x-oai-attestation";
+
+const INSTALL_BODY_KEY = "opencodex-codex-pool-install-body-v1";
+const INSTALL_TAG_KEY = "opencodex-codex-pool-install-tag-v1";
+const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
+const MAX_TURN_METADATA_BYTES = 32 * 1024;
+
+function accountTagForUuidPrefix(account: string, prefix20Hex: string): string {
+  return createHmac("sha256", INSTALL_TAG_KEY).update(`${account}\0${prefix20Hex.toLowerCase()}`).digest("hex").slice(0, 12);
+}
+
+/**
+ * Deterministic, idempotent RFC 4122 v4 UUID isolated per (chatgptAccountId, callerInstallationId).
+ * Calling it twice with the same chatgptAccountId returns the identical UUID without double-hashing.
+ */
+export function deriveCodexAccountInstallationId(chatgptAccountId: string, callerInstallationId: string): string {
+  const account = chatgptAccountId.trim();
+  const raw = callerInstallationId.trim();
+  if (!account || !raw) return callerInstallationId;
+  if (UUID_V4_RE.test(raw)) {
+    const hex = raw.replace(/-/g, "").toLowerCase();
+    if (hex.slice(20, 32) === accountTagForUuidPrefix(account, hex.slice(0, 20))) {
+      return raw.toLowerCase();
+    }
+  }
+  const h = createHmac("sha256", INSTALL_BODY_KEY).update(`${account}\0${raw}`).digest("hex");
+  const variant = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
+  const prefix20 = `${h.slice(0, 8)}${h.slice(8, 12)}4${h.slice(13, 16)}${variant}${h.slice(17, 20)}`;
+  const node12 = accountTagForUuidPrefix(account, prefix20);
+  return `${prefix20.slice(0, 8)}-${prefix20.slice(8, 12)}-${prefix20.slice(12, 16)}-${prefix20.slice(16, 20)}-${node12}`;
+}
+
+export function rewriteTurnMetadataInstallationId(rawMetadata: string, chatgptAccountId: string): string {
+  if (!chatgptAccountId.trim() || Buffer.byteLength(rawMetadata, "utf8") > MAX_TURN_METADATA_BYTES) return rawMetadata;
+  let parsed: unknown;
+  try { parsed = JSON.parse(rawMetadata); } catch { return rawMetadata; }
+  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return rawMetadata;
+  const record = parsed as Record<string, unknown>;
+  if (typeof record.installation_id !== "string" || !record.installation_id.trim()) return rawMetadata;
+  const nextId = deriveCodexAccountInstallationId(chatgptAccountId, record.installation_id);
+  if (nextId === record.installation_id) return rawMetadata;
+  return JSON.stringify({ ...record, installation_id: nextId });
+}
+
+export function isolateCodexPoolAccountHeaders(headers: Headers, chatgptAccountId: string): void {
+  headers.delete(CODEX_ATTESTATION_HEADER);
+  if (!chatgptAccountId.trim()) return;
+  const installId = headers.get(CODEX_INSTALLATION_ID_HEADER);
+  if (installId && installId.trim()) {
+    headers.set(CODEX_INSTALLATION_ID_HEADER, deriveCodexAccountInstallationId(chatgptAccountId, installId));
+  }
+  const turnMeta = headers.get(CODEX_TURN_METADATA_HEADER);
+  if (turnMeta) {
+    headers.set(CODEX_TURN_METADATA_HEADER, rewriteTurnMetadataInstallationId(turnMeta, chatgptAccountId));
+  }
+}
+
+export function isolateCodexPoolClientMetadata(body: unknown, chatgptAccountId: string | undefined): unknown {
+  if (!chatgptAccountId?.trim() || !body || typeof body !== "object" || Array.isArray(body)) return body;
+  const record = body as Record<string, unknown>;
+  const cm = record.client_metadata;
+  if (!cm || typeof cm !== "object" || Array.isArray(cm)) return body;
+  const meta = cm as Record<string, unknown>;
+  let nextMeta: Record<string, unknown> | undefined;
+  const rawInstallId = meta[CODEX_INSTALLATION_ID_HEADER];
+  if (typeof rawInstallId === "string" && rawInstallId.trim()) {
+    const nextId = deriveCodexAccountInstallationId(chatgptAccountId, rawInstallId);
+    if (nextId !== rawInstallId) nextMeta = { ...meta, [CODEX_INSTALLATION_ID_HEADER]: nextId };
+  }
+  const rawTurnMeta = (nextMeta ?? meta)[CODEX_TURN_METADATA_HEADER];
+  if (typeof rawTurnMeta === "string" && rawTurnMeta.trim()) {
+    const rewritten = rewriteTurnMetadataInstallationId(rawTurnMeta, chatgptAccountId);
+    if (rewritten !== rawTurnMeta) nextMeta = { ...(nextMeta ?? meta), [CODEX_TURN_METADATA_HEADER]: rewritten };
+  }
+  return nextMeta ? { ...record, client_metadata: nextMeta } : body;
+}
```

### 4.2 `src/oauth/chatgpt.ts`, `src/codex/account-store.ts`, `src/codex/main-account.ts`
```diff
--- a/src/oauth/chatgpt.ts
+++ b/src/oauth/chatgpt.ts
@@ -30,7 +30,7 @@
 async function chatGptTokenRequest(
-  body: URLSearchParams,
+  body: URLSearchParams | Record<string, string>,
   label: "ChatGPT refresh" | "ChatGPT token exchange",
   options: { signal?: AbortSignal; timeoutMs?: number },
 ): Promise<OAuthCredentials> {
@@ -41,9 +41,13 @@
   try {
     controller.signal.throwIfAborted();
+    const isForm = body instanceof URLSearchParams;
     const response = await fetch(TOKEN_URL, {
       method: "POST",
-      headers: { "Content-Type": "application/x-www-form-urlencoded" },
-      body: body.toString(),
+      headers: {
+        "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json",
+        Accept: "application/json",
+      },
+      body: isForm ? body.toString() : JSON.stringify(body),
       signal: controller.signal,
     });
@@ -115,1 +119,1 @@
-const ORIGINATOR = "opencodex";
+const ORIGINATOR = "codex_cli_rs";
@@ -274,9 +278,9 @@
 export async function refreshChatGPTToken(
   refreshToken: string,
   options: { signal?: AbortSignal; timeoutMs?: number } = {},
 ): Promise<OAuthCredentials> {
-  return chatGptTokenRequest(new URLSearchParams({
+  return chatGptTokenRequest({
+    client_id: CLIENT_ID,
     grant_type: "refresh_token",
-    client_id: CLIENT_ID,
     refresh_token: refreshToken,
-  }), "ChatGPT refresh", options);
+  }, "ChatGPT refresh", options);
 }
```

## 5. Activation Scenarios (`C-ACTIVATION-GROUNDING-01`) & Verifiers (`PLAN-VERIFIER-REAL-01`)

1. **Conditional Path 1 — Per-account installation ID isolation and idempotency**:
   - *Trigger*: Materialize headers via `materializeCodexUpstreamAuth` for pool account `acct-1` and `acct-2` from a request carrying `x-codex-installation-id: 11111111-1111-4111-8111-111111111111`, `x-codex-turn-metadata: {"installation_id":"11111111-1111-4111-8111-111111111111"}`, `x-oai-attestation: att-1`, and `body.client_metadata`, then pass through `createResponsesPassthroughAdapter.buildRequest`.
   - *Observable Effect*: `acct-1` and `acct-2` receive distinct valid v4 UUIDs in `x-codex-installation-id`, `x-codex-turn-metadata.installation_id`, and `body.client_metadata["x-codex-installation-id"]`; within `acct-1`, the HTTP header and `body.client_metadata` UUIDs are byte-identical (no double-hashing); `x-oai-attestation` is removed on pool overrides and preserved on direct caller-owned sends.
2. **Conditional Path 2 — `x-codex-turn-state` scrub on account change**:
   - *Trigger*: Serve turn 1 on `acct-1`, then switch to `acct-2` on turn 2 with `x-codex-turn-state: ts-acct-1` in headers and `body.client_metadata`.
   - *Observable Effect*: `applyAccountChangeConversationStateScrub` removes `x-codex-turn-state` from both outbound headers and `body.client_metadata`.
3. **Conditional Path 3 — Official JSON token refresh contract**:
   - *Trigger*: Call `refreshChatGPTToken`, `getValidCodexToken` (pool refresh), and `refreshNativeMainGrant` against a mock token server.
   - *Observable Effect*: Refresh requests send `Content-Type: application/json` and `Accept: application/json` with JSON body `{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","grant_type":"refresh_token","refresh_token":"..."}`, while `exchangeToken` sends `application/x-www-form-urlencoded`.

### Verifier Commands (Run & Verified in P Phase per `PLAN-VERIFIER-REAL-01`)
- `bun test tests/oauth/chatgpt-oauth.test.ts tests/oauth/chatgpt-token-expiry.test.ts tests/oauth/chatgpt-token-boundaries.test.ts` — baseline exit code `0`; reads `src/oauth/chatgpt.ts` and `src/codex/account-store.ts` directly.
- `bun run typecheck && bun run privacy:scan && bun run structure:check && bun test tests/ci-workflows/file-size-ratchet.test.ts` — baseline exit code `0`.
