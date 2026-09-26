# 030 — Kiro refusal classes and account failover

- Branch: `codex/kiro-lb2-030-refusal-failover`.
- Depends on: 020 (all Kiro physical sends use `ctx.executor` and the shared send budget), 010 (`src/providers/kiro-account-state-disk.ts` exports `hydrateKiroAccountState(): void`, `persistKiroAccountState(): void`, `kiroEvidenceIdentity(account: ProviderAccount): string`, and stores `KiroPersistedVerdict { identity: string; exhausted: boolean; overageEnabled: boolean; resetAt?: number; observedAt: number }`). 010 also adds optional UUID `ProviderAccount.loginId` on every login write, preserves it through normalization/refresh, and hashes `[account.id, account.loginId ?? String(account.addedAt ?? ""), cred.accountId ?? cred.email ?? "", cred.kiro?.profileArn ?? "", cred.kiro?.clientId ?? ""]` (no authType). Quota `updatedAt` and verdict `observedAt` are independent in 010. Rebase the hunks below onto those two landed layers before editing.
- Adopted inventory: P4/I, P5/E3, A5, P9 in `001_research_gap_inventory.md`.
- Architect decisions: D030-1, D030-2, D030-3 in `000_plan.md`. This is a Kiro-only semantic extension of the generic OAuth seam. No non-Kiro rotation rule changes.
- Classification: C4 for account eligibility/auth, docs-only planning here. Source anchors below are from `bb3f3c2d0d`; lines from 010/020 must be rechecked on the stacked base.

## Current state and evidence

| Function / path | Current contract at `bb3f3c2d0d` |
|---|---|
| `rotateGenericOAuthAccountOn429`, `src/oauth/generic-account-failover.ts:346-415` | Only 429 is represented. It parses `Retry-After`, otherwise uses measured exhaustion or a one-minute default, writes process-local health, then selects another eligible stored account. `eligibleIdsIn` excludes `needsReauth` and current cooldowns (`:187-202`); `preferredInitialAccount` checks Kiro's measured exhaustion (`:443-513`). |
| `prepareAdapterExchange`, `src/server/responses/adapter-dispatch.ts:563-626,848-951` | A Kiro 401 can force one refresh/replay; refresh failure currently returns 401. Generic account rotation has a 429-only loop, caps rotations, reserves a credential hop, applies the full OAuth snapshot, and rebuilds. A response marked non-replayable exits at `:566-569`. |
| `createAdapterContinuations`, `src/server/responses/adapter-continuation.ts:400-475` | A terminal-guard continuation has its own 429-only generic rotation arm and shares the rotation count and send reservation. It checks `isNonReplayableResponse` at `:406-411`. |
| `executeResponsesRunTurn`, `src/server/responses/run-turn-execution.ts:371-405` | Its preflight arm still calls `rotateGenericOAuthAccountOn429` for Kiro via `_kiroAuthContext` (`:61`); 030 must feed it the same bounded classifier and rotator. The error event is retained until replay admission so failed alternate resolution can return that original preflight error. |
| `preparePassthroughExchange`, `src/server/responses/passthrough-dispatch.ts:1313-1373` | Native Responses has a separate 429-only arm. Kiro uses an adapter (`src/adapters/kiro/adapter.ts:316-355`), so keep this arm unchanged; add a test proving no non-Kiro behavior drift. |
| `refreshResolvedOAuthSelection`, `src/server/responses/request-transport.ts:174-183`; initial selection `:515-584` | A selected account is refreshed and admitted as a full snapshot. Initial active-account resolution has no alternate on a terminal refresh error. `applyFailoverSnapshot` keeps the Kiro bearer, profile, and region paired (`:225-253`). |
| `terminal` / `refreshGenericAccountWithLock`, `src/oauth/index.ts:673-680,1024-1031,1060-1106` | Kiro refresh death is recognized only for HTTP 400/401 with an allowlisted OAuth code; the generic locked refresh marks exactly the credential generation `needsReauth`. Kiro's allowlist and bounded error parser are `src/oauth/kiro.ts:38-46,533-543`; do not broaden to a bare 400/401. |
| `commitKiroAccountUsageState` / `getKiroAccountExhaustion`, `src/providers/kiro-usage.ts:219-249` | Probe writes and reads an in-memory exhaustion verdict. `src/providers/quota.ts:488-503` writes it under the quota cache's generation guard. 010 adds disk continuity; 030 must use that same guarded owner, never a separate per-request map. |
| `readPersistedAccountQuotas` / `schedulePersistAccountQuotas`, `src/providers/account-quota-disk.ts:40-84`; `hydrateAccountQuotaCache` / `persistAccountQuotaCache`, `src/providers/quota/account-cache.ts:102-125` | At `bb3f3c2d0d` the disk file contains quota rows only. 010 owns the Kiro verdict map, independent quota/verdict timestamps, and `kiroEvidenceIdentity` fence. 030 consumes those exports and does not change the disk schema. |
| `isAccountQuotaExhausted`, `src/oauth/account-quota-rank.ts:126-135` | Kiro's explicit verdict beats a bare percent. The generic eligible roster itself currently excludes only reauth and cooldown (`src/oauth/generic-account-failover.ts:192-201`). |
| `readDisplaySafeErrorText`, `src/server/responses/core-errors.ts:14-31` | Reads a complete, bounded response body and substitutes a fallback for partial, oversized, or failed reads. A clone permits classification without consuming the original refusal. |
| `deliverAdapterResponse`, `src/server/responses/adapter-delivery.ts:74-116,120-135,191-264` | Streaming completion passes through `onCompletedResponse`; buffered completion has `adapterResponseReachedServingTerminal` at `:260-263`. These are the post-parse points for a *served* success, unlike a 200 response head. |
| `parseKiroAttempt`, `src/adapters/kiro/stream.ts:385-406` | A terminal error after emitted output is non-retryable. A second account must never replay that turn. |
| `fetchKiroWithRetry`, `src/adapters/kiro-retry.ts:287-338` | Unless `ctx.returnRawErrors` is set, the helper normalizes a final HTTP error before the outer rotation loop receives it (`:313-315,328-330`). `createKiroAdapter.fetchResponse` currently forwards `ctx` without setting that flag (`src/adapters/kiro/adapter.ts:316-331`); the Kiro fallback leg already sets it (`:239`). With explicit pool disablement, Kiro should keep the existing same-account retry shape. Layer 030 must preserve the complete bounded refusal body through classification and still apply 020's public 5xx hygiene. |
| `inspectKiroThrottle`, `src/adapters/kiro-retry.ts:227-253,303-332` | A transient 429 currently enters the same-account throttle loop before the Responses account rotator sees it. With a Kiro account pool, return that bounded refusal promptly so the account layer can cool and rotate. |
| `getAccountCredentialWithStatus` / `captureOAuthAccountSelection`, `src/oauth/store.ts:1055-1062,1088-1095` | The first reads selected row and `needsReauth`; the second captures active account identity/revision. Both support the terminal-refresh generation fence. |

Reference facts only (no AGPL implementation or structure copied): kiro-lb recognizes `USER_REQUEST_RATE_EXCEEDED` as a short rate cooldown (`/tmp/kiro-lb/kiro/account_manager.py:1496-1512`), `MONTHLY_REQUEST_COUNT` as monthly exclusion (`:1539-1555`), and `TEMPORARILY_SUSPENDED` or the four q-host wording markers as suspension (`/tmp/kiro-lb/kiro/kiro_errors.py:23-28,54-71`, `/tmp/kiro-lb/kiro/account_manager.py:1514-1537`). Its HTTP client returns a suspended 403 for account failover before refreshing (`/tmp/kiro-lb/kiro/http_client.py:308-337`). It also treats generic 429 as rate and a 400 `MONTHLY_REQUEST_COUNT` as account-scoped (`/tmp/kiro-lb/kiro/account_errors.py:119-150`). The broader reference classifier rotates ordinary 403 and some model errors; **do not adopt those**: an ordinary 403 or unknown 400 remains an ordinary client error. Its success clears old quarantine (`/tmp/kiro-lb/kiro/account_manager.py:1393-1425`), but our clear must additionally fence identity and observation order.

## File change map and executable patch design

The implementation PR's complete path map (010's new disk entrypoint is a dependency, not a 030 write):

| Status | Exact path(s) | Change |
|---|---|---|
| NEW | `src/adapters/kiro-refusal.ts`, `src/oauth/kiro-terminal-failover.ts` | Strict refusal classifier and generation-fenced terminal-refresh alternate. Full file content below. |
| MODIFY | `src/adapters/kiro/adapter.ts`, `src/adapters/kiro-retry.ts`, `src/adapters/base.ts` | Raw bounded refusal handoff and pooled 429 return; transport supplies an explicit Kiro move-enabled bit in fetch context. |
| MODIFY | `src/oauth/generic-account-failover.ts`, `src/providers/kiro-usage.ts` | Kiro class-aware health, eligibility, and verdict ordering. |
| DEPENDENCY ONLY | `src/oauth/types.ts`, `src/oauth/store.ts` | 010 adds and serializes `ProviderAccount.loginId` UUID on every login write, including in-place replacement; normalization validates UUID and refresh writers preserve it; account-set clone/serialization retains it as well (`src/oauth/store.ts:1189`). |
| DEPENDENCY ONLY | `src/providers/kiro-account-state-disk.ts`, `src/providers/account-quota-disk.ts`, `src/providers/quota/account-cache.ts` | 010 owns identity-fenced independent quota/verdict persistence and hydration; 030 writes none of these files. |
| MODIFY | `src/server/responses/adapter-dispatch.ts`, `src/server/responses/adapter-continuation.ts`, `src/server/responses/run-turn-execution.ts`, `src/server/responses/request-transport.ts`, `src/server/responses/adapter-delivery.ts`, `src/types/request.ts`, `src/adapters/kiro/stream.ts` | Bounded pre-output rotation in adapter, continuation, and run-turn arms; closed-set preflight refusal metadata, terminal refresh alternate, served-success clear. |
| MODIFY | `src/server/responses/sidecar-execution.ts`, `src/web-search/loop.ts`, `src/images/loop.ts` | Kiro-only 400/403/429 classification in web-search/image sidecar callbacks; preserve non-Kiro 429 key-first behavior. |
| NEW | `tests/providers/kiro/kiro-refusal.test.ts`, `tests/oauth/kiro-refusal-failover.test.ts`, `tests/server/server-kiro-refusal-e2e.test.ts` | Focused classifier, store, and local server regressions. |
| MODIFY | `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` | Register the three new test basenames. |
| MODIFY | `docs-site/src/content/docs/reference/adapters.md`, `docs-site/src/content/docs/reference/cli/providers-accounts.md` | English Kiro behavior and account-pool sentences. |
| MODIFY | `docs-site/src/content/docs/ko/reference/adapters.md`, `docs-site/src/content/docs/ko/reference/cli/providers-accounts.md`, `docs-site/src/content/docs/ja/reference/adapters.md`, `docs-site/src/content/docs/ja/reference/cli/providers-accounts.md`, `docs-site/src/content/docs/zh-cn/reference/adapters.md`, `docs-site/src/content/docs/zh-cn/reference/cli/providers-accounts.md`, `docs-site/src/content/docs/zh-tw/reference/adapters.md`, `docs-site/src/content/docs/zh-tw/reference/cli/providers-accounts.md` | Translate the same refusal and recovery sentences; keep existing page structure. |
| MODIFY | `docs-site/src/content/docs/fr/reference/adapters.md`, `docs-site/src/content/docs/fr/reference/cli/providers-accounts.md`, `docs-site/src/content/docs/ru/reference/adapters.md`, `docs-site/src/content/docs/ru/reference/cli/providers-accounts.md`, `docs-site/src/content/docs/tr/reference/adapters.md`, `docs-site/src/content/docs/tr/reference/cli/providers-accounts.md` | Translate the same refusal and recovery sentences; keep existing page structure. |
| MODIFY | `structure/providers/kiro.md`, `structure/providers-and-adapters.md`, `structure/transports/responses-failover.md` | Document Kiro refusal evidence, account identity, and replay/budget rule. |

