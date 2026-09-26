# 040 — Kiro account load cap and least-loaded selection

- **Branch:** `codex/kiro-lb2-040-account-load`, PR base: 030's head; retarget to `dev` after 030 lands.
- **Depends on:** 010's persisted Kiro exhaustion verdict and 030's refusal-aware `eligibleFailoverAccounts` / `rotateGenericOAuthAccountOnRefusal` contract. Re-read those signatures when applying this layer. The source anchors and hunks below are from opencodex `bb3f3c2d0d`, before 010–030; this document does not assert they are already implemented.
- **Inventory:** P3 (optional per-account concurrency cap, bounded wait, another eligible account), P1/P2 (opt-in deterministic least-loaded). Reference facts: `/tmp/kiro-lb/kiro/concurrency.py:2-14,95-110` caps a request with a wait; `/tmp/kiro-lb/kiro/account_manager.py:1162-1208` uses quota-weighted selection. This is an independent design, not copied code.
- **Architect decisions:** D040-1 process-local lease ledger, bounded wait and fallthrough; D040-2 eligibility then in-flight ordering with a stable tie. Preserve D030-2's before-output and send-budget gates.
- **Behavior contract:** Only provider `kiro` with OAuth and an explicit `maxConcurrentPerAccount` or `strategy: "least-loaded"` uses the ledger. No process-wide cap; no persistent in-flight state. `least-loaded` is accepted only for Kiro; its ranking and preferred initial choice require `pool.kernel: true` and effective proactive enablement, with **either** global or per-provider `oauthAccountFailover.enabled === false` authoritative for Kiro. A valid cap applies independently even when proactive movement or the kernel is off. When movement is allowed, a full account falls through to another eligible account first. When it is forbidden by explicit off or a singleton, a full cap waits at most 250 ms and then returns retryable 503 `account_capacity` with `Retry-After`; it never bypasses the cap. A current suspension/monthly-exhaustion verdict excludes an active account only when movement is allowed and another eligible account exists. Unknown quota is eligible; capacity never creates a health verdict.
- **010 evidence dependency:** `kiroEvidenceIdentity(account: ProviderAccount)` in `src/providers/kiro-account-state-disk.ts` is the SHA-256 hex digest of `JSON.stringify([account.id, account.loginId ?? String(account.addedAt ?? ""), cred.accountId ?? cred.email ?? "", cred.kiro?.profileArn ?? "", cred.kiro?.clientId ?? ""])`, with `cred = account.credential`. `authType` is not stored and is not hashed. `src/oauth/types.ts` adds optional `loginId?: string`; `saveCredentialWithReceipt` (`src/oauth/store.ts:834`) writes a new random UUID on **every login write**, whether append, identity-match replacement, or legacy identity-less upgrade. `normalizeAuthStore` validates and preserves its UUID shape; refresh writers `saveAccountCredential` and `mergeAccountCredential` replace only `.credential`. Legacy rows without `loginId` use `addedAt`. Thus two people replacing one identity-less slot get distinct evidence identities while a token refresh preserves identity. Every quota row and `KiroPersistedVerdict` carries `identity`, with independent quota timestamp and verdict `observedAt`; mismatched evidence is unknown. `kiroAccountEvidence(account: ProviderAccount, now?)` hydrates once per process and applies identity plus TTL/reset on each read without loading `auth.json` per account. This layer passes the caller's roster account to it for first choice and capacity fallback. 070's `autoSelectable`/`skipReason` is automatic-selection eligibility.
- **030 initial-admission dependency:** Even when neither 040 option is configured, 030 makes first Kiro admission refusal-aware only if the setting is unset (presence-is-consent) or true, with no explicit global or provider `enabled: false`. The same gate controls 040's `admitInitialKiroWithLease`. A known suspended/monthly-exhausted active identity is excluded only when an eligible sibling can be chosen; otherwise the usable active account remains the first candidate, subject to the cap. Explicit off keeps the active first and disables rotation. `kiroLoadEnabled === false` must not disable 030's independent exclusion when its gate is open.

## Current-state reading (all anchors at `bb3f3c2d0d`)

| Function / source | Fact that constrains the edit |
| --- | --- |
| `eligibleIdsIn`, `eligibleFailoverAccounts`, `hasEligibleGenericOAuthFailoverTarget`, `src/oauth/generic-account-failover.ts:187-221` | Live roster filters reauth and cooldown; 030 must add its Kiro verdict exclusions here, so 040 consumes this result rather than reconstructing eligibility. |
| `activeGenericStrategy`, `src/oauth/generic-account-failover.ts:224-242` | Only `round-robin` and `fill-first` activate behind `pool.kernel`; `quota` is the null/default path. |
| `rotateGenericOAuthAccountOn429`, `src/oauth/generic-account-failover.ts:346-415` | It cools the failed account, then walks an eligible ring and quota rank. On 030 this becomes the refusal-aware seam; 040 must not bypass its cooldown or retry budget. |
| `preferredInitialAccount`, `src/oauth/generic-account-failover.ts:443-514` | Proactive steering is opt-in, preserves an active healthy account in quota mode, and returns a disposable preference; Kiro least-loaded belongs before that quota-mode early return. |
| `isAccountQuotaExhausted`, `rankAccountsByHeadroom`, `src/oauth/account-quota-rank.ts:120-172` | 010's `kiroAccountEvidence(account)` is the sole Kiro routing read: hydrate once per process, check roster account identity, and expire both quota percent and verdict by TTL/reset on each read, without a store load per candidate. The routing uses of `getCachedProviderAccountQuota`, `isAccountQuotaExhausted`, and `getKiroAccountExhaustion` switch to that seam; 040 passes roster accounts directly for initial ordering. Unknown evidence does not exclude an account. |
| `parseGenericPoolStrategy`, `genericPoolSettingsDto`, `unifiedPoolSettingsDto`, `src/oauth/pool-settings-capability.ts:21-36,107-122,138-184` | The parser currently delegates to the common three-value kernel; both public DTOs project the stored strategy. The fourth value must be Kiro-specific to avoid widening Codex/Anthropic. |
| `parseAccountPoolStrategy`, `src/oauth/pool-kernel.ts:25-46` | The shared three-value parser feeds other pools. Leave it unchanged. |
| `OcxProviderConfig.oauthAccountFailover`, `src/types/provider.ts:653-681`; `OcxAccountPoolRotationStrategy`, `src/types/config.ts:1193` | The provider override currently stores `enabled`, three strategies, threshold and sticky limit. Widen only the provider field; leave the shared union alone. `src/config.ts` has no `oauthAccountFailover` parser (`rg` at this head); its 383 lines are below the 460-line cap, but this layer needs no edit there. |
| `/api/pool/settings`, `/api/oauth/accounts/pool`, `src/server/management/oauth-account-routes.ts:440-519,550-607` | Both endpoints validate and save generic strategy. The unified endpoint is the canonical shared read/write contract; the older generic route must reject invalid values identically and preserve settings. |
| `poolSetting`, `src/cli/account-extended.ts:917-1003`; account usage, `src/cli/account.ts:45-56` | CLI sends strategy values to the server without local revalidation; its human summary currently treats every non-round-robin/non-fill-first strategy as quota-like. Update the Kiro display and usage. |
| `prepareResponsesTransport`, `commitResolvedOAuthSelection`, `applyFailoverSnapshot`, `runSelectedTurn`, `oauthDispatch`, `src/server/responses/request-transport.ts:75-173,214-254,371-451` | Selection may be recommitted after an await, a Kiro failover must swap the full bearer/profile/region snapshot, and all physical dispatches cross the selected adapter. A lease must follow the *admitted* account, not a proposed id. |
| initial resolution, `src/server/responses/request-transport.ts:494-585`; returned transport state, `:730-844` | Initial preference resolves before guarded commit; a rejected preference falls back to active. The result supplies failover helpers to runTurn, adapter and passthrough lanes. |
| `HandleResponsesOptions`, `src/server/responses/core-options.ts:54-95`; `handleResponses`, `src/server/responses/core.ts:37-65`; `handleResponsesInner`, `:87-177` | The outer entry owns the complete response; the inner `finally` runs before a returned stream drains. Attach lease release to the outer response body and release on a thrown/early path. |
| `finalizeOwnedTranslatorBudget`, `src/server/responses/core-lifetime.ts:38-80` | Existing wrapper finalizes on EOF, read failure and cancel, preserving SSE response markers. Reuse that lifecycle shape for the account lease, including combo children that do not own the translator budget. |
| refusal call sites, `src/server/responses/adapter-dispatch.ts:862-916`, `src/server/responses/adapter-continuation.ts:427-451`; other arms `src/server/responses/run-turn-execution.ts:349-400`, `src/server/responses/passthrough-dispatch.ts:1315-1365`, `src/server/responses/sidecar-execution.ts:190-218` | 030 classifies every Kiro 429/400/403 arm through `classifyKiroRefusal` and rotates through `rotateGenericOAuthAccountOnRefusal`, including run-turn's `rotateGenericOAuthAccountOn429` call at `:371` when `_kiroAuthContext` is present at `:61`. 040 plugs lease admission into those Kiro arms and preserves their existing send budgets; non-Kiro order and `genericFailovers` accounting remain exact. |

