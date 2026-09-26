# 050 — Per-account Kiro model catalogue

- Layer/branch: 050, `codex/kiro-lb2-050-model-catalog`.
- Depends on: 040's eligible/least-loaded account selection seam, 030's refusal eligibility, 010's account-scoped evidence identity; rebase this plan against the landed 040 head before applying hunks. Baseline anchors below are `bb3f3c2d0d` except the #5937 usage probe, anchored to merged `9c7c046520` (`origin/dev` includes it).
- Adopted inventory: C1/N (account-scoped `ListAvailableModels`), C2 (model membership as preference, unknown IDs remain callable), C3 (reported input-token context limit, static fallback).
- Architect decisions: D050-1/2 accepted in `000_plan.md`; D010-1's `resolveKiroRequestProfile` and D040-2's selection seam are dependencies. AGPL source is factual evidence only, never an implementation source.
- Class: C3 cross-domain catalogue/selection; credential-bearing outbound and stale account identity get C4 care.

## Current state, with source anchors

| Function / contract | Baseline fact |
|---|---|
| `normalizeKiroModelId` | Normalizes the outbound slug in `src/providers/kiro-models.ts:67-77`; `KIRO_MODELS` and `KIRO_MODEL_CONTEXT_WINDOWS` are fixed arrays/maps at `:1-55`. No account dimension is represented. |
| `fetchKiroUsageSnapshot`, `kiroUsageContextForAccount` | At `9c7c046520`, `src/providers/kiro-usage.ts:79-99` has `usageRegion` (private) and `kiroUsageManagementUrl`; `:172-201` builds the usage request, and `:214-231` returns one account's bearer, profile ARN, `builderIdFallback`, and regions together. Export `kiroManagementHost(ctx)` from this module as `kiroUsageManagementUrl(usageRegion(ctx))`; reuse it for the catalogue operation. The fixed Builder ID service ARN must not pick the region. |
| `resolveKiroRequestProfile` | `src/oauth/kiro.ts:520-530` returns an ARN and `builderIdFallback` for a supplied account; passing `undefined` may inspect an imported account, so the catalogue must pass the selected account's metadata only. |
| `kiroEvidenceIdentity` | 010 adds `src/providers/kiro-account-state-disk.ts:kiroEvidenceIdentity(account: ProviderAccount)` as the non-secret identity fence. `saveCredentialWithReceipt` assigns a fresh UUID `loginId` on every login write, including same-slot replacement and legacy identity-less upgrade; refresh changes only `.credential`. `credentialGeneration()` hashes tokens and changes on refresh, so it is not the catalogue row identity. Legacy rows without `loginId` use `addedAt`. |
| `preferredInitialAccount`, baseline `rotateGenericOAuthAccountOn429` | `src/oauth/generic-account-failover.ts:443-513` chooses from eligible accounts, with a healthy-active shortcut at `:484-487` and quota ranking at `:508`; the reactive candidate ring is at `:375-414`. After 030, apply this preference inside `rotateGenericOAuthAccountOnRefusal`; the 040 least-loaded branch uses the same preference after eligibility. |
| `request-transport` | `src/server/responses/request-transport.ts:520-522` asks the synchronous preference seam before resolving a candidate, and `:530-564` falls back to the active credential if a proposal has gone stale. It records the admitted account at `:579-584`. |
| `fetchProviderModelsWithAuth`, `fetchAllModels` | `src/codex/catalog/provider-models.ts:172-217` constructs static rows and returns immediately for `liveModels: false`; `src/server/management/shared.ts:259-280` delegates `/api`, `/v1/models`, GUI, and client exports to one gathered catalogue. `src/providers/registry/entries-core.ts:598-612` deliberately leaves Kiro on the static path, avoiding a false runtime `/models` read. |
| `gatherRoutedModelsUncached`, `applyProviderConfigHints` | `src/codex/catalog/routed-gather.ts:337-372` joins provider rows then adds metadata; `src/codex/catalog/model-hints.ts:312-326` caps observed windows using the static policy. A known Kiro model's 272k seed would otherwise erase a larger observed limit. |
| `kiroUpstreamContextWindow`, `contextWindowForModel` | Kiro stream estimation reads the static map at `src/adapters/kiro/usage.ts:218-225`; request-log estimated usage does the same at `src/server/request-log.ts:1627-1634`. Neither has an account ID, so a shared conservative observed window must be used. |

Reference facts: `/tmp/kiro-lb/kiro/model_catalog.py:25,50-78` calls `KiroControlPlaneBearerService.ListAvailableModels` by POST to `https://management.{region}.kiro.dev/`, with `origin=AI_EDITOR` and `profileArn` in both query and body, then reads `models[]` and each `modelId`. `/tmp/kiro-lb/kiro/config.py:194-245` describes `tokenLimits.maxInputTokens` and `maxOutputTokens`; this layer uses the former as context evidence and deliberately does not infer an output limit. These are unverified against an opencodex-owned live account.

## File change map (apply after 040)

Exact planned paths and dispositions: `NEW src/providers/kiro-model-catalog.ts`; `MODIFY src/providers/kiro-usage.ts`, `src/server/responses/request-transport.ts`, `src/oauth/generic-account-failover.ts`, `src/codex/catalog/provider-models.ts`, `src/codex/catalog/routed-gather.ts`, `src/adapters/kiro/usage.ts`, `src/server/request-log.ts`; `NEW tests/providers/kiro/kiro-model-catalog.test.ts`, `tests/providers/kiro/kiro-model-preference.test.ts`; `MODIFY tests/providers/kiro/kiro-usage-quota.test.ts`, `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json`, `docs-site/src/content/docs/reference/adapters.md`, `docs-site/src/content/docs/reference/cli/providers-accounts.md`, `structure/providers-and-adapters.md`, `structure/catalog.md`, `structure/providers/kiro.md`. Localized account documentation listed below is also a `MODIFY` when the old quota-only sentence is present. No source or test file at its ratchet cap is edited.

`MODIFY src/providers/kiro-usage.ts` at `9c7c046520:87-99`: keep `usageRegion` as the sole region policy and add the exported helper below. It takes the same account-scoped context as the usage probe; its existing `builderIdFallback` branch ignores the fixed `us-east-1` service ARN and chooses `apiRegion`, then `ssoRegion`, then the default. Add a focused `kiro-usage-quota.test.ts` case for a Builder ID profile plus `apiRegion: "eu-west-1"` that asserts the helper yields `https://management.eu-west-1.kiro.dev/`.

```ts
export function kiroManagementHost(ctx: KiroUsageContext): string {
  return kiroUsageManagementUrl(usageRegion(ctx));
}
```

`NEW src/providers/kiro-model-catalog.ts` — complete intended module below. This is process-local evidence only: no bearer, ARN, or catalogue is written to disk. The common outbound helper enforces configured proxy, destination, redirect and response limits; the URL is constructed solely by `kiroManagementHost` from the account's routing context.

