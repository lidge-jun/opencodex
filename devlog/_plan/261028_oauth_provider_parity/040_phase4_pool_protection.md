# 040 — Phase 4 (`wp4`): Multi-Account Pool Protection (Cooldowns, Session Pinning & Suspended Account Auto-Exclusion)

- **Work-Phase ID**: `wp4`
- **Depends On**: `wp3` (`030_phase3_google_cursor_parity.md`)
- **Shared Types / Interfaces Used**: `QuotaModelFamily` (`src/oauth/account-quota-rank.ts`), `ChatgptRefreshDiagnosticCode` (`src/codex/chatgpt-refresh-failure.ts`), `AdapterEvent` (`src/types.ts`)
- **Design Decisions Implemented**: `DEC-07`, `DEC-08`

## 1. File Change Map

| Action | File Path | Current Lines / Cap | Responsibility & Change Summary |
|---|---|---:|---|
| `MODIFY` | `src/oauth/generic-account-failover.ts` | 896 / 1999 | In `isCooled(provider, accountId, now, family)` (line 120), also check bare account-wide cooldown `isCooled(provider, accountId, now, undefined)` when `family !== undefined`; in `rotateAntigravityAccountOnAuthRefusal` (line 418), record both family and bare cooldowns and invalidate `presence.delete("google-antigravity")` (without importing `./generic-session-affinity`, preserving `INV-LAYER-01` cycle-free invariant); add `rotateGenericAccountOnAuthRefusal` for generic 403/auth refusals. |
| `MODIFY` | `src/oauth/generic-session-affinity.ts` | 125 / 1999 | Export `clearGenericSessionAffinityForAccount(provider: string, accountId: string)` so server-layer auth/403/429 rotations and `readBinding` evict sessions pinned to a cooled or suspended account without introducing an import cycle. |
| `MODIFY` | `src/oauth/account-quota-rank.ts` | 310 / 1999 | Extend `exhaustedCooldownMs` (line 295) to support `google-antigravity` using `accountResetTimestamp` when headroom is 0. |
| `MODIFY` | `src/adapters/google-errors.ts` | 175 / 1999 | Export `extractGoogleRetryAfterSeconds(payloadText: string): string \| undefined` to parse `RetryInfo.retryDelay` or `ErrorInfo.metadata.quotaResetDelay` from 429 JSON error bodies. |
| `MODIFY` | `src/adapters/google-http.ts` | 240 / 1999 | When an Antigravity or Vertex 429 response has no `Retry-After` header, populate `Retry-After` from `extractGoogleRetryAfterSeconds(payloadText)` so `rotateGenericOAuthAccountOn429` cools for the server-stated reset window instead of 60s. |
| `MODIFY` | `src/oauth/cursor.ts` | 260 / 1999 | In `refreshCursorToken` (line 237), classify HTTP 400/401/403 and `data.shouldLogout === true` with `(invalid_grant)` in the error message so `isTerminalRefreshError` (`src/oauth/index.ts:778`) marks revoked/logged-out Cursor accounts `needsReauth`. |
| `MODIFY` | `src/oauth/index.ts` | 1984 / 1999 | Add `"cursor"` to `FORCE_REFRESH_PROVIDERS` (line 728). (1 line change; file stays at 1985 / 1999 lines.) |
| `MODIFY` | `src/server/responses/request-transport.ts` | 1425 / 1999 | Add `route.providerName === "cursor"` to `isOAuth401ReplayProvider` (line 191); generalize line 1073 terminal-refresh fallback from `kiro`-only to `tryAlternateAfterTerminalRefresh(config, route.providerName, failedId, failedGeneration)`. |
| `MODIFY` | `src/adapters/cursor/cursor-errors.ts` | 350 / 1999 | Distinguish `permission_denied` / `forbidden` / `access denied` as `"Cursor access denied (HTTP 403)"` (403) instead of `"Cursor authentication failed"` (401), and match `"failed with http 401|403|429"` from HTTP/1.1 & HTTP/2 transports. |
| `MODIFY` | `src/server/responses/run-turn-execution.ts` | 1120 / 1999 | In `recoverRunTurnAdapterOnPreflight401` (line 495), resolve `const status = error.status ?? adapterFailureFromMessage(error.message).httpStatus`; add `rotateRunTurnAdapterOnPreflight403` to cool and rotate on preflight 403 refusals. |
| `MODIFY` | `src/oauth/anthropic-account-refusal.ts` | 232 / 1999 | In `rotateAnthropicAccountOnResponseForInstance` (line 121), call `routing.clearAnthropicSessionAffinityForAccount(sent.accountId)` when `wasAccountAutoPaused(response)` is true. |
| `MODIFY` | `src/codex/chatgpt-refresh-failure.ts` | 60 / 1999 | Add `"account_deactivated"` and `"deactivated_workspace"` to `REFRESH_DIAGNOSTIC_CODES` and terminal `revoked` classification (lines 2-6, 35). |
| `MODIFY` | `tests/oauth/generic-oauth-failover.test.ts` | 842 / 1999 | Add red-to-green tests for bare account-wide cooldown enforcement under model-family queries (`isCooled`), session affinity eviction on Antigravity auth refusal, Google `RetryInfo` 429 cooldown extraction, Cursor 401/403 preflight rotation & `needsReauth` exclusion, Anthropic auto-pause affinity eviction, and Codex `deactivated_workspace` / `account_deactivated` terminal classification. |

