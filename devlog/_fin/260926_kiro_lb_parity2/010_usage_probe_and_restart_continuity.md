# 010 — Kiro usage probe and restart continuity

- **Layer / branch:** 010, `codex/kiro-lb2-010-usage-persist`.
- **Depends on:** merged #5937 (`9c7c046520`, contained in `origin/dev` at `7ea48b9827`). This checkout is `bb3f3c2d0d`; read landed files with `git show origin/dev:<path>` before implementation. Line anchors below describe the checkout unless marked #5937.
- **Inventory:** S1b (no ARN means no probe); B/P7 (quota and verdict survive restart within reset/TTL).
- **Architect decisions:** D010-1 landed in #5937; add only a shared-resolver regression. D010-2 skips a non-OIDC account without a formable ARN and preserves its last-good display row. D010-3 persists quota and verdict with independent observation times and the same login identity fence; each expires at its own `min(resetAt, observedAt + ACCOUNT_QUOTA_TTL_MS)` and clears on removal. Routing has one hydrated, bounded Kiro evidence read taking a roster account.
- **Class:** C3 cross-module persistence design. This is a code-free implementation unit; no source or test files are edited here.

## Current state at `bb3f3c2d0d`

| Function / path:line | Observed contract and gap |
| --- | --- |
| `resolveKiroRequestProfile`, `src/oauth/kiro.ts:520-530` | Returns account-owned ARN, fixed Builder ID service ARN when `authType === "aws_sso_oidc"`, or undefined for a non-OIDC account without an ARN. `resolveKiroRequestProfileArn`, `src/oauth/kiro.ts:505-509`, delegates to it. Runtime `build`, `src/adapters/kiro/adapter.ts:103-116`, already uses this same resolver. |
| `kiroUsageContextForAccount`, #5937 `src/providers/kiro-usage.ts:214-232` | Takes bearer and metadata from one account snapshot, calls `resolveKiroRequestProfile`, and carries `builderIdFallback`. `usageRegion` at #5937 lines 78-87 ignores the fixed Builder ID ARN for host selection. D010-1 implementation is already landed. |
| `fetchKiroUsageSnapshot`, `src/providers/kiro-usage.ts:166-199` | Sends `GetUsageLimits` even when `ctx.profileArn` is absent; it conditionally omits ARN from both URL and JSON. It returns null on status/schema/transport failure. |
| `parseKiroUsage`, `src/providers/kiro-usage.ts:110-156` | Only recognized `AGENTIC_REQUEST` or `CREDIT` rows produce a quota. `overageStatus === ENABLED` avoids exhaustion; any other status currently implies overage disabled, including an unrecognized status. Quota `updatedAt` and reset are available for a bounded persisted verdict. |
| `commitKiroAccountUsageState` / `getKiroAccountExhaustion`, `src/providers/kiro-usage.ts:219-250` | Verdict is process-local with its own timestamp; null clears it. Reader degrades to unknown after account TTL or reset. `clearKiroAccountUsageState` and `reconcileKiroAccountUsageState`, `src/providers/kiro-usage.ts:252-272`, remove rows in memory. |
| `fetchAccountQuota`, `src/providers/quota.ts:418-525` | Only Anthropic hydrates disk at line 426. Kiro probe failures keep the captured last-good quota and set `unavailable` at lines 477-493; success commits quota and verdict behind one `mayCommitAccountQuotaKey` guard at lines 495-504, but neither branch persists Kiro state. The catch path at lines 506-519 also keeps the last-good row. |
| `hydrateAccountQuotaCache` / `persistAccountQuotaCache`, `src/providers/quota/account-cache.ts:101-125` | Disk hydration is one-shot and seeds non-Anthropic cache rows with `quota.updatedAt`; persistence serializes quota rows only. `accountCacheKey`, lines 163-165, is `provider\0accountId`. `clearAccountQuotaCache`, lines 367-390, clears Kiro verdicts and schedules a quota-only write for a provider-specific clear. `reconcileProviderAccountQuotaRows`, lines 336-357, clears both in-memory maps but schedules no disk write. |
| `readPersistedAccountQuotas` / `schedulePersistAccountQuotas`, `src/providers/account-quota-disk.ts:31-79` | Version-1 file contains only `rows`; a six-hour disk bound applies to all providers. Writes are debounced and atomic. A separate Kiro limit must be enforced on hydration because six hours exceeds `ACCOUNT_QUOTA_TTL_MS` (`src/providers/quota-wire.ts:15-22`). |
| `isAccountQuotaExhausted` / `rankAccountsByHeadroom` / `exhaustedCooldownMs`, `src/oauth/account-quota-rank.ts:126-175,216-222` | Consumers read Kiro's explicit verdict before percentage-derived headroom and use reset for bounded cooldown. A stale or malformed persisted verdict must never create a cooldown. |
| `getAccountSet`, `src/oauth/store.ts:1025-1027` | Reads the stored roster; hydration admits only keys still in that roster with matching login identity. `saveCredentialWithReceipt`, lines 855-896, can upgrade an identity-less active slot in place, retaining its account ID. `credentialGeneration`, line 340, hashes volatile tokens, so it cannot be the durable evidence fence. |

The read-only AGPL reference supports the behavioral comparison at `/tmp/kiro-lb/kiro/usage.py:63-97` (ARN requirement) and `/tmp/kiro-lb/kiro/store.py:314-350` (startup rows). No reference code or layout is used below.

## File change map and exact patches

Apply the MODIFY hunks to the landed #5937 tree, preserving its resolver and Builder ID logic. The proposed disk format remains version 1 with one optional `kiroVerdicts` map and an identity field on Kiro quota rows; old version-1 files remain readable but identity-less Kiro evidence is unknown. Never persist bearer, ARN, email, client registration, or an upstream body. All diagnostics/logs use closed-set codes and statuses; they must never include upstream message text, tokens, device codes, or client secrets.

### MODIFY `src/providers/kiro-usage.ts`

Start from merged #5937: `kiroUsageContextForAccount` already calls `resolveKiroRequestProfile` and carries `builderIdFallback`. Do not reimplement D010-1. Retain a Builder ID host helper for 050, make a no-ARN probe a no-network unknown, and make quota/verdict independent. These hunks describe the changed contract; use the landed source for context.