```ts
import { loadConfig } from "../config";
import { providerOutboundPost, providerRedirectError } from "../lib/provider-outbound";
import { getAccountSet } from "../oauth/store";
import { isValidModelDiscoveryModelId, MODEL_DISCOVERY_MAX_MODELS } from "./model-discovery-limits";
import { normalizeKiroModelId } from "./kiro-models";
import { kiroEvidenceIdentity } from "./kiro-account-state-disk";
import { kiroManagementHost, kiroUsageContextForAccount } from "./kiro-usage";
import { asRecord, QUOTA_JSON_READ_FAILURE, readQuotaJson, REQUEST_TIMEOUT_MS } from "./quota-wire";

const TARGET = "KiroControlPlaneBearerService.ListAvailableModels";
const FRESH_MS = 5 * 60_000;
const FAILURE_RETRY_MS = 60_000;
type ModelRow = { identity: string; models: KiroAccountModel[]; observedAt: number; nextRefreshAt: number };
const rows = new Map<string, ModelRow>();
const flights = new Map<string, { identity: string; promise: Promise<KiroAccountModel[] | undefined> }>();

export interface KiroAccountModel {
  modelId: string;
  contextWindow?: number;
}

function positiveTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseModels(value: unknown): KiroAccountModel[] | undefined {
  const payload = asRecord(value);
  if (!payload || !Array.isArray(payload.models) || payload.models.length === 0
    || payload.models.length > MODEL_DISCOVERY_MAX_MODELS) return undefined;
  const seen = new Set<string>();
  const models: KiroAccountModel[] = [];
  for (const item of payload.models) {
    const row = asRecord(item);
    if (!row || !isValidModelDiscoveryModelId(row.modelId) || seen.has(row.modelId)) continue;
    seen.add(row.modelId);
    const limit = positiveTokenLimit(asRecord(row.tokenLimits)?.maxInputTokens);
    models.push({ modelId: row.modelId, ...(limit === undefined ? {} : { contextWindow: limit }) });
  }
  return models.length ? models : undefined;
}

function currentIdentity(accountId: string): string | undefined {
  const account = getAccountSet("kiro")?.accounts.find(row => row.id === accountId && row.needsReauth !== true);
  return account ? kiroEvidenceIdentity(account) : undefined;
}

/** Last good per-account list; undefined means no trustworthy observation yet. */
export async function getKiroAccountModels(accountId: string): Promise<KiroAccountModel[] | undefined> {
  const identity = currentIdentity(accountId);
  if (!identity) { rows.delete(accountId); flights.delete(accountId); return undefined; }
  const cached = rows.get(accountId);
  if (cached && cached.identity !== identity) rows.delete(accountId);
  const old = cached?.identity === identity ? cached : undefined;
  if (old && Date.now() < old.nextRefreshAt) return old.models;
  const joined = flights.get(accountId);
  if (joined?.identity === identity) return joined.promise;
  const flight = (async (): Promise<KiroAccountModel[] | undefined> => {
    let fresh: KiroAccountModel[] | undefined;
    try {
      // Shared usage context pairs bearer, profile, Builder ID fallback, and regions.
      const ctx = await kiroUsageContextForAccount(accountId);
      if (currentIdentity(accountId) !== identity) return undefined;
      const { profileArn } = ctx;
      if (!profileArn) throw new Error("Kiro account lacks a request profile");
      const url = new URL(kiroManagementHost(ctx));
      url.searchParams.set("origin", "AI_EDITOR");
      url.searchParams.set("profileArn", profileArn);
      const provider = loadConfig().providers.kiro ?? { baseUrl: url.origin };
      const response = await providerOutboundPost("kiro", provider, url.toString(), {
        headers: {
          authorization: `Bearer ${ctx.access}`,
          "content-type": "application/x-amz-json-1.0",
          accept: "application/json",
          "x-amz-target": TARGET,
          "x-amzn-codewhisperer-optout": "true",
        },
        body: JSON.stringify({ origin: "AI_EDITOR", profileArn }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok && !await providerRedirectError(response, url.toString())) {
        const body = await readQuotaJson(response);
        if (body !== QUOTA_JSON_READ_FAILURE) fresh = parseModels(body);
      }
    } catch {
      // Failure is advisory; neither a token nor a response body enters diagnostics.
    }
    // Neither publish nor return old evidence to a replacement identity; an older
    // flight cannot delete the replacement flight or its newly committed row.
    if (currentIdentity(accountId) !== identity) return undefined;
    const now = Date.now();
    if (fresh) {
      rows.set(accountId, { identity, models: fresh, observedAt: now, nextRefreshAt: now + FRESH_MS });
      return fresh;
    }
    if (old) rows.set(accountId, { ...old, nextRefreshAt: now + FAILURE_RETRY_MS });
    return old?.models;
  })();
  flights.set(accountId, { identity, promise: flight });
  try { return await flight; } finally { if (flights.get(accountId)?.promise === flight) flights.delete(accountId); }
}

/** No observation is distinct from an observed list that lacks this model. */
export function kiroAccountSupportsModel(accountId: string, model: string): boolean | undefined {
  const identity = currentIdentity(accountId);
  if (!identity) return undefined;
  const found = rows.get(accountId);
  if (!found || found.identity !== identity) return undefined;
  const normalized = normalizeKiroModelId(model);
  return found.models.some(row => row.modelId === model || row.modelId === normalized);
}

/** Conservative global limit: every observed live account listing a model must fit. */
export function kiroObservedContextWindow(model: string): number | undefined {
  const normalized = normalizeKiroModelId(model);
  if (normalized === "auto") return undefined; // Router choice has no fixed window.
  const limits: number[] = [];
  for (const account of getAccountSet("kiro")?.accounts ?? []) {
    if (account.needsReauth === true) continue;
    const identity = currentIdentity(account.id);
    if (!identity) return undefined;
    const row = rows.get(account.id);
    if (!row || row.identity !== identity) return undefined;
    const hit = row.models.find(item => item.modelId === model || item.modelId === normalized);
    if (hit?.contextWindow === undefined) return undefined;
    limits.push(hit.contextWindow);
  }
  return limits.length ? Math.min(...limits) : undefined;
}

/** Account removal/logout hook and isolated-test reset. */
export function clearKiroAccountModels(accountId?: string): void {
  if (accountId) { rows.delete(accountId); flights.delete(accountId); }
  else { rows.clear(); flights.clear(); }
}
```

The SD1' fence uses the 010 helper's SHA-256 hex of JSON `[account.id, account.loginId ?? String(account.addedAt ?? ""), cred.accountId ?? cred.email ?? "", cred.kiro?.profileArn ?? "", cred.kiro?.clientId ?? ""]`, where `cred = account.credential`; `authType` is never stored by `normalizeCredential` and is absent from the tuple. `ProviderAccount.loginId?: string` is a random UUID assigned by `saveCredentialWithReceipt` on every login write (append or in-place replacement), validated and preserved by `normalizeAuthStore`, and untouched by refresh writers `saveAccountCredential`/`mergeAccountCredential`. Two different people replacing one identity-less slot therefore get different evidence identities, while token refresh retains its row. Legacy rows fall back to `addedAt`. A failed read retains an old good list only for the same identity. The new caller can replace a stale in-flight entry, and the old flight returns `undefined` without writing or returning old models. Every read path, including fresh cache, joined flight, membership, and context limits, checks current roster identity. `clearKiroAccountModels` is an eager cleanup; correctness does not depend on it.