## File change map / patch recipe

Apply these hunks after rebasing onto 030. Hunk context is from `bb3f3c2d0d`; 030 owns `rotateGenericOAuthAccountOnRefusal` and its one bounded response loop. 040 adds only request-local capacity exclusion to that selector and lease admission to `applyFailoverSnapshot`; it does not start a second refusal loop. `AccountLease` is a new type below. The lease object is request-owned and idempotent, so multiple end paths cannot decrement twice.

### NEW `src/oauth/kiro-account-load.ts` — full file

```ts
/** Process-local Kiro serving load. No credentials or account labels are stored here. */
export interface AccountLease { readonly provider: string; readonly accountId: string; release(): void }
export interface AccountLeaseOptions { maxConcurrentPerAccount?: number; waitMs?: number; signal?: AbortSignal }
const inFlight = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const keyOf = (provider: string, accountId: string) => `${provider}\u0000${accountId}`;
export function accountInFlight(provider: string, accountId: string): number {
  return inFlight.get(keyOf(provider, accountId)) ?? 0;
}
/** Null means capacity deadline or caller abort; neither creates a reservation. */
export async function acquireAccountLease(
  provider: string, accountId: string, opts: AccountLeaseOptions = {},
): Promise<AccountLease | null> {
  const key = keyOf(provider, accountId);
  const max = opts.maxConcurrentPerAccount;
  const deadline = Date.now() + Math.max(0, opts.waitMs ?? 0);
  while (!opts.signal?.aborted) {
    const count = accountInFlight(provider, accountId);
    if (max === undefined || count < max) {
      inFlight.set(key, count + 1); // synchronous compare-and-increment: no await between them
      let held = true;
      return { provider, accountId, release() {
        if (!held) return;
        held = false;
        const next = (inFlight.get(key) ?? 1) - 1;
        if (next <= 0) inFlight.delete(key); else inFlight.set(key, next);
        for (const wake of listeners.get(key) ?? []) wake();
      } };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", finish);
        listeners.get(key)?.delete(finish);
        if (listeners.get(key)?.size === 0) listeners.delete(key);
        resolve();
      };
      const waiting = listeners.get(key) ?? new Set<() => void>();
      waiting.add(finish);
      listeners.set(key, waiting);
      const timer = setTimeout(finish, remaining);
      opts.signal?.addEventListener("abort", finish, { once: true });
      if (opts.signal?.aborted) finish();
    });
  }
  return null;
}
```

No persistence: a restart clears `inFlight` and `listeners` by process exit. Validate cap to a positive integer before passing it; `undefined` is the unbounded counting mode used by least-loaded.

### MODIFY `src/types/provider.ts`

```diff
@@ oauthAccountFailover (lines 662-681) @@
   oauthAccountFailover?: {
     enabled?: boolean;
+    /** Kiro OAuth only; optional serving-request cap, 1..100. */
+    maxConcurrentPerAccount?: number;
@@
-    strategy?: "quota" | "round-robin" | "fill-first";
+    strategy?: "quota" | "round-robin" | "fill-first" | "least-loaded";
```

The TypeScript union permits the value on a generic provider object; the public write parsers below enforce Kiro-only use. Runtime reads also test `providerName === "kiro"`, so a hand-edited non-Kiro config remains inert.

### MODIFY `src/oauth/pool-settings-capability.ts`

```diff
@@ lines 21-36 @@
-export const GENERIC_POOL_STRATEGIES = ["quota", "round-robin", "fill-first"] as const;
+export const GENERIC_POOL_STRATEGIES = ["quota", "round-robin", "fill-first", "least-loaded"] as const;
 export type GenericPoolStrategy = typeof GENERIC_POOL_STRATEGIES[number];
@@
-export function parseGenericPoolStrategy(value: unknown): GenericPoolStrategy | null {
-  return parseAccountPoolStrategy(value) as GenericPoolStrategy | null;
+export function parseGenericPoolStrategy(value: unknown, providerName?: string): GenericPoolStrategy | null {
+  if (value === "least-loaded") return providerName === "kiro" ? value : null;
+  return parseAccountPoolStrategy(value);
 }
+export function parseKiroAccountCap(value: unknown): number | null {
+  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
+}
@@ genericPoolSettingsDto, lines 107-122 @@
-    strategy: parseGenericPoolStrategy(failover.strategy),
+    strategy: parseGenericPoolStrategy(failover.strategy, name),
+    maxConcurrentPerAccount: name === "kiro" ? parseKiroAccountCap(failover.maxConcurrentPerAccount) : null,
@@ unifiedPoolSettingsDto generic branch, lines 169-183 @@
-    strategy: parseGenericPoolStrategy(failover.strategy),
+    strategy: parseGenericPoolStrategy(failover.strategy, provider),
+    maxConcurrentPerAccount: provider === "kiro" ? parseKiroAccountCap(failover.maxConcurrentPerAccount) : null,
```

Add `maxConcurrentPerAccount: number | null` to both DTO interfaces; add it to `POOL_SETTINGS_FIELDS` and only the Kiro `supported` projection (make `supported` provider-aware in `unifiedPoolSettingsDto`; Codex/Anthropic and other generic providers report `null`, unsupported). Their existing object literals must all supply `maxConcurrentPerAccount: null`. This is a field-complete DTO change, not an implicit omission. Update the stale three-strategy comment at lines 31-35. Do not edit `src/oauth/pool-kernel.ts` or `src/types/config.ts`.

### MODIFY `src/server/management/oauth-account-routes.ts`

```diff
@@ canonical /api/pool/settings, lines 440-449 @@
     const {
-      poolSettingsCapability, parseGenericPoolStrategy, parseGenericAutoSwitchThreshold, parseGenericStickyLimit,
+      poolSettingsCapability, parseGenericPoolStrategy, parseGenericAutoSwitchThreshold, parseGenericStickyLimit, parseKiroAccountCap,
@@
-    const fields = rawBody as { provider?: unknown; enabled?: unknown; strategy?: unknown; stickyLimit?: unknown; autoSwitchThreshold?: unknown; quotaWindow?: unknown };
+    const fields = rawBody as { provider?: unknown; enabled?: unknown; strategy?: unknown; stickyLimit?: unknown; autoSwitchThreshold?: unknown; quotaWindow?: unknown; maxConcurrentPerAccount?: unknown };
@@ lines 459-465 @@
-      const parsed = kind === "codex" ? parseCodexAccountPoolStrategy(fields.strategy) : parseGenericPoolStrategy(fields.strategy);
+      const parsed = kind === "codex" ? parseCodexAccountPoolStrategy(fields.strategy) : parseGenericPoolStrategy(fields.strategy, provider);
@@ after autoSwitchThreshold validation (line 477) @@
+    let maxConcurrentPerAccount: number | null | undefined;
+    if (fields.maxConcurrentPerAccount !== undefined) {
+      if (provider !== "kiro" || kind !== "generic") return jsonResponse({ error: "maxConcurrentPerAccount is only supported for Kiro OAuth" }, 400);
+      maxConcurrentPerAccount = fields.maxConcurrentPerAccount === null ? null : parseKiroAccountCap(fields.maxConcurrentPerAccount);
+      if (maxConcurrentPerAccount === null && fields.maxConcurrentPerAccount !== null) return jsonResponse({ error: "maxConcurrentPerAccount must be an integer 1-100 or null" }, 400);
+    }
@@ generic writer, lines 506-514 @@
         if (strategy !== undefined) next.strategy = strategy as never;
+        if (maxConcurrentPerAccount === null) delete next.maxConcurrentPerAccount;
+        else if (maxConcurrentPerAccount !== undefined) next.maxConcurrentPerAccount = maxConcurrentPerAccount;
@@ legacy /api/oauth/accounts/pool, lines 554-607 @@
       strategy?: unknown;
+      maxConcurrentPerAccount?: unknown;
@@
-          const parsed = parseGenericPoolStrategy(body.strategy);
+          const parsed = parseGenericPoolStrategy(body.strategy, provider);
@@ before saveConfigPreservingClaudeCode(config) @@
+      if (body.maxConcurrentPerAccount !== undefined) {
+        if (provider !== "kiro") return jsonResponse({ error: "maxConcurrentPerAccount is only supported for Kiro OAuth" }, 400);
+        const cap = body.maxConcurrentPerAccount === null ? null : parseKiroAccountCap(body.maxConcurrentPerAccount);
+        if (cap === null && body.maxConcurrentPerAccount !== null) return jsonResponse({ error: "maxConcurrentPerAccount must be an integer 1-100 or null" }, 400);
+        if (cap === null) delete next.maxConcurrentPerAccount;
+        else next.maxConcurrentPerAccount = cap;
+      }
```

Update both strategy error strings to include `least-loaded` only for Kiro; keep the old literal for every other pool. Validate the whole request before mutating `config` or persisting it. The two routes must return the same applied cap/strategy and reject malformed or non-Kiro values without a write.

### MODIFY `src/oauth/generic-account-failover.ts`

