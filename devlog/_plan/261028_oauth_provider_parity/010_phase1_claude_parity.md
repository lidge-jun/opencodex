# 010 — Phase 1 (`wp1`): Claude OAuth Translated & Native Path Parity, Session ID, and `device_id` Isolation

- **Work-Phase ID**: `wp1`
- **Depends On**: `wp0` (`000_plan.md`, `001_provider_parity_matrix.md`)
- **Shared Types / Interfaces Used**: `AnthropicMessagesPassthroughOptions` (`src/adapters/anthropic/passthrough.ts:87`), `OcxParsedRequest` (`src/types.ts`), `IncomingMeta` (`src/adapters/base.ts`)
- **Design Decisions Implemented**: `DEC-01`, `DEC-02`, `DEC-08`

## 1. File Change Map

| Action | File Path | Current Lines / Cap | Responsibility & Change Summary |
|---|---|---:|---|
| `MODIFY` | `src/providers/claude-cli-identity.ts` | 12 / 1999 | Export `CLAUDE_CLI_SDK_PACKAGE_VERSION = "0.112.1"` and `CLAUDE_CLI_RUNTIME_VERSION = "v26.3.0"` alongside `CLAUDE_CLI_VERSION = "2.1.280"` and `CLAUDE_CLI_USER_AGENT`. |
| `MODIFY` | `src/adapters/client-fingerprint.ts` | 86 / 1999 | Update `CLAUDE_CODE_HEADERS` (`X-Stainless-Package-Version: "0.112.1"`, `X-Stainless-Runtime-Version: "v26.3.0"`, normalized `X-Stainless-OS` via `stainlessOsName()`, normalized `X-Stainless-Arch` via `stainlessArchName()`, `anthropic-dangerous-direct-browser-access: "true"`); extend `claudeCodeSessionId(token, sessionKey?)` to derive a per-conversation UUID when `sessionKey` is present and fall back to per-credential UUID when absent. |
| `MODIFY` | `src/adapters/anthropic/account-metadata.ts` | 17 / 1999 | Add `deriveAnthropicAccountDeviceId(accountUuid)` and `extractAnthropicCallerSessionId(body)`; update `bindAnthropicAccountMetadata(body, providerAccountUuid)` so `metadata.user_id` always binds an isolated per-account 64-hex `device_id` alongside `account_uuid` while preserving `session_id` and extra JSON keys. |
| `MODIFY` | `src/adapters/anthropic/beta-allowlist.ts` | 159 / 1999 | Move `extended-cache-ttl-2025-04-11`, `effort-2025-11-24`, `thinking-token-count-2026-05-13`, `mid-conversation-tool-changes-2026-07-01`, and `advanced-tool-use-2025-11-20` from `KNOWN_UNFORWARDED_BETAS` into `NATIVE_CLIENT_BETAS` so observed native Claude Code clients keep their 2.1.280 feature betas. |
| `MODIFY` | `src/adapters/anthropic/passthrough.ts` | 334 / 1999 | Accept `sessionKey?: string | null` in `AnthropicMessagesPassthroughOptions`; resolve conversation session ID and pass to `applyAnthropicOAuthAuth` and `bindAnthropicAccountMetadata`; auto-append `extended-cache-ttl-2025-04-11` when first-party wire body contains `ttl: "1h"`. |
| `MODIFY` | `src/server/messages-native.ts` | 1133 / 1999 | Pass `sessionKey: oauthBinding?.sessionKey ?? options.sessionKey` into `buildAnthropicMessagesPassthroughRequest` at line 483. |
| `MODIFY` | `src/adapters/anthropic.ts` | 1719 / 1999 | Use `CLAUDE_CLI_SDK_PACKAGE_VERSION` in `anthropicBaseRequestHeaders`; set `headers["User-Agent"] = CLAUDE_CLI_USER_AGENT` and per-conversation `X-Claude-Code-Session-Id` in `applyAnthropicOAuthAuth(headers, accessToken, sessionKey)`; add `extended-cache-ttl-2025-04-11` when `1h` cache breakpoints are present; require `message_stop` on first-party Anthropic streams when a block is open or `message_stop` is absent. |
| `MODIFY` | `src/vision/anthropic-describe.ts` | 248 / 1999 | Use `CLAUDE_CLI_USER_AGENT` on OAuth vision requests instead of `@anthropic-ai/sdk/0.74.0`. |
| `MODIFY` | `src/web-search/anthropic-executor.ts` | 260 / 1999 | Use `CLAUDE_CLI_USER_AGENT` on OAuth web-search requests instead of `@anthropic-ai/sdk/0.74.0`. |
| `MODIFY` | `tests/clients/client-fingerprint.test.ts` | 136 / 1999 | Add red-to-green tests for `CLAUDE_CODE_HEADERS` (`0.112.1`, `v26.3.0`, `MacOS`/`Linux`/`Windows`, `anthropic-dangerous-direct-browser-access`), `CLAUDE_CLI_USER_AGENT` on OAuth vs `@anthropic-ai/sdk/0.112.1` on API-key, per-conversation `claudeCodeSessionId(token, sessionKey)` isolation, and isolate `GOOGLE_ANTIGRAVITY_USER_AGENT` env var. |
| `MODIFY` | `tests/adapters/anthropic/anthropic-account-metadata.test.ts` | 73 / 1999 | Update and expand tests for per-account deterministic `device_id` isolation (`deriveAnthropicAccountDeviceId(A) !== deriveAnthropicAccountDeviceId(B)`), `account_uuid` binding, `session_id` preservation, and extra-key retention. |
| `MODIFY` | `tests/adapters/anthropic/anthropic-client-identity.test.ts` | 225 / 1999 | Update SDK package version (`0.112.1`) and OAuth `User-Agent` (`claude-cli/2.1.280 (external, cli)`) assertions, plus per-conversation `X-Claude-Code-Session-Id` tests. |
| `MODIFY` | `tests/claude-integration/messages-native-oauth.test.ts` | 530 / 1999 | Update native OAuth `metadata.user_id` assertions to verify deterministic per-account `device_id` (`deriveAnthropicAccountDeviceId(uuid)`) across account switches. |
| `MODIFY` | `tests/vision/vision-anthropic.test.ts` | 240 / 1999 | Update OAuth vision `User-Agent` assertion to `claude-cli/2.1.280 (external, cli)`. |