`MODIFY src/server/responses/request-transport.ts` (baseline hunk at `:515-522`): warm only Kiro's eligible pool for a model request when the pool setting is unset (presence-is-consent default) or true, in parallel and bounded by `REQUEST_TIMEOUT_MS`; failures are advisory. Export the existing `isProactivePreferenceEnabled` predicate from `src/oauth/generic-account-failover.ts:174` so warming and `preferredInitialAccount` use the identical effective check. The 040 branch may already gather eligible IDs for leases: reuse that exact post-eligibility list. Explicit `oauthAccountFailover.enabled === false` globally or for Kiro keeps the active account at first admission and disables refusal rotation and model preference. The configured 040 concurrency cap remains its own opt-in: if the pool cannot move (explicit off or singleton), wait up to its bound and return retryable 503 `account_capacity` with `Retry-After` when still full; if it can move, try another eligible account first. Refusal-aware initial exclusion runs only with effective pool enablement.

```diff
@@
-        const preferredAccountId = isGenericFailoverProvider(route.providerName, route.provider)
+        if (route.providerName === "kiro" && route.modelId
+          && isProactivePreferenceEnabled(config, "kiro", Date.now())) {
+          const candidates = eligibleFailoverAccounts("kiro", Date.now(),
+            classifyModelFamilyForQuota("kiro", route.modelId));
+          await Promise.allSettled(candidates.map(id => getKiroAccountModels(id)));
+        }
+        const preferredAccountId = isGenericFailoverProvider(route.providerName, route.provider)
           ? preferredInitialAccount(config, route.providerName, Date.now(), route.modelId)
           : null;
```

`eligibleFailoverAccounts` is already imported at `src/server/responses/request-transport.ts:33`; add `getKiroAccountModels` from `../../providers/kiro-model-catalog` and `isProactivePreferenceEnabled` to its existing failover import. Do not fetch when there is no account/model, when effective pool enablement is off, or for a non-Kiro provider. Initial resolution and candidate ranking get quota state only through 010's `kiroAccountEvidence(account: ProviderAccount, now?: number)` via the updated `getCachedProviderAccountQuota` and `isAccountQuotaExhausted` call sites; 030's refusal exclusion, 040's eligibility, and 070's `autoSelectable`/`skipReason` use the updated `getKiroAccountExhaustion` routing call through that same read. Each caller passes its roster account; this evidence read does not call `getAccountCredential` or `loadAuthStore` per candidate. It hydrates once per process and applies identity, TTL, and reset bounds to both percentage and verdict on every read. This catalogue helper provides model membership only and does not duplicate quota state.

`MODIFY src/oauth/generic-account-failover.ts` (baseline hunks at `:174`, `:375-414`, and `:443-508`; the 030/040 rebase target is `rotateGenericOAuthAccountOnRefusal`). Export `isProactivePreferenceEnabled` and `preferKiroModelSupport`. The latter takes already eligible IDs: if at least one eligible ID has `kiroAccountSupportsModel(id, model) === true`, return only true IDs in the original stable order; otherwise return the original IDs. This narrows a *ranking set*, never `eligibleFailoverAccounts`, lease acquisition, credential resolution, or the outbound model ID. Use it after eligibility and request-local capacity exclusions in the 040 reactive candidate ring, and at 040's final initial-admission ranking seam only when effective pool enablement is on. The healthy-active shortcut must yield when another eligible account positively lists the requested model, again only under effective enablement. The 030 owner keeps one bounded `rotateGenericOAuthAccountOnRefusal` loop for every Kiro 429/400/403 arm, including `src/server/responses/run-turn-execution.ts:371` after `classifyKiroRefusal`; 040 capacity and 050 membership feed its candidate choice, with no additional retry loop. It retains the original upstream refusal Response until a replacement account is admitted; with no replacement, the original status/body reaches the client. The Kiro-only retain-until-admission reorder and `genericFailovers` accounting must leave non-Kiro adapter-dispatch and run-turn 429 order/counts unchanged, with named regressions in 030.

```diff
@@ inside rotateGenericOAuthAccountOnRefusal (on top of 040's capacity-filtered candidates)
-  const candidates = ring.filter(id => id !== failedAccountId && eligible.includes(id)
-    && !excludedAccountIds?.has(id));
+  const candidates = preferKiroModelSupport(providerName,
+    ring.filter(id => id !== failedAccountId && eligible.includes(id)
+      && !excludedAccountIds?.has(id)), requestedModelId);
@@
   const active = selected.activeAccountId;
   const order = selected.accounts.filter(account => account.needsReauth !== true).map(account => account.id);
   if (order.length < 2) return null;
+  const eligibleForModel = preferKiroModelSupport(providerName,
+    eligibleFailoverAccounts(providerName, now, classifyModelFamilyForQuota(providerName, requestedModelId)),
+    requestedModelId);
+  const positiveAlternative = providerName === "kiro" && requestedModelId
+    && isProactivePreferenceEnabled(config, providerName, now)
+    && eligibleForModel.some(id => id !== active && kiroAccountSupportsModel(id, requestedModelId) === true);
@@
   if (activeRow && activeRow.needsReauth !== true
     && !isCooled(providerName, activeRow.id, now, classifyModelFamilyForQuota(providerName, requestedModelId))
-    && !isAccountQuotaExhausted(providerName, activeRow.id, requestedModelId)) return null;
+    && !isAccountQuotaExhausted(providerName, activeRow.id, requestedModelId)
+    && !positiveAlternative) return null;
@@
-  if (!hasHeadroomEvidence(providerName, order, requestedModelId)) return null;
+  if (!hasHeadroomEvidence(providerName, order, requestedModelId) && !positiveAlternative) return null;
@@
-  const eligible = order.filter(id => !isCooled(providerName, id, now, classifyModelFamilyForQuota(providerName, requestedModelId)));
+  const eligible = preferKiroModelSupport(providerName,
+    order.filter(id => !isCooled(providerName, id, now, classifyModelFamilyForQuota(providerName, requestedModelId))),
+    requestedModelId);
```

Apply the same preference to strategy inputs; the current hunks below are the 040 rebase targets if 040 has already added `least-loaded`. Export the helper from this file and import it in `request-transport.ts` alongside `isProactivePreferenceEnabled`; it imports `kiroAccountSupportsModel`, and returns input unchanged for non-Kiro, absent model, no positive evidence, or an empty list:

```ts
export function preferKiroModelSupport(provider: string, ids: string[], model?: string | null): string[] {
  if (provider !== "kiro" || !model) return ids;
  const positive = ids.filter(id => kiroAccountSupportsModel(id, model) === true);
  return positive.length ? positive : ids;
}
```