```diff
@@ imports, lines 17-39 @@
+import { accountInFlight } from "./kiro-account-load";
@@ isProactivePreferenceEnabled, lines 174-184 @@
-function isProactivePreferenceEnabled(config: OcxConfig, providerName: string, now: number): boolean {
+export function isProactivePreferenceEnabled(config: OcxConfig, providerName: string, now: number): boolean {
@@ inside isProactivePreferenceEnabled, before provider override precedence @@
+  if (providerName === "kiro") {
+    if (config.oauthAccountFailover?.enabled === false
+      || config.providers?.kiro?.oauthAccountFailover?.enabled === false) return false;
+    return hasFailoverAccountQuorum(providerName, now); // unset is presence-is-consent
+  }
@@ lines 224-242 @@
-type ActiveGenericStrategy = "round-robin" | "fill-first";
+type ActiveGenericStrategy = "round-robin" | "fill-first" | "least-loaded";
@@
-  return raw === "round-robin" || raw === "fill-first" ? raw : null;
+  if (providerName === "kiro" && raw === "least-loaded") return raw;
+  return raw === "round-robin" || raw === "fill-first" ? raw : null;
@@ preferredInitialAccount, after strategy line 465 @@
+  if (strategy === "least-loaded") {
+    const family = classifyModelFamilyForQuota(providerName, requestedModelId);
+    const eligible = eligibleFailoverAccounts(providerName, now, family)
+      .filter(id => {
+        const account = selected.accounts.find(row => row.id === id);
+        return account && kiroAccountEvidence(account, now).exhausted !== true;
+      });
+    // Store order is the tie-break, not a random draw or a hash of private identity.
+    const picked = order.filter(id => eligible.includes(id))
+      .sort((a, b) => accountInFlight(providerName, a) - accountInFlight(providerName, b))[0];
+    return picked && picked !== active ? picked : null;
+  }
```

For 030's refusal rotation, append `excludedAccountIds?: ReadonlySet<string>` after `monthlyCooldownMs` in `rotateGenericOAuthAccountOnRefusal` and filter its `candidates` before any strategy branch. Preserve the current behavior when omitted. With `least-loaded`, sort the filtered candidates by `accountInFlight` and stable roster order after 030 eligibility/quota filters, but **only** if the Kiro explicit-off guard above is open and `isProactivePreferenceEnabled(config, providerName, now)` is true; otherwise keep 030's ring/quota order. The same Kiro explicit-off guard blocks reactive rotation at the call sites. Capacity exclusion never cools an account: cooldown belongs only to a real upstream refusal. The 030 rotator must apply the refusal cooldown/verdict once for the original failed account, then subsequent candidate selections pass the same original failed id, refusal class, and `excludedAccountIds` without re-recording it; factor candidate selection after the one-time refusal mutation if needed. Non-Kiro provider override precedence remains as it was.

### MODIFY `src/server/responses/core-options.ts`

```diff
@@ imports / HandleResponsesOptions, lines 1-18,54-62 @@
+import type { AccountLease } from "../../oauth/kiro-account-load";
 export interface HandleResponsesOptions {
+  /** Private owner of the serving-account lease; handleResponses replaces it for every ingress. */
+  accountLoad?: { lease: AccountLease | null };
```

### MODIFY `src/server/responses/core-lifetime.ts`

```diff
@@ after finalizeOwnedTranslatorBudget, line 80 @@
+/** End the account lease with the returned body, including stream error and client cancel. */
+export function finalizeAccountLease(response: Response, release: () => void): Response {
+  if (!response.body) { release(); return response; }
+  const reader = response.body.getReader();
+  let done = false;
+  const finish = () => { if (!done) { done = true; release(); } };
+  const body = new ReadableStream<Uint8Array>({
+    async pull(controller) {
+      try {
+        const next = await reader.read();
+        if (next.done) { finish(); controller.close(); }
+        else controller.enqueue(next.value);
+      } catch (error) { finish(); controller.error(error); }
+    },
+    async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } },
+  });
+  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
+  if (isNativePassthroughSseResponse(response)) markNativePassthroughSseResponse(wrapped);
+  if (isEagerRelaySseResponse(response)) markEagerRelaySseResponse(wrapped);
+  return wrapped;
+}
```

Do not wrap a response when `lease === null`; this keeps the off path byte-for-byte and avoids changing other providers' stream behavior.

### MODIFY `src/server/responses/core.ts`

```diff
@@ lines 13,43-65 @@
-import { finalizeOwnedTranslatorBudget } from "./core-lifetime";
+import { finalizeAccountLease, finalizeOwnedTranslatorBudget } from "./core-lifetime";
@@
   const translatorBudget = options.translatorBudget ?? createTranslatorBudget();
+  const accountLoad = { lease: null as import("../../oauth/kiro-account-load").AccountLease | null };
@@
       ...options,
+      accountLoad,
@@
-    return ownsBudget ? finalizeOwnedTranslatorBudget(response, translatorBudget) : response;
+    const owned = accountLoad.lease ? finalizeAccountLease(response, () => accountLoad.lease?.release()) : response;
+    return ownsBudget ? finalizeOwnedTranslatorBudget(owned, translatorBudget) : owned;
   } catch (error) {
+    accountLoad.lease?.release();
```

After a successful failover, release the previous lease and set `accountLoad.lease` to the new lease; the closure must reference this mutable holder so it releases the final serving account. Before replacing it, release the old lease exactly once. A 030 before-output refusal may release it earlier; the body wrapper's release is idempotent. Verify the file-size ratchet: `core.ts` is 198/210 at this head, and the proposed seven added lines stay below 210; split into `core-lifetime.ts` if intervening layers consume that headroom.

### MODIFY `src/server/responses/request-transport.ts`

```diff
@@ imports, lines 30-39 @@
+import { acquireAccountLease, accountInFlight, type AccountLease } from "../../oauth/kiro-account-load";
+import { isProactivePreferenceEnabled, eligibleFailoverAccounts, hasFailoverAccountQuorum } from "../../oauth/generic-account-failover";
+import { getAccountSet } from "../../oauth/store";
+import { kiroAccountEvidence } from "../../providers/kiro-usage";
+import { classifyModelFamilyForQuota } from "../../oauth/account-quota-rank";
+import { clientCancelledResponse } from "./core-errors";
@@ prepareResponsesTransport, after line 108 @@
+  const rawCap = config.providers.kiro?.oauthAccountFailover?.maxConcurrentPerAccount;
+  const kiroCap = typeof rawCap === "number" && Number.isInteger(rawCap) && rawCap >= 1 && rawCap <= 100 ? rawCap : undefined;
+  const kiroLeastLoaded = config.pool?.kernel === true
+    && isProactivePreferenceEnabled(config, "kiro", Date.now())
+    && config.providers.kiro?.oauthAccountFailover?.strategy === "least-loaded";
+  const kiroExplicitOff = config.oauthAccountFailover?.enabled === false
+    || config.providers.kiro?.oauthAccountFailover?.enabled === false;
+  const kiroMayMove = !kiroExplicitOff && hasFailoverAccountQuorum("kiro", Date.now());
+  const kiroLoadEnabled = route.providerName === "kiro" && route.provider.authMode === "oauth"
+    && options.accountLoad !== undefined
+    && (kiroLeastLoaded || kiroCap !== undefined);
+  const leaseOwner = options.accountLoad;
+  // Local 040 identity hook; 050 replaces its body with positive model-membership
+  // filtering. Input is the final eligible initial-admission set, before load sorting.
+  const filterInitialKiroRankCandidates = (ids: string[], _modelId: string): string[] => ids;
+  const kiroAccountCapacityResponse = (): Response => new Response(JSON.stringify({
+    error: { message: "All eligible Kiro accounts are busy", type: "server_error", code: "account_capacity" },
+  }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "1" } });
@@ initial selection, lines 563-566 @@
-        const admitted = await commitResolvedOAuthSelection(resolved, true);
+        let admitted: OAuthAccessSnapshot | null;
+        if (kiroLoadEnabled) {
+          const load = await admitInitialKiroWithLease(resolved);
+          if (load.kind === "capacity") return kiroAccountCapacityResponse();
+          if (load.kind === "cancelled") return clientCancelledResponse();
+          admitted = load.kind === "admitted" ? load.snapshot : null;
+        } else admitted = await commitResolvedOAuthSelection(resolved, true);
@@ applyFailoverSnapshot, lines 218-221 @@
   const applyFailoverSnapshot = async (
     snapshot: OAuthAccessSnapshot,
     retryParsed: OcxParsedRequest = parsed,
+    capacityExclusions?: Set<string>,
   ): Promise<OAuthAccessSnapshot | null> => {
-    const committed = await commitResolvedOAuthSelection(snapshot);
+    const load = kiroLoadEnabled ? await commitKiroWithLease(snapshot, false) : null;
+    if (load?.kind === "capacity") capacityExclusions?.add(snapshot.accountId);
+    const committed = kiroLoadEnabled
+      ? load?.kind === "admitted" ? load.snapshot : null
+      : await commitResolvedOAuthSelection(snapshot);
```

Append `capacityExclusions?: Set<string>` as the third, optional `applyFailoverSnapshot` parameter; all existing callers retain their old behavior. Every Kiro refusal arm, including run-turn, passes a set when it can try another candidate. The helper adds to it **only** on a full lease, so stale credentials, abort, and ordinary rejection cannot masquerade as capacity. Add the following local helpers after `commitResolvedOAuthSelection` (before `applyFailoverSnapshot`). `commitKiroWithLease` attempts exactly one named candidate: it must never choose a sibling on a refusal. `admitInitialKiroWithLease` is the initial, pre-send admission sweep; it does not own or repeat an upstream refusal.