```diff
@@ imports/types
+import type { ProviderAccount } from "../oauth/types";
+import { getAccountSet } from "../oauth/store";
+import { hydrateKiroAccountState, kiroEvidenceIdentity, type KiroPersistedVerdict } from "./kiro-account-state-disk";
+import { accountCacheKey, accountQuotaCache } from "./quota/account-cache";
@@ KiroUsageSnapshot
+  overageEnabled?: boolean;
@@ KiroUsageStateEntry
+  overageEnabled: boolean;
+  identity: string;
@@ parseKiroUsage
-  const overageEnabled = String(asRecord(payload.overageConfiguration)?.overageStatus ?? "")
-    .trim().toUpperCase() === "ENABLED";
+  const overageStatus = String(asRecord(payload.overageConfiguration)?.overageStatus ?? "").trim().toUpperCase();
+  const overageEnabled = overageStatus === "ENABLED";
@@
-    exhausted: used >= limit && !overageEnabled,
+    exhausted: used >= limit && overageStatus === "DISABLED",
+    overageEnabled,
@@ fetchKiroUsageSnapshot
+  if (!ctx.profileArn) return null; // before URL construction or fetch
@@
-  if (ctx.profileArn) url.searchParams.set("profileArn", ctx.profileArn);
+  url.searchParams.set("profileArn", ctx.profileArn);
@@
-  if (ctx.profileArn) body.profileArn = ctx.profileArn;
+  body.profileArn = ctx.profileArn;
@@ after usageRegion
+export function kiroManagementHost(ctx: KiroUsageContext): string {
+  return new URL(kiroUsageManagementUrl(usageRegion(ctx))).host;
+}
@@ commitKiroAccountUsageState
-export function commitKiroAccountUsageState(key: string, snapshot: KiroUsageSnapshot | null): void {
+export function commitKiroAccountUsageState(key: string, snapshot: KiroUsageSnapshot | null, identity?: string): void {
+  if (snapshot && !identity) return;
@@
   usageState.set(key, {
     exhausted: snapshot.exhausted,
+    overageEnabled: snapshot.overageEnabled === true,
     ...(snapshot.nextResetAt !== undefined ? { nextResetAt: snapshot.nextResetAt } : {}),
-    ts: Date.now(),
+    ts: Date.now(), // verdict observedAt, independent of quota.updatedAt
+    identity: identity!,
   });
 }
@@ after commit
+export function* kiroPersistableVerdicts(now = Date.now()): IterableIterator<[string, KiroPersistedVerdict]> {
+  const live = new Map<string, string>(getAccountSet("kiro")?.accounts.map(a => [accountCacheKey("kiro", a.id), kiroEvidenceIdentity(a)]) ?? []);
+  for (const [key, entry] of usageState) {
+    if (live.get(key) !== entry.identity || entry.ts > now || now - entry.ts >= ACCOUNT_QUOTA_TTL_MS
+      || (entry.nextResetAt !== undefined && entry.nextResetAt <= now)) continue;
+    yield [key, { exhausted: entry.exhausted, overageEnabled: entry.overageEnabled,
+      ...(entry.nextResetAt !== undefined ? { resetAt: entry.nextResetAt } : {}),
+      observedAt: entry.ts, identity: entry.identity }];
+  }
+}
+
+export function hydrateKiroUsageVerdict(key: string, verdict: KiroPersistedVerdict, account: ProviderAccount): void {
+  if (usageState.has(key) || verdict.identity !== kiroEvidenceIdentity(account)) return;
+  usageState.set(key, { exhausted: verdict.exhausted, overageEnabled: verdict.overageEnabled,
+    ...(verdict.resetAt !== undefined ? { nextResetAt: verdict.resetAt } : {}),
+    ts: verdict.observedAt, identity: verdict.identity });
+}
@@ getKiroAccountExhaustion
-export function getKiroAccountExhaustion(key: string, now = Date.now()): { exhausted: boolean; nextResetAt?: number } | null {
+export function getKiroAccountExhaustion(key: string, account: ProviderAccount, now = Date.now()): { exhausted: boolean; nextResetAt?: number } | null {
   const entry = usageState.get(key);
+  if (!entry || entry.identity !== kiroEvidenceIdentity(account)) return null;
-  if (now - entry.ts >= ACCOUNT_QUOTA_TTL_MS) return null;
+  if (entry.ts > now || now - entry.ts >= ACCOUNT_QUOTA_TTL_MS) return null;
@@ new single routing read
+export function kiroAccountEvidence(account: ProviderAccount, now = Date.now()):
+  { quotaPercent?: number; exhausted?: boolean; resetAt?: number } {
+  hydrateKiroAccountState(); // account-cache's one-shot flag gates disk I/O
+  const identity = kiroEvidenceIdentity(account);
+  const key = accountCacheKey("kiro", account.id);
+  const row = accountQuotaCache.get(key);
+  const quota = row?.identity === identity && row.quota
+    && typeof row.quota.monthlyPercent === "number" && Number.isFinite(row.quota.monthlyPercent)
+    && row.quota.updatedAt <= now
+    && now - row.quota.updatedAt < ACCOUNT_QUOTA_TTL_MS
+    && (row.quota.monthlyResetAt === undefined || row.quota.monthlyResetAt > now)
+    ? row.quota : null;
+  const verdict = getKiroAccountExhaustion(key, account, now);
+  return {
+    ...(quota?.monthlyPercent !== undefined ? { quotaPercent: quota.monthlyPercent } : {}),
+    ...(verdict ? { exhausted: verdict.exhausted } : {}),
+    ...(verdict?.nextResetAt !== undefined ? { resetAt: verdict.nextResetAt }
+      : quota?.monthlyResetAt !== undefined ? { resetAt: quota.monthlyResetAt } : {}),
+  };
+}
```

`kiroAccountEvidence` takes the freshly read roster `ProviderAccount` the caller already holds; callers must not cache that object across requests, and admission revalidates the selected account after awaits. It performs no `getAccountCredential`/`loadAuthStore` per evidence read and no network request. `getKiroAccountExhaustion` remains a low-level/test helper; routing must never call it directly. Unrecognized overage status gives a bar but no positive exhaustion. Layer 050 uses `kiroUsageContextForAccount` plus `kiroManagementHost(ctx)` so the fixed Builder ID service ARN never picks the management host region. Layer 030's refusal state uses the same login identity; diagnostics carry closed-set codes/statuses only.

### MODIFY `src/providers/account-quota-disk.ts`

Keep the existing version and writer debounce; add one optional map in the same atomic file. For Kiro only, `rows[key]` becomes a `ProviderQuota` plus `identity`; non-Kiro rows keep their old shape. The reader treats JSON as untrusted and returns an empty map for a missing/corrupt/future file. Validate quota and verdict independently; their timestamps need not match. A verdict requires a current live account and matching identity, but it can survive if the quota observation is stale, and vice versa.

```diff
@@
 import type { ProviderQuota } from "./quota-types";
+import type { KiroPersistedQuota, KiroPersistedVerdict } from "./kiro-account-state-disk";
+import { ACCOUNT_QUOTA_TTL_MS } from "./quota-wire";
@@
 type DiskFile = {
   version: 1;
   rows: Record<string, ProviderQuota | KiroPersistedQuota>;
+  kiroVerdicts?: Record<string, KiroPersistedVerdict>;
 };
@@
 export function readPersistedAccountQuotas(now = Date.now()): Map<string, ProviderQuota> {
@@
-      if (!quota || typeof quota !== "object" || typeof quota.updatedAt !== "number") continue;
-      if (now - quota.updatedAt > DISK_MAX_AGE_MS) continue;
+      if (!quota || typeof quota !== "object" || typeof quota.updatedAt !== "number"
+        || !Number.isFinite(quota.updatedAt) || quota.updatedAt > now) continue;
+      if (now - quota.updatedAt > DISK_MAX_AGE_MS) continue;
+      if (key.startsWith("kiro\0") && (typeof (quota as KiroPersistedQuota).identity !== "string"
+        || !/^[a-f0-9]{64}$/.test((quota as KiroPersistedQuota).identity))) continue;
@@
 }
+
+export function readPersistedKiroVerdicts(now = Date.now()): Map<string, KiroPersistedVerdict> {
+  const result = new Map<string, KiroPersistedVerdict>();
+  try {
+    const parsed: unknown = JSON.parse(readFileSync(join(getConfigDir(), FILENAME), "utf8"));
+    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
+    const file = parsed as Partial<DiskFile>;
+    if (file.version !== 1 || !file.rows || !file.kiroVerdicts
+      || typeof file.rows !== "object" || typeof file.kiroVerdicts !== "object"
+      || Array.isArray(file.rows) || Array.isArray(file.kiroVerdicts)) return result;
+    for (const [key, raw] of Object.entries(file.kiroVerdicts)) {
+      if (!key.startsWith("kiro\0") || !raw || typeof raw !== "object") continue;
+      const row = raw as Partial<KiroPersistedVerdict>;
+      if (typeof row.exhausted !== "boolean" || typeof row.overageEnabled !== "boolean"
+        || typeof row.identity !== "string" || !/^[a-f0-9]{64}$/.test(row.identity)
+        || typeof row.observedAt !== "number" || !Number.isFinite(row.observedAt)
+        || row.observedAt > now || now - row.observedAt >= ACCOUNT_QUOTA_TTL_MS
+        || (row.resetAt !== undefined && (typeof row.resetAt !== "number"
+          || !Number.isFinite(row.resetAt) || row.resetAt <= now
+          || !Number.isFinite(new Date(row.resetAt).getTime())))) continue;
+      result.set(key, row as KiroPersistedVerdict);
+    }
+  } catch { /* Corrupt/missing cache is unknown. */ }
+  return result;
+}
@@
-export function schedulePersistAccountQuotas(rows: () => Iterable<[string, ProviderQuota]>): void {
+export function schedulePersistAccountQuotas(
+  rows: () => Iterable<[string, ProviderQuota | KiroPersistedQuota]>,
+  verdicts: () => Iterable<[string, KiroPersistedVerdict]> = () => [],
+): void {
@@
       for (const [key, quota] of rows()) out[key] = quota;
-      const body: DiskFile = { version: 1, rows: out };
+      const kiroVerdicts: Record<string, KiroPersistedVerdict> = {};
+      for (const [key, verdict] of verdicts()) {
+        if (key.startsWith("kiro\0") && /^[a-f0-9]{64}$/.test(verdict.identity)) kiroVerdicts[key] = verdict;
+      }
+      const body: DiskFile = { version: 1, rows: out, kiroVerdicts };
```

The existing one-argument callers retain their signature and behavior; their write emits an empty `kiroVerdicts` object. The account-cache caller below supplies the actual Kiro map. The version-1 future-schema test at `tests/providers/provider-account-quota-persistence.test.ts:55-58` still rejects version 2.

### MODIFY `src/providers/quota/account-cache.ts`

Hydrate once, admitting only live Kiro accounts whose persisted identity matches the current `ProviderAccount`. Validate quota percentage, timestamp, TTL and reset. Hydrate a valid verdict separately: its `observedAt` is independent of `quota.updatedAt`. Other providers keep their existing six-hour disk policy. A failed probe can keep a same-login display bar, but only `kiroAccountEvidence` may drive routing.