```diff
@@ src/oauth/generic-account-failover.ts:292
-  const eligible = new Set(eligibleFailoverAccounts(providerName, now, family));
+  const eligible = new Set(preferKiroModelSupport(providerName,
+    eligibleFailoverAccounts(providerName, now, family), requestedModelId));
@@ src/oauth/generic-account-failover.ts:468
-    const eligibleNow = eligibleFailoverAccounts(providerName, now, family);
+    const eligibleNow = preferKiroModelSupport(providerName,
+      eligibleFailoverAccounts(providerName, now, family), requestedModelId);
```

`MODIFY src/server/responses/request-transport.ts` on top of 040's `filterInitialKiroRankCandidates` hook (rebase-verify at this layer's P). 040 passes only the final quota/reauth/cooldown-eligible roster to that hook, before its least-loaded sort or resolved-first ordering. Replace the identity body with Kiro model preference; `canMove` retains the explicit global/provider off and singleton guards. Keep IDs outside the preferred first sweep as a lower-priority capacity fallback. Both cohorts use 040's lease, stale-selection, and cancellation guards:

```diff
@@ 040 local hook in request-transport.ts (before admitInitialKiroWithLease)
-  const filterInitialKiroRankCandidates = (ids: string[], _modelId: string): string[] => ids;
+  const filterInitialKiroRankCandidates = (ids: string[], modelId: string): string[] =>
+    preferKiroModelSupport("kiro", ids, modelId);
@@ inside admitInitialKiroWithLease, after 040 eligibility and canMove
   const order = canMove
     ? filterInitialKiroRankCandidates(eligible, route.modelId)
     : [activeId];
+  const fallbackOrder = canMove ? eligible.filter(id => !order.includes(id)) : [];
   const ordered = kiroLeastLoaded && canMove
     ? order.slice().sort((a, b) => accountInFlight("kiro", a) - accountInFlight("kiro", b))
@@
-  const sweep = async (): Promise<KiroLoadResult> => {
+  const sweep = async (candidateIds: readonly string[] = ordered): Promise<KiroLoadResult> => {
     let full = false;
-    for (const id of ordered) {
+    for (const id of candidateIds) {
@@ after first sweep, before the shared bounded wait
   const first = await sweep();
+  if (first.kind === "capacity" && fallbackOrder.length) {
+    const fallbackRanked = kiroLeastLoaded
+      ? fallbackOrder.slice().sort((a, b) => accountInFlight("kiro", a) - accountInFlight("kiro", b))
+      : fallbackOrder;
+    const fallback = await sweep(fallbackRanked);
+    if (fallback.kind !== "capacity") return fallback;
+  }
   if (first.kind !== "capacity" || kiroCap === undefined) return first;
```

`fallbackOrder` is empty with absent/all-false membership, no eligible sibling, or explicit off, preserving 040 ordering. If the preferred cohort is full, a fallback is tried before 040's one shared bounded wait. A stale fallback retains 040's selection-conflict handling. Rebase-verify the hook and sweep signatures at this layer's P because 040 is still being amended in parallel.

In 040's final `admitInitialKiroWithLease` ranking seam, apply model preference *after* quota/reauth/cooldown eligibility and *before* load ranking or resolved-account-first ordering; keep the existing stable tie-break. The earlier `preferredInitialAccount` result alone is insufficient: 040 rebuilds and sorts the eligible roster after that result, so a less-loaded model-negative account could otherwise take the first send. With positive membership, the first admission sweep ranks only positive IDs; if none can be admitted because of capacity, try the remaining eligible IDs as advisory fallback before the existing bounded wait/error. With `undefined` or all-false membership, keep 040's whole ranking set and ordering. The active shortcut and quota-evidence guard are bypassed only with positive alternate support and effective pool enablement. The reactive preference never promotes a known suspended, monthly-exhausted, or capacity-blocked candidate. Explicit global or Kiro `enabled: false` preserves the active first admission and prevents rotation; a singleton also stays active. If an opted-in per-account cap is full and no move is allowed, the bounded wait ends in retryable 503 `account_capacity` with `Retry-After`; if a move is allowed, another eligible account is tried first. Catalogue evidence never bypasses this capacity decision.

`MODIFY src/codex/catalog/provider-models.ts` (current hunk at 213-218). The static registry remains `liveModels: false`; do not route Kiro through generic `/models`. Insert a Kiro-specific management merge before that return. Publish static IDs plus the union of observed account IDs (stable static-first order), preserving static rows' config hints. Use `getAccountSet("kiro")?.accounts` and `Promise.allSettled(...getKiroAccountModels(id))`. A list with no good account row returns `configured` byte-for-byte. `observed(..., "authoritative")` remains the outcome because static IDs are always callable and unknown IDs are still passthrough.

```diff
@@
   if (prov.liveModels === false) {
     clearProviderDiscoveryStatus(name);
+    if (name === "kiro" && prov.adapter === "kiro") {
+      const ids = getAccountSet("kiro")?.accounts.filter(a => a.needsReauth !== true).map(a => a.id) ?? [];
+      const observedResults = await Promise.allSettled(ids.map(id => getKiroAccountModels(id)));
+      const merged = [...configured];
+      const seen = new Set(merged.map(row => row.id));
+      for (const result of observedResults) for (const item of result.status === "fulfilled" ? result.value ?? [] : []) {
+        if (seen.has(item.modelId)) continue;
+        seen.add(item.modelId);
+        merged.push({ id: item.modelId, provider: name,
+          ...catalogHintsFromProviderConfig(name, prov, item.modelId, contextCap, metadataModelIdCaseFold, captured.effectiveAlias) });
+      }
+      return observed(merged, "authoritative");
+    }
     return observed(configured, "authoritative");
   }
```

Add imports for `getAccountSet` and `getKiroAccountModels`. The final public projection below is authoritative for observed context limits, including duplicate static IDs. New IDs receive safe registry/config hints, no inferred reasoning or vision capability.

`MODIFY src/codex/catalog/routed-gather.ts` (current hunk at 366-376). Immediately after `augmentRoutedModelsWithMetadata`, project a Kiro observed input limit onto Kiro rows and clamp with the original operator config's `modelContextWindows[id]`, provider `contextWindow`, and `providerContextCap`; never mutate persisted config or the registry seed. This happens after generic `applyProviderConfigHints` has seen the static seed, so an observed 1M value is not silently reduced to the old 272k seed.

```diff
@@
-  const all = augmentRoutedModelsWithMetadata(
+  const all = augmentRoutedModelsWithMetadata(
     apiAugmented,
@@
-  )
+  ).map(model => model.provider === "kiro" && kiroObservedContextWindow(model.id) !== undefined
+    ? { ...model, contextWindow: Math.min(kiroObservedContextWindow(model.id)!,
+        config.providers.kiro?.modelContextWindows?.[model.id] ?? Infinity,
+        config.providers.kiro?.contextWindow ?? Infinity,
+        providerContextCap(config, "kiro") ?? Infinity) }
+    : model)
```

