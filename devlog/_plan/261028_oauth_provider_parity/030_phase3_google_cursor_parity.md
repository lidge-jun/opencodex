# 030 — Phase 3 (`wp3`): Google OAuth (Gemini CLI / Antigravity / Cloud Code) & Cursor Parity and Account Isolation

- **Work-Phase ID**: `wp3`
- **Depends On**: `wp2` (`020_phase2_codex_parity.md`)
- **Shared Types / Interfaces Used**: `OcxParsedRequest` (`src/types.ts`), `OAuthCredentials` (`src/oauth/types.ts`), `CursorTransportFactoryInput` (`src/adapters/cursor/transport.ts`)
- **Design Decisions Implemented**: `DEC-05`, `DEC-06`, `DEC-08`

## 1. File Change Map

| Action | File Path | Current Lines / Cap | Responsibility & Change Summary |
|---|---|---:|---|
| `MODIFY` | `src/adapters/google-antigravity-wire.ts` | 221 / 1999 | Reject `"context_engineering_is_the_way_to_go"` in `isLikelyRealThoughtSignature`; accept `accountScope?: string` in `antigravitySessionId(parsed, accountScope)` so pooled Google Antigravity accounts emit isolated per-account/project `request.sessionId` values. |
| `MODIFY` | `src/adapters/google-antigravity-replay.ts` | 910 / 1999 | Export `THOUGHT_SIGNATURE_CONTEXT_BYPASS = "context_engineering_is_the_way_to_go"` and reject it in `extractSignature` and `loadReplaySnapshotEntry`. |
| `MODIFY` | `src/adapters/google-wire-compiler.ts` | 215 / 1999 | Preserve `thinkingBudget` (or `thinking_budget`) in `compileGenerationConfig` when `thinkingLevel` is not set. |
| `MODIFY` | `src/adapters/google.ts` | 1805 / 1999 | Pass `provider.project` into `antigravitySessionId(parsed, provider.project)` at line 1129 and scope `antigravityModel` by project (`${project}:${wireModelId}`) at line 1136 so the thoughtSignature replay cache never leaks across pooled Google accounts. |
| `MODIFY` | `src/oauth/google-antigravity.ts` | 310 / 1999 | Extract `sub` from `id_token` as `accountId` in `credentialsFromPayload`; select default tier from `allowedTiers` (`isDefault === true`) in `loadCodeAssistProject` and pass to `onboardProject`; preserve OAuth error code (`error` / `error_description`) in `postToken` on non-2xx responses. |
| `MODIFY` | `src/codex/catalog/provider-models.ts` | 910 / 1999 | Compute `catalogAuthority` for `cloudCodeAssist` (`google-antigravity`) from `(auth.oauthAccountId ?? apiKey, project)` at line 652 so per-account model discovery caches do not bleed across pooled accounts. |
| `MODIFY` | `src/providers/quota/antigravity.ts` | 355 / 1999 | Pass `ANTIGRAVITY_DISCOVERY_UA` (`antigravity/cli/1.3.4 ...`) when falling back to `:fetchAvailableModels` at line 333 so Gemini 4 Argon quota rows are preserved. |
| `MODIFY` | `src/adapters/cursor/h2-pool.ts` | 115 / 1999 | Accept `credentialScope?: string` in `CursorH2SessionPool.request(url, headers, credentialScope)` and key pool entries by `${origin}\0${credentialScope ?? ""}` so pooled Cursor accounts never share an HTTP/2 TLS connection. |
| `MODIFY` | `src/adapters/cursor/live-models.ts` | 265 / 1999 | Unify `CURSOR_DISCOVERY_CLIENT_VERSION` with `CURSOR_CLIENT_VERSION` (`"cli-2026.07.08-0c04a8a"`), derive a deterministic per-account `x-session-id` in `cursorDiscoveryHeaders`, and pass a hashed credential scope to `cursorH2Pool.request`. |
| `MODIFY` | `src/oauth/cursor.ts` | 260 / 1999 | Export `decodeCursorJwtPayload` (line 41) so `src/adapters/cursor.ts` can read the stable JWT `sub` claim one-way (`adapters -> oauth`, no import cycle). |
| `MODIFY` | `src/adapters/cursor.ts` | 740 / 1999 | Derive fallback `_parsed._cursorIdentityScope` from the JWT `sub` claim (via `decodeCursorJwtPayload` from `../oauth/cursor`) before falling back to `sha256(token)` so token refresh preserves checkpoints and thread continuity; pass `status` on preflight error events. |
| `MODIFY` | `src/adapters/cursor/live-transport.ts` | 1786 / 1999 | Scope `cursorContextUsageTracker` keys by `${request._cursorIdentityScope ?? "local"}\0${request.conversationId}`; surface HTTP `:status` 401/403/429 before Connect frames. |
| `MODIFY` | `src/adapters/cursor/http1-bidi.ts` | 260 / 1999 | Add `"x-cursor-streaming": "true"` in `commonHeaders` for HTTP/1.1 `RunSSE` requests. |
| `MODIFY` | `src/providers/quota/vendor-probes-oauth.ts` | 593 / 1999 | Remove the giveaway `"User-Agent": "opencodex-quota"` header on `fetchCursorQuota` (line 440). |
| `MODIFY` | `tests/adapters/google/google-antigravity-wire.test.ts` | 240 / 1999 | Add red-to-green tests for per-account/project `antigravitySessionId` isolation and `context_engineering_is_the_way_to_go` rejection. |
| `MODIFY` | `tests/adapters/google/google-wire-compiler.test.ts` | 120 / 1999 | Add red-to-green tests for `thinkingBudget` preservation. |
| `MODIFY` | `tests/adapters/google/google-antigravity-oauth.test.ts` | 180 / 1999 | Add red-to-green tests for `allowedTiers` default tier onboarding, `id_token` `sub` extraction, and `invalid_grant` error code preservation. |
| `MODIFY` | `tests/providers/cursor/cursor-adapter.test.ts` | 420 / 1999 | Add red-to-green tests for JWT `sub`-based `_cursorIdentityScope` stability across token refresh, per-credential `cursorH2Pool` isolation, and HTTP/1.1 `x-cursor-streaming: "true"`. |