## 2. Field and Option Chains (`PLAN-FIELD-CHAIN-01`)

| Field / Option | 1. Creation | 2. Serialization | 3. Deserialization | 4. Consumers |
|---|---|---|---|---|
| `ChatgptRefreshDiagnosticCode` (`"account_deactivated"`, `"deactivated_workspace"`) | Created in `classifyChatgptRefreshFailure` (`src/codex/chatgpt-refresh-failure.ts:31-36`). | Logged via `noteChatgptRefreshFailure` (`src/codex/chatgpt-refresh-failure.ts:58`) and attached to `ChatGptTokenError.oauthError` (`src/oauth/chatgpt.ts:80`) / `TokenRefreshError` (`src/codex/account-store.ts:1393`). | Parsed from OAuth token endpoint JSON `error` / `error.code` (`src/codex/chatgpt-refresh-failure.ts:22-28`). | `chatGptTokenError` (`src/oauth/chatgpt.ts:89`), `refreshNativeMainGrant` (`src/codex/main-account.ts:127`), `getValidCodexToken` (`src/codex/account-store.ts:1391`), `shouldMarkAccountNeedsReauthForCodexAuthFailure` (`src/codex/auth-context.ts`). |

## 3. Bypass & Enforcement Records (`PLAN-BYPASS-NAMED-01`)

| Mechanism | Tier | Executing Surface | Known Bypass Path | Residual Risk | Wording Downgraded? | Final Layer |
|---|---|---|---|---|---|---|
| Multi-account 401/403/429 cooldown, session affinity eviction, and `needsReauth` exclusion | E4 (Runtime pool router & pre-output recovery loops) | `src/oauth/generic-account-failover.ts`, `src/oauth/anthropic-account-refusal.ts`, `src/server/responses/run-turn-execution.ts`, `src/codex/routing.ts` | A mid-stream error occurring *after* assistant output bytes have already been streamed to the client cannot replay the turn on another account; a singleton 1-account pool has no alternate to rotate to. | Post-output mid-stream errors still record cooldowns/health where supported, and singleton pools surface the upstream error directly to the caller. | Yes — described as "pre-output multi-account failover and cooldown hygiene". | `src/oauth/generic-account-failover.ts`, `src/oauth/anthropic-account-refusal.ts`, `src/codex/routing.ts` |

## 4. Before / After Diffs (`DIFFLEVEL-ROADMAP-01`)

### 4.1 `src/oauth/generic-account-failover.ts` & `src/oauth/generic-session-affinity.ts`
```diff
--- a/src/oauth/generic-account-failover.ts
+++ b/src/oauth/generic-account-failover.ts
@@ -119,6 +119,7 @@
 function isCooled(provider: string, accountId: string, now: number, family?: QuotaModelFamily): boolean {
+  if (family !== undefined && isCooled(provider, accountId, now, undefined)) return true;
   const entry = health.get(healthKey(provider, accountId, family));
   if (!entry) return false;
@@ -418,6 +419,12 @@
   const failed = set.accounts.find(row => row.id === failedAccountId);
   if (failed && credentialGeneration(failed.credential) === sentGeneration) {
     health.set(healthKey("google-antigravity", failedAccountId), {
       cooldownUntil: now + DEFAULT_COOLDOWN_MS,
       cooldownSource: "auth",
       identity: sentGeneration,
     });
     health.set(healthKey("google-antigravity", failedAccountId, family), {
       cooldownUntil: now + DEFAULT_COOLDOWN_MS,
       cooldownSource: "auth",
       identity: sentGeneration,
     });
+    presence.delete("google-antigravity");
     sweepExpiredOnWrite(now);
   }
```

### 4.2 `src/oauth/cursor.ts`, `src/oauth/index.ts`, `src/server/responses/request-transport.ts`, `src/server/responses/run-turn-execution.ts`
```diff
--- a/src/oauth/index.ts
+++ b/src/oauth/index.ts
@@ -728,9 +728,10 @@
 const FORCE_REFRESH_PROVIDERS = new Set([
   "xai",
   "github-copilot",
   "kiro",
   "google-antigravity",
+  "cursor",
   "orcarouter-oauth",
   "devin",
   "workbuddy-ai",
   "dsh-account",
 ]);
```
```diff
--- a/src/server/responses/request-transport.ts
+++ b/src/server/responses/request-transport.ts
@@ -184,9 +184,10 @@
   const isOAuth401ReplayProvider = (
     route.providerName === "xai"
     || route.providerName === "github-copilot"
     || route.providerName === "kiro"
     || route.providerName === "google-antigravity"
+    || route.providerName === "cursor"
     || route.providerName === "orcarouter-oauth"
     // runTurn transport: the replay runs on the first-event preflight in run-turn-execution.
     || route.providerName === "devin"
```