```diff
@@ imports
+import { kiroEvidenceIdentity, type KiroPersistedQuota } from "../kiro-account-state-disk";
-import { clearKiroAccountUsageState, reconcileKiroAccountUsageState } from "../kiro-usage";
+import { clearKiroAccountUsageState, hydrateKiroUsageVerdict, kiroPersistableVerdicts, reconcileKiroAccountUsageState } from "../kiro-usage";
-import { cancelPendingAccountQuotaPersist, readPersistedAccountQuotas, schedulePersistAccountQuotas } from "../account-quota-disk";
+import { cancelPendingAccountQuotaPersist, readPersistedAccountQuotas, readPersistedKiroVerdicts, schedulePersistAccountQuotas } from "../account-quota-disk";
+import type { ProviderAccount } from "../../oauth/types";
@@ hydrateAccountQuotaCache
-  for (const [key, quota] of readPersistedAccountQuotas()) {
+  const now = Date.now();
+  const liveKiro = new Map<string, ProviderAccount>(getAccountSet("kiro")?.accounts.map(a =>
+    [accountCacheKey("kiro", a.id), a]) ?? []);
+  for (const [key, quota] of readPersistedAccountQuotas(now)) {
+    if (key.startsWith("kiro\0")) {
+      const account = liveKiro.get(key);
+      if (!account || (quota as KiroPersistedQuota).identity !== kiroEvidenceIdentity(account)
+        || typeof quota.monthlyPercent !== "number" || !Number.isFinite(quota.monthlyPercent)
+        || quota.monthlyPercent < 0 || quota.monthlyPercent > 100
+        || now - quota.updatedAt >= ACCOUNT_QUOTA_TTL_MS
+        || (quota.monthlyResetAt !== undefined && (typeof quota.monthlyResetAt !== "number"
+          || !Number.isFinite(quota.monthlyResetAt) || quota.monthlyResetAt <= now))) continue;
+    }
@@ accountQuotaCache.set inside hydration
-      accountQuotaCache.set(key, { ts: anthropic ? 0 : quota.updatedAt,
-        quota: anthropic ? normalizeAnthropicQuota(quota, Date.now()) : quota });
+      accountQuotaCache.set(key, { ts: anthropic ? 0 : quota.updatedAt,
+        quota: anthropic ? normalizeAnthropicQuota(quota, now) : quota,
+        ...(key.startsWith("kiro\0") ? { identity: (quota as KiroPersistedQuota).identity } : {}) });
@@ after quota hydration loop
+  for (const [key, verdict] of readPersistedKiroVerdicts(now)) {
+    const account = liveKiro.get(key);
+    if (account && verdict.identity === kiroEvidenceIdentity(account))
+      hydrateKiroUsageVerdict(key, verdict, account);
+  }
@@ persistAccountQuotaCache, inside debounced rows callback
+    const liveKiro = new Map<string, ProviderAccount>(getAccountSet("kiro")?.accounts.map(a => [accountCacheKey("kiro", a.id), a]) ?? []);
@@
-      if (quota) yield [key, quota] as [string, ProviderQuota];
+      if (quota && key.startsWith("kiro\0")) {
+        const account = liveKiro.get(key);
+        if (account && entry.identity === kiroEvidenceIdentity(account))
+          yield [key, { ...quota, identity: entry.identity } as KiroPersistedQuota] as [string, KiroPersistedQuota];
+      } else if (quota) yield [key, quota] as [string, ProviderQuota];
@@ schedulePersistAccountQuotas call end
-  });
+  }, () => kiroPersistableVerdicts());
@@ getCachedProviderAccountQuota, before the existing return
+  if (provider === "kiro") {
+    const account = getAccountSet("kiro")?.accounts.find(a => a.id === accountId);
+    if (!account || entry?.identity !== kiroEvidenceIdentity(account)) return null;
+  }
@@ setCachedProviderAccountQuotaForTests, when quota is non-null
+  // Seed a Kiro row with the actual roster identity; tests that need malformed rows write disk directly.
+  const account = provider === "kiro" ? getAccountSet("kiro")?.accounts.find(a => a.id === accountId) : undefined;
-  accountQuotaCache.set(key, { ts: Date.now(), quota });
+  accountQuotaCache.set(key, { ts: Date.now(), quota,
+    ...(account ? { identity: kiroEvidenceIdentity(account) } : {}) });
@@ reconcileProviderAccountQuotaRows, after removals
+  if (removed > 0) persistAccountQuotaCache();
@@ clearAccountQuotaCache, provider-specific branch before iterating keys
+  hydrateAccountQuotaCache();
```

`getCachedProviderAccountQuota` remains a display/read helper; its Kiro branch may read the store. Routing does not call it for Kiro. The full cache clear still cancels pending writes and resets one-shot hydration (`src/providers/quota/account-cache.ts:370-378`); tests wait for debounce before using it as a restart seam. A provider-specific clear hydrates before writing the whole map so it cannot erase other providers' disk rows. The existing `mayCommitAccountQuotaKey` generation fence remains in `quota.ts`; the new login identity check complements it.

### MODIFY `src/oauth/types.ts`; MODIFY `src/oauth/store.ts` — login identity fence

`ProviderAccount` gains optional `loginId?: string`. `saveCredentialWithReceipt` generates a new UUID on **every login write**, including new-slot append, existing identity match, and both in-place replacement paths. This is a login event marker, not a token generation. `normalizeAccount` preserves only UUID-shaped values; absent legacy values continue to use `addedAt`. Refresh writers `saveAccountCredential` (`src/oauth/store.ts:1065-1081`) and `mergeAccountCredential` (`:1244`) replace only `.credential` and leave `loginId` untouched. No `authType` belongs in the identity: `normalizeCredential` at `src/oauth/store.ts:539` does not store it.

```diff
--- a/src/oauth/types.ts
+++ b/src/oauth/types.ts
@@ ProviderAccount
   id: string;
+  /** New for every explicit login; stable across token refresh. */
+  loginId?: string;
--- a/src/oauth/store.ts
+++ b/src/oauth/store.ts
@@ normalizeAccount, after addedAt at line 616
+  if (typeof candidate.loginId === "string"
+    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.loginId))
+    account.loginId = candidate.loginId;
@@ saveCredentialWithReceipt, after the branch that assigns accountId (line 896), before return
+    // All login paths, including in-place legacy upgrades, invalidate old evidence.
+    store[provider]!.accounts.find(a => a.id === accountId)!.loginId = randomUUID();
```

The last assignment must run inside `mutateStore`, after all branches choose the written account. Add tests in `tests/oauth/oauth-store-multi.test.ts` named `each login write rotates loginId even when account id is reused` (new slot and same-ID relogin have distinct UUIDs), `normalizeAuthStore keeps a valid loginId and drops an invalid one` (round-trip valid UUID; invalid input is absent), and `refresh writers preserve loginId` (both refresh writers change tokens but keep UUID and account ID). The privacy boundary stays in the protected auth store; public management DTOs do not expose `loginId`.

### NEW `src/providers/kiro-account-state-disk.ts` — complete file

```ts
/** Kiro identity and disk entrypoints; quota mechanics stay in the shared cache. */
import { createHash } from "node:crypto";
import type { ProviderAccount } from "../oauth/types";
import type { ProviderQuota } from "./quota-types";
import { hydrateAccountQuotaCache, persistAccountQuotaCache } from "./quota/account-cache";

export function kiroEvidenceIdentity(account: ProviderAccount): string {
  const cred = account.credential;
  return createHash("sha256").update(JSON.stringify([
    account.id, account.loginId ?? String(account.addedAt ?? ""),
    cred.accountId ?? cred.email ?? "", cred.kiro?.profileArn ?? "",
    cred.kiro?.clientId ?? "",
  ])).digest("hex");
}

export interface KiroPersistedQuota extends ProviderQuota {
  identity: string;
}

export interface KiroPersistedVerdict {
  exhausted: boolean;
  overageEnabled: boolean;
  resetAt?: number;
  observedAt: number;
  identity: string;
}

export function hydrateKiroAccountState(): void {
  hydrateAccountQuotaCache();
}

export function persistKiroAccountState(): void {
  persistAccountQuotaCache();
}
```

The hash input is **exactly** this five-element JSON array. It stores no raw email, ARN, client ID, token or secret. A legacy row without `loginId` uses its stable `addedAt`; its next login acquires a new UUID and invalidates old evidence even if the same account ID and identity-less credential slot are reused. `credentialGeneration()` hashes volatile tokens (`src/oauth/store.ts:340-342`), so it cannot fence evidence across refresh. `account-quota-disk.ts` has only a type import from this file at runtime. Check the existing `kiro-usage.ts` ↔ `account-cache.ts` import cycle and Lab boundary before implementation.