## 2. Field and Option Chains (`PLAN-FIELD-CHAIN-01`)

| Field / Option | 1. Creation | 2. Serialization | 3. Deserialization | 4. Consumers |
|---|---|---|---|---|
| `AnthropicMessagesPassthroughOptions.sessionKey?: string \| null` | Created in `src/server/messages-native.ts:483` (`sessionKey: oauthBinding?.sessionKey ?? options.sessionKey`) and `src/adapters/anthropic.ts:535` (`resolveTranslatedAnthropicSessionKey(parsed, incoming)`). | Serialized into HTTP header `X-Claude-Code-Session-Id` via `claudeCodeSessionId(accessToken, sessionKey)` (`src/adapters/anthropic.ts:581`) and `body.metadata.user_id` JSON `session_id` (`src/adapters/anthropic/account-metadata.ts`). | N/A — outbound upstream wire header and JSON field only; OpenCodex does not deserialize its own outbound `X-Claude-Code-Session-Id`. | `buildAnthropicMessagesPassthroughRequest` (`src/adapters/anthropic/passthrough.ts:300-316`), `applyAnthropicOAuthAuth` (`src/adapters/anthropic.ts:574-583`), `bindAnthropicAccountMetadata` (`src/adapters/anthropic/account-metadata.ts:45-95`). |
| `metadata.user_id.device_id` (`deriveAnthropicAccountDeviceId(accountUuid)`) | Created in `bindAnthropicAccountMetadata(body, providerAccountUuid)` (`src/adapters/anthropic/account-metadata.ts:28`) from `providerAccountUuid` (`src/adapters/anthropic/passthrough.ts:300`). | Serialized into `body.metadata.user_id` as JSON `{ ...identity, device_id: isolatedDeviceId, account_uuid: providerAccountUuid }` (`src/adapters/anthropic/account-metadata.ts:35-42`). | Parsed in unit/integration tests (`tests/adapters/anthropic/anthropic-account-metadata.test.ts:24`, `tests/claude-integration/messages-native-oauth.test.ts:356,376`). | `buildAnthropicMessagesPassthroughRequest` (`src/adapters/anthropic/passthrough.ts:300`) and upstream Anthropic `/v1/messages`. |

## 3. Bypass & Enforcement Records (`PLAN-BYPASS-NAMED-01`)