### 4.3 `src/oauth/anthropic-account-refusal.ts` & `src/codex/chatgpt-refresh-failure.ts`
```diff
--- a/src/oauth/anthropic-account-refusal.ts
+++ b/src/oauth/anthropic-account-refusal.ts
@@ -121,5 +121,6 @@
   if (wasAccountAutoPaused(response)) {
+    routing.clearAnthropicSessionAffinityForAccount(sent.accountId);
     if (!options.canRetry || options.signal?.aborted) return null;
     return pickAlternateAnthropicAccount(options.config, sent.accountId, Date.now(),
```
```diff
--- a/src/codex/chatgpt-refresh-failure.ts
+++ b/src/codex/chatgpt-refresh-failure.ts
@@ -2,5 +2,5 @@
 const REFRESH_DIAGNOSTIC_CODES = [
   "invalid_grant", "refresh_token_invalidated", "token_invalidated", "refresh_token_reused",
-  "refresh_token_expired", "invalid_client", "invalid_request", "server_error",
+  "refresh_token_expired", "account_deactivated", "deactivated_workspace", "invalid_client", "invalid_request", "server_error",
   "temporarily_unavailable", "rate_limit_exceeded", "unsupported_grant_type", "invalid_scope",
 ] as const;
@@ -35,3 +35,3 @@
-    if (["invalid_grant", "refresh_token_invalidated", "token_invalidated", "refresh_token_reused"].includes(exactCode ?? "")) {
+    if (["invalid_grant", "refresh_token_invalidated", "token_invalidated", "refresh_token_reused", "account_deactivated", "deactivated_workspace"].includes(exactCode ?? "")) {
       reason = "revoked";
```

## 5. Activation Scenarios (`C-ACTIVATION-GROUNDING-01`) & Verifiers (`PLAN-VERIFIER-REAL-01`)

1. **Conditional Path 1 — Google Antigravity `invalid_grant` refresh -> `needsReauth` + bare cooldown check under model family**:
   - *Trigger*: Seed 2 Antigravity accounts (`acc-1`, `acc-2`); have `acc-1` return 401 on inference and 400 `{"error":"invalid_grant"}` on refresh; also test recording a bare `"auth"` cooldown on `acc-1` and querying `eligibleFailoverAccounts("google-antigravity", now, "gem")`.
   - *Observable Effect*: `acc-1` is marked `needsReauth: true`, `acc-2` serves the replayed turn, and a bare `"auth"` cooldown excludes `acc-1` even when queried with `family = "gem"` or `"cla"`.
2. **Conditional Path 2 — Cursor preflight 401/403/revoked refresh failover**:
   - *Trigger*: Seed 2 Cursor accounts (`cur-1`, `cur-2`); have `cur-1` fail preflight with 401 (and refresh fail with 401 `invalid_grant` or `shouldLogout: true`) or preflight 403 `permission_denied`.
   - *Observable Effect*: `cur-1` is marked `needsReauth` (on dead refresh) or cooled (on 403), session affinity is unbound from `cur-1`, and `runTurn` replays cleanly on `cur-2`.
3. **Conditional Path 3 — Anthropic auto-pause affinity eviction & Codex `deactivated_workspace` / `account_deactivated` terminal classification**:
   - *Trigger*: Trigger `wasAccountAutoPaused` on an Anthropic account with an active `sessionAffinity` binding, and trigger `deactivated_workspace` / `account_deactivated` refresh failure on a Codex pool account.
   - *Observable Effect*: Anthropic auto-pause immediately evicts the session affinity binding for the paused account, and `classifyChatgptRefreshFailure` classifies `deactivated_workspace` / `account_deactivated` as terminal `revoked`.

### Verifier Commands (Run & Verified in P Phase per `PLAN-VERIFIER-REAL-01`)
- `bun test tests/oauth/generic-oauth-failover.test.ts tests/oauth/oauth-account-auto-pause.test.ts tests/adapters/anthropic/anthropic-revoked-token.test.ts tests/claude-integration/messages-revoked-token.test.ts tests/oauth/chatgpt-token-expiry.test.ts` — baseline exit code `0`.
- `bun run typecheck && bun run privacy:scan && bun run structure:check && bun test tests/ci-workflows/file-size-ratchet.test.ts` — baseline exit code `0`.