```ts
type KiroLoadResult =
  | { kind: "admitted"; snapshot: OAuthAccessSnapshot }
  | { kind: "capacity" | "cancelled" | "stale" };
const KIRO_ACCOUNT_WAIT_MS = 250;
const commitKiroWithLease = async (
  candidate: OAuthAccessSnapshot, proactive: boolean, waitMs = 0,
): Promise<KiroLoadResult> => {
  if (options.abortSignal?.aborted) return { kind: "cancelled" };
  const id = candidate.accountId;
  // Same-account continuation keeps its one serving lease.
  if (leaseOwner?.lease?.accountId === id) {
    const admitted = await commitResolvedOAuthSelection(candidate, proactive);
    return admitted?.accountId === id ? { kind: "admitted", snapshot: admitted } : { kind: "stale" };
  }
  let lease = await acquireAccountLease("kiro", id, {
    maxConcurrentPerAccount: kiroCap,
    waitMs, signal: options.abortSignal,
  });
  if (!lease) return { kind: options.abortSignal?.aborted ? "cancelled" : "capacity" };
  try {
    const admitted = await commitResolvedOAuthSelection(candidate, proactive);
    // The guarded commit may resolve a newer manual choice: never pair its token with id's lease.
    if (admitted?.accountId !== id) return { kind: "stale" };
    leaseOwner?.lease?.release();
    if (leaseOwner) leaseOwner.lease = lease;
    lease = null;
    return { kind: "admitted", snapshot: admitted };
  } finally { lease?.release(); }
};
const admitInitialKiroWithLease = async (resolved: OAuthAccessSnapshot): Promise<KiroLoadResult> => {
  const selected = captureOAuthAccountSelection("kiro");
  if (!selected) return { kind: "stale" };
  const activeId = selected.accountId;
  const roster = getAccountSet("kiro")?.accounts ?? [];
  const eligibleIds = eligibleFailoverAccounts(
    "kiro", Date.now(), classifyModelFamilyForQuota("kiro", route.modelId),
  );
  const eligible = roster.filter(account => eligibleIds.includes(account.id)
    && kiroAccountEvidence(account).exhausted !== true).map(account => account.id);
  // Explicit off or no eligible sibling keeps the active choice, subject to the cap.
  const canMove = kiroMayMove && eligible.some(id => id !== activeId);
  const order = canMove
    ? filterInitialKiroRankCandidates(eligible, route.modelId)
    : [activeId];
  // 050 may narrow to positive model members; it must return a subset in roster order.
  // The filtered set, not the pre-filter preferred id, is ranked by in-flight load.
  const ordered = kiroLeastLoaded && canMove
    ? order.slice().sort((a, b) => accountInFlight("kiro", a) - accountInFlight("kiro", b))
    : [resolved.accountId, ...order.filter(id => id !== resolved.accountId)]
        .filter(id => order.includes(id));
  const unresolvableIds = new Set<string>();
  const resolveInitialCandidate = async (id: string): Promise<OAuthAccessSnapshot | null> => {
    try {
      const candidate = id === resolved.accountId ? resolved
        : await getValidAccessSnapshotForAccount("kiro", id, { requireUsableAccount: true });
      if (!candidate) unresolvableIds.add(id);
      return candidate;
    } catch {
      unresolvableIds.add(id); // removal/reauth race; no upstream diagnostic escapes
      return null;
    }
  };
  const sweep = async (): Promise<KiroLoadResult> => {
    let full = false;
    for (const id of ordered) {
      if (unresolvableIds.has(id)) continue;
      if (options.abortSignal?.aborted) return { kind: "cancelled" };
      const candidate = await resolveInitialCandidate(id);
      if (options.abortSignal?.aborted) return { kind: "cancelled" };
      if (!candidate) continue;
      const result = await commitKiroWithLease(candidate, kiroLeastLoaded && id !== activeId);
      if (result.kind === "admitted" || result.kind === "cancelled") return result;
      if (result.kind === "capacity") full = true;
      if (result.kind === "stale") return result; // re-resolve selection, never dispatch stale metadata
    }
    return { kind: full ? "capacity" : "stale" };
  };
  const first = await sweep();
  if (first.kind !== "capacity" || kiroCap === undefined) return first;
  // One deadline shared by the permitted candidates, including singleton/explicit off.
  const waitId = ordered.find(id => !unresolvableIds.has(id));
  if (!waitId) return { kind: "stale" };
  let wait = await acquireAccountLease("kiro", waitId, {
    maxConcurrentPerAccount: kiroCap, waitMs: KIRO_ACCOUNT_WAIT_MS, signal: options.abortSignal,
  });
  if (!wait) return options.abortSignal?.aborted ? { kind: "cancelled" } : sweep();
  try {
    const candidate = await resolveInitialCandidate(waitId);
    if (options.abortSignal?.aborted) return { kind: "cancelled" };
    if (candidate) {
      const admitted = await commitResolvedOAuthSelection(candidate, kiroLeastLoaded && waitId !== activeId);
      if (admitted?.accountId !== waitId) return { kind: "stale" };
      leaseOwner?.lease?.release();
      if (leaseOwner) leaseOwner.lease = wait;
      wait = null;
      return { kind: "admitted", snapshot: admitted };
    }
  } finally { wait?.release(); }
  return sweep(); // stale waiter account was removed; try remaining permitted ids once
};
```

The initial helper passes roster accounts to `kiroAccountEvidence` and tries the resolved first choice before another account when proactive ranking is off. `filterInitialKiroRankCandidates` is the named 050 hook: after eligibility and before load ranking, 050 narrows the final candidate set to positive model members when any exist; it returns the input unchanged otherwise and never adds an ineligible id. When `kiroLeastLoaded` is true, the filtered set sorts by in-flight count with stable roster order as the tie-break. A current refusal verdict excludes an account only when the explicit-off gate is open and another eligible account exists. Explicit off, a singleton, or an all-excluded fallback keeps the active account, subject to the cap. A snapshot resolver throw or null from a removed/reauth sibling records that id as unresolvable and the bounded sweep tries the next candidate; abort still returns `cancelled`, while a guarded commit reporting a changed selection returns `stale`. Try eligible immediate candidates before one shared 250 ms wait; a successful wait commits with the held lease, while a timeout gets one final sweep. If the active account is the only permitted choice, wait on that account and then return `kiroAccountCapacityResponse()` with JSON `error.code === "account_capacity"`, status 503, and `Retry-After: 1`; do not pass this response through `formatErrorResponse`, whose 503 classifier rewrites the code to `server_is_overloaded`. No upstream send or health verdict is created. `cancelled` uses `clientCancelledResponse`; `stale` uses the existing 409 selection-conflict path. Every admitted send must use the full returned snapshot, including Kiro bearer/profile/region. `refreshDispatchAdapter`'s same-account revalidation (`src/server/responses/request-transport.ts:346-360`) reuses the held lease.

A refusal calls the candidate-only `commitKiroWithLease` through `applyFailoverSnapshot` and passes its `excludedAccountIds` set as `capacityExclusions`. A full alternate records one request-local exclusion and returns `null` to 030's loop; a successful admission transfers the lease and only then may consume the original refusal. No capacity attempt spends an extra physical send or credential-hop reservation. The response's final release stays in `handleResponses`, never this helper's `finally`.

### MODIFY `src/cli/account-extended.ts` and `src/cli/account.ts`

```diff
@@ src/cli/account-extended.ts:964 @@
-        const thresholdSummary = strategy === "round-robin"
+        const thresholdSummary = strategy === "least-loaded"
+          ? "fewest active requests among eligible accounts"
+          : strategy === "round-robin"
@@ src/cli/account.ts:55 @@
-  ocx account strategy <provider> [<quota|round-robin|fill-first|reset-first>] [--json]
+  ocx account strategy <provider> [<quota|round-robin|fill-first|reset-first|least-loaded (kiro)>] [--json]
```

Apply the same usage line change to `src/cli/account-extended.ts:48`. The server remains the validator. Do not put the cap into the threshold text; it is an independent setting.

### MODIFY 030's bounded Kiro refusal arms in `src/server/responses/adapter-dispatch.ts`, `src/server/responses/adapter-continuation.ts`, and `src/server/responses/run-turn-execution.ts`

030 classifies every Kiro 429/400/403 through `classifyKiroRefusal` and rotates through `rotateGenericOAuthAccountOnRefusal`, including the run-turn arm (`run-turn-execution.ts:371`, reached with `_kiroAuthContext` at `:61`). Keep classification, pre-quorum verdict recording, no-output/replayability guard, and physical-send budget. **Rebase-verify at this layer's P:** 030's arms are a lower-layer planned change. In `adapter-dispatch.ts` and `adapter-continuation.ts`, put the capacity-aware candidate loop below strictly inside `route.providerName === "kiro"`; retain the 030 non-Kiro `rotateGenericOAuthAccountOn429` and single-candidate segment verbatim in the `else` branch. In particular, keep `adapter-dispatch.ts:897-906` from `origin/dev` in order: cancel body before snapshot resolution, then increment `genericFailovers` before `applyFailoverSnapshot`, including when admission returns false. Do not route other providers through `rotateGenericOAuthAccountOnRefusal`, defer their cancellation, or change their count. Rejoin only at the pre-existing common replay setup after successful admission; preserve its `pendingHopPermit` and `rebuildAndRefetch` flow. Adapt Kiro's candidate/exclusion sequence to the run-turn arm's existing guard and budget. `request-transport.ts` admits one named snapshot and contains no refusal rotation. The passthrough and sidecar arms use the shared `applyFailoverSnapshot` lease seam if a Kiro refusal can reach them; preserve their existing budgets. No arm starts an independent unbounded retry loop.