| Mechanism | Tier | Executing Surface | Known Bypass Path | Residual Risk | Wording Downgraded? | Final Layer |
|---|---|---|---|---|---|---|
| Per-account `device_id` & per-conversation `X-Claude-Code-Session-Id` isolation | E4 (Runtime request builder) | `bindAnthropicAccountMetadata` (`src/adapters/anthropic/account-metadata.ts`) and `applyAnthropicOAuthAuth` (`src/adapters/anthropic.ts`) | Caller-forward subscription passthrough (`src/server/claude-messages.ts:305` `anthropicNativePassthrough`) forwards the caller's own single-account bearer and body verbatim when not using the OpenCodex OAuth pool, or operator `provider.headers` explicitly overriding `X-Claude-Code-Session-Id`. | Single-account direct passthrough uses only the caller's own credential (no pool to link); operator header overrides are explicit local config. | Yes — described as "per-account device_id isolation for proxy-managed OAuth pools", not unbypassable enforcement. | `src/adapters/anthropic/passthrough.ts` & `src/adapters/anthropic.ts` |

## 4. Before / After Diffs (`DIFFLEVEL-ROADMAP-01`)

### 4.1 `src/providers/claude-cli-identity.ts`
```diff
 export const CLAUDE_CLI_VERSION = "2.1.280";
 export const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`;
+export const CLAUDE_CLI_SDK_PACKAGE_VERSION = "0.112.1";
+export const CLAUDE_CLI_RUNTIME_VERSION = "v26.3.0";
```

### 4.2 `src/adapters/client-fingerprint.ts`
```diff
 import { createHash } from "node:crypto";
+import {
+  CLAUDE_CLI_RUNTIME_VERSION,
+  CLAUDE_CLI_SDK_PACKAGE_VERSION,
+} from "../providers/claude-cli-identity";
+
+export function stainlessOsName(platform: string = process.platform): string {
+  switch (platform.toLowerCase()) {
+    case "darwin": return "MacOS";
+    case "linux": return "Linux";
+    case "win32": return "Windows";
+    case "freebsd": return "FreeBSD";
+    case "openbsd": return "OpenBSD";
+    default: return platform ? `Other:${platform}` : "Unknown";
+  }
+}
+
+export function stainlessArchName(arch: string = process.arch): string {
+  if (arch === "x64" || arch === "x86_64") return "x64";
+  if (arch === "arm64" || arch === "aarch64") return "arm64";
+  if (arch === "arm") return "arm";
+  if (arch === "ia32" || arch === "x32") return "x32";
+  return arch ? `other:${arch}` : "unknown";
+}

-// ── Claude Code CLI (matches Claude Code 2.1.63 / @anthropic-ai/sdk 0.74.0) ──
+// ── Claude Code CLI (matches Claude Code 2.1.280 / @anthropic-ai/sdk 0.112.1) ──
 export const CLAUDE_CODE_HEADERS: Record<string, string> = {
   "X-App": "cli",
+  "anthropic-dangerous-direct-browser-access": "true",
   "X-Stainless-Retry-Count": "0",
   "X-Stainless-Runtime": "node",
   "X-Stainless-Lang": "js",
   "X-Stainless-Timeout": "600",
-  "X-Stainless-Arch": process.arch,
-  "X-Stainless-OS": process.platform,
-  "X-Stainless-Package-Version": "0.74.0",
-  "X-Stainless-Runtime-Version": process.version.slice(1),
+  "X-Stainless-Arch": stainlessArchName(),
+  "X-Stainless-OS": stainlessOsName(),
+  "X-Stainless-Package-Version": CLAUDE_CLI_SDK_PACKAGE_VERSION,
+  "X-Stainless-Runtime-Version": CLAUDE_CLI_RUNTIME_VERSION,
 };