## 2. Field and Option Chains (`PLAN-FIELD-CHAIN-01`)

| Field / Option | 1. Creation | 2. Serialization | 3. Deserialization | 4. Consumers |
|---|---|---|---|---|
| `antigravitySessionId(parsed, accountScope?)` | Created in `src/adapters/google.ts:1129` (`antigravitySessionId(parsed, provider.project)`). | Serialized into `envelope.request.sessionId` (`src/adapters/google.ts:1148`). | N/A — outbound wire field to Google Cloud Code Assist. | `createGoogleAdapter.buildRequest` (`src/adapters/google.ts:1129-1180`) and `tests/adapters/google/google-antigravity-wire.test.ts`. |
| `CursorH2SessionPool.request(url, headers, credentialScope?)` | Created in `src/adapters/cursor/live-models.ts:212` (`createHash("sha256").update(opts.apiKey).digest("hex").slice(0, 16)`). | N/A — in-memory pool map key `${origin}\0${credentialScope ?? ""}`. | N/A — in-memory map lookup (`src/adapters/cursor/h2-pool.ts:44,77`). | `CursorH2SessionPool` (`src/adapters/cursor/h2-pool.ts`) and `fetchCursorUsableModelsHttp2Once` (`src/adapters/cursor/live-models.ts:212`). |

## 3. Bypass & Enforcement Records (`PLAN-BYPASS-NAMED-01`)