The following is the full intended classification module. It classifies only a complete, bounded body; the caller obtains one with `readDisplaySafeErrorText(response.clone(), signal, "")` before consuming or cancelling the original response. A malformed/oversize/aborted read yields `other` for 400/403 and ordinary `rate` for 429. No request payload or credential enters this module.

**NEW `src/adapters/kiro-refusal.ts`:**

```ts
/** Account-scoped Kiro refusals. Unknown data never convicts an account. */
export type KiroRefusalKind = "rate" | "monthly_quota" | "suspended" | "other";
export interface KiroRefusal { kind: KiroRefusalKind; resetAt?: number }
const SUSPENSION_WORDS = [
  "temporarily suspended", "temporarily is suspended",
  "locked your account", "locked it as a",
] as const;
export function classifyKiroRefusal(status: number, bodyText: string): KiroRefusal {
  let reason: unknown;
  let message: unknown;
  try {
    const row: unknown = JSON.parse(bodyText);
    if (row && typeof row === "object" && !Array.isArray(row)) {
      reason = (row as Record<string, unknown>).reason;
      message = (row as Record<string, unknown>).message;
    }
  } catch { /* An unrecognised body is not an account verdict. */ }
  // This is an HTTP-status AND exact-reason decision, not a substring search
  // across an arbitrary JSON/error echo supplied by a client.
  if ((status === 400 || status === 429) && reason === "MONTHLY_REQUEST_COUNT")
    return { kind: "monthly_quota" };
  if (status === 403 && (reason === "TEMPORARILY_SUSPENDED"
    || (typeof message === "string" && SUSPENSION_WORDS.some(word => message.toLowerCase().includes(word)))))
    return { kind: "suspended" };
  if (status === 429) return { kind: "rate" };
  return { kind: "other" };
}
```

`resetAt` is intentionally absent in this classifier until a verified *refusal-body* reset field exists. The caller obtains reset time from the same account's 010 cached usage row; never infer it from arbitrary text. This preserves the exact requested signature and makes absent evidence harmless.

**MODIFY `src/adapters/kiro/adapter.ts`:** the outer dispatch owns Kiro HTTP refusal classification. Pass raw errors to it; the outer bounded reader and existing public formatting then own the body. Ask the retry helper to return a pooled 429 promptly. 020's fixed public 5xx text must still be applied at the last error formatter, and the focused test must assert no raw 5xx bytes reach the client.

```diff
@@ src/adapters/kiro/adapter.ts:8-8 @@
 import { resolveKiroApiRegion, resolveKiroRequestProfile } from "../../oauth/kiro";
+// The transport supplies ctx.kiroPreferAccountFailover from its Kiro-only move gate.
@@ src/adapters/kiro/adapter.ts:327-331 @@
-      return fetchKiroWithRetry(request, requestOnPhysicalSend
-        ? { ...ctx, onPhysicalSend: (send: KiroPhysicalSend) => forwardPhysicalSend(send, 0) }
-        : ctx);
+      return fetchKiroWithRetry(request, requestOnPhysicalSend
+        ? { ...ctx, returnRawErrors: true, onPhysicalSend: (send: KiroPhysicalSend) => forwardPhysicalSend(send, 0) }
+        : { ...ctx, returnRawErrors: true },
+        { preferAccountFailover: ctx?.kiroPreferAccountFailover === true });
```

**MODIFY `src/adapters/base.ts` and the Kiro `fetchResponse` call sites in `src/server/responses/adapter-dispatch.ts` / `adapter-continuation.ts`:** add `kiroPreferAccountFailover?: boolean` to `AdapterFetchContext`. Set it only for Kiro from `isKiroAccountMoveEnabled(config)` at initial and replay dispatch; leave it absent for every other provider. That bit prevents an explicitly disabled Kiro pool from short-circuiting its existing same-account throttle retry merely because two accounts are stored. The adapter passes the bit to `fetchKiroWithRetry` as above. Test global false, provider false, unset, and true.