```diff
@@ src/oauth/generic-account-failover.ts: 030 rotateGenericOAuthAccountOnRefusal signature/candidate selection @@
   monthlyCooldownMs?: number,
+  excludedAccountIds?: ReadonlySet<string>, refusalAlreadyRecorded = false,
 ): string | null {
-  health.set(healthKey(providerName, failedAccountId, family), ...);
+  if (!refusalAlreadyRecorded) health.set(healthKey(providerName, failedAccountId, family), ...);
@@
-  const candidates = ring.filter(id => id !== failedAccountId && eligible.includes(id));
+  const candidates = ring.filter(id => id !== failedAccountId && eligible.includes(id)
+    && !excludedAccountIds?.has(id));
+  const strategy = activeGenericStrategy(config, providerName);
+  if (providerName === "kiro" && strategy === "least-loaded"
+    && isProactivePreferenceEnabled(config, providerName, now))
+    candidates.sort((a, b) => accountInFlight(providerName, a) - accountInFlight(providerName, b));
@@ before existing strategy branch @@
-  const strategy = activeGenericStrategy(config, providerName);
```

Keep 030's actual cooldown computation and `sweepExpiredOnWrite` inside the same `!refusalAlreadyRecorded` guard. Preserve the pre-existing non-Kiro `rotateGenericOAuthAccountOn429` wrapper exactly; it never supplies these new arguments. The sort is stable because `ring` begins in account order and JavaScript's stable sort preserves equal counts. `eligibleFailoverAccounts` already applies 030's refusal exclusions via `kiroAccountEvidence`; do not read a second state map.

```ts
// Insert only in 030's Kiro branch in adapter-dispatch; use `response` instead of
// `upstreamResponse` in adapter-continuation. Keep the non-Kiro else branch and its
// cancellation/increment/admission order verbatim. Classification and verdict recording
// happen once before this segment, as specified by 030.
const originalRefusal = upstreamResponse;
const excludedAccountIds = new Set<string>();
const maxCandidates = Math.min(
  eligibleFailoverAccounts(route.providerName, Date.now()).length,
  GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST,
);
// Retain the `hop = reserveCredentialHop(...)` expression immediately above this
// segment in each 030 arm. It has already established `hop.allowed` and its permit.
if (!hop.allowed) break; // originalRefusal is still owned; return it unchanged
let admitted: OAuthAccessSnapshot | null = null;
for (let checked = 0; checked < maxCandidates; checked++) {
  const nextAccountId = rotateGenericOAuthAccountOnRefusal(
    config, route.providerName, transportState.genericFailoverAccountId!,
    refusal.kind, originalRefusal.headers.get("retry-after"), Date.now(), route.modelId,
    monthlyCooldownMs, excludedAccountIds, checked > 0,
  );
  if (!nextAccountId) break;
  let snapshot: OAuthAccessSnapshot;
  try { snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId); }
  catch { excludedAccountIds.add(nextAccountId); continue; }
  const next = await applyFailoverSnapshot(snapshot, parsed, excludedAccountIds);
  if (!next) {
    if (excludedAccountIds.has(nextAccountId)) continue; // full; same reserved hop
    break; // stale/abort/guard rejection is not capacity
  }
  transportState.genericFailovers += 1; // Kiro only; after successful admission
  admitted = next;
  break;
}
if (!admitted) { hop.permit?.release(); upstreamResponse = originalRefusal; break; }
try { void originalRefusal.body?.cancel().catch(() => {}); } catch { /* closed */ }
// Continue with 030's existing invalidateSameTargetRequest(), adapter resolution,
// pendingHopPermit, and rebuildAndRefetch block; `admitted` is its full snapshot.
```

The non-Kiro `else` in `adapter-dispatch.ts` retains this exact `origin/dev:897-906` segment inside its existing try/catch, with its existing rotation and replay lines around it; 030 may have changed the enclosing guard, so rebase-verify at this layer's P:

```ts
try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
try {
  // The FULL snapshot, not just the bearer: Antigravity pairs an account-matched
  // projectId with its token and Kiro carries routing metadata, so a token-only swap
  // would mix one account's credential with another's routing data.
  const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
    transportState.genericFailovers += 1;
  if (!await applyFailoverSnapshot(snapshot)) {
    hop.permit?.release();
    break;
  }
```

At `adapter-continuation.ts` substitute `response` for `upstreamResponse`, and `nextParsed` for `parsed`; preserve its `if (nextAccountId)` framing and the same `hop = reserveCredentialHop(...)` call. Its non-Kiro `else` branch retains the same original cancellation and increment placement. In run-turn, move Kiro's `genericFailovers += 1` from before `applyFailoverSnapshot` to after a successful admission; leave the non-Kiro increment exactly where it is. At the adapter-dispatch, adapter-continuation, and run-turn 429 arms, test a non-Kiro provider to prove its response-body cancellation, first/next send order, and `genericFailovers` count have not moved, including failed snapshot admission. Preserve the existing non-Kiro `rotateGenericOAuthAccountOn429` branch byte for byte. Check the existing no-output/send-budget guard before cancelling `originalRefusal.body`; release a reserved permit if no replacement is admitted. A full first alternate leaves the original response intact; another candidate can be admitted under the same hop. If alternates are unavailable, return the original status/body. The Kiro candidate loop is bounded by the roster and `GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST`. Logs and diagnostics use only closed-set `capacity`, `stale`, and refusal-kind codes/statuses; never include upstream message text, token, device code, or client secret.

### MODIFY test registries

Add these exact lines to **both** `scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json`, in their existing alphabetical order (the latter has no `explicit` wrapper):

```json
"kiro-account-load.test.ts": "providers/kiro",
"kiro-leased-responses.test.ts": "providers/kiro",
"kiro-pool-load-settings.test.ts": "providers/kiro",
```

```diff
@@ scripts/test-layout/layout.json:1068-1076, under "explicit" @@
+    "kiro-account-load.test.ts": "providers/kiro",
     "kiro-account-quota.test.ts": "providers/kiro",
     "kiro-adapter.test.ts": "providers/kiro",
@@ scripts/test-layout/layout.json:1073-1077 @@
     "kiro-images.test.ts": "providers/kiro",
+    "kiro-leased-responses.test.ts": "providers/kiro",
     "kiro-oauth.test.ts": "providers/kiro",
+    "kiro-pool-load-settings.test.ts": "providers/kiro",
@@ tests/fixtures/test-layout-expected.json:889-897 @@
+  "kiro-account-load.test.ts": "providers/kiro",
   "kiro-account-quota.test.ts": "providers/kiro",
   "kiro-adapter.test.ts": "providers/kiro",
@@ tests/fixtures/test-layout-expected.json:894-898 @@
   "kiro-images.test.ts": "providers/kiro",
+  "kiro-leased-responses.test.ts": "providers/kiro",
   "kiro-oauth.test.ts": "providers/kiro",
+  "kiro-pool-load-settings.test.ts": "providers/kiro",
```

Sort by full filename: put `kiro-account-load` before `kiro-adapter`, `kiro-leased-responses` between `kiro-images` and `kiro-oauth`, and `kiro-pool-load-settings` between `kiro-oauth` and `kiro-pool-rank`. The displayed local context is deliberately short; the placement sentence is authoritative.

All new tests live under `tests/providers/kiro/`; no line is added to existing capped `tests/providers/kiro/kiro-adapter.test.ts` (2050/2050) or `kiro-stream.test.ts` (2258/2258). The baseline at `tests/fixtures/file-size-baseline.json` also caps `src/config.ts` at 460 and `core.ts` at 210; the other proposed runtime files are not entries in its `files` map at this head. Re-check on the 030 base.

## PLAN-FIELD-CHAIN-01