### MODIFY `src/providers/quota.ts`; MODIFY `src/providers/quota/vendor-probes-oauth.ts`

`fetchAccountQuota` (`src/providers/quota.ts:418-525`) hydrates Kiro disk state before a probe can overwrite it, captures the login identity before its first await, and rechecks it at each commit in addition to `mayCommitAccountQuotaKey`. Keep Kiro cache hits only when identity matches, and let an in-flight joiner with a new login identity start a fresh probe after the old promise settles. The catch/failure paths retain a same-login last-good bar and any matching, unexpired verdict, including `exhausted: false` for overage at 100%; neither path refreshes the quota's `updatedAt` or the verdict's `observedAt`. Identity and independent TTL/reset checks in `kiroAccountEvidence` make mismatched or expired evidence unknown. Routing still hydrates independently: the first routing request can arrive without a quota API call. `src/providers/quota.ts` has a 558-line cap; extract Kiro-specific logic into `vendor-probes-oauth.ts` if needed rather than raising it.

```diff
@@ quota.ts imports
+import { hydrateKiroAccountState, kiroEvidenceIdentity, persistKiroAccountState } from "./kiro-account-state-disk";
@@ fetchAccountQuota, before reading the cache or starting a probe
+  if (provider === "kiro") hydrateKiroAccountState();
@@ fetchAccountQuota, before first await
+  const kiroAccount = provider === "kiro" ? getAccountSet("kiro")?.accounts.find(a => a.id === accountId) : undefined;
+  const kiroIdentity = kiroAccount ? kiroEvidenceIdentity(kiroAccount) : undefined;
+  const kiroCurrent = () => provider !== "kiro" || (kiroIdentity !== undefined
+    && getAccountSet("kiro")?.accounts.some(a => a.id === accountId && kiroEvidenceIdentity(a) === kiroIdentity) === true);
@@
-  const cached = accountQuotaCache.get(key);
+  const candidate = accountQuotaCache.get(key);
+  const cached = provider !== "kiro" || candidate?.identity === kiroIdentity ? candidate : undefined;
@@
-  if (joinable) return joinable;
+  if (joinable) {
+    const joined = await joinable;
+    return provider !== "kiro" || joined.identity === kiroIdentity
+      ? joined : fetchAccountQuota(provider, accountId, true, providerConfig);
+  }
@@ all three commit guards: failure, success, catch
-      if (mayCommitAccountQuotaKey(key, writerGeneration)) {
+      if (mayCommitAccountQuotaKey(key, writerGeneration) && kiroCurrent()) {
+        if (provider === "kiro") entry.identity = kiroIdentity;
         accountQuotaCache.set(key, entry);
@@ failed Kiro probe branch
-          if (provider === "kiro") commitKiroAccountUsageState(key, null);
+          if (provider === "kiro") persistKiroAccountState(); // retain only live, same-login verdict; do not renew observedAt
@@ successful Kiro probe branch
-        if (provider === "kiro") commitKiroAccountUsageState(key, kiroSnapshot);
+        if (provider === "kiro") { commitKiroAccountUsageState(key, kiroSnapshot, kiroIdentity); persistKiroAccountState(); }
```

The null-result and thrown-error paths leave `usageState` untouched. Hydration before the probe prevents a failure immediately after restart from replacing a saved overage verdict with an empty map. The failed-probe persistence call above rewrites the last-good quota with its original `updatedAt`; `kiroPersistableVerdicts` emits only an identity-matching verdict still before its original TTL/reset. A stale or different-login verdict is filtered rather than carried to disk. Only a successful snapshot replaces the verdict; explicit account removal/reconciliation still clears it.

The `vendor-probes-oauth.ts:363-381` provider-level Kiro probe is a second writer. Before its await, capture `probedAccount = getAccountSet("kiro")?.accounts.find(a => a.id === probedAccountId)` and `identity = kiroEvidenceIdentity(probedAccount)`. At the existing `mayCommitAccountQuotaKey` guard, require the current roster account to have the same identity; set `{ts, quota, identity}` in `accountQuotaCache`, then call `commitKiroAccountUsageState(probedAccountKey, snapshot, identity)` and `persistKiroAccountState()`. If the login changed, return `null` instead of publishing a provider report for an old credential. At its `:407-410` whole-cache persistence path, retain the identity guard. This closes the same-key in-flight upgrade race on both probe entrypoints. Tests assert an old promise neither commits nor feeds a new-login joiner.

### MODIFY `src/oauth/account-quota-rank.ts`; MODIFY `src/oauth/generic-account-failover.ts` — routing read migration

The current `headroomOf` at `src/oauth/account-quota-rank.ts:87` calls `getCachedProviderAccountQuota`, which has neither Kiro hydration nor Kiro age checks. `isAccountQuotaExhausted` at `:132` falls back from an expired verdict to that stale percentage. `rankAccountsByHeadroom`, `hasHeadroomEvidence`, and `exhaustedCooldownMs` directly read `getKiroAccountExhaustion` at `:161,204,218`. Replace every Kiro routing branch with `kiroAccountEvidence(account, now)`. The account comes from the caller's already-read roster; **no** `getAccountCredential` or `loadAuthStore` runs per evidence read. Non-Kiro paths keep their existing signatures/behavior through optional account arguments.

```diff
@@ account-quota-rank.ts imports
-import { getKiroAccountExhaustion } from "../providers/kiro-usage";
+import { kiroAccountEvidence } from "../providers/kiro-usage";
+import type { ProviderAccount } from "./types";
@@ headroomOf signature and line 87
-function headroomOf(provider: string, accountId: string, requestedModelId?: string | null): number | null {
-  const quota = getCachedProviderAccountQuota(provider, accountId);
+function headroomOf(provider: string, accountId: string, requestedModelId?: string | null, account?: ProviderAccount): number | null {
+  const evidence = provider === "kiro" && account ? kiroAccountEvidence(account) : null;
+  const quota = provider === "kiro"
+    ? evidence?.quotaPercent === undefined ? null : { monthlyPercent: evidence.quotaPercent, updatedAt: Date.now() }
+    : getCachedProviderAccountQuota(provider, accountId);
@@ isAccountQuotaExhausted signature and line 132
+  account?: ProviderAccount,
-  const exhaustion = provider === "kiro" ? getKiroAccountExhaustion(`${provider}\u0000${accountId}`) : null;
-  if (exhaustion !== null) return exhaustion.exhausted;
+  const exhaustion = provider === "kiro" && account ? kiroAccountEvidence(account).exhausted : undefined;
+  if (exhaustion !== undefined) return exhaustion;
-  const headroom = headroomOf(provider, accountId, requestedModelId);
+  const headroom = headroomOf(provider, accountId, requestedModelId, account);
@@ rankAccountsByHeadroom signature and map loop
+  accounts?: ReadonlyMap<string, ProviderAccount>,
-    const exhaustion = provider === "kiro" ? getKiroAccountExhaustion(`${provider}\u0000${id}`) : null;
-    const headroom = headroomOf(provider, id, requestedModelId);
-    if (exhaustion !== null || headroom !== null) sawEvidence = true;
+    const account = accounts?.get(id);
+    const exhaustion = provider === "kiro" && account ? kiroAccountEvidence(account).exhausted : undefined;
+    const headroom = headroomOf(provider, id, requestedModelId, account);
+    if (exhaustion !== undefined || headroom !== null) sawEvidence = true;
@@
-    if (isAccountQuotaExhausted(provider, id, requestedModelId))
+    if (isAccountQuotaExhausted(provider, id, requestedModelId, account))
@@ hasHeadroomEvidence signature/body
+  accounts?: ReadonlyMap<string, ProviderAccount>,
-    headroomOf(provider, id, requestedModelId) !== null
-    || (provider === "kiro" && getKiroAccountExhaustion(`${provider}\u0000${id}`) !== null));
+    headroomOf(provider, id, requestedModelId, accounts?.get(id)) !== null
+    || (provider === "kiro" && accounts?.get(id) !== undefined
+      && kiroAccountEvidence(accounts.get(id)!).exhausted !== undefined));
@@ exhaustedCooldownMs signature/body
+  account?: ProviderAccount,
-  const exhaustion = getKiroAccountExhaustion(`${provider}\u0000${accountId}`, now);
-  if (!exhaustion?.exhausted) return null;
-  const untilReset = exhaustion.nextResetAt === undefined ? MIN_EXHAUSTED_COOLDOWN_MS : exhaustion.nextResetAt - now;
+  const evidence = account ? kiroAccountEvidence(account, now) : {};
+  if (!evidence.exhausted) return null;
+  const untilReset = evidence.resetAt === undefined ? MIN_EXHAUSTED_COOLDOWN_MS : evidence.resetAt - now;
```