-export function claudeCodeSessionId(token: string | undefined): string {
+export function claudeCodeSessionId(token: string | undefined, sessionKey?: string | null): string {
   const seed = token && token.length > 0 ? token : "opencodex-anon";
-  const h = createHash("sha256").update(`claude-code-session:${seed}`, "utf8").digest("hex");
+  const conv = typeof sessionKey === "string" ? sessionKey.trim() : "";
+  const input = conv ? `claude-code-session:${seed}:conv:${conv}` : `claude-code-session:${seed}`;
+  const h = createHash("sha256").update(input, "utf8").digest("hex");
   // Shape the hash into a v4-looking UUID (version nibble 4, variant nibble 8-b).
   const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
   return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
 }
```

### 4.3 `src/adapters/anthropic/account-metadata.ts`
```diff
+import { createHash } from "node:crypto";
 const PROVIDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const MAX_USER_ID_BYTES = 4096;
 type Rec = Record<string, unknown>;
 const isRec = (value: unknown): value is Rec => value !== null && typeof value === "object" && !Array.isArray(value);

+/** Deterministic per-account 64-hex device_id so pooled accounts never share one client device_id. */
+export function deriveAnthropicAccountDeviceId(accountUuid: string): string {
+  return createHash("sha256").update(`ocx-claude-code-device-v1:${accountUuid.trim().toLowerCase()}`, "utf8").digest("hex");
+}
+
+export function extractAnthropicCallerSessionId(body: Readonly<Rec>): string | undefined {
+  if (!isRec(body.metadata) || typeof body.metadata.user_id !== "string") return undefined;
+  const userId = body.metadata.user_id;
+  if (Buffer.byteLength(userId) > MAX_USER_ID_BYTES) return undefined;
+  try {
+    const identity: unknown = JSON.parse(userId);
+    if (isRec(identity) && typeof identity.session_id === "string" && identity.session_id.trim()) {
+      return identity.session_id.trim();
+    }
+  } catch { /* ignore */ }
+  return undefined;
+}
+
 /** Unknown formats stay untouched; the argument is the provider UUID, never the local pool id. */
 export function bindAnthropicAccountMetadata(body: Rec, providerAccountUuid: string | undefined): Rec {
   if (!providerAccountUuid || !PROVIDER_UUID.test(providerAccountUuid) || !isRec(body.metadata)) return body;
   const userId = body.metadata.user_id;
   if (typeof userId !== "string" || Buffer.byteLength(userId) > MAX_USER_ID_BYTES) return body;
   let identity: unknown;
   try { identity = JSON.parse(userId); } catch { return body; }
-  if (!isRec(identity) || typeof identity.account_uuid !== "string" || !PROVIDER_UUID.test(identity.account_uuid)
-    || identity.account_uuid === providerAccountUuid) return body;
-  return { ...body, metadata: { ...body.metadata, user_id: JSON.stringify({ ...identity, account_uuid: providerAccountUuid }) } };
+  if (!isRec(identity) || typeof identity.account_uuid !== "string" || !PROVIDER_UUID.test(identity.account_uuid)) return body;
+  const isolatedDeviceId = deriveAnthropicAccountDeviceId(providerAccountUuid);
+  const nextDevice = typeof identity.device_id === "string" ? isolatedDeviceId : undefined;
+  if (identity.account_uuid === providerAccountUuid && (nextDevice === undefined || identity.device_id === nextDevice)) return body;
+  return {
+    ...body,
+    metadata: {
+      ...body.metadata,
+      user_id: JSON.stringify({
+        ...identity,
+        ...(nextDevice !== undefined ? { device_id: nextDevice } : {}),
+        account_uuid: providerAccountUuid,
+      }),
+    },
+  };
 }
```

### 4.4 `src/adapters/anthropic.ts`, `src/adapters/anthropic/passthrough.ts`, `src/adapters/anthropic/beta-allowlist.ts`, `src/vision/anthropic-describe.ts`, `src/web-search/anthropic-executor.ts`
```diff
--- a/src/adapters/anthropic.ts
+++ b/src/adapters/anthropic.ts
@@ -30,6 +30,7 @@
 import { redactSecretString } from "../lib/redact";
 import { CLAUDE_CODE_HEADERS, claudeCodeSessionId } from "./client-fingerprint";
+import { CLAUDE_CLI_SDK_PACKAGE_VERSION, CLAUDE_CLI_USER_AGENT } from "../providers/claude-cli-identity";
+import { collectAnthropicCacheTtls } from "./anthropic/cache-retention";
@@ -554,10 +555,10 @@
 export function anthropicBaseRequestHeaders(stream: boolean | undefined): Record<string, string> {
   return {
     "Content-Type": "application/json",
     "anthropic-version": ANTHROPIC_API_VERSION,
     "Accept": stream ? "text/event-stream" : "application/json",
-    "User-Agent": "@anthropic-ai/sdk/0.74.0",
+    "User-Agent": `@anthropic-ai/sdk/${CLAUDE_CLI_SDK_PACKAGE_VERSION}`,
   };
 }
@@ -573,11 +574,23 @@
-export function applyAnthropicOAuthAuth(headers: Record<string, string>, accessToken: string): void {
+export function resolveTranslatedAnthropicSessionKey(parsed: OcxParsedRequest, incoming?: IncomingMeta): string | undefined {
+  return parsed._codexOwnThreadId?.trim()
+    || parsed._clientThreadId?.trim()
+    || (parsed.options.promptCacheKey?.trim() || undefined)
+    || incoming?.headers?.get("x-claude-code-session-id")?.trim()
+    || incoming?.headers?.get("session_id")?.trim()
+    || incoming?.headers?.get("session-id")?.trim()
+    || incoming?.headers?.get("thread-id")?.trim()
+    || undefined;
+}
+
+export function applyAnthropicOAuthAuth(headers: Record<string, string>, accessToken: string, sessionKey?: string | null): void {
   headers["Authorization"] = `Bearer ${accessToken}`;
   headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
+  headers["User-Agent"] = CLAUDE_CLI_USER_AGENT;
   Object.assign(headers, CLAUDE_CODE_HEADERS);
-  headers["X-Claude-Code-Session-Id"] = claudeCodeSessionId(accessToken);
+  headers["X-Claude-Code-Session-Id"] = claudeCodeSessionId(accessToken, sessionKey);
   headers["x-client-request-id"] = crypto.randomUUID();
 }
```
And in `src/adapters/anthropic.ts:1245-1262`, pass `resolveTranslatedAnthropicSessionKey(parsed, incoming)` to `applyAnthropicOAuthAuth`, and after `normalizeTtlOrdering(body)`, if `usesNativeAnthropicEndpoint(provider) && collectAnthropicCacheTtls(body).includes("1h")`, call `mergeAnthropicBetaHeader(headers, ["extended-cache-ttl-2025-04-11"])` (and `"effort-2025-11-24"` when `body.output_config` carries `effort`). In `parseStream` (`src/adapters/anthropic.ts:1548`), require `currentBlockType === "" && currentToolCallId === ""` and `!usesNativeAnthropicEndpoint(provider)` before allowing EOF without `message_stop` to emit `done`.

## 5. Activation Scenarios (`C-ACTIVATION-GROUNDING-01`) & Verifiers (`PLAN-VERIFIER-REAL-01`)

1. **Conditional Path 1 — Per-conversation `X-Claude-Code-Session-Id` vs per-credential fallback**:
   - *Trigger*: Build two translated OAuth requests with the same `accessToken` and different `_clientThreadId` (`thread-A` vs `thread-B`), two turns with the same `_clientThreadId` (`thread-A`), and one request with no thread/session key.
   - *Observable Effect*: `thread-A` and `thread-B` produce distinct `X-Claude-Code-Session-Id` UUIDs; both turns of `thread-A` produce the identical UUID; the keyless request falls back to `claudeCodeSessionId(accessToken)`.
2. **Conditional Path 2 — Per-account `device_id` isolation in `bindAnthropicAccountMetadata`**:
   - *Trigger*: Pass the same native Messages `body` (`metadata.user_id` carrying `{ device_id: "caller-device", account_uuid: A, session_id: S }`) through `buildAnthropicMessagesPassthroughRequest` for pool account `A` and pool account `B`.
   - *Observable Effect*: Account `A` receives `device_id: deriveAnthropicAccountDeviceId(A)` and account `B` receives `device_id: deriveAnthropicAccountDeviceId(B)` (`device_id` values are 64-hex strings and `!==`), while `source.metadata.user_id` remains unmutated.
3. **Conditional Path 3 — `1h` cache TTL paired with `extended-cache-ttl-2025-04-11` and `message_stop` truncation check**:
   - *Trigger*: Build a first-party Anthropic request with `cacheRetention: "long"` (or default 1h on `api.anthropic.com`) and feed a truncated SSE stream (`message_start` -> `content_block_start` -> `message_delta` -> EOF without `message_stop`) to `parseStream`.
   - *Observable Effect*: `headers["anthropic-beta"]` includes `extended-cache-ttl-2025-04-11`, and the truncated first-party stream yields an `error` event instead of a false `done`.

### Verifier Commands (Run & Verified in P Phase per `PLAN-VERIFIER-REAL-01`)
- `env -u GOOGLE_ANTIGRAVITY_USER_AGENT bun test tests/clients/client-fingerprint.test.ts tests/adapters/anthropic/anthropic-account-metadata.test.ts tests/adapters/anthropic/anthropic-client-identity.test.ts tests/claude-integration/messages-native-oauth.test.ts tests/vision/vision-anthropic.test.ts` — baseline exit code `0`; reads targets directly via imports at `tests/clients/client-fingerprint.test.ts:2-8`, `tests/adapters/anthropic/anthropic-account-metadata.test.ts:2-3`, `tests/adapters/anthropic/anthropic-client-identity.test.ts:1-8`, `tests/claude-integration/messages-native-oauth.test.ts:1-20`, `tests/vision/vision-anthropic.test.ts:1-10`.
- `bun run typecheck` — baseline exit code `0`; reads all `src/**/*.ts` and `tests/**/*.ts` via `tsconfig.json` `include`.
- `bun run privacy:scan && bun run structure:check && bun test tests/ci-workflows/file-size-ratchet.test.ts` — baseline exit code `0`; scans repository files for secrets, structure ownership (`structure/manifest.json`), and file-size caps (`tests/fixtures/file-size-baseline.json`).