`MODIFY src/adapters/kiro/usage.ts` and `MODIFY src/server/request-log.ts` (current hunks at `:218-225` and `:1627-1634`): in each, look up `kiroObservedContextWindow(modelId)` before `KIRO_MODEL_CONTEXT_WINDOWS`. No request-body or log DTO field is added. This conservative cross-account value can understate a selected account's true limit, but cannot make an estimated usage exceed a smaller observed account window. A future account-ID thread can make this exact without changing the cache contract.

```diff
@@ src/adapters/kiro/usage.ts
-  const window = modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
+  const window = kiroObservedContextWindow(modelId)
+    ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
@@ src/server/request-log.ts
-    return modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
+    return kiroObservedContextWindow(modelId)
+      ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
```

Do not modify `src/providers/kiro-models.ts` or registry `entries-core.ts`: they remain the fallback and their `liveModels: false` prevents the wrong runtime operation. Add imports to each touched file in its existing sorted/conventional group; every imported export above exists at baseline except this layer's new module.

## PLAN-FIELD-CHAIN-01

| New field/value | Creation | Serialization | Deserialization | Consumer |
|---|---|---|---|---|
| Upstream `models[].modelId` → `KiroAccountModel.modelId` | Management JSON parser, `src/providers/kiro-model-catalog.ts` | N/A local memory only; outbound query/body contain no model ID | Bounded JSON `readQuotaJson` plus `isValidModelDiscoveryModelId` in new module | `kiroAccountSupportsModel`, static-plus-observed catalogue merge. |
| Upstream `tokenLimits.maxInputTokens` → `contextWindow` | Positive safe-integer parse in new module | Public catalogue row serialization through existing `/api/models` and `/v1/models` pipeline; no new wire key | N/A after parse; cache holds typed number | `kiroObservedContextWindow`, catalog projection, Kiro usage estimates. |
| `ProviderAccount.loginId?: string` | Random UUID on every `saveCredentialWithReceipt` login write, including append, same-identity replacement, and legacy identity-less upgrade | Auth-store account row; refresh writers replace only `.credential` | `normalizeAuthStore` validates UUID shape and preserves it; legacy row without it uses `addedAt` | `kiroEvidenceIdentity(account)` distinguishes successive logins in one slot without changing on token refresh. |
| Cache `identity`, `observedAt`, `nextRefreshAt`, `models` | `kiroEvidenceIdentity` from the current `ProviderAccount` roster row before request; successful response or failed-refresh backoff in new module | N/A process-local only; never a bearer or profile in a row | N/A process-local only | Fresh-cache read, in-flight join/replacement, response commit, last-good return, membership, and conservative window all reject mismatched identity. |
| In-flight `{ identity, promise }` | New model fetch for one account and SD1' identity | N/A process-local only | N/A process-local only | Join only a matching identity; a new login replaces the flight, and an old flight cannot return or commit old models. |
| Quota/refusal evidence supplied to selection | 010's `kiroAccountEvidence(account: ProviderAccount, now?: number)` from the caller's roster row | 010 owns persisted evidence and one-time hydration; 050 adds no serialization | 010 applies UUID/legacy identity, TTL, and reset bounds once hydrated | First preference/eligibility and reactive ranking use the same bounded evidence without `getAccountCredential`/`loadAuthStore` per candidate. |
| `KiroAccountModel` membership `true`/`false`/`undefined` | Cache lookup in `kiroAccountSupportsModel` | N/A decision-only | N/A | Generic preference helper; only `true` can bias ranking. |
| No new config enum | N/A; 040's `least-loaded` stays the configured strategy | Existing config serializer | Existing config parser | 050 uses the 040 selector without schema changes. |
| Existing pool `enabled` and independent `maxConcurrentPerAccount` | Global or Kiro account-pool config | Existing config serializer | Existing config parser | Explicit false bars first-admission move and rotation; unset/true permits eligible model preference. A configured cap can still wait and yield retryable 503 `account_capacity` with `Retry-After` when the pool cannot move. |

`maxOutputTokens`, display names, account ID, bearer, ARN, and raw response are deliberately not copied into a new persisted/public field. A catalogue window is a reported limit, not a measured runtime guarantee.

## Conditional paths and observable tests

| Guard/fallback | Activation | Observable assertion |
|---|---|---|
| No live account or no account-scoped Kiro metadata/profile | Removed/reauth account or unformable ARN | No POST; `undefined` before a good read; static models remain listed. |
| Fresh cache/in-flight join | Two reads before TTL, including overlapping reads for the same identity | One POST, same account ID and identity, same returned model set. |
| Builder ID in non-US region | Builder ID service ARN points at fixed `us-east-1`, account `apiRegion` is `eu-west-1` | POST URL host is `management.eu-west-1.kiro.dev`; query and body use the same service `profileArn`, header is that account's bearer, target is `KiroControlPlaneBearerService.ListAvailableModels`. |
| Valid response | `models` contains valid `modelId` and optional positive `tokenLimits.maxInputTokens` | Correct management host/target, bearer and profile paired; membership true/false; context reported. |
| Unknown/empty/oversized/malformed reply | Missing `models`, `[]`, invalid rows, invalid token limit, HTTP/JSON/body failure | No false empty catalogue; static first-read behavior and last good list survive; invalid limit falls back to static. |
| Credential identity change with a fresh row | Two different people log into the same identity-less account slot before five-minute TTL expires; also repeat with a legacy row lacking `loginId` | Each login writes a new UUID and has a different digest even when account ID, absent email/accountId/profile/clientId, and slot are identical. `getKiroAccountModels` does not return old models; membership is `undefined` and public context uses static fallback until new evidence. Token-only refresh retains `loginId`, digest, and fresh row. |
| Account switch/removal during POST | In-flight account is removed or re-registered with a different Builder ID identity | Old promise resolves `undefined`, cannot publish or return `old?.models`, and new request issues a second POST instead of joining it. |
| One account positively lists a model | Two eligible accounts, only one lists requested model; pool setting unset or true; model-negative account has lower in-flight load | Final `admitInitialKiroWithLease` first send uses the positive account after quota/reauth/cooldown and capacity guards; eligible refusal alternate also prefers it. Explicit global or Kiro `enabled: false` retains the active account and never rotates. |
| Capacity exclusion precedes reactive membership | Three eligible accounts: first positive alternate is full and added to `excludedAccountIds`, second positive alternate is free, and a model-negative alternate has lower load | Refusal loop skips the full ID and admits the free positive ID without a second upstream send or extra hop; if every positive is capacity-excluded, the ordinary eligible alternate remains available. |
| Positive first-admission cohort is full | One eligible model-positive account is at its configured cap and one eligible model-negative account has room | The final sweep falls through to the model-negative account before the shared bounded wait; model membership remains advisory and the cap is never bypassed. |
| Cap without a movable pool | Configured `maxConcurrentPerAccount` is full with explicit pool off or a singleton | Bounded wait precedes retryable 503 `account_capacity` and `Retry-After`; no alternate admission. With an enabled multi-account pool, try another eligible account before waiting/failing. |
| Kiro refusal and non-Kiro scope | Kiro 429/400/403 on adapter-dispatch or run-turn; non-Kiro 429 on each arm | Kiro uses `classifyKiroRefusal` and `rotateGenericOAuthAccountOnRefusal`, retaining original body until replacement admission; non-Kiro order and `genericFailovers` count match baseline. |
| No positive membership evidence | All unknown, all false, or unknown requested model ID | Existing 040 least-loaded/quota/ring choice is unchanged; outbound model slug follows existing normalization path, without a new rejection. |
| Different observed limits | Two live accounts list same model with different positive limits | Public/estimate window is the smaller observed limit, capped further by explicit user cap; static used with no valid observation. `auto` remains without a fixed window. |