~~~diff
@@ src/adapters/base.ts:166-176 @@
 export interface AdapterFetchContext {
+  kiroPreferAccountFailover?: boolean;
@@ src/server/responses/adapter-dispatch.ts:300-305,469-475 @@
       upstreamResponse = await transportState.activeAdapter.fetchResponse(builtInitialRequest, {
+        kiroPreferAccountFailover: route.providerName === "kiro" && isKiroAccountMoveEnabled(config),
            return await transportState.activeAdapter.fetchResponse(retryRequest, {
+              kiroPreferAccountFailover: route.providerName === "kiro" && isKiroAccountMoveEnabled(config),
@@ src/server/responses/adapter-continuation.ts:203-208 @@
           return await transportState.activeAdapter.fetchResponse(builtContinuationRequest, {
+            kiroPreferAccountFailover: route.providerName === "kiro" && isKiroAccountMoveEnabled(config),
~~~

**MODIFY `src/adapters/kiro-retry.ts`:** keep the existing same-account throttle gate for a one-account install and accountless calls; for a pool, return the first 429 to the outer refusal classifier. This changes neither the physical-send budget nor 020's alternate-host policy.

```diff
@@ src/adapters/kiro-retry.ts:287-288 @@
-export async function fetchKiroWithRetry(request: AdapterRequest, ctx: AdapterFetchContext = {}): Promise<Response> {
+export async function fetchKiroWithRetry(
+  request: AdapterRequest, ctx: AdapterFetchContext = {},
+  opts: { preferAccountFailover?: boolean } = {},
+): Promise<Response> {
@@ src/adapters/kiro-retry.ts:308-310 @@
       const response = await fetchKiroAttempt(request, ctx, timeoutMs, notePhysicalSend);
       const throttle = await inspectKiroThrottle(response, ctx.abortSignal);
+      if (throttle && opts.preferAccountFailover) {
+        releaseKiroThrottleProbe(probeToken);
+        return throttle.response;
+      }
       if (!throttle || !throttle.transient) {
```

**MODIFY `src/oauth/generic-account-failover.ts`:** add a Kiro-only class argument while preserving the public 429 wrapper. The displayed hunk is the replacement of `:340-373`; retain the selection code `:375-415` byte-for-byte under the new function. Keep suspension process-local (24h), rate at a short 10s cooldown, and monthly state in 010's verdict owner. Import `KiroRefusalKind` and the 010/030 verdict helper only in this module; it must not import `src/lab/`.

```diff
@@ src/oauth/generic-account-failover.ts:36-39 @@
 import { parseRetryAfterMs } from "../combos/failover";
+import type { KiroRefusalKind } from "../adapters/kiro-refusal";
@@ src/oauth/generic-account-failover.ts:153-166 (Kiro-only explicit-off gate) @@
+export function isKiroAccountMoveEnabled(config: OcxConfig, now = Date.now()): boolean {
+  if (config.oauthAccountFailover?.enabled === false
+    || config.providers?.kiro?.oauthAccountFailover?.enabled === false) return false;
+  return hasFailoverAccountQuorum("kiro", now);
+}
@@ src/oauth/generic-account-failover.ts:76-79 @@
 interface AccountHealth {
   cooldownUntil: number;
-  cooldownSource: "retry-after" | "default";
+  cooldownSource: "retry-after" | "default" | "kiro-suspension";
 }
@@ src/oauth/generic-account-failover.ts:93-104 @@
 const healthKey = (provider: string, accountId: string, family?: QuotaModelFamily) =>
   family ? `${provider}\u0000${accountId}\u0000${family}` : `${provider}\u0000${accountId}`;
+export function quarantineKiroSuspendedAccount(accountId: string, now = Date.now()): void {
+  health.set(healthKey("kiro", accountId), { cooldownUntil: now + 24 * 60 * 60_000, cooldownSource: "kiro-suspension" });
+  sweepExpiredOnWrite(now);
+}
@@ src/oauth/generic-account-failover.ts:192-201 @@
   return set.accounts
-    .filter(account => account.needsReauth !== true && !isCooled(providerName, account.id, now, family))
+    .filter(account => account.needsReauth !== true
+      && !isCooled(providerName, account.id, now, family)
+      && (providerName !== "kiro" || (!isCooled("kiro", account.id, now)
+        && kiroAccountEvidence(account, now).exhausted !== true)))
     .map(account => account.id);
@@ src/oauth/generic-account-failover.ts:443-513 (new sibling of preferredInitialAccount) @@
+/** Refusal-aware first admission is allowed only while Kiro account moves are enabled. */
+export function refusalAwareInitialKiroAccount(
+  config: OcxConfig, activeId: string, now = Date.now(), requestedModelId?: string | null,
+): string | null {
+  if (!isKiroAccountMoveEnabled(config, now)) return null;
+  const set = getAccountSet("kiro");
+  if (!set || set.accounts.length < 2) return null;
+  const active = set.accounts.find(row => row.id === activeId);
+  if (!active) return null;
+  const suspended = health.get(healthKey("kiro", activeId));
+  const excluded = (suspended?.cooldownSource === "kiro-suspension" && suspended.cooldownUntil > now)
+    || kiroAccountEvidence(active, now).exhausted === true;
+  if (!excluded) return null;
+  const order = set.accounts.map(row => row.id);
+  const at = order.indexOf(activeId);
+  if (at < 0) return null;
+  const ring = [...order.slice(at + 1), ...order.slice(0, at)];
+  const eligible = new Set(eligibleFailoverAccounts("kiro", now,
+    classifyModelFamilyForQuota("kiro", requestedModelId)));
+  return ring.find(id => id !== activeId && eligible.has(id)) ?? null;
+}
@@ src/oauth/generic-account-failover.ts:346-373 @@
 export function rotateGenericOAuthAccountOn429(
   config: OcxConfig, providerName: string, failedAccountId: string,
   retryAfterHeader: string | null | undefined, now = Date.now(), requestedModelId?: string | null,
 ): string | null {
+  return rotateGenericOAuthAccountOnRefusal(
+    config, providerName, failedAccountId, "rate", retryAfterHeader, now, requestedModelId,
+  );
+}
+export function rotateGenericOAuthAccountOnRefusal(
+  config: OcxConfig, providerName: string, failedAccountId: string,
+  kind: KiroRefusalKind, retryAfterHeader: string | null | undefined,
+  now = Date.now(), requestedModelId?: string | null, monthlyCooldownMs?: number,
+): string | null {
   if (!isGenericOAuthFailoverEnabled(config, providerName)) return null;
+  if (providerName === "kiro" && !isKiroAccountMoveEnabled(config, now)) return null;
   const set = getAccountSet(providerName);
   if (!set || set.accounts.length < 2) return null;
-  const parsed = parseRetryAfterMs(retryAfterHeader, now, { preserveImmediate: true, preserveServerDelay: true });
-  const exhausted = parsed === undefined ? exhaustedCooldownMs(providerName, failedAccountId, now) : null;
-  const cooldownMs = exhausted ?? parsed ?? DEFAULT_COOLDOWN_MS;
+  if (providerName !== "kiro" && kind !== "rate") return null;
+  const parsed = parseRetryAfterMs(retryAfterHeader, now, { preserveImmediate: true, preserveServerDelay: true });
+  const exhausted = parsed === undefined ? exhaustedCooldownMs(providerName, failedAccountId, now) : null;
+  const cooldownMs = providerName !== "kiro"
+    ? exhausted ?? parsed ?? DEFAULT_COOLDOWN_MS
+    : kind === "rate" ? parsed ?? 10_000
+    : kind === "suspended" ? 24 * 60 * 60_000
+    : monthlyCooldownMs ?? 0;
   const family = classifyModelFamilyForQuota(providerName, requestedModelId);
   health.set(healthKey(providerName, failedAccountId, family), {
     cooldownUntil: now + cooldownMs,
     cooldownSource: providerName === "kiro" && kind === "suspended"
       ? "kiro-suspension" : parsed ? "retry-after" : "default",
   });
   sweepExpiredOnWrite(now);
```

`refusalAwareInitialKiroAccount` is a guarded initial-admission exclusion, not least-loaded ranking: an unset setting permits it through presence-is-consent, but **either** explicit global or Kiro-provider `enabled: false` vetoes every Kiro account move, including terminal-refresh fallback and reactive refusal rotation. Keep this Kiro-only so non-Kiro rotation retains its current behavior. Singleton/all-excluded pools still send the active account. `preferredInitialAccount` and least-loaded ranking remain under effective pool enablement. `noteKiroMonthlyRefusal` returns the remaining reset-aligned period, bounded by 010 freshness and a conservative fallback (see below). The dispatch/continuation callers record and persist it **before** checking roster quorum or send budget, so even a single account gets an exhaustion verdict. They likewise call `quarantineKiroSuspendedAccount` before that check. The rotator only chooses an alternate and refreshes process-local health for a pool. Keep `rotateGenericOAuthAccountOn429` behavior for every other provider exactly as at `:346-415`; its wrapper uses the old default minute/Retry-After/exhaustion formula for them. A `kind: "other"` is never passed to the rotator.

The extra Kiro eligibility filter above is required for restart continuity: process-local `health` disappears on restart, while the 010 verdict does not. Import `kiroAccountEvidence` from `src/providers/kiro-usage.ts`; it hydrates once before the first read and applies identity, TTL, and reset bounds to both quota percentage and verdict without loading auth.json per account. 010 changes routing call sites of `getCachedProviderAccountQuota`, `isAccountQuotaExhausted`, and `getKiroAccountExhaustion` to pass their already-loaded `ProviderAccount` into this single read. 030 `eligibleIdsIn` and initial admission pass the account object from their roster; 040 eligibility and 070 `autoSelectable` do the same. The ranking path uses `kiroAccountEvidence(account, now).quotaPercent`, never an unfenced cache row. 030's confirmed suspension/monthly refusal excludes the active account only when `isKiroAccountMoveEnabled(config)` permits movement; either explicit false leaves the active account in place. If every account is excluded, the first attempt still uses the active account. 040's `maxConcurrentPerAccount` is separately opt-in: when configured and the pool may not move (explicit false or singleton), a full cap waits up to its bounded wait and then returns retryable HTTP 503 with closed-set code `account_capacity` and `Retry-After`; when movement is allowed, it tries another eligible account first.

**MODIFY `src/providers/kiro-usage.ts`:** 010 retains the usage-state map and exports `kiroAccountEvidence(account: ProviderAccount, now?: number): { quotaPercent?: number; exhausted?: boolean; resetAt?: number }`. Insert the refusal/success mutations beside its guarded verdict mutation (at base `bb3f3c2d0d`, after `getKiroAccountExhaustion`, `:238-250`), using 010's persisted verdict type and identity helper. The routing read hydrates once per process and returns unknown for mismatched identity, TTL expiry, or elapsed reset for **both** quota and verdict. Persistence is scheduled by the caller after mutation. Because this file imports 010's `kiroEvidenceIdentity` at runtime, the 010 disk module must expose that pure helper without a runtime import back into `kiro-usage.ts`.

```diff
@@ src/providers/kiro-usage.ts:14-25 @@
 import { getValidAccessSnapshotForAccount } from "../oauth";
+import { credentialGeneration, getAccountSet } from "../oauth/store";
+import { kiroEvidenceIdentity } from "./kiro-account-state-disk";
@@ src/providers/kiro-usage.ts:246-250 @@
   return {
     exhausted: entry.exhausted,
     ...(entry.nextResetAt !== undefined ? { nextResetAt: entry.nextResetAt } : {}),
   };
 }
+/** An observed monthly refusal beats an older probe, never a newer one. */
+export function noteKiroMonthlyRefusal(accountId: string, generation: string, observedAt = Date.now()): number {
+  const key = `kiro\u0000${accountId}`;
+  const live = getAccountSet("kiro")?.accounts.find(row => row.id === accountId);
+  if (!live || credentialGeneration(live.credential) !== generation) return 0;
+  const identity = kiroEvidenceIdentity(live);
+  const old = usageState.get(key);
+  const same = old?.identity === identity ? old : undefined;
+  if (same && same.observedAt >= observedAt) return Math.max(0, (same.nextResetAt ?? observedAt) - observedAt);
+  const resetAt = kiroAccountEvidence(live, observedAt).resetAt; // Already identity/TTL/reset bounded by 010.
+  const until = Math.min(resetAt ?? observedAt + ACCOUNT_QUOTA_TTL_MS, observedAt + ACCOUNT_QUOTA_TTL_MS);
+  usageState.set(key, { identity, exhausted: true, overageEnabled: same?.overageEnabled ?? false,
+    ...(resetAt ? { nextResetAt: resetAt } : {}), observedAt });
+  return Math.max(0, until - observedAt);
+}
+/** A completed turn supersedes only an older verdict on the same live identity. */
+export function noteKiroServedSuccess(accountId: string, generation: string, observedAt = Date.now()): boolean {
+  const live = getAccountSet("kiro")?.accounts.find(row => row.id === accountId);
+  if (live && credentialGeneration(live.credential) === generation) {
+    const key = `kiro\u0000${accountId}`;
+    const identity = kiroEvidenceIdentity(live);
+    const old = usageState.get(key);
+    if (old?.identity === identity && old.observedAt < observedAt && old.exhausted) {
+      usageState.set(key, { ...old, exhausted: false, observedAt });
+      return true;
+    }
+  }
+  return false;
+}
```

The implementation retains `ACCOUNT_QUOTA_TTL_MS` and reads the live `ProviderAccount` once per mutation; routing callers pass their already-loaded roster account to `kiroAccountEvidence` and incur no per-account auth-store load. The generation argument comes from the serving snapshot captured before send; it fences an in-flight response against a token refresh. The persisted `identity` is 010 `kiroEvidenceIdentity(account)`: SHA-256 hex of JSON `[account.id, account.loginId ?? String(account.addedAt ?? ""), cred.accountId ?? cred.email ?? "", cred.kiro?.profileArn ?? "", cred.kiro?.clientId ?? ""]`. `authType` is omitted because `normalizeCredential` drops it (`src/oauth/store.ts:539`). 010 writes a fresh random-UUID `loginId` on **every** `saveCredentialWithReceipt` login, whether append or in-place replacement (including identity-less slot upgrade), validates/preserves it in `normalizeAuthStore`, and leaves it untouched on token refresh. Legacy rows lacking it use `addedAt`. Two people logging into the same identity-less slot therefore receive different evidence identities while a token refresh keeps the identity. A removed/replaced identity cannot write or hydrate its prior verdict. A refusal forces `exhausted: true` regardless of overage; without a reset, it expires at 010 TTL. `observedAt` orders verdicts independently of quota `updatedAt`.

010 owns the atomic file contract from the start: a refusal can persist before any probe, after an older quota probe, or after a completed success, because quota `updatedAt` and verdict `observedAt` are independent. Its reader validates type, identity, TTL, reset, and live account before hydration. 030 changes only the guarded verdict owner above; it does not edit `src/providers/account-quota-disk.ts` or `src/providers/quota/account-cache.ts`. The 030 regression reads the persisted file after restart in all three sequences, including a re-login of the same account id with a different `loginId` / `kiroEvidenceIdentity` and token-only refresh with the same identity. The first must degrade to unknown, the second must retain evidence.

**MODIFY `src/server/responses/adapter-dispatch.ts` (rebase-verify at this layer's P):** put the new refusal loop inside `if (route.providerName === "kiro")`, before an `else` containing the original base `:856-951` non-Kiro 429 loop verbatim. In the Kiro branch, classify a clone of the original response using `readDisplaySafeErrorText(upstreamResponse.clone(), upstream.signal, "")` only for status 400/403/429, while replayable and before client bytes. Classify once per iteration. Unknown 400/403 follows the existing error path; confirmed rate/monthly/suspension enters the **single bounded account-rotation policy** owned by `rotateGenericOAuthAccountOnRefusal` across the existing adapter, continuation, run-turn, and sidecar loops. 040 capacity exclusion contributes candidates to that policy and must not add another account-rotation loop. Record monthly/suspension evidence before quorum or budget checks, even for a singleton. The Kiro branch retains the existing hop reservation, full-snapshot application, and no-output guard at base `:862-951`. Keep the original Response readable through `failoverAccountSnapshot`, `applyFailoverSnapshot`, and local adapter setup: cancel its body only after the replacement account is admitted and immediately before replay. If budget, roster, candidate refresh, or snapshot application fails, deliver the original status/body. Use only closed-set telemetry codes/statuses, never the parsed upstream message or credential material. Do not carry the mixed provider ternaries or delayed body cancellation from the Kiro hunk into the non-Kiro `else`.

The raw-error handoff bypasses the retry helper's normal final-error formatting. Preserve 020's public 5xx hygiene with the fixed-text replacement below before either combo failure handling or the general error reader. This is a public response rule, not an internal classification rule.

```diff
@@ src/server/responses/adapter-dispatch.ts:56-60 @@
  rotateGenericOAuthAccountOn429,
+  rotateGenericOAuthAccountOnRefusal,
+  isKiroAccountMoveEnabled,
+  quarantineKiroSuspendedAccount,
  failoverAccountSnapshot,
} from "../../oauth/generic-account-failover";
+import { classifyKiroRefusal } from "../../adapters/kiro-refusal";
+import { noteKiroMonthlyRefusal } from "../../providers/kiro-usage";
+import { persistKiroAccountState } from "../../providers/kiro-account-state-disk";
@@ src/server/responses/adapter-dispatch.ts:856-860 @@
+      if (route.providerName === "kiro") {
      while (
-        upstreamResponse.status === 429
+        (upstreamResponse.status === 429 || (route.providerName === "kiro" && (upstreamResponse.status === 400 || upstreamResponse.status === 403)))
         && transportState.genericFailoverAccountId
-        && transportState.genericFailovers < transportState.genericFailoverLimit
+        && (route.providerName === "kiro"
+          || transportState.genericFailovers < transportState.genericFailoverLimit)
-        && isGenericOAuthFailoverEnabled(config, route.providerName)
+        && (route.providerName === "kiro" || isGenericOAuthFailoverEnabled(config, route.providerName))
       ) {
+        const refusal = route.providerName === "kiro"
+          ? classifyKiroRefusal(upstreamResponse.status, await readDisplaySafeErrorText(upstreamResponse.clone(), upstream.signal, ""))
+          : { kind: "rate" as const };
+        if (refusal.kind === "other") break;
+        let monthlyCooldownMs: number | undefined;
+        if (route.providerName === "kiro" && refusal.kind === "monthly_quota" && transportState.sentOAuthSnapshot) {
+          monthlyCooldownMs = noteKiroMonthlyRefusal(
+            transportState.sentOAuthSnapshot.accountId, transportState.sentOAuthSnapshot.generation, Date.now());
+          persistKiroAccountState();
+        }
+        if (route.providerName === "kiro" && refusal.kind === "suspended")
+          quarantineKiroSuspendedAccount(transportState.genericFailoverAccountId);
+        if (transportState.genericFailovers >= transportState.genericFailoverLimit
+          || !isGenericOAuthFailoverEnabled(config, route.providerName)
+          || (route.providerName === "kiro" && !isKiroAccountMoveEnabled(config))) break;
@@ src/server/responses/adapter-dispatch.ts:885-892 @@
-        const nextAccountId = rotateGenericOAuthAccountOn429(
+        const nextAccountId = route.providerName === "kiro" ? rotateGenericOAuthAccountOnRefusal(
+          config, route.providerName, transportState.genericFailoverAccountId,
+          refusal.kind, upstreamResponse.headers.get("retry-after"), Date.now(), route.modelId,
+          monthlyCooldownMs,
+        ) : rotateGenericOAuthAccountOn429(
           config, route.providerName, transportState.genericFailoverAccountId,
           upstreamResponse.headers.get("retry-after"), Date.now(), route.modelId,
         );
@@ src/server/responses/adapter-dispatch.ts:897-910 @@
-        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
+        if (route.providerName !== "kiro")
+          try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
         try {
           const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
-          transportState.genericFailovers += 1;
+          if (route.providerName !== "kiro") transportState.genericFailovers += 1;
           if (!await applyFailoverSnapshot(snapshot)) {
             hop.permit?.release();
-            break; // The original refusal remains readable.
+            break; // Kiro's original refusal remains readable.
           }
+          if (route.providerName === "kiro") transportState.genericFailovers += 1;
@@ src/server/responses/adapter-dispatch.ts:923-929 @@
           sendBudgetState.pendingHopPermit = hop.permit;
           let result: Response | { failed: Response };
           try {
+            // Admission and local adapter setup succeeded; replay is about to start.
+            if (route.providerName === "kiro")
+              try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* closed */ }
             result = await rebuildAndRefetch("oauth-account-429", () => {
@@ src/server/responses/adapter-dispatch.ts:951 (after Kiro loop) @@
+      } else {
+        // Copy the original base :856-951 loop here verbatim at P: status === 429,
+        // early genericFailovers++, pre-resolution body cancellation, and
+        // its existing reservation, replay, and error-delivery order.
+      }
@@ src/server/responses/adapter-dispatch.ts:1049-1051 @@
     if (!upstreamResponse.ok) {
+      if (route.providerName === "kiro" && upstreamResponse.status >= 500) {
+        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* closed */ }
+        upstreamResponse = new Response("Kiro upstream service error", { status: upstreamResponse.status });
+      }
       if (options.comboAttempt) {
```

**MODIFY `src/server/responses/adapter-continuation.ts`:** apply the same Kiro-only status predicate, bounded clone read, pre-quorum verdict write, `other` break, and class-aware rotation at base `:406-435`; retain `isNonReplayableResponse` and the **same** shared rotation count/reservation. Delete the base `try { void response.body?.cancel()... }` immediately before `failoverAccountSnapshot` (`:450-452`); after `applyFailoverSnapshot(snapshot, nextParsed)` and all local adapter setup succeed, cancel the original response immediately before `continue` starts the next send. If alternate resolution or admission fails, the original continuation refusal remains available for delivery. This path matters when a terminal guard issues a second Kiro request before delivery. Extract duplicated bounded classification into `src/adapters/kiro-refusal.ts` only if the exact call sites otherwise diverge.

```diff
@@ src/server/responses/adapter-continuation.ts:42-46 @@
  rotateGenericOAuthAccountOn429,
+  rotateGenericOAuthAccountOnRefusal,
+  isKiroAccountMoveEnabled,
+  quarantineKiroSuspendedAccount,
  failoverAccountSnapshot,
} from "../../oauth/generic-account-failover";
+import { classifyKiroRefusal } from "../../adapters/kiro-refusal";
+import { noteKiroMonthlyRefusal } from "../../providers/kiro-usage";
+import { persistKiroAccountState } from "../../providers/kiro-account-state-disk";
@@ src/server/responses/adapter-continuation.ts:406-412 @@
-       response.status === 429
+       (response.status === 429 || (route.providerName === "kiro" && (response.status === 400 || response.status === 403)))
        && transportState.genericFailoverAccountId
        && !isNonReplayableResponse(response)
-       && transportState.genericFailovers < transportState.genericFailoverLimit
+       && (route.providerName === "kiro"
+         || transportState.genericFailovers < transportState.genericFailoverLimit)
-        && isGenericOAuthFailoverEnabled(config, route.providerName)
+        && (route.providerName === "kiro" || isGenericOAuthFailoverEnabled(config, route.providerName))
      ) {
+      const refusal = route.providerName === "kiro"
+        ? classifyKiroRefusal(response.status, await readDisplaySafeErrorText(response.clone(), upstream.signal, ""))
+        : { kind: "rate" as const };
+      if (refusal.kind === "other") break;
+      let monthlyCooldownMs: number | undefined;
+      const identity = transportState.replayOAuthCredentialSnapshot;
+      if (route.providerName === "kiro" && refusal.kind === "monthly_quota" && identity) {
+        monthlyCooldownMs = noteKiroMonthlyRefusal(identity.accountId, identity.generation, Date.now());
+        persistKiroAccountState();
+      }
+      if (route.providerName === "kiro" && refusal.kind === "suspended")
+        quarantineKiroSuspendedAccount(transportState.genericFailoverAccountId);
+      if (transportState.genericFailovers >= transportState.genericFailoverLimit
+        || !isGenericOAuthFailoverEnabled(config, route.providerName)
+        || (route.providerName === "kiro" && !isKiroAccountMoveEnabled(config))) break;
@@ src/server/responses/adapter-continuation.ts:426-435 @@
-          ? rotateGenericOAuthAccountOn429(
+          ? (route.providerName === "kiro" ? rotateGenericOAuthAccountOnRefusal(
+            config, route.providerName, transportState.genericFailoverAccountId,
+            refusal.kind, response.headers.get("retry-after"), Date.now(), route.modelId,
+            monthlyCooldownMs,
+          ) : rotateGenericOAuthAccountOn429(
             config, route.providerName, transportState.genericFailoverAccountId,
             response.headers.get("retry-after"), Date.now(), route.modelId,
-          )
+          ))
          : null;
@@ src/server/responses/adapter-continuation.ts:450-463 @@
-          try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
+          if (route.providerName !== "kiro")
+            try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
           try {
             const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
-            transportState.genericFailovers += 1;
+            if (route.providerName !== "kiro") transportState.genericFailovers += 1;
             const applied = await applyFailoverSnapshot(snapshot, nextParsed);
             if (!applied) hop.permit?.release();
             if (applied) {
+              if (route.providerName === "kiro") transportState.genericFailovers += 1;
               invalidateSameTargetRequest();
@@ src/server/responses/adapter-continuation.ts:478-484 @@
               if (adapterOwnsDispatch) sendBudgetState.pendingHopPermit = hop.permit;
               nextContinuationRecoveryKind = "oauth-account-429";
+              // Admission and local setup succeeded; next iteration starts replay.
+              if (route.providerName === "kiro")
+                try { void response.body?.cancel().catch(() => {}); } catch { /* closed */ }
               continue;
```

**MODIFY `src/server/responses/request-transport.ts`:** initial Kiro terminal refresh rejection can occur before any HTTP send. Capture selected account id/generation, resolve it, and on a *code-classified* `OAuthLoginRequiredError` whose same account is now `needsReauth`, walk at most `GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST - 1` eligible alternate IDs. Resolve each through `getValidAccessSnapshotForAccount("kiro", id, { requireUsableAccount: true })`, then use `commitResolvedOAuthSelection(resolved, false)` behind an explicit terminal-alternate guard before a send. The base `commitResolvedOAuthSelection(resolved, true)` can reselect the dead active credential when proactive preference is not enabled. Kiro terminal fallback therefore runs only when `isKiroAccountMoveEnabled(config)` permits movement and uses non-proactive guarded admission. The guard also rejects a committed account id different from the alternate, rather than sending the dead account after a concurrent selection change. A missing account, transient refresh error, generic 401, or generation-changed stale error does not trigger this branch. Do not call `rotateGenericOAuthAccountOnRefusal` here: no upstream data-plane refusal exists and no cooldown should be added.

```diff
@@ src/server/responses/request-transport.ts:23-29 @@
   getValidAccessTokenSnapshot,
   publicOAuthAuthenticationErrorMessage,
+  OAuthLoginRequiredError,
   UnsupportedOAuthProviderError,
 } from "../../oauth";
+import { tryKiroAlternateAfterTerminalRefresh } from "../../oauth/kiro-terminal-failover";
@@ src/server/responses/request-transport.ts:515-530 @@
-        const preferredAccountId = isGenericFailoverProvider(route.providerName, route.provider)
-          ? preferredInitialAccount(config, route.providerName, Date.now(), route.modelId)
-          : null;
+        const activeId = oauthSelection?.accountId;
+        let refusalAwareId = route.providerName === "kiro" && activeId
+          ? refusalAwareInitialKiroAccount(config, activeId, Date.now(), route.modelId) : null;
+        const preferredAccountId = refusalAwareId ?? ((route.providerName !== "kiro"
+          || isKiroAccountMoveEnabled(config)) && isGenericFailoverProvider(route.providerName, route.provider)
+          ? preferredInitialAccount(config, route.providerName, Date.now(), route.modelId) : null);
+        // A safety exclusion is admitted without proactive preference, but only its exact
+        // resolved account id may proceed. Singleton/all-excluded falls back to active.
+        let terminalAlternateId: string | null = null;
+        let terminalRefreshError: OAuthLoginRequiredError | null = null;
@@ src/server/responses/request-transport.ts:535-546 @@
          } catch {
+            // An alternate that disappeared during resolution leaves an effectively
+            // all-excluded pool. Fall back to the active account; do not invent an error.
+            refusalAwareId = null;
            forgetGenericFailoverRoster(route.providerName);
@@ src/server/responses/request-transport.ts:548-553 @@
         } else {
+          const failedId = route.providerName === "kiro" ? oauthSelection?.accountId : undefined;
+          const failedRow = failedId ? getAccountCredentialWithStatus("kiro", failedId) : null;
+          const failedGeneration = failedRow ? credentialGeneration(failedRow.credential) : undefined;
+          try { resolved = await getValidAccessTokenSnapshot(route.providerName); }
+          catch (error) {
+            if (route.providerName !== "kiro" || !(error instanceof OAuthLoginRequiredError)
+              || !failedId || !failedGeneration) throw error;
+            const alternate = await tryKiroAlternateAfterTerminalRefresh(config, failedId, failedGeneration);
+            if (!alternate) throw error;
+            resolved = alternate;
+            terminalAlternateId = alternate.accountId;
+            terminalRefreshError = error;
+          }
         }
@@ src/server/responses/request-transport.ts:563-566 @@
-        const admitted = await commitResolvedOAuthSelection(resolved, true);
+        const safetyAlternateId = terminalAlternateId ?? refusalAwareId;
+        const admitted = await commitResolvedOAuthSelection(resolved, safetyAlternateId === null);
+        if (safetyAlternateId && admitted?.accountId !== safetyAlternateId) {
+          // Selection changed during admission: never send the previously dead/excluded row.
+          if (terminalRefreshError) return formatErrorResponse(401, "authentication_error",
+            publicOAuthAuthenticationErrorMessage(terminalRefreshError));
+          return formatErrorResponse(409, "conflict_error", "OAuth account selection changed; retry the request");
+        }
```

The shared helper below checks the post-error row's `needsReauth` and generation before selecting an alternate. If none resolves, rethrow the original `OAuthLoginRequiredError`. Extend the existing 401 replay catch at `src/server/responses/adapter-dispatch.ts:579-585` with the same candidate path when a terminal refresh marks the sent generation `needsReauth`; reserve one credential hop *before* rebuilding and do not replay if `isNonReplayableResponse` or the budget refuses. Other refresh failures retain the 401 response. This is necessary for A5 both pre-send and post-401.

Use this complete shared helper instead of inventing local helpers in two call sites. **NEW `src/oauth/kiro-terminal-failover.ts`:**

```ts
import type { OAuthAccessSnapshot } from "./index";
import type { OcxConfig } from "../types";
import { getValidAccessSnapshotForAccount } from "./index";
import { credentialGeneration, getAccountCredentialWithStatus, getAccountSet } from "./store";
import { eligibleFailoverAccounts, isKiroAccountMoveEnabled, GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST } from "./generic-account-failover";

/** Only an unchanged, code-classified dead credential permits this alternate. */
export async function tryKiroAlternateAfterTerminalRefresh(
  config: OcxConfig,
  failedAccountId: string,
  failedGeneration: string,
): Promise<OAuthAccessSnapshot | null> {
  if (!isKiroAccountMoveEnabled(config)) return null;
  const failed = getAccountCredentialWithStatus("kiro", failedAccountId);
  if (!failed?.needsReauth || credentialGeneration(failed.credential) !== failedGeneration) return null;
  const order = getAccountSet("kiro")?.accounts.map(row => row.id) ?? [];
  const after = order.indexOf(failedAccountId);
  const ring = after < 0 ? [] : [...order.slice(after + 1), ...order.slice(0, after)];
  const eligible = new Set(eligibleFailoverAccounts("kiro"));
  let attempted = 0;
  for (const id of ring) {
    if (id === failedAccountId || !eligible.has(id)) continue;
    if (++attempted >= GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST) break;
    try { return await getValidAccessSnapshotForAccount("kiro", id, { requireUsableAccount: true }); }
    catch { /* A second stale/dead account does not widen the failure. */ }
  }
  return null;
}
```

`commitResolvedOAuthSelection(candidate, false)` performs generation-safe, non-proactive admission (base `src/server/responses/request-transport.ts:129-173`); the exact-id guard above prevents its manual-selection retry from sending a dead/excluded account. The normal proactive path retains `true` only when effective pool enablement authorizes it. The post-401 branch uses the same helper with `transportState.sentOAuthSnapshot` and the existing `applyFailoverSnapshot`/`rebuildAndRefetch` rotation body (`src/server/responses/adapter-dispatch.ts:897-941`) under a reserved hop. In both cases the *captured* failed generation, not the mutable active-account pointer, is decisive.

The exact post-401 insertion is below. It is inside the `recovery` loop, after the non-replayable return at `src/server/responses/adapter-dispatch.ts:563-569`; it consumes the same credential-hop budget and rotation counter as refusal recovery. It does not change the generic 401 handling for other providers.

```diff
@@ src/server/responses/adapter-dispatch.ts:44-45 @@
 import type { OAuthAccessSnapshot } from "../../oauth";
-import { publicOAuthAuthenticationErrorMessage } from "../../oauth";
+import { OAuthLoginRequiredError, publicOAuthAuthenticationErrorMessage } from "../../oauth";
+import { tryKiroAlternateAfterTerminalRefresh } from "../../oauth/kiro-terminal-failover";
@@ src/server/responses/adapter-dispatch.ts:579-585 @@
         try {
           refreshed = await refreshResolvedOAuthSelection(transportState.sentOAuthSnapshot);
         } catch (err) {
+          const failed = transportState.sentOAuthSnapshot;
+          if (route.providerName === "kiro" && err instanceof OAuthLoginRequiredError && failed
+            && transportState.genericFailovers < transportState.genericFailoverLimit) {
+            const alternate = await tryKiroAlternateAfterTerminalRefresh(config, failed.accountId, failed.generation);
+            if (alternate) {
+              const adapterOwnsDispatch = transportState.activeAdapter.fetchResponse !== undefined;
+              const hop = reserveCredentialHop(
+                "auth-recovery", `${route.providerName}|${route.modelId}|terminal-refresh-account`,
+                !adapterOwnsDispatch && transientRetryPolicyFor(route.provider) !== null,
+              );
+              if (hop.allowed) {
+                try {
+                  if (await applyFailoverSnapshot(alternate)) {
+                    transportState.genericFailovers += 1;
+                    invalidateSameTargetRequest();
+                    transportState.activeAdapter = resolveSelectionAdapter(
+                      resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy),
+                      config.cacheRetention,
+                    );
+                    bindRouteReasoningReplayScope({
+                      parsed, providerName: route.providerName, provider: route.provider,
+                      adapterName: transportState.activeAdapter.name,
+                      oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot,
+                    });
+                    sendBudgetState.pendingHopPermit = hop.permit;
+                    const result = await rebuildAndRefetch("oauth-account-429", () => {
+                      if (!adapterOwnsDispatch) hop.permit?.use();
+                    });
+                    if ("failed" in result) return result.failed;
+                    upstreamResponse = result;
+                    continue recovery;
+                  }
+                } catch { /* Preserve the public authentication refusal below. */ }
+                finally { sendBudgetState.pendingHopPermit = undefined; hop.permit?.release(); }
+              }
+            }
+          }
           cleanupUpstreamAbort();
           return formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(err));
         }
```

The `oauth-account-429` telemetry enum in that hunk is a temporary reuse of an existing closed union, not a false claim about the upstream status; before review, prefer adding a dedicated recovery kind if the usage-log type and all exhaustiveness consumers can be updated without expanding this layer. The response/error path remains bounded even if that telemetry rename is deferred.

**MODIFY `src/server/responses/adapter-delivery.ts`:** for P9, pass the serving `OAuthAccessSnapshot` (account id + generation, no token in logs) into this delivery owner; on streaming `onCompletedResponse` (`:120-135`) only after `response.status === "completed"`, and on buffered `adapterResponseReachedServingTerminal(events, json)` (`:260-263`) only when `json.status === "completed"`, call `noteKiroServedSuccess(id, generation, Date.now())` for Kiro. Snapshot must be captured at the actual completed attempt, after any rotation; a response head, incomplete/error event, or post-output terminal error cannot clear. This requires adding `sentOAuthSnapshot` to the `ResponsesTransport` Pick at `:36` and wiring it from `src/server/responses/request-transport.ts:233-253,566-571` for Kiro even without a 401 replay. The active-account id is not enough: another request can rotate it while this one streams.

```diff
@@ src/server/responses/adapter-delivery.ts:23-24 @@
 import { clientEncoderForDelivery, deliverClientEncodedResponse } from "../inference/client-encoder-delivery";
+import { noteKiroServedSuccess } from "../../providers/kiro-usage";
+import { persistKiroAccountState } from "../../providers/kiro-account-state-disk";
@@ src/server/responses/adapter-delivery.ts:36 @@
-  transportState: Pick<ResponsesTransport, "activeAdapter" | "bindKeyUsageFromBridge">,
+  transportState: Pick<ResponsesTransport, "activeAdapter" | "bindKeyUsageFromBridge" | "sentOAuthSnapshot">,
@@ src/server/responses/adapter-delivery.ts:120-122 @@
     const onCompletedResponse = (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) => {
+      if (transportState.activeAdapter.name === "kiro" && response.status === "completed" && transportState.sentOAuthSnapshot
+        && noteKiroServedSuccess(transportState.sentOAuthSnapshot.accountId, transportState.sentOAuthSnapshot.generation, Date.now()))
+        persistKiroAccountState();
       commitReasoningReplayServingRoute();
@@ src/server/responses/adapter-delivery.ts:260-263 @@
     if (adapterResponseReachedServingTerminal(events, json)) {
+      if (transportState.activeAdapter.name === "kiro" && json.status === "completed" && transportState.sentOAuthSnapshot
+        && noteKiroServedSuccess(transportState.sentOAuthSnapshot.accountId, transportState.sentOAuthSnapshot.generation, Date.now()))
+        persistKiroAccountState();
       commitReasoningReplayServingRoute();
```

**MODIFY run-turn refusal path (rebase-verify at this layer's P):** `src/server/responses/run-turn-execution.ts:371-405` is a third Kiro entry point through `_kiroAuthContext`. The current `AdapterEvent` error carries a sanitized message, status, and code, so re-parsing that message cannot recover an exact monthly or suspension reason. Add optional internal `kiroRefusalKind` to the error union in `src/types/request.ts`, with only the closed set `rate`/`monthly_quota`/`suspended`/`other`. In `src/adapters/kiro/stream.ts`, call `classifyKiroRefusal` on the bounded HTTP fallback payload at `:1097-1108` before `classifyKiroHttpError` consumes it. For both structured `ev.reason` at `:711-714` **and** Smithy `exception`/`error` frames at `:583`, retain a bounded candidate alongside the sanitized failure and classify it before emitting the error event. Smithy has no authoritative HTTP status: use only an exact top-level `reason` from a valid bounded JSON object to supply the classifier's semantic 400 for `MONTHLY_REQUEST_COUNT` or 403 for `TEMPORARILY_SUSPENDED`; otherwise pass the failure's status (including synthetic 502) and let unrecognized evidence return `other`. Do not mine arbitrary message text or headers to synthesize a status. Retain the original sanitized `failure.status` for public delivery and carry only the closed-set kind into `AdapterEvent`. Oversized/malformed Smithy payloads and missing 400/403 evidence are `other`; status-only 429 is `rate`. No raw upstream text enters logs, diagnostics, or retry metadata.

The Kiro run-turn preflight arm reads the closed-set kind first; only if it is absent does it call `classifyKiroRefusal(status, "")` for a status-only fallback. A known monthly/suspension kind can therefore rotate even when the public event status is synthetic 502. `other` returns the original error, and emitted-output errors remain terminal under the existing preflight rule. Record monthly/suspension evidence before the Kiro move gate, then use `rotateGenericOAuthAccountOnRefusal` under the existing shared send budget and `genericFailovers` bound. If alternate resolution or admission fails, return the original preflight stream/error. Place this arm behind `route.providerName === "kiro"`; the non-Kiro run-turn 429 predicate, early count increment, and error delivery remain verbatim.

~~~diff
@@ src/types/request.ts:1-10 @@
+import type { KiroRefusalKind } from "../adapters/kiro-refusal";
@@ src/types/request.ts:410-419 @@
       code?: string;
+      kiroRefusalKind?: KiroRefusalKind; // Internal closed-set metadata only.
@@ src/adapters/kiro/stream.ts:11-15 @@
+import { classifyKiroRefusal, type KiroRefusalKind } from "../kiro-refusal";
@@ src/adapters/kiro/stream.ts:385-404 @@
+const KIRO_REFUSAL_FRAME_MAX_BYTES = 16_384;
+// Reuse for structured reason events and bounded Smithy exception/error payloads.
+// An event stream has no HTTP status. Only an exact top-level reason may replace
+// a synthetic failure status for refusal classification, never for delivery.
+const classifyKiroEventFrameRefusal = (failureStatus: number, candidate: string): KiroRefusalKind => {
+  let semanticStatus = failureStatus;
+  try {
+    const row: unknown = JSON.parse(candidate);
+    if (row && typeof row === "object" && !Array.isArray(row)) {
+      const reason = (row as Record<string, unknown>).reason;
+      if (reason === "MONTHLY_REQUEST_COUNT") semanticStatus = 400;
+      if (reason === "TEMPORARILY_SUSPENDED") semanticStatus = 403;
+    }
+  } catch { /* No exact structured reason; leave status unchanged. */ }
+  return classifyKiroRefusal(semanticStatus, candidate).kind;
+};
+// classifiedTerminal gains an optional closed-set refusal kind and attaches it
+// to its error event; it never attaches the raw frame.
-  const classifiedTerminal = (failure: KiroErrorClassification): AdapterEvent => {
+  const classifiedTerminal = (failure: KiroErrorClassification, kiroRefusalKind?: KiroRefusalKind): AdapterEvent => {
     return {
       type: "error",
+      ...(kiroRefusalKind ? { kiroRefusalKind } : {}),
@@ src/adapters/kiro/stream.ts:583-592 (Smithy exception/error producer) @@
-        return {
-          assistantText, sawReasoning,
-          terminal: classifiedTerminal(classifyKiroStreamError(msg.headers, new TextDecoder().decode(msg.payload))),
-        };
+        const payload = new TextDecoder().decode(msg.payload);
+        const failure = classifyKiroStreamError(msg.headers, payload);
+        const candidate = msg.payload.byteLength <= KIRO_REFUSAL_FRAME_MAX_BYTES ? payload : "";
+        return {
+          assistantText, sawReasoning,
+          terminal: classifiedTerminal(failure, classifyKiroEventFrameRefusal(failure.status, candidate)),
+        };
@@ src/adapters/kiro/stream.ts:711-714 @@
-          return { assistantText, sawReasoning, terminal: classifiedTerminal(classifyKiroEventError(ev.reason, ev.message)) };
+          const failure = classifyKiroEventError(ev.reason, ev.message);
+          const candidate = JSON.stringify({ reason: ev.reason, message: ev.message });
+          const kind = Buffer.byteLength(candidate) <= KIRO_REFUSAL_FRAME_MAX_BYTES
+            ? classifyKiroEventFrameRefusal(failure.status, candidate)
+            : classifyKiroRefusal(failure.status, "").kind;
+          return { assistantText, sawReasoning, terminal: classifiedTerminal(failure, kind) };
@@ src/adapters/kiro/stream.ts:1097-1108 @@
       const payload = await readDisplaySafeErrorPayloadText(fallback.response, fallback.abortSignal);
+      const kiroRefusalKind = classifyKiroRefusal(fallback.response.status, payload).kind;
       const failure = classifyKiroHttpError(fallback.response.status, fallback.response.headers, payload);
       yield {
         type: "error",
+        kiroRefusalKind,
@@ src/server/responses/run-turn-execution.ts:27-35 @@
   rotateGenericOAuthAccountOn429,
+  rotateGenericOAuthAccountOnRefusal,
+  isKiroAccountMoveEnabled,
+  quarantineKiroSuspendedAccount,
+import { classifyKiroRefusal } from "../../adapters/kiro-refusal";
+import { noteKiroMonthlyRefusal } from "../../providers/kiro-usage";
+import { persistKiroAccountState } from "../../providers/kiro-account-state-disk";
@@ src/server/responses/run-turn-execution.ts:345-405 (Kiro branch before unchanged 429 arm) @@
     const rotateRunTurnAdapterOnPreflight429 = async (error: Extract<AdapterEvent, { type: "error" }>): Promise<boolean> => {
       if (error.code === SEND_BUDGET_EXHAUSTED_CODE) return false;
       const status = error.status ?? adapterFailureFromMessage(error.message).httpStatus;
+      if (route.providerName === "kiro")
+        return rotateKiroRunTurnOnPreflightRefusal(error, status);
       if (
         status !== 429
         || !transportState.genericFailoverAccountId
         || transportState.genericFailovers >= transportState.genericFailoverLimit
         || !isGenericOAuthFailoverEnabled(config, route.providerName)
       ) return false;
       // From this predicate through the existing replay/error return, retain
       // the non-Kiro block byte-for-byte, including early genericFailovers++.
@@ src/server/responses/run-turn-execution.ts:before rotateRunTurnAdapterOnPreflight429 @@
+    const rotateKiroRunTurnOnPreflightRefusal = async (
+      error: Extract<AdapterEvent, { type: "error" }>, status: number,
+    ): Promise<boolean> => {
+      const kind = error.kiroRefusalKind ?? classifyKiroRefusal(status, "").kind;
+      if (kind === "other" || !transportState.genericFailoverAccountId) return false;
+      const sent = transportState.replayOAuthCredentialSnapshot;
+      let monthlyCooldownMs: number | undefined;
+      if (kind === "monthly_quota" && sent) {
+        monthlyCooldownMs = noteKiroMonthlyRefusal(sent.accountId, sent.generation, Date.now());
+        persistKiroAccountState();
+      }
+      if (kind === "suspended") quarantineKiroSuspendedAccount(transportState.genericFailoverAccountId);
+      if (transportState.genericFailovers >= transportState.genericFailoverLimit
+        || !isGenericOAuthFailoverEnabled(config, "kiro") || !isKiroAccountMoveEnabled(config)) return false;
+      const hop = reserveCredentialHop("auth-recovery", `kiro|${route.modelId}|runturn-oauth-refusal`);
+      if (!hop.allowed) {
+        if (hasEligibleGenericOAuthFailoverTarget("kiro", transportState.genericFailoverAccountId,
+          Date.now(), route.modelId))
+          noteAttemptRecoveryWithheld(logCtx.activeAttempt, "rotation-send-budget");
+        return false;
+      }
+      const nextAccountId = rotateGenericOAuthAccountOnRefusal(config, "kiro",
+        transportState.genericFailoverAccountId, kind, null, Date.now(), route.modelId, monthlyCooldownMs);
+      if (!nextAccountId) { hop.permit?.release(); return false; }
+      try {
+        const snapshot = await failoverAccountSnapshot("kiro", nextAccountId);
+        const admittedSnapshot = await applyFailoverSnapshot(snapshot);
+        if (!admittedSnapshot) { hop.permit?.release(); return false; }
+        const rotatedProvider = resolveWireProtocolOverride("kiro", route.modelId, route.provider,
+          inboundWire, route.staticPolicy);
+        const rotatedAdapter = resolveSelectionAdapter(rotatedProvider, config.cacheRetention);
+        if (!rotatedAdapter.runTurn) { hop.permit?.release(); return false; }
+        transportState.genericFailovers += 1;
+        transportState.runTurnAdapter = rotatedAdapter;
+        bindRouteReasoningReplayScope({
+          parsed, providerName: "kiro", provider: rotatedProvider, adapterName: rotatedAdapter.name,
+          oauthCredentialSnapshot: { accountId: admittedSnapshot.accountId, generation: admittedSnapshot.generation },
+          codexAuthContext: admissionState.authCtx, forwardHeaders: requestState.selectedForwardHeaders,
+        });
+        sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, rotatedAdapter.name, logCtx.accountLogLabel);
+        recordAttemptCredentialSource(logCtx.activeAttempt, "kiro", route.provider, rotatedAdapter.name);
+        sendBudgetState.pendingHopPermit = hop.permit;
+        return true;
+      } catch { hop.permit?.release(); return false; }
+    };
~~~

Both event-frame producers classify a bounded structured payload before public sanitization; the HTTP fallback hunk shows the raw-body chain. `KiroRefusalKind` is a type-only import in `src/types/request.ts`, or the closed literal union is repeated there if a type import would create a cycle. No new loop is added: `preflightRunTurnFailover` already bounds retries using the same rotation count. Add exact tests in `tests/server/server-kiro-refusal-e2e.test.ts` named `kiro run-turn structured monthly 502 rotates before output`, `kiro run-turn Smithy suspension 502 rotates before output`, `kiro run-turn Smithy monthly 502 rotates before output`, `kiro run-turn ordinary Smithy 502 stays on original error`, `kiro run-turn oversized Smithy frame never quarantines`, `kiro run-turn failed alternate preserves original error`, and `non-Kiro run-turn 429 preserves early count and original error`. Assert the first three use the refusal kind despite synthetic 502, each makes exactly one B physical send with paired bearer/profile/region, and ordinary or oversized Smithy frames never quarantine A. The post-output variant must never send B. Assert failure paths deliver the original sanitized event, and no upstream text enters logs.

**MODIFY sidecar refusal callbacks:** src/server/responses/sidecar-execution.ts:159-217 also calls rotateGenericOAuthAccountOn429, through the web-search and image bridge callbacks. Both loops currently invoke on429 only for 429 and pass no Response body. Extend the callback with the original Response as a fourth argument; web-search/loop.ts:572-580 and images/loop.ts:674-681 invoke it for Kiro 400/403 only when their iteration request has _kiroAuthContext, while non-Kiro stays 429-only. In the callback, classify a bounded clone with classifyKiroRefusal before any cancellation, record monthly/suspension evidence, respect isKiroAccountMoveEnabled, and call rotateGenericOAuthAccountOnRefusal. If no candidate is admitted, return null so both loops deliver the original response. Keep the key-pool 429 arm and all non-Kiro callback order and count unchanged. A Kiro account rotation increments genericFailovers after applyFailoverSnapshot succeeds; non-Kiro retains the early increment. These callbacks use the same rotator and request-local bound as adapter/continuation/run-turn, not another account rotation owner.

~~~diff
@@ src/web-search/loop.ts:345-351,572-580 @@
   on429?: (
     retryAfterHeader: string | null,
     responseHeaders?: Headers,
     retryParsed?: OcxParsedRequest,
+    originalResponse?: Response,
   ) =>
-      while (prepared.response.status === 429 && deps.on429) {
-        const rotated = await deps.on429(prepared.response.headers.get("retry-after"), prepared.response.headers, iterParsed);
+      while ((prepared.response.status === 429
+        || (iterParsed._kiroAuthContext && (prepared.response.status === 400 || prepared.response.status === 403))) && deps.on429) {
+        const rotated = await deps.on429(prepared.response.headers.get("retry-after"), prepared.response.headers, iterParsed, prepared.response);
@@ src/images/loop.ts:333-340,674-681 @@
   on429?: (
     retryAfterHeader: string | null,
     responseHeaders?: Headers,
     retryParsed?: OcxParsedRequest,
+    originalResponse?: Response,
   ) =>
-      while (prepared.response.status === 429 && deps.on429) {
-        const rotated = await deps.on429(prepared.response.headers.get("retry-after"), prepared.response.headers, iterParsed);
+      while ((prepared.response.status === 429
+        || (iterParsed._kiroAuthContext && (prepared.response.status === 400 || prepared.response.status === 403))) && deps.on429) {
+        const rotated = await deps.on429(prepared.response.headers.get("retry-after"), prepared.response.headers, iterParsed, prepared.response);
@@ src/server/responses/sidecar-execution.ts:159-194 @@
   const rotateSidecarProviderOn429 = async (
     retryAfter: string | null,
     responseHeaders?: Headers,
     retryParsed?: OcxParsedRequest,
+    originalResponse?: Response,
   ) => {
+    if (route.providerName !== "kiro" && originalResponse && originalResponse.status !== 429) return null;
+    const refusal = route.providerName === "kiro" && originalResponse
+      ? classifyKiroRefusal(originalResponse.status,
+          await readDisplaySafeErrorText(originalResponse.clone(), options.abortSignal, "")).kind
+      : "rate";
+    if (refusal === "other") return null;
+    const sent = transportState.replayOAuthCredentialSnapshot;
+    const monthlyCooldownMs = route.providerName === "kiro" && refusal === "monthly_quota" && sent
+      ? noteKiroMonthlyRefusal(sent.accountId, sent.generation, Date.now()) : undefined;
+    if (monthlyCooldownMs !== undefined) persistKiroAccountState();
+    if (route.providerName === "kiro" && refusal === "suspended")
+      quarantineKiroSuspendedAccount(transportState.genericFailoverAccountId);
     let recoveryKind: AttemptRecoveryKind = "key-429";
-    const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
+    const rotated = route.providerName !== "kiro" || originalResponse?.status === 429
+      ? rotateProviderTransportOn429(config, route.providerName, route.provider, {
         retryAfter,
         now: Date.now(),
         attemptedKey: route.provider.apiKey,
         promptCacheKey: parsed.options.promptCacheKey,
-    });
+      }) : null;
@@ src/server/responses/sidecar-execution.ts:386,469 @@
-      retryOn429Policy: rateLimitRetryPolicyFor(route.provider),
+      retryOn429Policy: route.providerName === "kiro" && isKiroAccountMoveEnabled(config)
+        ? null : rateLimitRetryPolicyFor(route.provider),
@@ src/server/responses/sidecar-execution.ts:181-213 @@
       transportState.genericFailoverAccountId
       && transportState.genericFailovers < transportState.genericFailoverLimit
       && isGenericOAuthFailoverEnabled(config, route.providerName)
+      && (route.providerName !== "kiro" || isKiroAccountMoveEnabled(config))
     ) {
+      // Kiro monthly/suspension evidence is recorded before this eligibility gate.
-      const nextAccountId = rotateGenericOAuthAccountOn429(
+      const nextAccountId = route.providerName === "kiro" ? rotateGenericOAuthAccountOnRefusal(
+        config, route.providerName, transportState.genericFailoverAccountId,
+        refusal, retryAfter, Date.now(), route.modelId, monthlyCooldownMs,
+      ) : rotateGenericOAuthAccountOn429(
         config, route.providerName, transportState.genericFailoverAccountId,
         retryAfter, Date.now(), route.modelId,
       );
       const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
-      transportState.genericFailovers += 1;
+      if (route.providerName !== "kiro") transportState.genericFailovers += 1;
       if (!await applyFailoverSnapshot(snapshot, retryParsed)) {
         hop.permit?.release();
         return null;
       }
+      if (route.providerName === "kiro") transportState.genericFailovers += 1;
~~~

Add replayOAuthCredentialSnapshot to the ResponsesTransport Pick in sidecar-execution.ts so the callback uses the actual sent generation, and import the same refusal, verdict, persistence, suspension, and move-gate helpers used by adapter-dispatch. Its bounded clone uses options.abortSignal, already passed to both loops. Add exact tests in tests/server/server-kiro-refusal-e2e.test.ts named "Kiro web-search sidecar monthly refusal keeps body when alternate fails", "Kiro image sidecar suspension rotates once before output", and "non-Kiro sidecar 429 keeps key-first order and early count". Assert same physical-send budget, exact original status/body on no admission, and no upstream text in logs.

## PLAN-FIELD-CHAIN-01

| New value | Creation → serialization → deserialization → consumer |
|---|---|
| `KiroRefusalKind` `rate`, `monthly_quota`, `suspended`, `other` | `src/adapters/kiro-refusal.ts` from status plus bounded JSON → N/A, request-local classification only → N/A → `src/server/responses/adapter-dispatch.ts`, `adapter-continuation.ts`, `run-turn-execution.ts`, and `sidecar-execution.ts` select Kiro-only rotation; `other` preserves ordinary error. |
| internal `kiroRefusalKind` on run-turn AdapterEvent error | Kiro HTTP fallback or event-stream frame calls `classifyKiroRefusal` on bounded raw/structured input before sanitization → request-local closed-set metadata only, never serialized to logs → run-turn preflight reads it or status-only classifier fallback → the same Kiro rotator as adapter, continuation, and sidecar. |
| `KiroRefusal.resetAt?` | Not populated until an observed refusal-body reset field is proven → N/A → N/A → the 030 monthly writer instead reads the existing account-scoped usage reset from 010; unknown falls back to TTL. |
| `preferAccountFailover?` Kiro retry argument | `src/adapters/kiro/adapter.ts` sets it from `ctx?.kiroPreferAccountFailover === true` → N/A, request-local function argument → N/A → `src/adapters/kiro-retry.ts` returns a bounded 429 before same-account retries; absent/false retains the current retry loop. |
| `KiroPersistedVerdict.identity` / `exhausted` / `overageEnabled` / `resetAt?` / `observedAt` | 010 probe and 030 refusal/success writer compute `kiroEvidenceIdentity(live)` from the roster account (SHA-256 hex of the five non-secret identity fields including loginId/legacy addedAt), generation-fence the in-flight writer, and order `observedAt` independently of quota `updatedAt` → 010 `persistKiroAccountState()` writes the account-keyed verdict even before a quota probe → `hydrateKiroAccountState()` checks live identity, TTL and reset → `kiroAccountEvidence(account, now)` is the sole routing read for quota and verdict; a changed identity returns unknown, while a token refresh retains evidence. |
| `kiroAccountEvidence` quota/verdict view | 010 hydrates once per process; each read compares the caller-supplied roster account identity and applies TTL/reset to both fields → N/A, computed view → N/A → 010 `getCachedProviderAccountQuota` and `isAccountQuotaExhausted`, 030 `eligibleIdsIn` / `refusalAwareInitialKiroAccount`, 040 eligibility, 070 `autoSelectable`. Routing uses of `getKiroAccountExhaustion` switch to this view. |
| `ProviderAccount.loginId` | 010 `saveCredentialWithReceipt` creates a new UUID for every login write, append or same-slot replacement → auth.json account row (also retained by account-set clone) → `normalizeAuthStore` validates UUID and keeps it; legacy rows fall back to `addedAt` → `kiroEvidenceIdentity(account)` fences quota, verdict, catalogue, and in-flight fetch across re-login while refresh writers leave loginId unchanged. |
| Kiro account-move gate | `isKiroAccountMoveEnabled(config)` returns false if either global or provider enabled is explicitly false; unset uses presence-is-consent → N/A → N/A → initial refusal exclusion, proactive Kiro preference, terminal-refresh alternate, and all Kiro refusal arms. Non-Kiro keeps its current behavior. |
| `kiro-suspension` health source | 030 `quarantineKiroSuspendedAccount` records only a closed-set status and expiry → process-local `health`, no disk serialization → N/A → 030 initial-admission exclusion and the single refusal rotator; TTL expiration restores eligibility. |
| `needsReauth` (existing field, new Kiro failover consumer) | `src/oauth/index.ts:673-680,1060-1106` sets it only for allowlisted terminal refresh code, generation-safe → existing OAuth store writer `src/oauth/store.ts:1245` → existing account store reader `src/oauth/index.ts:548-562` → new Kiro-only initial/401 alternate selection in `request-transport.ts` / `adapter-dispatch.ts`; other providers unchanged. |
| `sentOAuthSnapshot` as Kiro completion identity (existing type; new delivery read) | `src/server/responses/request-transport.ts:233-253,566-571` binds actual serving snapshot → N/A, request-local only → N/A → `adapter-delivery.ts` success hook fences id/generation. Never serialize the bearer. |

## Conditional-path acceptance matrix

| Trigger | Asserted observable effect |
|---|---|
| Kiro 429 with exact `USER_REQUEST_RATE_EXCEEDED` or no known monthly reason | When Kiro account movement is permitted the retry helper returns immediately; short cooldown on the refused account; one alternate may serve within roster/send budget. One-account Kiro keeps bounded same-account retry. Other-provider 429 keeps its existing `Retry-After`/default behavior. |
| Kiro 429 **or** 400 with exact top-level `MONTHLY_REQUEST_COUNT` | Persist exhausted verdict for that same account even with one account or no send permit; when possible, rotate before bytes and skip it on later requests until the account-scoped reset or 010 TTL. A newer probe verdict wins over an older refusal. |
| Kiro run-turn structured event or bounded Smithy exception/error frame with exact monthly/suspension reason and synthetic 502 | Internal closed-set kind controls Kiro rotation before output despite public 502; the original sanitized status/error still delivers if admission fails. Unknown/oversized frames never quarantine. Non-Kiro run-turn and adapter 429 paths keep their base ordering. |
| Kiro 403 with `TEMPORARILY_SUSPENDED` or one of the four known message wordings | Process-local quarantine of only the failed account even without an alternate; full-snapshot alternate within budget when available; no refresh of that known-suspended data-plane response. |
| Ordinary 403, 400 `INVALID_MODEL_ID`, malformed body, nested/echoed reason, unknown future reason, over-limit body | `other`; no quarantine or account switch; existing safe error returned. In particular an unrecognised upstream shape stays harmless. |
| Terminal Kiro refresh 400/401 carrying an allowlisted OAuth error | Existing generation-safe `needsReauth`, then at most bounded alternate resolution and `commitResolvedOAuthSelection(resolved, false)` with an exact-id guard; works when the setting is unset (presence-is-consent) or true; explicit false returns the original auth failure and never sends the dead credential. Bare 400/401, I/O error, changed generation, one-account pool: no new rotation. |
| Initial active account is known suspended or monthly exhausted | With setting unset (presence-is-consent) or true and two eligible accounts, choose the next eligible before first send. An explicit false at global or provider scope keeps the active account and disables refusal/terminal-refresh rotation. Least-loaded preference requires effective proactive enablement. Singleton/all-excluded still sends active. |
| Configured 040 maxConcurrentPerAccount is full | When movement is permitted, try another eligible account first. With explicit false or singleton, wait up to the configured bound, then return retryable 503 with code account_capacity and Retry-After. This capacity cap is separately opt-in. |
| Kiro run-turn preflight 429/400/403 | A bounded source classification becomes only a closed-set kind on AdapterEvent; the run-turn arm uses the same refusal rotator and shared budget, while a failed alternate yields the original error event. Non-Kiro 429 preserves its current order and count. |
| Kiro web-search/image sidecar 429/400/403 | The loop gives the callback a bounded clone of the original Response, records a confirmed refusal, and invokes the same rotator. No admitted alternate leaves the original status/body readable. Non-Kiro 429 retains key-first order and early count. |
| Refusal after any output, caller abort, no alternate, or no send permit | No replay. Return the already-owned terminal/original refusal; no fresh synthetic 429. |
| Completed Kiro turn after an older monthly refusal, same live account/generation | Clears exhaustion and persists a newer observation. Incomplete/error/200-head-only, different generation, removed account, or success observed before a newer refusal: leaves verdict intact. |

## Tests, layout, docs, and verifiers

Add sibling files, not lines to capped tests. `tests/fixtures/file-size-baseline.json:31,46-48` caps `src/providers/quota.ts` and the large Kiro/provider quota tests; the 030 tests below are new files. Exact test names:

- **NEW `tests/providers/kiro/kiro-refusal.test.ts`**: `kiro refusal: 429 rate and 400 or 429 monthly reasons stay distinct`; `kiro refusal: runtime and q-host suspension shapes require 403`; `kiro refusal: unknown, nested, malformed and oversized shapes never quarantine`; `kiro refusal: resetAt is absent without verified refusal evidence`; `kiro two identity-less logins to same slot change evidence identity`; `kiro token refresh preserves loginId evidence identity`; `kiro malformed loginId is dropped and legacy addedAt is stable`.
- **NEW `tests/oauth/kiro-refusal-failover.test.ts`**: `kiro monthly refusal persists and skips only the refused account until reset or TTL`; `kiro monthly refusal records with one account or spent send budget`; `kiro pooled 429 bypasses same-account retry while one-account Kiro keeps it`; `kiro rate uses short cooldown while other OAuth 429 retains its prior delay`; `kiro suspension records without alternate and ordinary 403 does not`; `kiro suspended account rotates before output`; `kiro terminal refresh code marks only its generation for reauth and tries a sibling`; `kiro bare refresh status and I/O failure do not rotate`; `kiro later served completion clears older exhaustion but not a newer refusal or different identity`; `kiro re-login under same account id discards persisted refusal after restart but token refresh retains it`; `kiro initial admission skips suspended active with setting unset`; `kiro initial admission skips monthly exhausted active with setting unset`; `kiro singleton or all-excluded pool still sends active`; `kiro terminal refresh alternate admits with setting unset and never reselects dead active`; `kiro explicit false disables initial and reactive account moves at global and provider scope`; `kiro explicit false blocks terminal-refresh alternate`; `kiro failed alternate resolution returns original monthly or suspension refusal status and body in adapter and continuation`; `kiro no alternate or spent send budget returns original body`.
- **NEW `tests/server/server-kiro-refusal-e2e.test.ts`**: `streaming Kiro 400 monthly and 403 suspension rotate with paired bearer profile and region`; `kiro run-turn structured monthly 502 rotates before output`; `kiro run-turn Smithy suspension 502 rotates before output`; `kiro run-turn Smithy monthly 502 rotates before output`; `kiro run-turn ordinary Smithy 502 stays on original error`; `kiro run-turn oversized Smithy frame never quarantines`; `Kiro post-output refusal never resends`; `Kiro completed buffered and streamed turns clear only their serving account`; `continuation refusal shares the request rotation budget`; `continuation failed alternate resolution preserves original refusal body`; `non-Kiro run-turn 429 preserves early count and original error`; `non-Kiro adapter 429 keeps early count and original cancellation order`; `unrotated Kiro 5xx retains fixed public text after raw-error handoff`. For the non-Kiro adapter test, make alternate snapshot resolution fail and assert cancellation occurred before that attempt, `genericFailovers` advanced at the base point, and no second physical send occurred. Use local fixture fetch/executor only; no AWS/Kiro endpoint.
- Extend the new `tests/providers/kiro/kiro-refusal.test.ts` with `monthly refusal persists before any quota probe`, `monthly refusal after a stale quota probe survives restart`, and `served success after a probe persists a newer non-exhausted verdict`; each writes/reads the 010 disk format under a temporary home and proves the independent-observation disk delta above. The missing/malformed/future/stale/live-account-negative cases from 010 remain required. Assert a legacy identity-less slot upgrade invalidates prior verdict and quota rows, while same-identity token refresh does not; assert quota `updatedAt` is unchanged by later refusal/success `observedAt`.

The setting-unset cases each seed two usable accounts with A active and B eligible, write an A suspension or monthly exhaustion verdict, and assert the **first** physical send uses B's bearer/profile/region; the terminal-refresh case marks A `needsReauth` with an allowlisted code and asserts exactly one B send and zero A sends. For `kiro singleton or all-excluded pool still sends active`, seed first one account and then two excluded accounts and assert the active bearer is sent in both cases; when the only apparent alternate disappears during resolution, assert the fallback also sends active. The explicit-false cases set global false and provider false in separate fixtures and assert A remains the sole physical send on first admission and refusal, even with B eligible; terminal refresh returns the original authentication error without B. Seed a non-Kiro OAuth provider in separate adapter and run-turn 429 tests and assert its early genericFailovers increment, original pre-admission cancellation/error behavior, and unchanged second-send count. The failed-alternate case makes B's snapshot resolution throw before admission in both adapter and continuation paths; assert the client receives the exact original 400/403 status and bounded refusal body, with no second physical send. The re-login/restart case keeps the account id constant but has two different people log into the same identity-less slot, issuing distinct loginId UUIDs and asserts `kiroAccountEvidence(newAccount)` returns neither old `quotaPercent` nor old `exhausted`; refreshing only the token retains both. The legacy-row case omits loginId and asserts the addedAt fallback is stable until the next login write; malformed UUID input is dropped by normalization. The 040 capacity test sets maxConcurrentPerAccount with explicit pool false and singleton separately, fills the cap, and asserts a bounded wait followed by retryable 503 account_capacity plus Retry-After; with movement permitted it asserts B is tried first. These are local fixture sends only; do not call Kiro/AWS.

Cross-layer contracts consumed here: 050's catalogue row **and in-flight fetch** carry 010 `kiroEvidenceIdentity`, and a mismatch makes either unknown; its model lookup uses `kiroUsageContextForAccount` (including #5937 `builderIdFallback`) and exported `kiroManagementHost(ctx)` from `src/providers/kiro-usage.ts`, so the Builder ID service ARN cannot choose the management region. 070 exposes `autoSelectable` plus `skipReason` as automatic-selection eligibility and tests that a singleton still sends. Logs and diagnostics in every layer carry only closed-set codes/statuses, never refusal body text, tokens, device codes, or client secrets.

Register each in both files, one exact JSON line per file (their `explicit`/expected maps use `"basename.test.ts": "domain"`, verified at `scripts/test-layout/layout.json:972,1067-1084,1643-1644` and `tests/fixtures/test-layout-expected.json:793,888-905,1469-1470`):

```diff
@@ scripts/test-layout/layout.json (inside "explicit") @@
+    "kiro-refusal.test.ts": "providers/kiro",
+    "kiro-refusal-failover.test.ts": "oauth",
+    "server-kiro-refusal-e2e.test.ts": "server",
@@ tests/fixtures/test-layout-expected.json (top-level map) @@
+  "kiro-refusal.test.ts": "providers/kiro",
+  "kiro-refusal-failover.test.ts": "oauth",
+  "server-kiro-refusal-e2e.test.ts": "server",
```

Docs at implementation: in `docs-site/src/content/docs/reference/adapters.md:339-355`, replace the Kiro 429 sentence with: “Kiro distinguishes request rate refusals from confirmed monthly quota exhaustion, cools the former briefly, and excludes the latter until an observed reset or freshness expiry. A confirmed account suspension can rotate before output when account movement is enabled; an ordinary 403 cannot. Either explicit global or provider account-failover off switch keeps the active account and disables rotation. Completed service on the same login supersedes an older exhaustion verdict.” In `docs-site/src/content/docs/reference/cli/providers-accounts.md:339-343`, say the same in one concise account-pool sentence. Update translated `reference/adapters.md` and `reference/cli/providers-accounts.md` pages where the existing 429/Kiro claims would contradict English (paths under `ko/`, `ja/`, `zh-cn/`, `zh-tw/`, `fr/`, `ru/`, `tr/`; inspect each before editing). Ownership from `structure/INDEX.md:111,136,138,146`: append a Kiro refusal/terminal-refresh paragraph to `structure/providers/kiro.md`, an account eligibility/identity paragraph to `structure/providers-and-adapters.md`, and a before-output budget sentence to `structure/transports/responses-failover.md`. Do not edit the manifest merely to add prose. When 040 lands, its docs add the separately configured concurrency-cap wait and retryable 503 `account_capacity` plus `Retry-After`; 030 must not claim the cap is already implemented.

Run after implementation: `bun test tests/providers/kiro/kiro-refusal.test.ts tests/oauth/kiro-refusal-failover.test.ts tests/server/server-kiro-refusal-e2e.test.ts tests/oauth/generic-oauth-failover.test.ts tests/server/server-kiro-oauth-401-replay.test.ts tests/lab/core-lab-boundary.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/adapters/run-turn-queue.test.ts tests/providers/kiro/kiro-stream.test.ts tests/providers/kiro/kiro-retry.test.ts tests/web-search/web-search-sidecar-429.test.ts tests/images/loop.test.ts`, `bun run typecheck`, `bun run test:changed`, `bun run privacy:scan`, `bun run structure:check`; then exact-head hosted CI. `bun run typecheck` and `bun run test:changed` are named gates only, not claimed as run here. This docs-only pass ran the following existing commands *now*; none reads this change target (`030_refusal_classes_and_account_failover.md`), so none validates the future implementation:

| Command | Exit | Reads planned code target now? | Observed result |
|---|---:|---|---|
| `bun test tests/oauth/generic-oauth-failover.test.ts` | 0 | Existing generic failover source, not future 030 code | 50 pass, 0 fail. |
| `bun test tests/server/server-kiro-oauth-401-replay.test.ts` | 0 | Existing 401 path, not future 030 code | 5 pass, 0 fail. |
| `bun test tests/lab/core-lab-boundary.test.ts` | 0 | Existing import graph, not future 030 code | 25 pass, 0 fail. |
| `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | 0 | Current layout, not future 030 files | 18 pass, 0 fail. |
| `bun test tests/adapters/run-turn-queue.test.ts tests/providers/kiro/kiro-stream.test.ts tests/providers/kiro/kiro-retry.test.ts` | 0 | Existing event queue and Kiro parser/retry paths; not future 030 code | 175 pass, 0 fail. |
| `bun test tests/web-search/web-search-sidecar-429.test.ts tests/images/loop.test.ts` | 0 | Existing sidecar and image-loop paths; not future 030 code | 61 pass, 0 fail. |
| `bun test tests/server/account-pool-management-api.test.ts` | 1 | Existing pool management path; not a 030 regression | 25 pass, 8 fail. All eight fail at the same test-home guard before assertions: this worktree is under the real `~/.codex`, and the fixture attempts removal there. Treat as environment-only; hosted CI outside `~/.codex` must supply evidence. |
| `bun run structure:check` | 0 | Existing structure docs only | `structure/ SSOT checks passed`. |
| `bun run test:changed` | 0 | No: comparison saw 10 changed files but selected zero tests | 0 pass, 0 fail; no behavior evidence. |
| `bun run privacy:scan` | 0 | No: scanner uses tracked `git ls-files`, and this plan is untracked | `Privacy scan passed`; rerun after staging in the layer PR. |

These are fresh runs after dependencies became available; the run-turn/Kiro parser/retry and sidecar verifiers were added for the revised refusal arms. The earlier `zod/v4` load failures are superseded. The new 030 test files do not exist in this docs-only pass, so neither local result nor hosted CI for this checkout proves the future implementation.

## Risks, rollback, out of scope

Risk: 010's actual storage API and 020's response body/budget changes may differ from this `bb3f3c2d0d` plan. At 030 P, inspect those landed commits, adapt the insertion hunk to the real verdict owner, and run red/green focused tests. Do not create a second persistent source of truth. A 200 head alone is not success; completion must be confirmed after parsing. Body classification must use a complete bounded clone and never log its text. The account id, live credential generation at write time, stable 010 evidence identity on disk, independent observation times, and 010 writer generation jointly fence stale state. Keep Kiro suspension process-local because the shared persisted verdict type carries only exhaustion and overage. If a safety guard cannot be established, retain the old error path.

Rollback: revert the 030 commit/PR; the 010 disk format remains readable, and its rows expire under the existing TTL/reset rules. Clear process-local cooldowns on restart; no migration or credential rewrite is needed. Out of scope: generalizing non-Kiro 403/400 behavior, model-specific `INVALID_MODEL_ID` routing (050, which reuses `kiroUsageContextForAccount` and exported `kiroManagementHost(ctx)` so Builder ID service ARN cannot select a region), lease/load strategy (040), native device login (060), measured credits (070 `autoSelectable` with `skipReason` for automatic selection only, including a singleton-send test), endpoint changes (020), and broadening terminal refresh status-only classification.

## Round-1 audit fold

- `r2-2 High` → terminal-refresh alternate uses non-proactive exact-id admission only when Kiro movement is allowed; setting-unset two-account test sends B, while explicit false leaves A/error unchanged (lines 449-496, 827-831).
- `r2-3 High` → first admission excludes a confirmed suspended/monthly active account only when movement is allowed; singleton/all-excluded sends active, explicit false blocks the move, and a singleton refusal still records evidence (lines 145-188, 299-324, 384-409, 449-464, 814-817, 827-831).
- `r2-4 High` → Kiro adapter/continuation preserve original Response through alternate admission; run-turn retains its preflight error and sidecars retain their Response. Non-Kiro cancellation/count order stays unchanged (lines 335-356, 417-437, 614-701, 703-783, 827-831).
- `r2-5 High` → refusal/success writes use 010 loginId-based evidence identity and independent observedAt; same-slot re-login/restart invalidates evidence while token refresh preserves it (lines 4, 243-282, 798-800, 827-831).
- `r2-1 Medium` → fresh verifier exits replace stale zod/v4 failures; the eight account-pool-management failures are confined to this worktree's ~/.codex test-home guard and await hosted CI evidence (lines 849-865).
- `SD1'` → ProviderAccount.loginId is a validated UUID renewed on every login write, with addedAt fallback for legacy rows; authType is absent from the five-field hash (lines 4, 41, 279-282, 798-800, 829-831).
- `SD2'` → kiroAccountEvidence takes the caller's roster ProviderAccount and hydrates once; routing does not load auth.json per account (lines 151-188, 233-279, 799).
- `SD3'` → adapter, continuation, run-turn, and web-search/image sidecar Kiro refusals use classifyKiroRefusal and rotateGenericOAuthAccountOnRefusal; Kiro-only retain/count changes and non-Kiro regressions are explicit (lines 293-437, 614-783, 827-831).
- `SD4'` → either explicit false vetoes every Kiro account move, while maxConcurrentPerAccount remains separately opt-in and can wait then return retryable 503 account_capacity with Retry-After (lines 145-151, 231-233, 449-496, 801, 814-817, 827-831).

## Round-2 audit fold

- `r2-R2-1 High — Smithy event producer` → classify bounded `exception`/`error` payloads and structured reason events with the same exact-reason `classifyKiroRefusal` path; retain the sanitized public failure and discard oversized/unknown evidence (lines 621, 638-680). Rebase-verify at this layer's P after 010/020 land.
- `r2-R2-1 High — sanitized 502 gate` → the Kiro-only run-turn branch uses `kiroRefusalKind` before the status-only fallback, so exact monthly/suspension 502 events reach the refusal rotator; unknown and post-output errors do not replay (lines 623, 694-754, 865). Named structured, Smithy, negative, and non-Kiro regression cases are at lines 754 and 882. Rebase-verify at this layer's P.
- `r2-R2-1 High — provider isolation` → adapter-dispatch keeps its original non-Kiro 429 loop byte-for-byte in the `else`, while run-turn's original non-Kiro predicate/count/error block follows an early Kiro branch unchanged (lines 284-362, 693-706). The adapter test asserts early count and cancellation before failed snapshot resolution; the run-turn test asserts original error and early count (lines 754, 882). Rebase-verify at this layer's P.