| New field/value | Creation | Serialization | Deserialization | Consumer |
| --- | --- | --- | --- | --- |
| `maxConcurrentPerAccount?: number` | `src/server/management/oauth-account-routes.ts` validates 1..100 or null; direct config has the same runtime guard | Existing `saveConfigPreservingClaudeCode` in that route writes `providers.kiro.oauthAccountFailover.maxConcurrentPerAccount` | Config loader retains provider fields; `parseKiroAccountCap` projects DTO; runtime validates again in `request-transport.ts` | `acquireAccountLease` enforces cap for Kiro only; null removes it. A full cap waits at most 250 ms then yields retryable 503 `account_capacity` and `Retry-After` when no permitted account opens, including explicit off and singleton. |
| `strategy: "least-loaded"` | Both pool write routes parse only with provider `kiro` | Existing provider config writer in `oauth-account-routes.ts` | `parseGenericPoolStrategy(value, provider)` on DTO reads; `activeGenericStrategy` checks provider and `pool.kernel` | `preferredInitialAccount`, `request-transport.ts` initial ordering, and 030 refusal candidate ordering read `accountInFlight` only when `isProactivePreferenceEnabled(config, "kiro", now)` is true; Kiro unset is presence-is-consent and either explicit false wins, while other providers keep existing precedence and strategies. |
| `ProviderAccount.loginId` / Kiro `quotaPercent` / refusal verdict / `identity` | `saveCredentialWithReceipt` writes a random UUID on every append or replacement login; 010's probe and 030's refusal capture `kiroEvidenceIdentity(account)` using account id, loginId (legacy `addedAt` fallback), accountId/email, profileArn, and clientId | `normalizeAuthStore` validates/preserves `loginId`; refresh writers replace only `.credential`. Each quota row, `KiroPersistedVerdict`, 030 refusal verdict, and 050 catalogue row/in-flight fetch carry the SHA-256 identity, with independent quota timestamp and verdict `observedAt`; no `authType` or token generation participates | 010 `hydrateKiroAccountState` validates current account identity and independent TTL/reset bounds, once per process | `kiroAccountEvidence(account: ProviderAccount, now?)` is 040's only Kiro routing read; caller passes its roster row, with no `auth.json` load per candidate. `getCachedProviderAccountQuota`, `isAccountQuotaExhausted`, 030 exclusion, and 070 `autoSelectable` use the same seam and treat mismatch as unknown. |
| `AccountLease` / in-flight count | `acquireAccountLease` increments synchronously | N/A: process-local and intentionally lost on restart | N/A: each request re-acquires; no disk state | `accountInFlight` ranks; cap blocks; response EOF/error/cancel and failover release. |
| `accountLoad` request holder | `handleResponses` creates a fresh holder | N/A: internal request object | N/A | `request-transport` transfers on failover; outer response wrapper releases. |
| `PoolSettingsDto.maxConcurrentPerAccount` and `GenericPoolSettingsDto.maxConcurrentPerAccount` | `pool-settings-capability.ts` projects validated Kiro config or null | JSON response from both management routes | CLI/API clients receive JSON; absent is not silently equated to zero | Operator and tests can verify the applied cap; unsupported providers report null. |

## Conditional paths and observable tests

| Activation | Observable assertion |
| --- | --- |
| Neither Kiro option set; any non-Kiro provider | No lease acquired, no additional wait. Non-Kiro initial and 429 behavior, cancellation order, and `genericFailovers` counts are unchanged on adapter-dispatch and run-turn. |
| Kiro least-loaded on, pool kernel on, no explicit global/provider off, 2+ healthy eligible accounts | Fewest in-flight wins on the **first physical send**; equal counts resolve in stored account order; no random draw. Unset is presence-is-consent; either explicit `enabled: false` wins over `true` on the other level. |
| Kiro least-loaded stored but kernel off, with no explicit off | The first physical send uses the active account when healthy, even if a sibling has fewer in-flight requests. A valid cap falls through to an eligible sibling when the active account is full. 030's refusal-aware first admission still applies with no 040 option configured. |
| Global or per-provider `oauthAccountFailover.enabled === false`, even if the other is true | First send stays on the active account; no first-admission exclusion or refusal rotation. If its cap is full, wait up to 250 ms, then return 503 `account_capacity` and `Retry-After`; no sibling send. |
| An account has `needsReauth`, cooldown, 030 suspension, or a current exhausted verdict | Exclude it before load ordering only if movement is allowed and another eligible account exists; a singleton/all-excluded pool attempts its usable active account subject to its cap. An unrecognised/absent quota shape leaves the account eligible and causes no quarantine. |
| First candidate at cap and another eligible account has room | Another account is admitted with its own full credential metadata; first account gets no extra lease. |
| All permitted candidates at cap, including singleton/all-excluded/explicit-off | One shared bounded wait (250 ms), one final sweep, then retryable 503 `account_capacity` with `Retry-After` for an initial request; no unbounded queue, bypass, or account id in body. A refusal path preserves its original upstream status/body. |
| Kiro 429/400/403 reaches adapter, continuation, run-turn, passthrough, or sidecar refusal arm | `classifyKiroRefusal` feeds `rotateGenericOAuthAccountOnRefusal`; a full alternate is excluded locally before retry, the original refusal survives until replacement admission, and `genericFailovers` increments only after Kiro admission. |
| Signal aborts during wait or credential resolution | Wait listener/timer and speculative lease are removed; the request returns the existing client-cancel outcome. |
| Selection revision changes after speculative lease | Lease is released and current selection is retried; no bearer is dispatched with a different account's region/profile. |
| Kiro stream completes, errors, or client cancels; non-streaming response has no body | Count returns to zero once. A failover moves the count from A to B before the next physical send, then B is released at terminal. |

## Tests (new sibling files; exact names)

`tests/providers/kiro/kiro-account-load.test.ts`:

- `lease counts are process local and release is idempotent`: acquire twice unbounded, release twice, count returns to zero.
- `a cap admits one, wakes one waiter, and never exceeds the limit`: deferred promise controls release; maximum observed count is one.
- `bounded wait returns null and removes its waiter`: fake timer advances past 250 ms; later release does not resurrect it.
- `aborted wait returns null without a reservation`: abort signal, no count leak.

Complete direct-ledger test file skeleton (the three account ids are deliberately distinct, so tests can run in parallel):

```ts
import { expect, test } from "bun:test";
import { acquireAccountLease, accountInFlight } from "../../../src/oauth/kiro-account-load";

test("lease counts are process local and release is idempotent", async () => {
  const a = await acquireAccountLease("kiro", "load-idempotent");
  const b = await acquireAccountLease("kiro", "load-idempotent");
  expect(a && b).toBeTruthy();
  expect(accountInFlight("kiro", "load-idempotent")).toBe(2);
  a!.release(); a!.release(); b!.release();
  expect(accountInFlight("kiro", "load-idempotent")).toBe(0);
});
test("a cap admits one, wakes one waiter, and never exceeds the limit", async () => {
  const first = await acquireAccountLease("kiro", "load-wake", { maxConcurrentPerAccount: 1 });
  expect(first).not.toBeNull();
  const pending = acquireAccountLease("kiro", "load-wake", { maxConcurrentPerAccount: 1, waitMs: 100 });
  expect(accountInFlight("kiro", "load-wake")).toBe(1);
  first!.release();
  const second = await pending;
  expect(second).not.toBeNull();
  expect(accountInFlight("kiro", "load-wake")).toBe(1);
  second!.release();
  expect(accountInFlight("kiro", "load-wake")).toBe(0);
});
test("bounded wait returns null and removes its waiter", async () => {
  const first = await acquireAccountLease("kiro", "load-deadline", { maxConcurrentPerAccount: 1 });
  const second = await acquireAccountLease("kiro", "load-deadline", { maxConcurrentPerAccount: 1, waitMs: 5 });
  expect(second).toBeNull();
  first!.release();
  expect(accountInFlight("kiro", "load-deadline")).toBe(0);
});
test("aborted wait returns null without a reservation", async () => {
  const controller = new AbortController();
  const first = await acquireAccountLease("kiro", "load-abort", { maxConcurrentPerAccount: 1 });
  const pending = acquireAccountLease("kiro", "load-abort", { maxConcurrentPerAccount: 1, waitMs: 100, signal: controller.signal });
  controller.abort();
  expect(await pending).toBeNull();
  first!.release();
  expect(accountInFlight("kiro", "load-abort")).toBe(0);
});
```

`tests/providers/kiro/kiro-pool-load-settings.test.ts`:

- `Kiro persists and reads least-loaded and maxConcurrentPerAccount`: PUT/GET canonical and legacy routes both return applied values, then reload config.
- `non-Kiro strategy and cap writes are rejected without a config mutation`: include Codex, Anthropic and another generic OAuth provider.
- `malformed cap or unknown strategy is rejected without a write`: 0, fractional, >100, string and unknown name.
- `unknown Kiro quota stays selectable while a current exhausted verdict is not preferred`: no upstream call; exercise the 010/030 cache seam.
- `least-loaded uses eligible accounts then stable order for ties`: controlled leases for A/B and an ineligible C.
- `initial candidate hook leaves 040 eligibility intact before load ranking`: with A/B eligible and C excluded by current Kiro verdict, assert `filterInitialKiroRankCandidates` sees only A/B in roster order; 040's identity body leaves the set unchanged. **Rebase-verify at this layer's P** for the 030 eligibility seam.
- `kernel off keeps active first but cap may fall through`: with no explicit off, A has one lease and B zero; without cap assert first-send bearer/profile/region is A's; with cap 1 assert B serves instead.
- `explicit global or provider off keeps active and forbids rotation`: test global `enabled=false` with provider `enabled=true`, then provider `enabled=false` with global `enabled=true`; assert first-send bearer/profile/region is A's and a classified refusal does not select B.
- `unset Kiro enablement admits refusal-aware first choice`: no global/provider `enabled` field, active A has a current identity-matched suspension and B is eligible; assert first physical send uses B's bearer/profile/region. Repeat with either explicit false and assert A remains first.