## Tests and registry entries

Create siblings `tests/providers/kiro/kiro-model-catalog.test.ts` and `tests/providers/kiro/kiro-model-preference.test.ts`; do not append to capped `kiro-adapter.test.ts` (2050/2050) or `kiro-stream.test.ts` (2258/2258), per `tests/fixtures/file-size-baseline.json:46-47`. Mock `providerOutboundPost` before importing the module in an isolated test process; assert all request arguments. Never make a live Kiro/AWS call.

Exact proposed `test(...)` names and assertions:

1. `management ListAvailableModels pairs each bearer with its own profile and region` — two account snapshots; for the Builder ID account with fixed `us-east-1` service ARN and `apiRegion: "eu-west-1"`, assert POST URL host `management.eu-west-1.kiro.dev`, bearer from that account, identical service profile ARN in query and JSON body, and exact target header. Assert the second account's bearer/profile/host stay paired separately.
2. `the per-account catalogue joins concurrent reads and refreshes after TTL` — one POST per account in flight, then a later refresh.
3. `unrecognised or empty management replies preserve static models and the last good list` — malformed, `models: []`, failed status, and bounded-body failure.
4. `model IDs and token limits are validated without inventing capabilities` — invalid ID/limit ignored, positive safe integer published, output limit not inferred.
5. `a fresh old catalogue is absent immediately after account re-login` — prime a row inside `FRESH_MS`, replace the same account ID with a new Builder ID registration, then call `getKiroAccountModels` before TTL expiry; assert a new POST occurs, no old model is returned, and `kiroAccountSupportsModel` is `undefined` before the replacement reply. Assert the new `loginId` differs and token-only refresh keeps `loginId`, digest, and the fresh row.
6. `a removed or replaced account cannot publish an in-flight catalogue` — defer old POST, re-register the same account ID with a different identity, start a second read and assert it starts a second POST instead of joining the old flight; resolve the old response and assert its promise yields `undefined`, no old row is visible, and the new flight's response alone supplies membership. Removal also yields `undefined`.
7. `positive per-account membership biases least-loaded Kiro choice after eligibility` — supported account wins the actual first `admitInitialKiroWithLease` send even when a model-negative eligible account has fewer in-flight requests; stable tie-break retained; explicit global and per-provider `enabled: false` each preserve the active first admission and disable refusal rotation.
8. `unknown model IDs and absent membership never block dispatch` — request reaches existing Kiro transport unchanged by catalogue, all-false pool retains current choice; singleton active account still sends even with no model evidence.
9. `catalogue token limits reach model listings and conservative usage estimates` — dynamic context beats seed, smaller live account limit wins, explicit cap wins, static on no observation or stale identity.
10. `two identity-less logins in one slot invalidate catalogue evidence while refresh retains it` — write two login receipts to one legacy identity-less slot with the same account ID and absent email, accountId, profile ARN, and client ID; assert distinct UUID `loginId` values and SHA-256 identities, no old model membership after replacement, then refresh tokens and assert unchanged UUID, identity, and model row. A loaded legacy row without `loginId` uses its `addedAt` fallback.
11. `catalogue ranking reads hydrated roster evidence without per-candidate auth-store loads` — with two roster accounts, prime 010 evidence then rank a requested model twice; assert one process hydration, no `getAccountCredential`/`loadAuthStore` per candidate, and stable identity/TTL/reset filtering.
12. `an explicit pool off keeps Kiro on the active account despite positive model evidence` — test both global and per-provider false with two accounts; assert first admission stays active and 429/400/403 do not rotate. With the setting unset, assert a positive eligible alternative can be selected.
13. `a full per-account cap waits then reports account_capacity when the pool cannot move` — cap enabled with explicit off and with singleton; assert bounded wait, retryable 503 code and `Retry-After`. With an enabled multi-account pool, assert an eligible alternative is tried first.
14. `non-Kiro adapter-dispatch 429 keeps its original retry order and genericFailovers count` — run the existing non-Kiro adapter-dispatch arm with a rejected alternate; assert its original body handling, account sequence, and counter delta are unchanged by the Kiro retain-until-admission path.
15. `non-Kiro run-turn 429 keeps its original retry order and genericFailovers count` — run the existing non-Kiro run-turn arm with a rejected alternate; assert its original body handling, account sequence, and counter delta are unchanged by the Kiro refusal classifier and rotation path.
16. `capacity-excluded Kiro alternate never reenters model-preferred refusal ranking` — first model-positive alternate is full, second model-positive alternate is free, and model-negative alternate is less loaded; assert the refusal rotator retains `!excludedAccountIds?.has(id)`, admits the free positive alternate, and does not retry the full ID. Repeat with all positives excluded and assert eligible fallback remains callable.
17. `initial Kiro admission prefers a listed model over lower load and falls through on full cap` — before the first send, assert the model-positive eligible account wins over a less-loaded model-negative account; then saturate its cap and assert an eligible model-negative account admits before the bounded wait. Unknown evidence leaves 040 ordering intact.

Tests 10-11 verify 010's login/roster evidence dependency; 12, 14, and 15 verify 030's refusal boundary; 13 verifies 040's cap contract. Put each in that layer's focused regression file and rerun it with 050's two new files after the stack lands. The 050 tests above own catalogue invalidation, membership, and window projection; no duplicated login writer or retry loop is introduced here.

`tests/providers/kiro/kiro-usage-quota.test.ts`: add `Builder ID management host ignores the fixed service ARN region`, asserting `kiroManagementHost` gives `management.eu-west-1.kiro.dev` for a Builder ID context whose ARN region is `us-east-1` and `apiRegion` is `eu-west-1`. The catalogue test above asserts this same host together with bearer and profile on the actual outbound call. Neither test uses live Kiro/AWS.

Add these exact lines to the `explicit` object, alphabetically after `kiro-images.test.ts` / before `kiro-oauth.test.ts`, in **both** `scripts/test-layout/layout.json:1067-1084` and `tests/fixtures/test-layout-expected.json:888-905`:

```diff
@@ scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json
     "kiro-images.test.ts": "providers/kiro",
+    "kiro-model-catalog.test.ts": "providers/kiro",
+    "kiro-model-preference.test.ts": "providers/kiro",
     "kiro-oauth.test.ts": "providers/kiro",
```