`accountHeadroomPercent` forwards its optional `ProviderAccount` to `headroomOf`. In `generic-account-failover.ts`, `preferredInitialAccount` already holds `selected.accounts` at `:449-455`: build `const accountRows = new Map(selected.accounts.map(a => [a.id, a]))` once and pass it to `hasHeadroomEvidence` (`:494`), `rankAccountsByHeadroom` (`:508`), and `activeRow` to `isAccountQuotaExhausted` (`:487`). The 429 rotator already holds `set.accounts` at `:355`; pass its failed account to `exhaustedCooldownMs` (`:366`) and its roster map to `rankAccountsByHeadroom` (`:414`). For fill-first, add `accountRows?: ReadonlyMap<string, ProviderAccount>` to `pickFillFirstGenericAccount` (`:282`) and `account?: ProviderAccount` to `isOverAutoSwitchThreshold` (`:271`); `preferredInitialAccount` passes its map, and the threshold helper forwards `accountRows?.get(activeId)` through `accountHeadroomPercent` to `headroomOf`. This replaces an ID-only evidence read without adding a store read per account. A missing Kiro row is unknown. Update direct Kiro rank tests to pass a roster map.

`exhausted === false` overrides a 100% bar; `exhausted === true` excludes. After both independently bounded observations expire, unknown returns the original ring. `preferredInitialAccount` may move only under **effective pool enablement**; an explicit `oauthAccountFailover.enabled === false` globally or for Kiro wins over presence and stops first-admission movement and all rotation. With setting unset, presence-is-consent enables 030 refusal-aware exclusion of a known suspended/monthly-exhausted active account. The configured concurrency cap is separately opt-in; its full-cap behavior is specified below.

### Cross-layer handoff contracts used by 010 evidence

These are integration requirements for later layers, not 010 source edits. Layer 030 classifies **every** Kiro 429/400/403 arm with `classifyKiroRefusal` and rotates in one bounded `rotateGenericOAuthAccountOnRefusal` loop. This includes `src/server/responses/adapter-dispatch.ts:859-903` and `src/server/responses/run-turn-execution.ts:371` (Kiro reaches the run-turn arm through `_kiroAuthContext` at `:61`). Layer 040 capacity exclusion plugs into that same loop. For Kiro, retain the original upstream `Response` without canceling it until a replacement is admitted; if none is admitted, forward the original status/body. Change `genericFailovers` accounting and admission order only in Kiro branches. Non-Kiro 429 behavior, ordering and counts stay exact; regression tests cover both adapter-dispatch and run-turn arms.

An explicit `oauthAccountFailover.enabled === false` globally or per provider forbids initial account movement and rotation, including refusal-aware movement. When the setting is unset or true, refusal-aware initial exclusion may choose an alternate; singleton/all-excluded fallback still sends the active account. `maxConcurrentPerAccount` is an independent explicit opt-in: when movement is forbidden or the pool is singleton, a full cap waits up to the bounded wait and then returns retryable `503` with code `account_capacity` and `Retry-After`; when movement is allowed, try another eligible account first. Layer 070 renames `routable` to `autoSelectable` with `skipReason` to describe automatic-selection eligibility; the singleton-send test proves it is not a hard send prohibition. Layer 050 stores the same identity in every catalogue row and in-flight fetch, and obtains host from `kiroUsageContextForAccount` plus `kiroManagementHost(ctx)`.

Layer 030's exact regression targets are `tests/oauth/adapter-event-oauth-failover.test.ts` with `non-Kiro adapter-dispatch 429 keeps original response order and failover count`, and `tests/responses/responses-run-turn-web-search.test.ts` with `non-Kiro run-turn 429 keeps original response order and failover count`: for xAI, assert adapter-dispatch still cancels the original response before snapshot admission (`adapter-dispatch.ts:900-903`), run-turn still leaves its preflight 429 to the client if no hop is admitted (`run-turn-execution.ts:349-369`), and both still increment `genericFailovers` after snapshot retrieval but before `applyFailoverSnapshot` (adapter `:903`, run-turn `:385`). Add Kiro cases in those same files named `Kiro adapter-dispatch classifies 400 403 and 429 before bounded rotation` and `Kiro run-turn classifies 400 403 and 429 before bounded rotation`: assert all three statuses call `classifyKiroRefusal`, use `rotateGenericOAuthAccountOnRefusal` once, and preserve the original body/status when no replacement is admitted. Add `explicit off blocks Kiro first admission and refusal rotation` to `tests/oauth/generic-oauth-failover.test.ts` and `full singleton cap returns retryable account_capacity` to the 040 capacity test file; assert bounded wait, 503 and `Retry-After`. These tests are later-layer targets, not 010 source work.

### MODIFY `tests/providers/kiro/kiro-usage-quota.test.ts`

Most existing parser/transport tests call the probe with `baseContext` (`bb3f3c2d0d:31,45-190`). Give that fixture a real ARN so they continue to test the intended outbound path. The new sibling explicitly tests the missing-ARN early return.

```diff
@@
-const baseContext = { accountId: "acct-1", access: "tok-1" };
+const baseContext = {
+  accountId: "acct-1", access: "tok-1",
+  profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/TEST",
+};
```

### MODIFY `tests/providers/kiro/kiro-account-quota.test.ts` (landed #5937 addition)

#5937 adds `a non-Builder-ID account without a stored ARN still sends none`. S1b supersedes its expectation of an ARN-less network send. Keep the case and change its observable assertion, while the new sibling proves last-good preservation. This file is not among the capped tests in `tests/fixtures/file-size-baseline.json:45-48`.

```diff
@@
-  test("a non-Builder-ID account without a stored ARN still sends none", async () => {
+  test("a non-Builder-ID account without a stored ARN makes no usage request", async () => {
@@
-    expect(seen).toHaveLength(1);
-    expect(seen[0]!.arn).toBeNull();
-    expect(seen[0]!.bodyArn).toBeUndefined();
+    expect(seen).toHaveLength(0);
```

### MODIFY `docs-site/src/content/docs/reference/adapters.md`

Apply after #5937's wording at the Kiro per-account-usage bullet (`bb3f3c2d0d:344-350`). The sentence-level addition is: “For a non-Builder-ID account with no usable profile ARN, the usage probe makes no request and reports usage unavailable; an earlier same-login quota bar remains visible. Known Kiro quota and overage/exhaustion evidence survive a restart only for the same login and until each observation's reset or ten-minute lifetime; missing, old, or malformed evidence is unknown.” This is a user-facing behavior change. Inspect localized provider pages for contrary claims; do not invent translations.

```diff
@@
   limit. The operation is undocumented by AWS, so treat the numbers as best-effort.
+  A non-Builder-ID account with no usable profile ARN makes no usage request; its usage is
+  unavailable while an earlier same-login quota bar remains visible. Known quota and
+  exhaustion evidence survive restart only for the same login, each until its
+  own reset or ten-minute lifetime; missing, old, or malformed evidence becomes unknown.
```

### MODIFY `structure/providers-and-adapters.md`; MODIFY `structure/providers/kiro.md`

`structure/INDEX.md:136,138` assigns `src/oauth/` and `src/providers/` to `providers-and-adapters.md`; `structure/INDEX.md:64` identifies `providers/kiro.md` as the Kiro contract. Add the following text immediately after the existing quota-probe discussion in `providers-and-adapters.md` (`bb3f3c2d0d:44-50`) and after the login-rollback paragraph in `providers/kiro.md` (`bb3f3c2d0d:25-31`). This documents the login marker, source ownership, and vendor-specific invariant.

```diff
--- a/structure/providers-and-adapters.md
+++ b/structure/providers-and-adapters.md
@@
 video quota rows are unrelated and omitted.
+Kiro's account quota cache persists quota and an optional exhaustion/overage verdict under
+one opaque account key and non-secret login identity; hydration admits only
+matching live accounts, bounding quota and verdict independently by their reset and
+ten-minute TTL, while a failed probe keeps the same-login last-good display bar.
+The protected OAuth store rotates `ProviderAccount.loginId` on every explicit login,
+preserves it across credential refresh, and uses `addedAt` for legacy rows without one.
--- a/structure/providers/kiro.md
+++ b/structure/providers/kiro.md
@@
 > Decision record: [ADR-0109](../decisions/ADR-0109-kiro-login-rollback-ownership.md)
+
+Kiro usage probing uses the same request-profile resolver as generation. A non-OIDC account
+without a formable ARN is not probed. Persisted quota and exhaustion/overage evidence are
+bound independently by observation time, reset and the login identity, never by
+token or raw account label; removal, identity change, expiry or malformed disk degrades
+routing evidence to unknown. Initial routing reads it through `kiroAccountEvidence`.
```

## PLAN-FIELD-CHAIN-01