| Mechanism | Tier | Executing Surface | Known Bypass Path | Residual Risk | Wording Downgraded? | Final Layer |
|---|---|---|---|---|---|---|
| Per-account/project `antigravitySessionId` & replay cache isolation and per-credential `cursorH2Pool` isolation | E4 (Runtime adapter & transport pool) | `src/adapters/google.ts`, `src/adapters/google-antigravity-wire.ts`, `src/adapters/cursor/h2-pool.ts`, `src/adapters/cursor.ts` | Direct caller call to `antigravitySessionId(parsed)` without `accountScope` or `_reasoningReplayScope` (e.g. unit tests calling the pure helper with one argument) keeps the un-scoped hash for backward compatibility. | Production `google.ts:1129` always supplies `provider.project` (which is required on line 1128). | Yes — described as "per-project session and replay isolation in the Google CCA adapter". | `src/adapters/google.ts:1129-1180` & `src/adapters/cursor/h2-pool.ts:38-55` |

## 4. Before / After Diffs (`DIFFLEVEL-ROADMAP-01`)

### 4.1 `src/adapters/google-antigravity-wire.ts` & `src/adapters/google.ts`
```diff
--- a/src/adapters/google-antigravity-wire.ts
+++ b/src/adapters/google-antigravity-wire.ts
@@ -54,5 +54,5 @@
   // evidence that a turn was signed. It is never a real signature.
-  if (sig === "skip_thought_signature_validator") return false;
+  if (sig === "skip_thought_signature_validator" || sig === "context_engineering_is_the_way_to_go") return false;
   // Reject synthetic Responses/tool-call ids and Anthropic tool-use ids (`_` or `-` separators).
@@ -83,5 +83,8 @@
-export function antigravitySessionId(parsed: OcxParsedRequest): string {
+export function antigravitySessionId(parsed: OcxParsedRequest, accountScope?: string): string {
   const text = codexThreadAnchor(parsed).preimage ?? firstUserText(parsed);
   if (!text) return `-${Math.floor(Math.random() * 9e18).toString()}`;
-  const digest = createHash("sha256").update(text, "utf8").digest();
+  const scope = parsed._reasoningReplayScope?.identity?.credentialDurableIdentity?.trim()
+    || accountScope?.trim()
+    || "";
+  const preimage = scope ? `acct:${scope}\0${text}` : text;
+  const digest = createHash("sha256").update(preimage, "utf8").digest();
   const masked = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
   return `-${masked.toString()}`;
 }
```
```diff
--- a/src/adapters/google.ts
+++ b/src/adapters/google.ts
@@ -1127,10 +1127,10 @@
         const project = provider.project;
         if (!project) throw new Error("Antigravity requires a discovered Cloud Code Assist project id (re-run `ocx login google-antigravity`).");
-        const sessionId = antigravitySessionId(parsed);
+        const sessionId = antigravitySessionId(parsed, project);
         const mappedEffort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
         const { wireModelId, thinkingLevel } = resolveAntigravityEffortWireModel(
           parsed.modelId,
           mappedEffort,
           provider.baseUrl,
         );
-        antigravityModel = wireModelId;
+        antigravityModel = `${project}:${wireModelId}`;
         antigravitySession = sessionId;
@@ -1179,3 +1179,3 @@
           if (antigravityUsesReplayCache(wireModelId)) {
-            applyAntigravityReplay(wireModelId, sessionId, contents);
+            applyAntigravityReplay(antigravityModel, sessionId, contents);
           } else {
```

### 4.2 `src/adapters/google-wire-compiler.ts`
```diff
--- a/src/adapters/google-wire-compiler.ts
+++ b/src/adapters/google-wire-compiler.ts
@@ -173,5 +173,9 @@
       if (thinkingLevel) thinking.thinkingLevel = thinkingLevel;
     }
+    const rawBudget = finiteNumber(value.thinkingConfig.thinkingBudget ?? value.thinkingConfig.thinking_budget);
+    if (!thinking.thinkingLevel && rawBudget !== undefined && (rawBudget === -1 || rawBudget >= 0)) {
+      thinking.thinkingBudget = Math.floor(rawBudget);
+    }
     if (value.thinkingConfig.includeThoughts === true) thinking.includeThoughts = true;
```