Also run `tests/test-layout-tooling.test.ts` after adding both. Neither new filename appears in the baseline (`rg -n` check); the source files in this map are not line-capped there. The core import chain gets `bun test tests/lab/core-lab-boundary.test.ts` to prove no optional Lab import reaches `src/router.ts`, `src/server/lifecycle.ts`, or `src/server/responses/core.ts`.

## Docs and owning structure contracts

- `docs-site/src/content/docs/reference/adapters.md:309-358`: add after the Kiro usage paragraph: “The proxy reads each signed-in Kiro account's model list from the regional management service. A missing or unrecognised reply keeps the shipped model list (or the last good account list); model availability only guides which eligible account is preferred, and an unknown model ID is still sent upstream.” Add that reported input-token limits inform displayed context, with static limits as fallback.
- `docs-site/src/content/docs/reference/cli/providers-accounts.md:339-383`: say that proactive preference for a model-positive account applies when the pool switch is unset or true; explicit global or provider false keeps the active account and disables refusal rotation. A configured cap can independently wait and return retryable 503 `account_capacity` with `Retry-After`. Reactive refusal rotation uses the same eligible candidate ring and does not reject an unknown ID. Preserve manual selection and the singleton active-account send. Update translated counterpart paragraphs only where they contradict that behavior; do not leave stale “quota only” claims.
- `structure/providers-and-adapters.md:78,109` (owner for `src/oauth/`, `src/providers/` from `structure/INDEX.md:136-138`): state that Kiro management catalogue evidence is account-scoped, TTL-cached, last-good, and never credential authority; model membership is a preference after ordinary eligibility.
- `structure/catalog.md` (owner for `src/codex/` at `structure/INDEX.md:120`): state that Kiro's static roster is the degradation floor while the management operation adds observed IDs and context windows; generic `/models` discovery stays disabled.
- `structure/providers/kiro.md` (Kiro transport/usage owner noted in `structure/INDEX.md:64`): state that reported token limits are advisory and a malformed list never removes a callable static model. Update `structure/INDEX.md` only if its ownership summary needs a new clause; run `bun run structure:check`.

Sentence-level `MODIFY` hunks (English source and structure). Keep the exact prior text and insert the indicated sentences; line anchors are from `bb3f3c2d0d`:

```diff
@@ docs-site/src/content/docs/reference/adapters.md:344
 - Reports per-account usage. `AmazonCodeWhispererService.GetUsageLimits` on
@@ docs-site/src/content/docs/reference/adapters.md:350
   limit. The operation is undocumented by AWS, so treat the numbers as best-effort.
+- Reads each Kiro account's available models from the regional management service. An empty or
+  unrecognised reply keeps the shipped list or that account's last good list. Membership guides
+  eligible-account preference (proactively when the pool switch is unset or true), never
+  rejects an unknown model ID; reported input-token limits
+  inform displayed context windows, with shipped limits as fallback.
@@ docs-site/src/content/docs/reference/cli/providers-accounts.md:339
 where ordering does not apply, such as OAuth accounts and API keys. By default, with two or more eligible stored Kiro accounts, a 429 rotates automatically to
-another account and prefers the one with the most known remaining allowance; rotation is
+another eligible account and prefers one with positive model-list evidence when available, then uses
+the existing pool strategy; rotation is
@@ docs-site/src/content/docs/reference/cli/providers-accounts.md:381
 With two or more Kiro accounts logged in, a 429 rotates to another account automatically and
-prefers the one with the most remaining allowance. Accounts are added one at a time —
+uses positive model-list evidence as a preference before the ordinary pool ranking. Proactive
+preference applies when the pool switch is unset or true; explicit off keeps the active account
+and disables rotation. A singleton still sends on the active account. Unknown model IDs remain
+callable. Accounts are added one at a time —
@@ structure/providers-and-adapters.md:109
 Live model discovery is bounded and registry-driven through `src/providers/model-discovery.ts`.
+Kiro's management catalogue is a separate per-account, TTL-cached observation. It retains the
+last good list and supplies only a preference after ordinary account eligibility; the bearer
+and profile always come from one account snapshot, and the list is never credential authority.
@@ structure/catalog.md:229
 For `liveModels: false`, a static provider publishes the ordered union of `models` and
@@ structure/catalog.md:233
-forward-auth native path remains separate. Static gathering does not refresh OAuth or call
-the provider's model endpoint, and normal selection and visibility filters still apply.
+forward-auth native path remains separate. Kiro is the bounded exception: it keeps that static
+union as a degradation floor and adds account-scoped management model IDs and reported input
+limits without using runtime `/models`. Other static gathering does not refresh OAuth or call
+the provider's model endpoint; normal selection and visibility filters still apply.
@@ structure/providers/kiro.md:124
 positive value overwrites an earlier one.
+
+The account-scoped management model list is advisory: a missing or malformed response leaves
+the static/last-good list intact, and `tokenLimits.maxInputTokens` only informs a conservative
+displayed and estimated context window. Model membership never blocks an unknown request ID.
```

Localized `MODIFY` paths and literal clause substitutions in the current Kiro account paragraph (all anchored by the `rg -n` reading of these exact files). Keep every other login, manual-selection, and failover sentence; these are one-clause before/after hunks, not whole-paragraph rewrites:

| Path:line | Before clause | After clause |
|---|---|---|
| `docs-site/src/content/docs/fr/reference/cli/providers-accounts.md:169` | `en privilégiant celui dont l'allocation restante connue est la plus élevée` | `en privilégiant un compte dont la liste de modèles confirme le modèle demandé, puis selon la stratégie du pool` |
| `docs-site/src/content/docs/ja/reference/cli/providers-accounts.md:131` | `既知の残り利用枠が最も多いアカウントを優先します` | `要求モデルがアカウント別一覧に確認できるアカウントを優先し、その後はプールの選択方式に従います` |
| `docs-site/src/content/docs/ko/reference/cli/providers-accounts.md:216` | `알려진 잔여 할당량이 가장 많은 계정을 우선합니다` | `요청 모델이 계정별 목록에서 확인된 계정을 우선하고, 이후 풀 선택 전략을 따릅니다` |
| `docs-site/src/content/docs/ru/reference/cli/providers-accounts.md:158` | `предпочитая аккаунт с наибольшим известным остатком лимита` | `предпочитая аккаунт, в списке моделей которого подтверждена запрошенная модель, затем применяя стратегию пула` |
| `docs-site/src/content/docs/tr/reference/cli/providers-accounts.md:182-183` | `bilinen kalan kotası en yüksek hesabı tercih eder` | `istenen modeli hesap listesinden doğrulayan hesabı tercih eder, ardından havuz stratejisini uygular` |
| `docs-site/src/content/docs/zh-cn/reference/cli/providers-accounts.md:145` | `优先选择已知剩余额度最多的账号` | `优先选择账号模型列表已确认支持所请求模型的账号，然后按账号池策略排序` |
| `docs-site/src/content/docs/zh-tw/reference/cli/providers-accounts.md:113` | `優先選擇已知剩餘額度最多的帳號` | `優先選擇帳號模型清單已確認支援所請求模型的帳號，再依帳號池策略排序` |