| Field / export | Creation and write | Read and consumer |
| --- | --- | --- |
| `ProviderAccount.loginId` | `saveCredentialWithReceipt` sets `randomUUID()` on every login write after choosing the account; new slot, existing identity match, and identity-less replacement all pass through it. | `normalizeAccount` preserves valid UUID shape; refresh writers leave it intact. `kiroEvidenceIdentity` uses it, falling back to `String(addedAt ?? "")` for legacy rows. The protected auth store persists it; public management DTOs do not expose it. |
| `kiroEvidenceIdentity(account: ProviderAccount): string` | `src/providers/kiro-account-state-disk.ts` hashes `[account.id, account.loginId ?? String(account.addedAt ?? ""), cred.accountId ?? cred.email ?? "", cred.kiro?.profileArn ?? "", cred.kiro?.clientId ?? ""]`. Capture before probe await; set `AccountQuotaCacheEntry.identity`, `rows[key].identity`, and `KiroPersistedVerdict.identity`. | Disk hydration, in-flight join/commit fences, display reads, and `kiroAccountEvidence(account)` compare to the current roster account. Different explicit logins into one identity-less slot differ; token refresh keeps the identity. `authType` is absent from stored credential and absent from this hash. |
| `KiroPersistedQuota.identity` | Shared writer adds identity to version-1 Kiro `rows[key]` only. | Disk reader validates 64-hex shape; hydration compares to live `ProviderAccount`. Identity-less Kiro rows are unknown; other providers keep their legacy shape. |
| `KiroPersistedVerdict.identity`, `.exhausted`, `.overageEnabled`, `.resetAt` | `commitKiroAccountUsageState` stores captured login identity and parsed verdict; writer emits `kiroVerdicts[key]`. | Disk reader validates shape/bools/reset. `kiroAccountEvidence` checks identity and time before routing. Layer 030's refusal verdict and 050's catalogue row/in-flight fetch use the same identity. Logs expose only closed-set codes/statuses. |
| `rows[key].updatedAt` and `KiroPersistedVerdict.observedAt` | Quota parser and verdict commit record independent times. No equality condition. | Each validates finite/nonfuture age and its own reset/TTL on every Kiro routing read. Either half can survive the other's expiry. |
| `builderIdFallback` / `kiroManagementHost(ctx)` | #5937's `kiroUsageContextForAccount` gets the flag from `resolveKiroRequestProfile`; 010 exports host helper over existing `usageRegion`. | Probe and layer 050 catalogue use account API/SSO region for Builder ID, never the fixed service ARN's region. Neither field is persisted. |

`AccountQuotaCacheEntry.unavailable` remains process-local; a failed probe preserves a same-login display bar and matching live verdict but cannot extend either routing TTL. No new enum is added.

## Conditional paths and assertions

| Activation | Observable test assertion |
| --- | --- |
| First request after restart, no quota API call | Seed version-1 Kiro evidence for a live roster account; reset process state; call `preferredInitialAccount` under an enabled pool. `kiroAccountEvidence(account)` hydrates once, ranks around saved exhausted active, and makes zero quota requests. |
| Hydrated 100% row crosses TTL without a new probe | At `updatedAt + ACCOUNT_QUOTA_TTL_MS - 1`, `isAccountQuotaExhausted` sees 100%; at the exact TTL it returns false/unknown and ranking stops demoting it. No `fetch`. Verdict `observedAt` and earlier reset have their own exact boundaries. |
| Two people use the same identity-less slot | Save H1 evidence, then `saveCredentialWithReceipt` for a different login into the same account ID; `loginId` changes H1→H2 even if other identity fields are empty. After restart `kiroAccountEvidence(account)` is `{}`. A subsequent token-only refresh leaves H2 stable. |
| Old in-flight probe finishes after login replacement | Hold H1 fetch, save H2 login in same slot, release; H1 cannot commit quota, verdict, or disk write. New-login joiner waits and starts H2 probe after H1 settles. |
| Quota and verdict observation clocks differ | Expired quota/fresh verdict gives `{exhausted, resetAt}`; expired verdict/fresh quota gives `{quotaPercent, resetAt}`. Identity matches in each case; timestamps need not match. |
| Overage at 100% then failed refresh | A successful `ENABLED` snapshot records 100% and `exhausted: false`; forced null-result and thrown-error refreshes mark usage unavailable without clearing or renewing the verdict. `isAccountQuotaExhausted` remains false and enabled-pool first admission keeps the active account before and after restart. A failed first probe after restart also retains the hydrated verdict. The original verdict expires at its own reset/TTL; another login cannot inherit it. |
| Builder ID and non-OIDC ARN paths | #5937's shared resolver gives Builder ID's fixed ARN in query/body while host uses API region; non-OIDC without ARN returns unknown without network, retaining only same-login last-good display bar. |
| Missing, malformed, removed evidence | Invalid identity, old version-1 Kiro row without identity, invalid verdict, future version, reset/TTL expiration, or removed account yields unknown; clear/reconcile removes persisted entries. |
| Explicit pool off, global or provider | `oauthAccountFailover.enabled === false` prevents first-admission movement and any 429/400/403 rotation, even with known refusal evidence. The active account is used unless its separately configured concurrency cap is full. |
| Pool unset or true, refusal-aware first admission | A known suspended/monthly-exhausted active account may be bypassed when another account is eligible; singleton/all-excluded sends active. Proactive least-loaded/preferred choice runs only under effective enablement. |
| Explicit cap full | With `maxConcurrentPerAccount` set, movement forbidden or singleton: wait bounded time, then retryable 503 `account_capacity` plus `Retry-After`. When movement is allowed, try another eligible account before waiting/failing. |
| Kiro adapter-dispatch and run-turn refusal arms | Every Kiro 429/400/403 arm uses `classifyKiroRefusal` and the one `rotateGenericOAuthAccountOnRefusal` loop. Hold original response until replacement admission; with none, forward original status/body. Kiro-only `genericFailovers` count changes. Non-Kiro adapter-dispatch and run-turn 429 tests retain exact old order/count. |
| 070 automatic-selection eligibility | `autoSelectable` plus `skipReason` replaces `routable`. A singleton-send test proves `autoSelectable: false` does not itself block active-account send. |

## Tests and registry edits

`src/providers/quota.ts` is at its file-size cap, so move Kiro-only guard logic into `vendor-probes-oauth.ts` if a net-zero edit is not possible. Keep new regression cases in the two sibling files; do not add to capped `kiro-adapter.test.ts`, `kiro-stream.test.ts`, or `provider-quota.test.ts`. These are future implementation targets, not files edited in this docs-only pass.

| Test file | Exact test names and assertions |
| --- | --- |
| MODIFY `tests/providers/kiro/kiro-account-quota.test.ts` | Existing `exhaustion state is recorded next to the quota row and cleared with it` and `an overage-enabled account past its limit is not marked exhausted` call `getKiroAccountExhaustion(key, storedAccount)` using the matching roster `ProviderAccount`. The #5937 `a non-Builder-ID account without a stored ARN still sends none` case changes to the no-network assertion shown above. |
| MODIFY `tests/providers/kiro/kiro-usage-quota.test.ts` | Give `baseContext` a real ARN as shown above. Existing direct `commitKiroAccountUsageState` tests must create a stored `acct-1` fixture and pass `kiroEvidenceIdentity(stored ProviderAccount fixture)` as the third argument; check the exact TTL and reset boundaries against `getKiroAccountExhaustion(key, storedAccount, now)`. Add `Builder ID management host ignores service ARN region`: API region `eu-west-1`, fixed service ARN `us-east-1`; `kiroManagementHost(ctx)` is `management.eu-west-1.kiro.dev`. |
| MODIFY `tests/providers/kiro/kiro-pool-rank.test.ts` | Pass fixture identity to direct `commitKiroAccountUsageState` calls, seed quota entries with the same identity, and pass a `Map<string, ProviderAccount>` as the fourth argument to Kiro `rankAccountsByHeadroom`/`exhaustedCooldownMs` tests. Assert `exhausted: false` overrides 100% while `exhausted: true` excludes a candidate. |
| `tests/providers/kiro/kiro-usage-restart.test.ts` | `probe and runtime use the same request-profile resolver`: Builder ID and enterprise cases produce the same ARN; only the former sets `builderIdFallback`. `non-OIDC missing ARN makes no usage request and keeps same-login last good bar`: prime, force refresh, assert zero new fetches, unavailable and same display percent. `unknown overage status cannot exhaust an account`: spent CREDIT with unknown status has `exhausted: false`. `unrecognised usage body stays unknown`: invalid breakdown returns null without a positive verdict. `Kiro management host follows account region`: API region wins over Builder ID service ARN. |
| `tests/providers/kiro/kiro-account-state-disk.test.ts` | `first routing request hydrates exhausted evidence without probing`: seed disk, simulate restart, call `preferredInitialAccount` (`src/oauth/generic-account-failover.ts:443`) and assert alternate selected, no quota fetch. `hydrated 100 percent row expires for routing at TTL without a probe`: synthetic `now` at boundary; `isAccountQuotaExhausted("kiro", account.id, undefined, account)` changes true→false and `rankAccountsByHeadroom("kiro", ids, undefined, rosterMap)` becomes unranked with no fetch. `failed refresh preserves overage verdict before and after restart`: prime an `ENABLED` 100% snapshot, force a null-result refresh and separately a thrown-error refresh, assert `unavailable`, unchanged quota `updatedAt` and verdict `observedAt`, `isAccountQuotaExhausted("kiro", account.id, undefined, account) === false`, and enabled-pool `preferredInitialAccount` keeps active; flush disk, simulate restart, make the same routing assertions with zero new quota requests. In a separate restart, make the first operation a failing forced probe before any routing read; assert the disk verdict is hydrated, preserved and still routes active. At the original verdict reset/TTL boundary it becomes unknown; replacing the login does not restore it. `two different logins into one identity-less slot invalidate evidence across restart`: `saveCredentialWithReceipt` retains account ID, assigns a new loginId and changes H1→H2 even with both credentials identity-less; both disk row/verdict are ignored. `token refresh retains evidence identity`: `saveAccountCredential` and `mergeAccountCredential` change access/refresh/expiry only; loginId and hash stay unchanged. `quota and verdict clocks expire independently`: skew two timestamps; assert surviving half through `kiroAccountEvidence(storedAccount)`. `in-flight old credential cannot commit after slot upgrade`: hold fetch, upgrade identity, release, assert no old disk/memory row and next probe uses new credential. `overage-enabled verdict survives restart without exclusion`: spent with ENABLED restores `exhausted: false`. `corrupt identity or verdict is unknown`: missing identity, invalid hash, bad bool, malformed JSON and future version do not exclude. `account removal deletes quota and verdict from disk`: clear/reconcile then restart. `another provider write preserves valid Kiro evidence`: both fields remain after shared write. |