`tests/providers/kiro/kiro-leased-responses.test.ts`:

- `a full Kiro account falls through to another eligible account before first send`: fake upstream and two local credentials; assert account-matched bearer/profile/region and no send on full A.
- `all accounts full wait once then return public account_capacity`: fake clock; assert JSON `error.type === "server_error"`, `error.code === "account_capacity"`, fixed body, 503, `Retry-After: 1`, and no leaked lease. This fails if the 503 passes through `formatErrorResponse` and becomes `server_is_overloaded`.
- `stale first sibling is skipped and free second sibling serves`: hold active A at cap; let B pass roster eligibility but make `getValidAccessSnapshotForAccount` throw for B after removal/reauth; leave C free. Assert one physical send with C's full bearer/profile/region, zero sends to B, no 503, and no leaked lease. Repeat with B returning null; neither case retries B in the final sweep.
- `positive model membership filters final initial ranking before least-loaded`: **050 acceptance test, rebase-verify at 050's P**. With A and B eligible, positive model evidence only for A, and B less loaded, replace `filterInitialKiroRankCandidates` with 050's positive-membership body and assert A makes the first physical send; with no positive evidence assert the unchanged 040 load order chooses B. The 050 hook may narrow only and cannot bypass cooldown, quota verdict, or capacity.
- `Kiro stream completion releases the serving lease`: hold body open, count remains one, then EOF gives zero.
- `Kiro cancellation and stream error release exactly once`: cancel/read error, zero count and no stale waiter.
- `pre-output refusal failover transfers lease before retry`: 030 classifier fixture, one send budget reservation, A drops and B rises, then zero at terminal.
- `first refusal alternate full and second free uses the same reserved hop`: A returns a classified refusal, B is held at cap, C is free; assert one new physical send to C, no send to B, original response cancelled only after C admission, and `genericFailovers` advances once.
- `two full refusal alternates return the original status and body`: A returns a classified refusal, B and C are held at cap; assert no replacement send, unchanged original status/body, released hop permit, zero added `genericFailovers`, and no capacity health verdict.
- `singleton and all-excluded pools use active only while under cap`: with cap 1, assert the first send uses A's full snapshot while free; hold A's lease, advance the 250 ms wait, then assert retryable 503 with JSON `error.code === "account_capacity"`, `Retry-After: 1`, and no second send for both singleton and all-excluded cases.
- `explicit off full cap waits and returns account_capacity without moving`: test both global and provider false with a free B; hold A's lease, advance 250 ms, assert 503 with JSON `error.code === "account_capacity"`, `Retry-After: 1`, no B send, and no health verdict.
- `stale identity evidence cannot exclude a Kiro account`: replace a legacy identity-less credential with a different person's login in the same slot; assert `loginId` and `kiroEvidenceIdentity(account)` change, quota percentage/verdict become unknown through `kiroAccountEvidence(account)`, and first send may use that account. Refresh only `.credential` and assert identity is stable.
- `selection race releases speculative lease and never mixes credential metadata`: change selection revision while resolver awaits.
- `non-Kiro adapter-dispatch 429 retains pre-admission cancellation and increment`: use a non-Kiro OAuth account pair; make the snapshot resolver observe that the original body was already cancelled, then reject admission and assert `genericFailovers` has already incremented. On a successful replay assert the same first/next send order and zero Kiro ledger entries.
- `non-Kiro adapter-continuation 429 retains pre-admission cancellation and increment`: force continuation through a non-Kiro OAuth pair; observe body cancellation before snapshot resolution and the existing increment point even if admission fails; assert successful replay order and zero Kiro ledger entries.
- `non-Kiro run-turn 429 retains send order and failover count`: use a non-Kiro OAuth account pair through run-turn; assert original refusal handling, replacement send order, and the existing pre-admission increment even if snapshot admission fails; zero Kiro ledger entries.
- `Kiro run-turn refusal waits for admission before accounting`: with `_kiroAuthContext`, exercise classified 429, 400, and 403; assert `classifyKiroRefusal` and `rotateGenericOAuthAccountOnRefusal` are used, a full first alternate tries a free second under the same hop, and `genericFailovers` increments once only after admitted replacement.

The two integration siblings are NEW files. Their implementation skeleton is: import `{ test, expect, beforeEach, afterEach }` from `bun:test`, install an isolated Codex home and fake provider executor using the existing `tests/providers/kiro/kiro-pool-rank.test.ts` account fixture; construct a deferred `ReadableStream` for held-stream cases; invoke `handleResponses` with a Kiro OAuth route and fake `fetch`; assert the selected first physical send's full account snapshot and `accountInFlight("kiro", accountId)` at the exact hold, failover, EOF and cancel boundaries. For settings, use an isolated-home management harness (`tests/server/account-pool-management-api.test.ts` cannot clean its in-tree temp path from this `~/.codex` worktree), call both routes with authenticated local test requests, reload config, and compare complete `strategy`, `maxConcurrentPerAccount` and `supported` DTO fields. Every test restores config/home and releases any direct lease in `afterEach`. No test sends to a real endpoint.

No live Kiro or AWS endpoint is called; all request tests use a fake executor. Register all three files in both registries above. A test that reads source as data must use `repoPath()` from `tests/helpers/repo-root.ts`.

## User and structure docs

- MODIFY `docs-site/src/content/docs/reference/configuration/providers.md:828-834`: add a Kiro-only row for `maxConcurrentPerAccount` (integer 1..100, absent means unlimited) and widen the strategy row with `least-loaded`; state that it first honors current identity-fenced eligibility/quota verdict, then, with no explicit global/provider off, fewest in-flight and stable account-order tie, with a 250 ms capacity wait. If movement is forbidden or no sibling is eligible, a full active cap returns retryable 503 `account_capacity` with `Retry-After`. Keep translated pages from contradicting the English source.
- MODIFY `docs-site/src/content/docs/reference/cli/providers-accounts.md:381-383,434`: add a sentence that Kiro may opt into least-loaded placement and an independent per-account cap. A full cap tries another account when movement is allowed; explicit off or singleton waits at most 250 ms, then returns retryable 503 `account_capacity` with `Retry-After`. Update the strategy command table at line 242.
- MODIFY `structure/runtime.md` and `structure/transports/inventory.md` (mapped `src/oauth/` and `src/server/` in `structure/INDEX.md:136,146`): one present-tense sentence each: Kiro load admission is process-local, request-owned and released on terminal/cancel; all other providers retain their prior admission path.
- MODIFY `structure/transports/responses.md` and `structure/transports/responses-failover.md` (`src/server/` mapping, `structure/INDEX.md:146`): state that a Kiro account lease follows the actual admitted credential, transfers before a pre-output failover send, and is released by the response body rather than inner request `finally`.
- MODIFY `structure/providers-and-adapters.md` (`src/oauth/`, `src/server/`, `src/types/` mapping, `structure/INDEX.md:136,143,146,157`): state Kiro-specific strategy/cap and that unknown quota remains eligible.
- MODIFY `structure/config.md` (`src/types.ts` and provider config contract, `structure/INDEX.md:124,156`): document Kiro-only persisted cap and strategy validation. Review `structure/providers/xai-grok.md` for mapped `src/oauth/` but no wording change if its xAI description stays accurate. `structure/providers/kiro.md` should receive the short Kiro-specific operator contract even though `structure/INDEX.md` does not currently map `src/oauth/` to it; do not edit generated `structure/INDEX.md` by hand. If adding ownership, edit `structure/manifest.json`, regenerate the index and validate.

Sentence-level doc patch example against the current English config row:

```diff
@@ docs-site/src/content/docs/reference/configuration/providers.md:832 @@
-| `providers.<name>.oauthAccountFailover.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | — | Pool strategy for a generic OAuth provider (#695).
+| `providers.<name>.oauthAccountFailover.strategy?` | `"quota" \| "round-robin" \| "fill-first" \| "least-loaded" (Kiro only)` | — | Kiro may choose the eligible, non-exhausted account with the fewest active requests, breaking ties in account order; this option requires `pool.kernel` and proactive preference. |
+| `providers.kiro.oauthAccountFailover.maxConcurrentPerAccount?` | integer 1..100 | unlimited | Holds a process-local slot until response completion or cancellation; a full account tries an eligible sibling when movement is allowed, or waits up to 250 ms and returns retryable 503 `account_capacity` with `Retry-After`. |
```

Remaining MODIFY hunks, one for each named document:

```diff
@@ docs-site/src/content/docs/reference/cli/providers-accounts.md:242 @@
-strategy <provider> [<quota|round-robin|fill-first|reset-first>]  Pool placement strategy; omit the value to read it.
+strategy <provider> [<quota|round-robin|fill-first|reset-first|least-loaded (kiro)>]  Pool placement strategy; omit the value to read it.
@@ docs-site/src/content/docs/reference/cli/providers-accounts.md:381-383 @@
 With two or more Kiro accounts logged in, a 429 rotates to another account automatically and
 prefers the one with the most remaining allowance. Accounts are added one at a time —
+With `strategy: "least-loaded"`, Kiro chooses the eligible account with the fewest active requests when neither global nor provider failover is explicitly off; a configured per-account cap tries another eligible account when allowed, otherwise waits up to 250 ms before retryable 503 `account_capacity` with `Retry-After`.
@@ structure/runtime.md:26-27 @@
 Responses admission and finalization are composed through the
 [core module ownership](transports/responses.md#core-module-ownership). This surface retains its existing behavior.
+Kiro's optional account lease is held through response-body completion or cancellation, including account failover; other provider admission is unchanged.
@@ structure/transports/inventory.md:10-11 @@
 The existing Responses transport is divided by responsibility in the
 [core module ownership](responses.md#core-module-ownership). This surface retains its existing behavior.
+The optional Kiro OAuth account cap is process-local and request-owned; absent config keeps the existing transport.
@@ structure/transports/responses.md:15-17 @@
 `/v1/responses` is the main Codex-facing endpoint. The server parses Responses input, routes to a
 provider, lets the selected adapter speak the upstream protocol, then bridges adapter events back to
+For Kiro OAuth with load admission enabled, the selected account holds one lease until the returned body reaches EOF, error, or cancellation; a pre-output failover transfers it before the replacement send.
@@ structure/transports/responses-failover.md:24 @@
 ## Upstream reset retry
+Kiro capacity fallback tries another eligible account within the existing credential-hop allowance only when movement is allowed; explicit off or singleton waits on the active account and returns retryable 503 `account_capacity` with `Retry-After` if full. Capacity alone does not cool an account or authorize an extra physical send.
@@ structure/providers-and-adapters.md:78 @@
 | `src/oauth/` | OAuth providers, token storage, refresh, and auth-token resolution.
+The Kiro-specific `src/oauth/kiro-account-load.ts` counts active serving leases in process memory. When Kiro movement is allowed, selection filters existing eligibility and current quota verdicts before using the fewest active requests with stable account-order ties; unknown quota remains eligible. Either explicit failover off keeps the active account, still subject to the cap.
@@ structure/config.md:1 @@
 # Config Surface
+Kiro OAuth alone accepts `oauthAccountFailover.strategy: "least-loaded"` and integer `maxConcurrentPerAccount` from 1 to 100. The strategy requires the pool kernel and no explicit global/provider failover off; unset is presence-is-consent. The cap independently applies when configured, including explicit off and singleton.
@@ structure/providers/kiro.md:1 @@
 # Kiro Provider
+The optional Kiro account cap holds one process-local serving lease per request; least-loaded placement considers eligible, non-exhausted accounts and stable account order when neither failover setting is explicitly off. A full active account under explicit off or singleton waits up to 250 ms, then returns retryable 503 `account_capacity` with `Retry-After`.
```

Append the `src/oauth/` sentence **inside** the existing table cell in `structure/providers-and-adapters.md`; its short context above identifies the cell and the addition's exact wording. `structure/INDEX.md` is generated and is not a manual MODIFY target. If ownership is widened to map `src/oauth/` to `structure/providers/kiro.md`, add `"providers/kiro.md"` to the relevant `structure/manifest.json` `documents` array and regenerate `INDEX.md`; this is conditional on the owning-doc review. Review other mapped documents for stale claims without copying unchanged prose into each.

## PLAN-VERIFIER-REAL-01

Pre-implementation probes run now at `bb3f3c2d0d` (none reads the new file, because it does not exist yet):

| Exact command | Exit | What it actually read / result |
| --- | --- | --- |
| `bun test tests/providers/kiro/kiro-pool-rank.test.ts tests/oauth/generic-oauth-failover.test.ts tests/server/account-pool-management-api.test.ts tests/lab/core-lab-boundary.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | 1 | **152 tests ran: 144 pass, 8 fail.** All eight failures are Codex cases in `tests/server/account-pool-management-api.test.ts`: its cleanup asks `test-home-guard.ts` to remove `tests/server/.tmp-account-pool-mgmt-codex`, which resolves under the real `/Users/jun/.codex` because this worktree lives there. The guard correctly refuses removal. No `zod/v4` load error remains. This local environment cannot prove that file; require its hosted CI result on the implementation PR's exact head. |
| `bun run test:changed` | 0 | Compared with `origin/dev`, found 10 changed files and selected **0 tests**. It does not exercise this proposed runtime layer. |
| `bun run privacy:scan` | 0 | Existing tree scan passed (`Privacy scan passed`); it does not validate the not-yet-written runtime patch. |
| `bun run structure:check` | 0 | Existing structure map passed (`structure/ SSOT checks passed`); it does not see proposed new runtime/docs paths. |
| `bun run typecheck` | 0 | `bun x tsc --noEmit` passed on this docs-only checkout; implementation must rerun it on the actual 040 head. |

On the actual 040 branch, run the three new focused test files, the existing pool/layout/lab files above, `bun run typecheck`, `bun run test:changed`, `bun run privacy:scan`, `bun run structure:check`, and the docs-site build required by `docs-site/AGENTS.md`. Record real exit codes and exact-head hosted CI; a zero-test `test:changed` is not enough. Check the file-size baseline and both registries again after 030 lands.

## Risks, rollback, and out of scope

- **Risk:** A response wrapper that releases when `handleResponsesInner` returns will undercount a live stream. Release at body EOF/error/cancel; idempotent lease protects double terminal/cancel. Direct adapter calls outside `/v1/responses` are not covered by this layer unless they use the same request owner; test and document any such path on the 030 base.
- **Risk:** 030 changes refusal eligibility and call signatures. Rebase this recipe on 030; when Kiro movement is allowed, do not reintroduce an exhausted or suspended account through capacity fallback while another eligible candidate exists. Explicit off keeps the active choice. Preserve the original refusal until alternate admission, the one existing credential-hop reservation, and the physical-send budget. A full alternate must not cause an extra upstream request or a second rotation loop. Non-Kiro accounting and body order stay on their existing paths.
- **Risk:** The ledger is process-local; multiple proxy processes each enforce their own cap. State this in user docs. It stores only opaque provider/account keys and never logs them.
- **Rollback:** remove the two Kiro settings or set strategy to `quota`; with no cap and no `least-loaded`, the lease path is off and existing selection/failover resumes. A deployment rollback loses only in-memory counts, not quota or credentials.
- **Out of scope:** global cap, cross-process coordination, dashboard controls, quota probes, model catalogue (050), device login (060), measured credits (070), random weighted routing, and non-Kiro behavior changes. The 030 refusal semantics and the 010 verdict format are owned by their layers.

## Round-1 audit fold

- **r2-6 High:** Gate least-loaded at the effective Kiro proactive predicate and kernel; initial admission orders the first send accordingly. The tests cover first-send order and cap independence. Singleton/all-excluded fallback is subject to the configured cap.
- **r2-7 High:** 030's bounded Kiro refusal arms own request-local capacity exclusions; candidate-only admission reports a full account through `capacityExclusions` and retains the original response until admission. Tests cover a full first alternate and an available second, plus two full alternates returning the original status/body.
- **r2-1 Medium:** Focused verifiers were rerun with installed dependencies. The six-file Bun command ran 152 tests: 144 pass, eight local `~/.codex` cleanup-guard failures; hosted exact-head CI must establish those eight on the implementation PR. `test:changed`, privacy scan, structure check, and typecheck exited 0 with the documented coverage limits.
- **Architect recheck SD1'/SD2':** The 010 dependency and field chain use a fresh login UUID, `addedAt` fallback, no `authType`, and a roster-account argument to `kiroAccountEvidence`; the stale-identity test now proves a second identity-less login changes evidence while refresh does not.
- **Architect recheck SD3':** Every Kiro 429/400/403 arm, including run-turn, uses the refusal classifier/rotator and shared lease admission. Kiro alone delays body consumption and `genericFailovers` until replacement admission; named non-Kiro adapter-dispatch and run-turn tests pin existing order/counts.
- **Architect recheck SD4':** Either explicit global or provider off blocks Kiro first-admission movement and rotation. The cap remains independently active: explicit off, singleton, and all-excluded cases wait up to 250 ms then return retryable 503 `account_capacity` with `Retry-After` when full; exact tests and operator wording now state that contract.

## Round-2 audit fold

- **r2-R2-2 High → lines 456-536, 680-682:** The refusal-arm amendment is Kiro-only; the non-Kiro `adapter-dispatch.ts:897-906` sequence is copied verbatim and the continuation/run-turn placement is preserved. Named non-Kiro tests pin cancellation before resolution, pre-admission increment, and replay order. Rebase-verify at this layer's P against 030.
- **r2-R2-3 High → lines 305-313, 668, 676-677:** Initial full-cap returns `kiroAccountCapacityResponse()` with explicit JSON `error.code: "account_capacity"`, HTTP 503, and `Retry-After: 1`; the named full, singleton, and explicit-off tests assert the wire code.
- **r2-R2-4 High → lines 384-432, 669:** `resolveInitialCandidate` catches removed/reauth sibling resolution, excludes that id from the bounded first and final sweeps, and continues to a free sibling. The named stale-first-sibling test covers throw and null variants.
- **050 initial-ranking handoff → lines 302-304, 375-379, 660, 670:** `filterInitialKiroRankCandidates` is the named hook after 030 eligibility and before 040 load ranking. Its 040 identity test and 050 positive-model-membership acceptance test are specified above; rebase-verify at each layer's P.