Append in each language that an unknown model ID is still sent upstream; model preference applies when the pool switch is unset or true, while explicit global or provider false keeps the active account and disables rotation. A singleton still sends on the active account, subject to an opted-in concurrency cap's bounded wait and retryable 503 `account_capacity` with `Retry-After`. Re-read these literal anchors after rebasing on 040 and refresh a changed clause before editing; none of the substitutions should touch account-login instructions.

## PLAN-VERIFIER-REAL-01 (fresh baseline after dependencies installed, before 050 implementation)

| Command | Exit/result in this worktree | Reads 050 change target now? |
|---|---|---|
| `bun test tests/providers/kiro/kiro-usage-quota.test.ts` | 0; 22 pass, 0 fail | Current quota/region baseline only; the new helper and Builder ID case do not exist yet. |
| `bun test tests/providers/kiro/kiro-pool-rank.test.ts` | 0; 26 pass, 0 fail | Current ranking baseline only; 050 source is absent. |
| `bun test tests/lab/core-lab-boundary.test.ts` | 0; 25 pass, 0 fail | Current core/Lab boundary only; 050 source is absent. |
| `bun run structure:check` | 0, `structure/ SSOT checks passed` | No 050 structure edit exists yet; it reads current ownership documents. |
| `bun test tests/test-layout-tooling.test.ts` | 0; 16 pass, 0 fail | Current layout only; new test files and registry entries do not exist yet. |
| `bun test tests/server/account-pool-management-api.test.ts` | 1; 25 pass, 8 fail | Environment-only test-home guard: this worktree is inside `/Users/jun/.codex`, and eight Codex strategy cases refuse to remove a temp path beneath the real Codex home. Use hosted CI for this suite's evidence after implementation. |
| `bun run test:changed` | 0; 0 pass, 0 fail; 10 changed files, no affected tests | No 050 implementation source or tests exist yet; this is not test evidence for the layer. |
| `bun run privacy:scan` | 0, `Privacy scan passed` | The 050 document is still untracked; rerun after the layer is staged. |

`bun run typecheck` is **named but intentionally unrun now**, as requested; no claim of typecheck success. At implementation C run `bun run typecheck`, both new focused files, the changed usage-quota test, `tests/test-layout-tooling.test.ts`, `bun run test:changed`, `bun run privacy:scan`, `bun run structure:check`, the Lab boundary test, and exact-head hosted CI. The full local suite is the default review gate, with the repository's documented resource exception recorded in the PR if used. The eight local management-API failures need hosted CI evidence; do not describe this local suite as green.

## Risks, rollback, and limits

- A management schema seen in kiro-lb may differ for this account or later change. Strict parsing plus static/last-good fallback makes that a harmless loss of preference and dynamic limits; no login or request is rejected.
- A positive model list is advisory, not proof of plan entitlement or runtime availability. The ordinary refusal/failover path remains authoritative. The conservative global window may understate one selected account; per-account serving-window threading is a follow-up if required by live evidence.
- The catalogue fetch adds a bounded first-request delay and consumes management quota; join and TTL limit repeats. Measure it in the 050 PR and adjust the named TTL only from evidence.
- Diagnostics for a catalogue fetch, if emitted, use only closed-set status/code values such as `available`, `unavailable`, `invalid_response`, and `identity_changed`; never include upstream message text, bearer tokens, device codes, client secrets, request/response bodies, or profile ARNs. Cache entries store only the identity digest, parsed model fields, and timestamps.
- Rollback removes the Kiro-specific gather/selection hooks and the new cache module, leaving `KIRO_MODELS`, static windows, existing transport, and persisted credentials intact. No data migration is needed.
- Out of scope: changing the Kiro wire fingerprint, persisting catalogue rows or secrets, hard-blocking models, changing non-Kiro selectors, using `tokenLimits.maxOutputTokens`, or calling live Kiro/AWS endpoints in tests.

## Round-1 audit fold

- `r2-8 High` → Added `kiroManagementHost(ctx)` beside the usage probe's region policy (`:29-35`) and used `kiroUsageContextForAccount` plus that host in the catalogue request (`:98-121`). The non-US Builder ID test asserts host, bearer, and profile together (`:328`, `:343`, `:353`).
- `r2-9 High` → Keyed rows and flights by 010's stable evidence identity, checked every read and post-fetch commit, and made a replacement flight independent (`:52-54`, `:82-168`, `:177`). Fresh-cache re-login and in-flight replacement have distinct named regressions (`:331-332`, `:347-348`).
- `r2-1 Medium` → Replaced missing-`zod/v4` baseline claims with fresh exit codes and pass/fail counts (`:434-447`). The local management-API test-home guard failure is recorded as environment-only, with hosted CI required for that suite (`:443`, `:447`).
- Architect recheck SD1' → Catalogue identity now hashes the roster `ProviderAccount`, including per-login UUID `loginId` (legacy `addedAt` fallback), and drops non-persisted `authType`. The helper and tests fence same-slot identity-less re-login from old cached and in-flight models while retaining evidence on token refresh.
- Architect recheck SD2' → 010's quota/refusal read takes the caller's roster account and hydrates once per process, with no credential/auth-store load per candidate; 050's identity check also reads the roster row instead of loading a credential.
- Architect recheck SD3' → 050's reactive model preference is fed only by 030's Kiro classifier/rotation on every 429/400/403 arm, including run-turn. Its retained-response and `genericFailovers` semantics are Kiro-scoped, with exact non-Kiro adapter-dispatch and run-turn regression names above.
- Architect recheck SD4' → Explicit global or provider pool off wins over model preference and refusal exclusion. The independent cap waits and returns retryable 503 `account_capacity` plus `Retry-After` when movement is barred; activation rows and exact tests cover off, singleton, and movable pools.

## Round-2 audit fold

- `r2-R2-5 High` → The reactive replacement now starts from 040's `ring.filter(... && !excludedAccountIds?.has(id))` and applies `preferKiroModelSupport` only to that result (`:198-204`). Named test `capacity-excluded Kiro alternate never reenters model-preferred refusal ranking` covers a full first positive alternate, a free second positive alternate, and fallback when all positives are excluded (`:373`, `:401`). Rebase-verify at this layer's P against 040's final refusal signature.
- `r2-R2-6 High` → 050 replaces 040's final `filterInitialKiroRankCandidates` identity hook with positive-membership filtering before `admitInitialKiroWithLease` sorts or admits (`:231-258`), and keeps capacity fallback behind the preferred first sweep (`:259-284`). The original eligibility, cap, stale-selection, and cancellation guards remain in 040; absent/false evidence retains the entire eligible set. Named test `initial Kiro admission prefers a listed model over lower load and falls through on full cap` checks the first physical send and full-cap fallback (`:372`, `:374`, `:402`). Rebase-verify at this layer's P against 040's hook and sweep signatures.