Use isolated `OPENCODEX_HOME` and `bun:test` setup as in `tests/providers/kiro/kiro-account-quota.test.ts:16-65`. Wait for the 250 ms debounce before `clearAccountQuotaCache()` to simulate restart, and cancel pending writes in teardown. The first-request test must call the actual initial-resolution function, not `hydrateKiroAccountState()` directly; otherwise it cannot catch blocker r1-1. The TTL test must call `isAccountQuotaExhausted("kiro", account.id, undefined, account)` after hydration without another quota probe; otherwise it cannot catch r1-2. The identity test must exercise two explicit `saveCredentialWithReceipt` calls into the **same identity-less account ID**, confirm distinct `loginId` UUIDs, then restart; otherwise it cannot catch r1-3 or SD1'. Synthetic version-1 fixtures write `{version:1,rows:{[key]:{...quota,identity}},kiroVerdicts:{[key]:{...verdict,identity}}}`; intentionally different `updatedAt`/`observedAt` are valid.

MODIFY `tests/providers/provider-account-quota-persistence.test.ts:16,34-78`: its generic `KEY = "kiro\0acct-a"` currently writes identity-less rows through the one-argument disk writer. Change the generic fixture key to `"cursor\0acct-a"` so those tests continue to exercise the unchanged provider-agnostic version-1 path. Add `Kiro rows require a stable identity without exposing credential fields`: write a Kiro row with the 64-hex `kiroEvidenceIdentity(storedAccount)`, assert the disk contains that hash and quota percentages but no access/refresh/email/ARN/client secret, then write an identity-less Kiro row and assert `readPersistedAccountQuotas().has(kiroKey) === false`. This is an explicit expected test change, not a relaxation of privacy checks.

Exact registry additions, alphabetically placed after `kiro-account-quota` and after `kiro-usage-quota` respectively, in **both** files (`scripts/test-layout/layout.json:1067-1084`, `tests/fixtures/test-layout-expected.json:888-905`):

```diff
--- a/scripts/test-layout/layout.json
+++ b/scripts/test-layout/layout.json
@@
     "kiro-account-quota.test.ts": "providers/kiro",
+    "kiro-account-state-disk.test.ts": "providers/kiro",
@@
     "kiro-usage-quota.test.ts": "providers/kiro",
+    "kiro-usage-restart.test.ts": "providers/kiro",
--- a/tests/fixtures/test-layout-expected.json
+++ b/tests/fixtures/test-layout-expected.json
@@
   "kiro-account-quota.test.ts": "providers/kiro",
+  "kiro-account-state-disk.test.ts": "providers/kiro",
@@
   "kiro-usage-quota.test.ts": "providers/kiro",
+  "kiro-usage-restart.test.ts": "providers/kiro",
```

## PLAN-VERIFIER-REAL-01

Dependencies are installed. Commands below ran on the `bb3f3c2d0d` checkout while this docs-only plan was being amended; they verify the current baseline and layout, **not** the proposed source/test edits. No unimplemented behavior is claimed passing.

| Command run now | Exit / observed result | Scope |
| --- | --- | --- |
| `bun test tests/providers/kiro/kiro-usage-quota.test.ts tests/providers/kiro/kiro-account-quota.test.ts tests/providers/provider-account-quota-persistence.test.ts` | 0; 37 pass, 0 fail across 3 files. | Current Kiro probe and generic persistence baseline; new identity/hydration tests do not exist yet. |
| `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/lab/core-lab-boundary.test.ts` | 0; 43 pass, 0 fail across 3 files. | Current layout/Lab guards; registry changes are only proposed. |
| `bun run structure:check` | 0; `structure/ SSOT checks passed`. | Current structure docs; proposed ownership-doc changes are not yet applied. |
| `bun run privacy:scan` | 0; `Privacy scan passed` on this docs-only plan. | Repository content; rerun after implementation. |
| `bun test tests/server/account-pool-management-api.test.ts` | 1; 25 pass, 8 fail. All eight fail in fixture cleanup because this checkout is inside `/Users/jun/.codex`; `src/lib/test-home-guard.ts:237` refuses removal of `tests/server/.tmp-account-pool-mgmt-codex` inside the real Codex home. | Environment-only local failure; hosted CI outside this path must supply that suite's evidence. Do not describe it as passing locally. |

At implementation time run the modified Kiro quota/rank/persistence tests, the new restart/disk tests, loginId store regressions, 030 non-Kiro adapter-dispatch and run-turn order/count regressions, layout/Lab guards, `bun run structure:check`, `bun run privacy:scan`, `bun run typecheck`, and `bun run test:changed`. The full local suite is the default; if concurrent worktrees make it disproportionate, record the exact focused coverage and CI remainder in PR Verification. Confirm exact-head hosted CI, including `account-pool-management-api.test.ts`, before review readiness or merge. No hosted CI or future command is claimed run here.

## Risk, rollback, and exclusions

- **Risk:** #5937 is merged into `origin/dev` (`7ea48b9827`) but this checkout is older. Its non-Builder-ID ARN-less HTTP expectation is superseded by S1b; amend that landed test. Re-read the landed source before implementing or rebasing. The merged Builder ID resolver and host-region behavior must remain intact.
- **Risk:** the generic disk reader accepts legacy quota shapes; the Kiro-specific gate rejects old identity-less rows and implausible percentages/timestamps. A corrupt row or unrecognized upstream response must never create a hard exclusion. `loginId` is a protected-store login marker; normalization, all login branches, refresh preservation, and management DTO privacy need their named tests.
- **Rollback:** remove Kiro calls to `kiroAccountEvidence`/`persistKiroAccountState`, then retire the optional `kiroVerdicts` reader/writer. Version-1 non-Kiro rows remain valid. `ProviderAccount.loginId` is optional and safe for old stores; if reverting its writer, leave legacy `addedAt` fallback until persisted Kiro evidence is retired.
- **Out of scope:** 020 egress/retry; 030 refusal classes and success supersession; 040 account load; 050 model catalogue; 060 login; 070 credit metering; any live Kiro/AWS call or release.

## Round-1 audit fold