### 4.3 `src/adapters/cursor/h2-pool.ts`, `src/adapters/cursor.ts`, `src/adapters/cursor/http1-bidi.ts`
```diff
--- a/src/adapters/cursor/h2-pool.ts
+++ b/src/adapters/cursor/h2-pool.ts
@@ -38,8 +38,9 @@
   request(
     url: string,
     headers: http2.OutgoingHttpHeaders,
+    credentialScope?: string,
   ): Promise<{ session: http2.ClientHttp2Session; stream: http2.ClientHttp2Stream }> {
-    const origin = new URL(url).origin;
+    const origin = new URL(url).origin;
+    const poolKey = credentialScope ? `${origin}\0${credentialScope}` : origin;
```
```diff
--- a/src/adapters/cursor/http1-bidi.ts
+++ b/src/adapters/cursor/http1-bidi.ts
@@ -220,6 +220,7 @@
       "connect-protocol-version": "1",
       authorization: `Bearer ${this.options.token}`,
       "x-ghost-mode": "true",
+      "x-cursor-streaming": "true",
       "x-cursor-client-version": this.options.clientVersion,
       "x-cursor-client-type": "cli",
```

## 5. Activation Scenarios (`C-ACTIVATION-GROUNDING-01`) & Verifiers (`PLAN-VERIFIER-REAL-01`)

1. **Conditional Path 1 — Per-project `antigravitySessionId` and replay cache isolation**:
   - *Trigger*: Observe a Gemini `thoughtSignature` on `project-A` for thread `T`, then build a request for `project-B` on the same thread `T`.
   - *Observable Effect*: `project-A` and `project-B` receive different `request.sessionId` values, and `project-A`'s cached signature is not injected into `project-B`'s `contents`, while a second turn on `project-A` does receive the cached signature.
2. **Conditional Path 2 — `thinkingBudget` preservation and `context_engineering_is_the_way_to_go` sentinel filtering**:
   - *Trigger*: Compile a Gemini body with `generationConfig: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } }`, and test `isLikelyRealThoughtSignature("context_engineering_is_the_way_to_go")`.
   - *Observable Effect*: `compiled.body.generationConfig.thinkingConfig` retains `{ thinkingBudget: 8192, includeThoughts: true }`, and the bypass sentinel returns `false`.
3. **Conditional Path 3 — Cursor JWT `sub` identity scope stability & per-credential HTTP/2 pool isolation**:
   - *Trigger*: Run two turns of a Cursor conversation where the JWT `accessToken` rotates (`exp` changes) while `sub` (`"github|12345"`) stays the same; then run `fetchCursorUsableModelsOnce` for two different Cursor tokens.
   - *Observable Effect*: `_parsed._cursorIdentityScope` remains identical across the token refresh (preserving the committed checkpoint), and `cursorH2Pool` opens separate HTTP/2 sessions per token digest.

### Verifier Commands (Run & Verified in P Phase per `PLAN-VERIFIER-REAL-01`)
- `env -u GOOGLE_ANTIGRAVITY_USER_AGENT bun test tests/adapters/google/google-antigravity-wire.test.ts tests/adapters/google/google-antigravity-replay.test.ts tests/adapters/google/google-antigravity-oauth.test.ts tests/adapters/google/google-wire-compiler.test.ts tests/providers/cursor/cursor-adapter.test.ts tests/providers/cursor/cursor-discovery.test.ts` — baseline exit code `0`.
- `bun run typecheck && bun run privacy:scan && bun run structure:check && bun test tests/ci-workflows/file-size-ratchet.test.ts` — baseline exit code `0`.