| Blocker / shared decision | Change in this document |
| --- | --- |
| r1-1 | `kiroAccountEvidence(account)` hydrates on first routing read (§ `src/providers/kiro-usage.ts`, lines 30-137); rank/preferred-initial call sites pass roster accounts (lines 373-429); first-request/no-quota-call regression (lines 524, 547). |
| r1-2 | Quota and verdict apply independent TTL/reset checks on **every** routing read (lines 112-137, 373-429); exact TTL transition without probe is asserted (lines 525, 547). |
| r1-3 / SD1′ | Every login write rotates `ProviderAccount.loginId`; legacy `addedAt` fallback and five-field `kiroEvidenceIdentity(account)` fence disk/cache/in-flight evidence (lines 270-333, 335-371); two-people/same-slot and refresh-stability tests (lines 526, 547). |
| SD2′ | Routing read takes `ProviderAccount`, without per-read store load; callers hand it their existing roster (lines 112-137, 373-429). |
| SD3′ | Adapter-dispatch **and** run-turn Kiro 429/400/403 use one refusal rotator, retain original response until replacement admission; non-Kiro order/count regressions are named (lines 431-437, 534). |
| SD4′ | Explicit off forbids movement/rotation; opted-in capacity cap waits then returns `503 account_capacity` with `Retry-After` when movement cannot occur (lines 429-437, 531-533). |
| SD5–SD7 | `autoSelectable`/`skipReason` and singleton-send behavior, `kiroManagementHost(ctx)`/Builder ID region, and closed-set diagnostics are recorded (lines 30-137, 431-437, 511-534). |
| SD8 | Local account-pool management test failure is identified as the `.codex` test-home guard; hosted CI is required for that suite (lines 574-586). |

## Round-2 audit fold

| Finding | Change in this document |
| --- | --- |
| r1-R2-1 High | Kiro state hydrates before a probe can persist over it, and failure no longer calls `commitKiroAccountUsageState(key, null)`; the proposed `quota.ts` hunk preserves only identity-matching, unexpired evidence without renewing either observation clock (lines 337-373, 522). The named `failed refresh preserves overage verdict before and after restart` test covers 100% overage success, null and thrown failures, routing on both sides of restart, a failed first probe after restart, original expiry, and login replacement (lines 533, 552). **rebase-verify at this layer's P** against #5937 and the implemented 010 cache/verdict store. |

## wp2 P re-verification (2026-09-26, tree `ff06b29c50` on dev `c323ad2564`)

This section is the executable plan for the 010 build and **overrides** any earlier hunk it
contradicts. Architect proposal: `.tmp/kiro-lb-research/wp2-arch-proposal.md` (scratch).

| ID | Disposition |
|---|---|
| D010-S1 | Accept. The checkout already contains #5937; read current files directly. |
| D010-S2–S4, S9, S10 | Accept. Current anchors: `parseKiroUsage` `src/providers/kiro-usage.ts:116-162` (overage check 153-155, `exhausted:` 159); probe 172-205; commit 235; `getKiroAccountExhaustion` 253-266; clear/reconcile 268-287; `usageRegion` 87-95; `KiroUsageStateEntry` 64-68; `preferredInitialAccount` accounts 453-457; capped Kiro tests at `file-size-baseline.json:46-48`. |
| D010-S5 | Accept, **fixed decision**: `src/providers/quota.ts` stays at ≤558 lines. The hydrate call folds into the existing line 426 condition (`provider === "anthropic" \|\| provider === "kiro"`). The identity capture, `kiroCurrent` guard, cached-row filter and joinable re-probe live in NEW `src/providers/quota/kiro-account-probe.ts`; `quota.ts` calls it through at most a net-zero change. C runs `wc -l src/providers/quota.ts` and the ratchet test. |
| D010-S6/S7 | Accept: structure note after `structure/providers-and-adapters.md:59`; docs note after `docs-site/src/content/docs/reference/adapters.md:352`. |
| D010-S8 | Accept: `fetchKiroQuota` (`src/providers/quota/vendor-probes-oauth.ts:365-382`) calls `hydrateKiroAccountState()` before its cache `set` at 378, so a post-restart persist cannot erase other providers' rows. |
| D010-M1 | Accept: the in-memory `KiroUsageStateEntry` timestamp is renamed `ts` → `observedAt`, matching `KiroPersistedVerdict` and 030. |
| D010-M2 | Accept: `replaceProviderAccountSet` (`src/oauth/store.ts:~1184`) copies `loginId`. `upsertCredentialByIdentity` (Antigravity importer only) is out of scope and recorded. |
| D010-M3 | Accept: `kiroEvidenceIdentity` and the persisted types have no runtime imports; a test imports each of `kiro-usage.ts`, `kiro-account-state-disk.ts`, `quota/account-cache.ts` in isolation. |
| D010-M4 | Accept: first Kiro routing read hydrates the whole disk cache; a test asserts a non-Kiro row keeps its TTL behaviour. |
| D010-M5 | Accept: a Kiro fill-first threshold test through `preferredInitialAccount` proves callers pass the `accounts` map. |
| D010-U1 | Accept: `kiroManagementHost` moves to 050. |
| D010-U2 | Accept: the cross-layer handoff section and the 030/040/070 conditional-path rows are pointers only; 010's C runs no test that belongs to a later layer. |
| D010-U3 | Accept, **decision**: `overageEnabled` is dropped from `KiroPersistedVerdict`; the persisted `exhausted` verdict already encodes overage. A later layer that needs it adds it with its own consumer. |

Verifier set for 010's C (each read by the command named):
`bun run typecheck`; `bun test tests/providers/kiro/` (the new `kiro-account-state-disk` and
`kiro-usage-restart` files live there); `bun test tests/oauth/` subset touching `store` and
`generic-account-failover`; `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts`;
`bun test tests/lab/core-lab-boundary.test.ts`; the file-size ratchet test; `bun run test:changed`;
`bun run privacy:scan`; `bun run structure:check`.


### Reflection fold (same architect: MISALIGNED → folded)

1. S8 path corrected to `src/providers/quota/vendor-probes-oauth.ts`.
2. M1/U3 are 010 contract changes; every earlier hunk in this doc that names the in-memory
   `ts` field or `overageEnabled` is superseded by this section at build time. 030 (lines 4,
   257, 271-272) and 040 (line 510) still name `ts`/`overageEnabled` and are corrected at
   their own P re-verification against the landed 010 (recorded in 000's residual table).
3. U1: the tests `Builder ID management host ignores service ARN region` and `Kiro management
   host follows account region` move to 050 with `kiroManagementHost`; 020 line 9, 030 line
   583 and 050's references to a 010 export are corrected at their P.
4. M3 test: `tests/providers/kiro/kiro-account-state-imports.test.ts`, test `each Kiro evidence
   module imports on its own` (spawns `bun -e 'await import(<module>)'` per module and asserts
   exit 0), registered in both layout registries next to `kiro-account-state-disk`.
5. Verifier set adds `tests/providers/provider-account-quota-persistence.test.ts`,
   `tests/ci-workflows/file-size-ratchet.test.ts`, `tests/oauth/oauth-store-multi.test.ts`,
   `tests/oauth/generic-oauth-failover.test.ts` by name.

### wp2 A round 1 fold (reviewer 01a0de34: FAIL, 2 High + 1 Medium → folded)

1. **High — percentage-only exhaustion.** For Kiro, `isAccountQuotaExhausted` and every
   exclusion decision return *unknown* (never exhausted) when `kiroAccountEvidence(account).exhausted`
   is absent; the quota percentage is used only for ranking. Test
   `fresh 100% quota without a verdict ranks last but is not excluded` in
   `tests/providers/kiro/kiro-usage-restart.test.ts`, driven through `preferredInitialAccount`
   with the quota row and verdict on independent clocks (verdict expired, row fresh).
2. **High — reconciliation persisting before hydration.** Every whole-cache persist path this layer
   adds or reaches (`reconcile...` at `src/providers/quota/account-cache.ts:336`, the Kiro
   clear/reconcile path, `fetchKiroQuota`, `fetchAccountQuota`) calls `hydrateAccountQuotaCache()`
   before mutating, the same rule the observation writers follow at `account-cache.ts:240,287`.
   Test `first post-restart reconciliation keeps unrelated disk rows` in
   `tests/providers/kiro/kiro-account-state-disk.test.ts`.
3. **Medium — future-timestamp rule scope.** The `updatedAt <= now` rejection in the disk reader
   applies only to Kiro rows (cache key prefix `kiro\0`, `src/providers/quota/account-cache.ts:163`); other providers keep the current reader
   behaviour (`src/providers/account-quota-disk.ts:47`). Test
   `a future-dated non-Kiro row still loads` in the same file.


## wp2 build notes

- The no-ARN last-good test seeds a same-login quota bar before the forced probe. Removing a stored ARN from a previously successful credential would change the specified five-field evidence identity, so it cannot exercise same-login preservation.
- Kiro quota hydration and rewrites retain only parser-owned percentage, reset, and fixed free-trial fields. This prevents malformed disk extras, including upstream message text, from being copied into a later whole-cache persist.
- The OAuth store test fixture uses an OS temporary directory and resets its test-only reconciliation generation after each case. The former repository-local fixture path is inside the protected Codex home in this checkout, and the latter otherwise contaminated the requested grouped OAuth test run.
