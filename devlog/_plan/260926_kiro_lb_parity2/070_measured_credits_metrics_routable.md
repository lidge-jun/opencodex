# 070 — measured Kiro credits and operator state

- Layer: 070; branch: `codex/kiro-lb2-070-credits-ops`; base: 060 in the single stacked chain, ultimately `dev` after #5937.
- Depends on: 010's cached quota/verdict hydration, 030's refusal and routing eligibility, 040's account lease selection, 050's model evidence, and 060's account listing. Recheck their landed signatures before applying these hunks. Current-state anchors below are at `bb3f3c2d0d`, not predictions of the 060 head.
- Adopted inventory rows: P8/J (measured credits on the final serving account), K (cached quota gauges), L (automatic-selection eligibility and reason on the account list). Architect decision: D070-1/2/3 in `000_plan.md`.
- Class: C3 with public management/CLI contract and metering integrity requiring C4-level negative/privacy proof. AGPL reference is facts only: `/tmp/kiro-lb/kiro/parsers.py:319-327,473-476` recognizes a JSON `usage` member without proving its Smithy header; `/tmp/kiro-lb/kiro/usage_tracking.py:55-77` accepts a positive bare number or `creditUsage`, `credit_usage`, `creditsConsumed`, `credits`. Its accumulator adds frames, but that does not prove whether our Smithy stream repeats cumulative values. This plan does not copy the reference implementation. A live capture of header and cumulative/incremental semantics remains unresolved evidence for 080.

## Current-state reading at bb3f3c2d0d

| Owning function / contract | Proof and consequence |
| --- | --- |
| `parseKiroEvent` | `src/adapters/kiro-events.ts:4-27,111-129,184-201`: known Smithy event types include `metadataEvent`; metadata parses tokenUsage, context percent and stopReason, but no `usage` credit member. Unknown event types return null before parsing at :113-115. Credit extraction therefore belongs in stream dispatch before that early return, independently of the header. |
| `parseKiroAttemptEvents`, `mergeKiroUsage`, `parseKiroStream` | `src/adapters/kiro/stream.ts:140-180,367-383,594-608,742-755,1020-1045,1137-1153`: stream dispatches decoded events; usage is authoritative tokens or an estimate; the one-shot completion fallback merges attempt usage. There is no credit accumulator. |
| `OcxUsage`, `AdapterEvent` | `src/types/request.ts:363-410,440-463`: terminal events carry optional `OcxUsage`; it has no credit member. |
| `usageForFinalLog`, `normalizeUsageValue`, `normalizeAttemptUsage`, `normalizePersistedUsageRow` | `src/usage/log.ts:542-557,565-583,613-629,1025-1033,1755-1770`: estimation and field-by-field normalization would drop an added credit field unless each path forwards and validates it. |
| `addFinalRequestLog`, `addLog` | `src/server/request-log.ts:626-670,1461-1500,1533-1578`: terminal usage reaches a final in-memory log and is copied field-by-field to `usage.jsonl`; the last physical attempt is detached at :1472-1485. `src/server/responses/request-transport.ts:565-584` stamps the resolved OAuth account label before sending, and `src/providers/label.ts:64-75` derives an opaque Kiro `o` label. No raw account id is needed in the usage row. |
| `parseKiroUsage`, `kiroAccountEvidence`, `getCachedProviderAccountQuota`, `readPersistedAccountQuotas` | At `bb3f3c2d0d`, `src/providers/kiro-usage.ts:110-143` reads precise used/limit and percent but stores only percent/reset in `ProviderQuota`; `src/providers/quota/account-cache.ts:171-175` reads last-good quota synchronously; `src/providers/account-quota-disk.ts:39-55,58-68` persists quota objects. `src/providers/quota-types.ts:44-54` lacks a Kiro used/limit pair. Layer 010 adds `kiroAccountEvidence(account: ProviderAccount, now?)` as the hydrated, identity-fenced TTL/reset read for percentage/verdict; 070 passes its roster account without reloading credentials. |
| `createRequestMetricsOwner`, `handleMetricsRoutes`, `createServeOptions` | `src/server/request-metrics.ts:191-202,239-290` renders bounded process-local request metrics; `src/server/management/metrics-routes.ts:3-19` calls its snapshot only; `src/server/index/serve-options.ts:295-299` constructs/injects the owner when enabled. No Kiro quota gauges or scrape-time fetch exist. |
| Metrics composition source-oracle test | `tests/server/management-metrics-export.test.ts:539-553` asserts the current exact `createRequestMetricsOwner()` composition string. Changing the call without changing this assertion makes an otherwise-correct layer red. This test is not listed in `tests/fixtures/file-size-baseline.json`. |
| `eligibleFailoverAccounts`, `eligibleIdsIn`, `isAccountQuotaExhausted` | `src/oauth/generic-account-failover.ts:96-104,187-202` excludes reauth/cooldown; `src/oauth/account-quota-rank.ts:126-135` interprets Kiro exhaustion with overage-aware verdict. Layer 030 must make one automatic-selection projection incorporate refusal state and 010's `kiroAccountEvidence`; active-account singleton/all-excluded fallback remains a send path. A metrics/account API copy of these predicates would drift. |
| `handleOAuthAccountRoutes` account GET | `src/server/management/oauth-account-routes.ts:342-405`: plain list is local and quota probing is opt-in; `projectAccounts` emits masked rows/health, then the quota branch decorates them. It has no `autoSelectable`/`skipReason`. |
| `fetchOAuthRows`, `statusText`, `cmdAccountList` | `src/cli/account-api.ts:16-50,340-387` maps the management DTO; `src/cli/account.ts:100-110,145-155,164-245` prints/JSON-serializes rows. It has no routing reason. |

## File change map: apply on the 060 head after stale-check

The hunks show the exact insertion/removal against bb3f3c2d0d. Where earlier layers have edited the same block, keep their logic and apply the stated semantic insertion once. Every NEW file below is a complete implementation skeleton: signatures, validation, and callers are specified. Do not add lines to capped tests or `src/providers/quota.ts`.

### P8/J: credit frame to final usage

`src/adapters/kiro-credits.ts` — NEW. Decode the payload without trusting the Smithy header; absent, malformed, non-object, or unrecognised JSON is simply no credit. This helper never logs or throws upstream data:

```ts
/** Pure parser for a decoded Smithy event payload, regardless of :event-type. */
const FIELDS = ["creditUsage", "credit_usage", "creditsConsumed", "credits"] as const;
export function parseKiroMeteredCredits(payload: Uint8Array): number | undefined {
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(payload)); } catch { return undefined; }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)
    || !Object.hasOwn(decoded, "usage")) return undefined;
  const value = (decoded as Record<string, unknown>).usage;
  let raw: unknown = value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const present = FIELDS.filter(key => Object.hasOwn(object, key));
    if (present.length !== 1) return undefined;
    raw = object[present[0]!];
  }
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}
```

`src/adapters/kiro-events.ts:111-115` — NO CHANGE to known-event handling: unknown headers still return null for ordinary events. In `src/adapters/kiro/stream.ts:594-600`, inspect every decoded `:message-type=event` payload for a credit member *before* the `if (!ev) continue` path. Thus an unexpected, nonempty `:event-type` with `{"usage":2.5}` is metered, while `parseKiroEvent` remains the authority for token metadata/content. Do not synthesize a `usageEvent` header. More than one recognised field in one object is ambiguous even if values agree, so omit that frame. A malformed credit member never breaks token metadata or the response; malformed known event payloads retain their existing protocol-error handling. The source evidence establishes the member/fields (`/tmp/kiro-lb/kiro/parsers.py:319-327,473-476`, `/tmp/kiro-lb/kiro/usage_tracking.py:55-76`), not a header or repeat semantics.

`src/types/request.ts` — MODIFY:

```diff
@@ export interface OcxUsage {
   outputTokens: number;
+  /** Kiro-only upstream-reported credit amount; absent when the wire did not prove it. */
+  meteredCredits?: number;
```

`src/adapters/kiro/stream.ts` — MODIFY:

```diff
@@ import section
+import { parseKiroMeteredCredits } from "../kiro-credits";
@@ function mergeKiroUsage(
     ...(sumOptional("reasoningOutputTokens") !== undefined ? { reasoningOutputTokens: sumOptional("reasoningOutputTokens") } : {}),
+    // Fallback attempts are one logical turn; neither credit value is added to the other.
+    ...(second.meteredCredits !== undefined ? { meteredCredits: second.meteredCredits }
+      : first.meteredCredits !== undefined ? { meteredCredits: first.meteredCredits } : {}),
@@ async function* parseKiroAttemptEvents(
  let meteredCredits: number | undefined;
  const usage = (): OcxUsage => {
@@
-    return contextTotal > 0 ? { ...base, contextTotalTokens: contextTotal } : base;
+    const withCredits = meteredCredits !== undefined ? { ...base, meteredCredits } : base;
+    return contextTotal > 0 ? { ...withCredits, contextTotalTokens: contextTotal } : withCredits;
```

In the Smithy message dispatch at `src/adapters/kiro/stream.ts:594-601`, use this hunk before parsing the ordinary event. It applies even when `parseKiroEvent` returns null for an unexpected header; a known metadata event carrying token usage still reaches its existing switch:

```diff
@@ after `if (!eventType) ...` and before `const ev = parseKiroEvent(...)`
+      const observedCredits = parseKiroMeteredCredits(msg.payload);
+      if (observedCredits !== undefined) meteredCredits = observedCredits;
       const ev = parseKiroEvent(eventType, msg.payload);
```

**Policy:** take the last valid positive observed credit value for the logical turn. Repeated values may be cumulative or incremental; never sum them or claim to know which. The one-shot completion fallback remains part of that turn, so `mergeKiroUsage` takes the second attempt's credit if present, otherwise the first's; it continues to sum tokens under its existing contract. If neither attempt has credit, omit `meteredCredits`. On generic account failover, only the terminal Kiro attempt's `OcxUsage` is attached to the final serving account; earlier refused account attempts must not donate credit to the final row. If 030 records refused-attempt spend separately, keep it on that attempt and never merge it into the final account's measured field. Ensure an incomplete/failed terminal with one valid frame still records measured spend, without claiming a completed response. No token-to-credit conversion.

`src/usage/log.ts` — MODIFY (both attempt and final-row normalizers use `normalizeUsageValue`; no top-level duplicate field):

```diff
@@ function normalizeUsageValue(usage: OcxUsage | undefined): OcxUsage | undefined {
     outputTokens: usage.outputTokens,
+    ...(typeof usage.meteredCredits === "number" && Number.isFinite(usage.meteredCredits)
+      && usage.meteredCredits > 0 ? { meteredCredits: usage.meteredCredits } : {}),
@@ function normalizeAttemptUsage(raw: unknown): OcxUsage | null {
   for (const key of [
+    "meteredCredits",
@@
   ] as const) {
     if (key in usage && !isNonNegativeFiniteNumber(usage[key])) return null;
```

For `meteredCredits`, require **positive** finite number during deserialization, never accept `0`, `NaN`, infinity, string or object. The field guard in `normalizeUsageValue` handles both writer and final-row reader: `normalizePersistedUsageRow` calls `normalizeUsageEntry` at `src/usage/log.ts:1755-1759`; the latter calls `normalizeUsageValue` at :1031. `normalizeAttemptUsage` separately rejects malformed attempt usage; add after its existing loop:

```diff
@@ function normalizeAttemptUsage(raw: unknown): OcxUsage | null {
   if ("estimated" in usage && typeof usage.estimated !== "boolean") return null;
+  if ("meteredCredits" in usage && !(typeof usage.meteredCredits === "number"
+    && Number.isFinite(usage.meteredCredits) && usage.meteredCredits > 0)) return null;
   return normalizeUsageValue(usage as unknown as OcxUsage) ?? null;
```

`src/server/request-log.ts:626-670,1533-1578` already carries `usage` as a unit, so no request-log hunk is needed. Its existing `accountLogLabel` stamp is the serving account attribution; verify it after 030 rotations. Do not forward `meteredCredits` in protocol encoder usage objects: this is operator telemetry, not an OpenAI token-usage contract.

### K: bounded cached quota gauges

`src/providers/quota-types.ts` — MODIFY:

```diff
@@ export interface ProviderQuota {
   monthlyPercent?: number;
+  /** Kiro's observed plan allowance; not a token or currency estimate. */
+  kiroCreditsUsed?: number;
+  kiroCreditsLimit?: number;
```

`src/providers/kiro-usage.ts` — MODIFY:

```diff
@@ function parseKiroUsage(body: unknown): KiroUsageSnapshot | null {
   const quota: ProviderQuota = {
     monthlyPercent: percent,
+    kiroCreditsUsed: used,
+    kiroCreditsLimit: limit,
```

Layer 010 owns the quota row's `identity` and `updatedAt` and the verdict's separate `identity` and `observedAt`. Its `kiroAccountEvidence(account: ProviderAccount, now?)` hydrates disk state once per process and applies identity, TTL, and reset bounds to both percentage and verdict on every read, using the roster account supplied by the caller. `src/oauth/types.ts` adds optional `ProviderAccount.loginId?: string`; `saveCredentialWithReceipt` (`src/oauth/store.ts:834-901`) writes a new random UUID on **every login write**, whether it appends a slot or replaces a matching/legacy identity-less slot. `normalizeAuthStore` validates UUID shape and preserves the field; refresh writers `saveAccountCredential` and `mergeAccountCredential` replace only `.credential` and leave `loginId` unchanged. `src/providers/kiro-account-state-disk.ts` exports `kiroEvidenceIdentity(account: ProviderAccount): string` = SHA-256 hex of JSON `[account.id, account.loginId ?? String(account.addedAt ?? ""), cred.accountId ?? cred.email ?? "", cred.kiro?.profileArn ?? "", cred.kiro?.clientId ?? ""]`, where `cred = account.credential`. `authType` is absent because `normalizeCredential` at `src/oauth/store.ts:539` does not store it. Legacy rows without `loginId` use `addedAt`; old identity-less evidence rows resolve to unknown. A new person logging into the same legacy slot changes the identity, while token refresh preserves it. `credentialGeneration()` at `src/oauth/store.ts:340` is token-sensitive and must not be used as this evidence fence. The extra used/limit pair is valid only as part of the same current quota row.

`src/providers/kiro-quota-metrics.ts` — NEW:

```ts
import { oauthAccountLogLabel } from "../codex/account-label";
import { getAccountSet } from "../oauth/store";
import { kiroEvidenceIdentity } from "./kiro-account-state-disk";
import { kiroAccountEvidence } from "./kiro-usage";
import { getCachedProviderAccountQuota } from "./quota/account-cache";
import { ACCOUNT_QUOTA_TTL_MS } from "./quota-wire";

export interface KiroQuotaMetricRow {
  account: string; used: number; limit: number; percent: number; secondsToReset?: number;
}
const MAX_KIRO_METRIC_ACCOUNTS = 32;
export function cachedKiroQuotaMetricRows(now = Date.now()): KiroQuotaMetricRow[] {
  const accounts = getAccountSet("kiro")?.accounts ?? [];
  const rows: KiroQuotaMetricRow[] = [];
  const labels = new Set<string>();
  for (const account of [...accounts].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_KIRO_METRIC_ACCOUNTS)) {
    // 010 hydrates once, then applies identity, TTL and reset to the routing evidence.
    const evidence = kiroAccountEvidence(account, now);
    if (evidence.quotaPercent === undefined) continue;
    const quota = getCachedProviderAccountQuota("kiro", account.id);
    if (!quota || quota.identity !== kiroEvidenceIdentity(account)
      || !Number.isFinite(quota.updatedAt) || quota.updatedAt > now
      || now - quota.updatedAt >= ACCOUNT_QUOTA_TTL_MS) continue;
    const { kiroCreditsUsed: used, kiroCreditsLimit: limit } = quota;
    const percent = evidence.quotaPercent;
    const resetAt = evidence.resetAt;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0
      || typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0
      || typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) continue;
    if (resetAt !== undefined && (!Number.isFinite(resetAt) || resetAt <= now)) continue;
    const label = oauthAccountLogLabel(account.id, "kiro");
    if (labels.has(label)) continue;
    labels.add(label);
    rows.push({ account: label, used, limit, percent,
      ...(resetAt !== undefined ? { secondsToReset: Math.max(0, (resetAt - now) / 1000) } : {}) });
  }
  return rows;
}
```

The cache/disk path at `src/providers/quota/account-cache.ts:117-124` and `src/providers/account-quota-disk.ts:58-68` serializes the extended `ProviderQuota` object with 010's evidence `identity` field; 010 must expose that field on the cached quota row so the hunk above typechecks. The projector uses `kiroAccountEvidence` for the percentage/reset gate and separately reads the *same identity-matched quota row* for precise used/limit. A future `updatedAt` is invalid even though `now - updatedAt < TTL`; a reset-passed row is unknown. No removed account or stale credential can enter this snapshot. If a 6-digit opaque label collides among the 32 displayed accounts, omit the later row and test that no duplicate Prometheus series is emitted. The maximum is a named constant and the metric collector must not scan all historical usage rows or initiate a probe.

`src/server/request-metrics.ts` — MODIFY:

```diff
@@ export function createRequestMetricsOwner(
   processStartTimeSeconds = Date.now() / 1000,
+  kiroQuotaRows?: () => readonly KiroQuotaMetricRow[],
 ): RequestMetricsOwner {
@@ snapshot(): string {
       const lines: string[] = [
@@ before process-start HELP group
+      // Iterate the validated, capped cache projection only. Four gauge families share account.
+      appendKiroQuotaGauges(lines, kiroQuotaRows?.() ?? []);
```

Add a type-only import of `KiroQuotaMetricRow` from `../providers/kiro-quota-metrics` and this complete local helper before `createRequestMetricsOwner`; it validates the second boundary, including a duplicate-label guard:

```ts
function appendKiroQuotaGauges(lines: string[], rows: readonly KiroQuotaMetricRow[]): void {
  const families = [
    ["opencodex_kiro_quota_used_credits", "Cached Kiro plan credits used.", "used"],
    ["opencodex_kiro_quota_limit_credits", "Cached Kiro plan credit limit.", "limit"],
    ["opencodex_kiro_quota_used_percent", "Cached Kiro plan percent used.", "percent"],
    ["opencodex_kiro_quota_seconds_to_reset", "Seconds until the observed Kiro reset.", "secondsToReset"],
  ] as const;
  const labels = new Set<string>();
  const valid = rows.slice(0, 32).filter(row => {
    if (!/^o[0-9a-f]{6}$/.test(row.account) || labels.has(row.account)) return false;
    if (![row.used, row.limit, row.percent].every(value => Number.isFinite(value) && value >= 0)) return false;
    if (row.limit <= 0 || row.percent > 100) return false;
    labels.add(row.account);
    return true;
  });
  for (const [name, help, key] of families) {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const row of valid) {
      const value = row[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        lines.push(`${name}{account="${row.account}"} ${value}`);
    }
  }
}
```

No account id, email, model or upstream text enters labels. Empty cache emits HELP/TYPE but no samples.

`src/server/index/serve-options.ts` — MODIFY:

```diff
@@
 import { createRequestMetricsOwner } from "../request-metrics";
+import { cachedKiroQuotaMetricRows } from "../../providers/kiro-quota-metrics";
@@
-  const requestMetrics = metricsExportEnabled(config) ? createRequestMetricsOwner() : undefined;
+  const requestMetrics = metricsExportEnabled(config)
+    ? createRequestMetricsOwner(Date.now() / 1000, cachedKiroQuotaMetricRows) : undefined;
```

Keep `src/server/management/metrics-routes.ts:3-19` unchanged: it invokes the owner's synchronous snapshot. This callback reads only the existing cache; `GET /api/metrics` never calls Kiro/AWS. Update the source-oracle assertion below for the changed composition.

`tests/server/management-metrics-export.test.ts` — MODIFY the source-oracle assertion (the file has 1304 lines and no entry in the ratchet baseline):

```diff
@@ test("the metrics modules contain no timer, listener, network, or module-global owner", () => {
-    expect(composition).toContain(
-      "metricsExportEnabled(config) ? createRequestMetricsOwner() : undefined",
-    );
+    expect(composition).toContain("metricsExportEnabled(config)");
+    expect(composition).toContain("createRequestMetricsOwner(Date.now() / 1000, cachedKiroQuotaMetricRows)");
```

Keep the existing forbidden-I/O and owner-lifetime assertions at :539-553; the new gauge tests above exercise the callback itself. Because the source oracle reads the change target, rerun this test after the 070 implementation.

### L: one automatic-selection projection, management and CLI

`src/oauth/generic-account-failover.ts` — MODIFY, applied to 030's final eligibility function (return the same projection to candidate selection and presentation). Rebase-verify at this layer's P: 030 extends `AccountHealth.cooldownSource` with `"kiro-suspension"` and writes it in both `quarantineKiroSuspendedAccount` and the refusal rotator (`030_refusal_classes_and_account_failover.md:151-163,221-230`). Consume that existing closed source directly; do not add `kiroKind` or replace 030's suspension writes. This projection answers whether the account may be *automatically selected as an alternative*, not whether the active account can send:

```diff
@@ function eligibleIdsIn (after 030's Kiro suspension and evidence filter)
  return set.accounts
-    .filter(account => account.needsReauth !== true
-      && !isCooled(providerName, account.id, now, family)
-      && (providerName !== "kiro" || (!isCooled("kiro", account.id, now)
-        && kiroAccountEvidence(account, now).exhausted !== true)))
+    .filter(account => providerName === "kiro"
+      ? projectKiroAccountAutoSelection(account, now).autoSelectable
+      : account.needsReauth !== true && !isCooled(providerName, account.id, now, family))
     .map(account => account.id);
```

Add this complete export beside `eligibleIdsIn`; both the routing filter above and the API call it. The `isCooled` call prunes expired entries before `cooldownSource` is read:

```ts
export type KiroSkipReason = "needs_reauth" | "cooldown" | "quota_exhausted" | "suspended";
export function projectKiroAccountAutoSelection(
  account: ProviderAccount, now = Date.now(),
): { autoSelectable: boolean; skipReason?: KiroSkipReason } {
  if (account.needsReauth === true) return { autoSelectable: false, skipReason: "needs_reauth" };
  const cooled = isCooled("kiro", account.id, now);
  if (cooled && health.get(healthKey("kiro", account.id))?.cooldownSource === "kiro-suspension")
    return { autoSelectable: false, skipReason: "suspended" };
  if (kiroAccountEvidence(account, now).exhausted === true)
    return { autoSelectable: false, skipReason: "quota_exhausted" };
  if (cooled) return { autoSelectable: false, skipReason: "cooldown" };
  return { autoSelectable: true };
}
```

Add a type-only `ProviderAccount` import from `./types` and `kiroAccountEvidence` from `../providers/kiro-usage`; never read Kiro quota through `isAccountQuotaExhausted` or a raw cache in this projection. Pass each existing roster account from `eligibleIdsIn` and management `projectAccounts`, with no `getAccountCredential`/`loadAuthStore` per projection call. Unknown evidence yields `{ autoSelectable: true }`; overage-enabled at 100% remains auto-selectable. This is candidate eligibility at observation time, not a promise that a later lease/send succeeds. 040's transient lease cap is outside the projection and has no `skipReason`; 050's model membership is a preference, not a skip reason. Proactive least-loaded ranking and preferred initial-account selection run only under effective pool enablement. 030 refusal-aware first-admission exclusion of a *known* suspended/monthly-exhausted active account runs when `oauthAccountFailover.enabled` is unset (presence-is-consent default) or true. An explicit global or per-provider `false` forbids both an account move at first admission and refusal rotation (`src/server/responses/adapter-dispatch.ts:852`); it wins over a known exclusion. When movement is permitted, initial selection tries another eligible account; a singleton or all-excluded pool still sends to the active account, even if its row says `autoSelectable:false`. The configured `maxConcurrentPerAccount` cap is independently opt-in: at a full cap, try another eligible account when movement is permitted; if movement is disabled or this is a singleton, wait only the bounded interval and then return retryable HTTP 503, code `account_capacity`, with `Retry-After`. 030's `rotateGenericOAuthAccountOnRefusal` owns the sole bounded retry loop; 040's capacity exclusion feeds that loop. Keep the original refusal `Response` intact until a replacement is admitted; if none is admitted, return its original status/body to the client. For Kiro 429/400/403, including the run-turn 429 arm at `src/server/responses/run-turn-execution.ts:371` reached through `_kiroAuthContext` at :61, classify with `classifyKiroRefusal` and use this same rotation function. Kiro-only retain-until-admission ordering and `genericFailovers` accounting must not change non-Kiro order/counts; test adapter-dispatch and run-turn 429 arms for non-Kiro. No second rotation loop is introduced here.

`src/server/management/oauth-account-routes.ts` — MODIFY:

```diff
@@ if (url.pathname === "/api/oauth/accounts" && req.method === "GET") {
     const quotaProvider = config.providers[provider];
+    const { projectKiroAccountAutoSelection } = await import("../../oauth/generic-account-failover");
@@
-          return { ...summary, ...oauthAccountHealthFields(provider, summary.id, health), quotaMode };
+          return { ...summary, ...oauthAccountHealthFields(provider, summary.id, health), quotaMode,
+            ...(provider === "kiro" && full ? projectKiroAccountAutoSelection(full) : {}) };
```

Pass the `ProviderAccount` roster object (`full`) to the projection, not the masked `summary`; if it is absent, omit the Kiro fields rather than fabricating identity evidence. Both the cheap list and `?quota=1` use `projectAccounts`; do not probe merely to compute automatic-selection eligibility. The quota branch's post-probe projection at `src/server/management/oauth-account-routes.ts:383-405` picks up any new refusal/reauth state. Maintain the existing mask and no-token response.

`src/cli/account-api.ts` — MODIFY:

```diff
@@ export interface AccountRow {
   needsReauth?: boolean;
+  autoSelectable?: boolean;
+  skipReason?: "needs_reauth" | "cooldown" | "quota_exhausted" | "suspended";
@@ interface OAuthAccountDto {
   needsReauth?: boolean;
+  autoSelectable?: boolean;
+  skipReason?: AccountRow["skipReason"];
@@ async function fetchOAuthRows(
     needsReauth: a.needsReauth,
+    ...(name === "kiro" && typeof a.autoSelectable === "boolean" ? { autoSelectable: a.autoSelectable } : {}),
+    ...(name === "kiro" && a.autoSelectable === false && isKiroSkipReason(a.skipReason)
+      ? { skipReason: a.skipReason } : {}),
```

Define `isKiroSkipReason(value: unknown): value is NonNullable<AccountRow["skipReason"]>` beside `OAuthAccountDto`, using the four literal values. Older servers omit the field, so CLI leaves it absent rather than guessing. Unknown server reason is omitted while a valid `autoSelectable:false` still prints a generic skip.

```ts
function isKiroSkipReason(value: unknown): value is NonNullable<AccountRow["skipReason"]> {
  return value === "needs_reauth" || value === "cooldown"
    || value === "quota_exhausted" || value === "suspended";
}
```

`src/cli/account.ts` — MODIFY:

```diff
@@ function statusText(row: AccountRow): string {
-  if (row.needsReauth) parts.push("needs-reauth");
+  if (row.needsReauth && !(row.provider === "kiro" && row.skipReason === "needs_reauth")) parts.push("needs-reauth");
+  if (row.provider === "kiro" && row.autoSelectable === false)
+    parts.push(row.skipReason ? `skipped(${row.skipReason})` : "skipped");
```

JSON output already serializes `AccountRow` at `src/cli/account.ts:245`; no separate JSON serializer. The conditional avoids double `needs-reauth` status text while preserving both fields in JSON. `skipped(reason)` describes automatic-selection exclusion; the active singleton/all-excluded fallback may still send.

## PLAN-FIELD-CHAIN-01

| Field / enum | Creation | Serialization | Deserialization | Consumer |
| --- | --- | --- | --- | --- |
| `meteredCredits?: number` | `src/adapters/kiro-credits.ts` parses the JSON `usage` member independent of header; `src/adapters/kiro/stream.ts` keeps the last positive value per logical turn | `src/usage/log.ts:565-583,1025-1033` and `src/server/request-log.ts:626-670` preserve nested usage in JSONL | `src/usage/log.ts:613-629,1755-1770` accepts positive finite only | `src/server/request-log.ts:1533-1578` in-memory final-serving record; management log/usage readers; never protocol-token accounting |
| `kiroCreditsUsed`, `kiroCreditsLimit` | `src/providers/kiro-usage.ts:110-143` from precise upstream pair | `src/providers/account-quota-disk.ts:58-68` via identity-tagged `ProviderQuota`; account API quota DTO when requested | 010's `kiroAccountEvidence(account, now)` gates identity/TTL/reset; NEW metrics projector also validates precise values and `updatedAt <= now` | `src/providers/kiro-quota-metrics.ts` -> `src/server/request-metrics.ts` gauges |
| `KiroSkipReason` literals | 030's live Kiro eligibility facts, projected once in `src/oauth/generic-account-failover.ts` | `src/server/management/oauth-account-routes.ts:355-369` JSON; CLI JSON row | `src/cli/account-api.ts:340-387` closed-value guard | `src/cli/account.ts:100-110` status, account API client |
| `AccountHealth.cooldownSource === "kiro-suspension"` | 030's refusal rotation/quarantine in `src/oauth/generic-account-failover.ts` | N/A: process-local cooldown state deliberately expires and is not persisted | N/A: restart clears suspension | `projectKiroAccountAutoSelection` chooses `suspended` rather than generic `cooldown` |
| `autoSelectable: boolean` | Same candidate projection as `eligibleIdsIn`; 010 evidence uses supplied `ProviderAccount` | Same account-list JSON path; absent for non-Kiro | `src/cli/account-api.ts:340-387` boolean guard | CLI text/JSON and dashboard-capable account API; active singleton/all-excluded fallback is separate |
| `secondsToReset` metric value | `monthlyResetAt` minus scrape time in NEW projector, only future reset | Prometheus text in `src/server/request-metrics.ts` | N/A: exporter output is terminal; Prometheus parses it, not this repo | Operator scrape |

No new config enum or persistent verdict is introduced in 070. Earlier layers' `KiroPersistedVerdict` (with identity and independently timed `observedAt`), `least-loaded`, `maxConcurrentPerAccount`, model evidence, and device-flow state are dependencies, not recreated here. Shared names used here are `kiroEvidenceIdentity(account)`, `kiroAccountEvidence(account, now?)`, `projectKiroAccountAutoSelection`, `autoSelectable`, and `KiroSkipReason`. All Kiro routing reads switch to 010's evidence function with a roster account: `headroomOf`/`accountHeadroomPercent`/`rankAccountsByHeadroom`/`hasHeadroomEvidence` in `src/oauth/account-quota-rank.ts:86-123,144-204` stop reading `getCachedProviderAccountQuota` for Kiro; `isAccountQuotaExhausted` and `exhaustedCooldownMs` at :127-135,216-222 stop reading `getKiroAccountExhaustion`, including the current direct calls at :132,161,204,218. Thread a preloaded `ProviderAccount`/roster map from each initial-selection or rotation caller into these Kiro branches; do not call `getAccountCredential` or `loadAuthStore` per candidate. The Kiro branch uses `evidence.exhausted` when known and does not infer monthly exhaustion from percent alone (overage may allow 100%); percentage only ranks known headroom. `src/oauth/generic-account-failover.ts:487` and 030 refusal exclusion use that same Kiro evidence, as do 040 eligibility and 070's projection. Non-Kiro reads keep their existing paths. The metric projector's raw cached quota read is only for the precise used/limit pair after this evidence gate. 050's catalogue row and in-flight fetch carry the same identity and treat a mismatch as absent; its fetch reuses `kiroUsageContextForAccount` and exported `kiroManagementHost(ctx)` from `src/providers/kiro-usage.ts`, so Builder ID's service ARN never chooses the region.

## Conditional paths and test observables

| Activation | Observable assertion |
| --- | --- |
| Positive numeric `usage` member under an unexpected nonempty Smithy header | Terminal usage and persisted final serving row have exactly that `meteredCredits`; serving Kiro `o` label matches the post-failover account. No `metadataEvent` header is manufactured. |
| Known object field under any decoded event header | Each of four field spellings is accepted; a numeric string, multi-key disagreement, unknown key, absent `usage`, malformed JSON member, zero/negative/nonfinite amount emits no credit and does not break token parsing. A known `metadataEvent` carrying both `tokenUsage` and `usage` preserves both. |
| Two or more credit frames in one logical turn | Terminal has the last positive value, not a sum, for equal and unequal pairs; later malformed frames leave the last valid value intact. Semantics remain unverified without live capture. |
| One valid frame in each of two one-shot fallback sends | Merged token counts keep their existing sum, but measured credit is the second value, not the sum; if the second has none, preserve the first; if both have none, omit it. A failed generic account before a later account's answer is not credited to the latter. |
| Cached Kiro quota is fresh and has used/limit/percent/reset | Exactly four gauges with one opaque `o` label; scrape count/fetch spy remains zero; no raw id/email in text. |
| Missing, stale, future-dated after clock rollback, reset-passed, malformed, identity-mismatched, removed account, >32 accounts or label collision | Samples are omitted or capped; no infinity/NaN/duplicate series; unknown stays harmless. Relogin to the same identity-less slot invalidates earlier gauges, while a token refresh preserves them. |
| Reauth/suspended/cooldown/exhausted, versus unknown or overage | Candidate selection and API/CLI agree on `autoSelectable`/closed `skipReason`; 040 lease capacity is not falsely reported as permanent ineligibility. |
| Explicit failover off versus unset/true; singleton/all-excluded; full capacity | Explicit global/provider false keeps the active account and prevents rotation even when known excluded; unset/true may choose another account; singleton/all-excluded still sends active unless an opted-in full cap times out and returns retryable 503 `account_capacity` with `Retry-After`. |
| Kiro refusal versus non-Kiro 429 | Every Kiro 429/400/403 arm, including run-turn, classifies/rotates through the sole 030 loop and retains the original response until replacement admission; no replacement returns original status/body. Non-Kiro adapter-dispatch and run-turn 429 preserve current order and `genericFailovers` count. |
| Older/malformed account API response | CLI remains usable, reason is absent or generic; non-Kiro rows retain old shape. |

## Tests and layout registration

Add new sibling tests; do not append to `tests/providers/kiro/kiro-stream.test.ts` (2258/2258), `tests/providers/kiro/kiro-adapter.test.ts` (2050/2050), `tests/responses/openai-responses-passthrough.test.ts` (4809/4809), or `tests/cli/cli-account.test.ts` (2313/2313), as recorded in `tests/fixtures/file-size-baseline.json:37,46-50`.

| NEW test file | Exact tests to add |
| --- | --- |
| `tests/providers/kiro/kiro-metered-credits.test.ts` | `unexpected Smithy header usage member persists credits on the final serving account` (header `futureUsageFrame`, JSON `{"usage":2.5}`, final row `2.5` with final Kiro label); `all four known credit fields remain measured` (one positive field each); `unknown and malformed credit frames leave meteredCredits absent` (no member, bad shape, nonpositive/nonfinite, malformed JSON); `metadata tokenUsage and usage coexist without lost tokens`; `repeated credit frames keep the last value without summing` (equal/unequal and malformed-later cases); `one-shot fallback keeps the last measured credit across attempts` (second wins, first retained if second absent, neither omitted); `a failed account does not lend credits to the final account` (fixture stream and mocked failover, no live endpoint). |
| `tests/providers/kiro/kiro-quota-metrics.test.ts` | `fresh cached Kiro usage emits precise used limit percent and reset gauges`; `scraping does not fetch Kiro usage`; `stale removed malformed and reset-passed rows emit no samples`; `clock rollback rejects a future updatedAt` (advance sample clock backwards and assert no account gauge); `relogin identity invalidates gauges but refresh preserves them` (same legacy slot, two people, distinct UUID loginId; refresh unchanged); `opaque labels are capped at 32 and collisions do not duplicate series`. |
| `tests/oauth/kiro-auto-selection.test.ts` | `Kiro candidate and list projection agree on reauth suspension cooldown and exhaustion` (seed 030's `quarantineKiroSuspendedAccount` and refusal-rotator `cooldownSource: "kiro-suspension"`; assert both candidate and list return `suspended`, while `"retry-after"`/`"default"` return `cooldown` and an expired entry is selectable); `unknown evidence and overage remain autoSelectable`; `lease pressure does not become a permanent skip reason`; `active singleton sends despite autoSelectable false` (known exhausted/suspended, no alternative, request reaches active); `explicit false prevents initial move and rotation while unset permits move`; `other OAuth providers keep their eligibility and DTO shape`. |
| `tests/cli/cli-kiro-auto-selection.test.ts` | `Kiro account list prints closed skip reason and autoSelectable JSON field`; `older or malformed server reason degrades to generic skipped or absent`; `non-Kiro account text stays unchanged`. |

030/040 must also add focused cases before 070 is review-ready. In 030's new `tests/oauth/kiro-refusal-transport.test.ts` (register it in both layout maps), add `Kiro run-turn 429 classifies and rotates through one bounded refusal loop`, `Kiro adapter-dispatch 400 and 403 preserve original response when no replacement is admitted`, and `non-Kiro adapter-dispatch 429 preserves response ordering and genericFailovers`. In existing `tests/oauth/adapter-event-oauth-failover.test.ts`, add `non-Kiro run-turn 429 preserves response ordering and genericFailovers`. In `tests/oauth/generic-oauth-failover.test.ts`, add `Kiro explicit off forbids first-admission move and rotation` while leaving its non-Kiro reactive-rotation tests intact. In 040's new `tests/oauth/kiro-account-capacity.test.ts` (register it in both maps), add `singleton full cap waits then returns retryable account_capacity with Retry-After`. Assert Kiro `genericFailovers` increments only after replacement admission and that the original upstream `Response` is not cancelled before then. These exercise both `src/server/responses/adapter-dispatch.ts:852` and `src/server/responses/run-turn-execution.ts:61,371`; 070 does not create a second retry loop.

All 070 logs, API diagnostics and metric labels remain closed-set codes/statuses or the validated opaque account label. Never include upstream refusal message text, tokens, device codes, client secrets, or raw account identifiers in them. Add a negative assertion to `tests/providers/kiro/kiro-metered-credits.test.ts` named `credit diagnostics omit upstream text and credentials`, and to `tests/oauth/kiro-auto-selection.test.ts` named `Kiro skip reason is closed and contains no upstream message`; use sentinel values and assert they are absent from serialized diagnostics/logs.

`scripts/test-layout/layout.json` `explicit` — MODIFY, add exact alphabetically placed lines (current Kiro block at :1067-1084; CLI block at :500-506; OAuth block nearby):

```diff
@@
+    "cli-kiro-auto-selection.test.ts": "cli",
@@
+    "kiro-auto-selection.test.ts": "oauth",
@@
+    "kiro-metered-credits.test.ts": "providers/kiro",
+    "kiro-quota-metrics.test.ts": "providers/kiro",
```

`tests/fixtures/test-layout-expected.json` — MODIFY, mirror the same four `"basename.test.ts": "domain"` entries at the matching alphabetical positions (current Kiro block at :888-905 and CLI at :326-332). This fixture has one key per basename, so the selected names must remain unique. New files also need the ordinary domain imports used by their siblings.

```diff
@@ alphabetical cli block
+  "cli-kiro-auto-selection.test.ts": "cli",
@@ alphabetical kiro block
+  "kiro-auto-selection.test.ts": "oauth",
+  "kiro-metered-credits.test.ts": "providers/kiro",
+  "kiro-quota-metrics.test.ts": "providers/kiro",
```

## Public and structure documentation

`docs-site/src/content/docs/reference/management-api.md` — MODIFY: under `GET /api/oauth/accounts`, say “Kiro rows include `autoSelectable` and, when false, a closed `skipReason`; this is automatic-selection eligibility, and the active singleton/all-excluded fallback may still send. Quota remains opt-in.” At the metrics table at :317-330 add four Kiro gauge names, the 32-account cap, omission of stale/future-dated/identity-mismatched readings, opaque labels, and absence of scrape-time probes. In the no-account-identifiers sentence at :300 distinguish an opaque digest label from a raw identifier. Mirror the directly affected management API page in `ko`, `ja`, `zh-cn`, `zh-tw`, `fr`, `ru`, `tr` only where that page describes metrics/account rows; translation must not contradict English.

`docs-site/src/content/docs/reference/cli/providers-accounts.md` — MODIFY: after the Kiro quota example at :371-383, say “`ocx account list kiro` shows `skipped(reason)` when an account is excluded from automatic selection; JSON carries `autoSelectable` and a closed `skipReason`. The active singleton/all-excluded fallback may still send. Credits appear only from a positive Kiro JSON `usage` member and use the last value observed for the turn; they are never estimated from tokens.” Mirror the directly affected translated CLI page where it describes Kiro listing.

Sentence-level diff hunks for documentation MODIFY paths (apply the same meaning, in each page's language, to the seven directly affected translated `reference/management-api.md` and `reference/cli/providers-accounts.md` pages under `ko`, `ja`, `zh-cn`, `zh-tw`, `fr`, `ru`, `tr`):

```diff
--- a/docs-site/src/content/docs/reference/management-api.md
+++ b/docs-site/src/content/docs/reference/management-api.md
@@ GET /api/oauth/accounts table row
-| `GET, DELETE /api/oauth/accounts` | List masked accounts or remove one account |
+| `GET, DELETE /api/oauth/accounts` | List masked accounts or remove one account; Kiro rows include `autoSelectable` and a closed `skipReason` when excluded from automatic selection (an active singleton may still send); quota remains opt-in. |
@@ metrics table after process-start row
+| `opencodex_kiro_quota_{used_credits,limit_credits,used_percent,seconds_to_reset}` | `account` (opaque, at most 32 live Kiro accounts) | Current identity-matched cached Kiro plan readings; absent, stale or future-dated fields emit no sample; scraping never probes upstream. |
--- a/docs-site/src/content/docs/reference/cli/providers-accounts.md
+++ b/docs-site/src/content/docs/reference/cli/providers-accounts.md
@@ after Kiro quota example
+`ocx account list kiro` shows `skipped(reason)` when automatic selection excludes an account; JSON includes `autoSelectable` and a closed `skipReason`. An active singleton may still send. Credits use the last positive Kiro `usage` value observed in a turn, never token estimates.
--- a/structure/providers/kiro.md
+++ b/structure/providers/kiro.md
@@ after Kiro usage section
+`src/adapters/kiro-credits.ts` and `src/adapters/kiro/stream.ts` extract a positive JSON `usage` member independent of Smithy header and retain the last value per logical turn without summing. `src/usage/log.ts` persists that amount on the final serving account's usage row without deriving it from tokens.
--- a/structure/dashboard-and-usage.md
+++ b/structure/dashboard-and-usage.md
@@ Opt-in aggregate request metrics
+The opt-in owner renders four Kiro quota gauges from fresh identity-matched cached per-account observations, with at most 32 opaque account labels and no scrape-time network call; missing, future-dated or expired evidence emits no sample.
--- a/structure/gui-and-management-api.md
+++ b/structure/gui-and-management-api.md
@@ Request metrics / OAuth accounts table
+Kiro account-list rows carry the same current automatic-selection projection used for candidate choice, with a closed skip reason; an active singleton may still send. Cached Kiro quota gauges share the existing authenticated metrics snapshot.
--- a/structure/transports/inventory.md
+++ b/structure/transports/inventory.md
@@ OAuth account failover table
+Kiro candidate eligibility is projected once for automatic selection and account-list status; unknown evidence remains eligible, while known reauth, suspension, cooldown and exhaustion carry closed reasons. An active singleton/all-excluded fallback may still send unless an opted-in capacity cap times out.
```

`structure/providers/kiro.md` — MODIFY: add a present-tense “Metered credits” paragraph naming `src/adapters/kiro-credits.ts`, `src/adapters/kiro/stream.ts`, and `src/usage/log.ts`, and the last-value/no-sum rule. `structure/dashboard-and-usage.md:361-378` — MODIFY: add four cache-only Kiro gauges and bounded opaque labels to the request-metrics contract. `structure/gui-and-management-api.md:192` — MODIFY: account-list Kiro automatic-selection eligibility and cached gauge behavior. `structure/transports/inventory.md:44` — MODIFY: eligibility projection is shared by selection and account-list reason, and active singleton fallback remains a send path. `structure/runtime.md` and `structure/providers-and-adapters.md` are mapped by `structure/INDEX.md` to the touched `src/` areas: review their descriptions and add only the sentence-level consequence where their current contract mentions Kiro usage or generic selection. Do not edit generated `structure/INDEX.md`; `structure/AGENTS.md` and `structure/manifest.json` govern it. No new source area is introduced. Before applying, read the nearest nested `AGENTS.md` for every touched directory.

## PLAN-VERIFIER-REAL-01: baseline execution and layer gate

The baseline commands were rerun in the `bb3f3c2d0d` worktree after dependencies were installed, while amending this plan. They do **not** execute the future 070 source/test targets because those files/changes do not exist yet. No live Kiro/AWS endpoint was called by this delegated work. An earlier “zod/v4 missing” observation is superseded by these real exits.

| Command run now | Exit | Reads change target now? |
| --- | ---: | --- |
| `bun test tests/providers/kiro/kiro-usage-quota.test.ts tests/server/management-metrics-export.test.ts tests/cli/cli-account-pool-verbs.test.ts tests/lab/core-lab-boundary.test.ts` | 0; 108 pass, 0 fail | Existing Kiro quota, metrics, CLI pool, and Lab boundary code; no new credit/metric/automatic-selection target. |
| `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | 0; 18 pass, 0 fail | Existing registries, not the four new entries. |
| `bun run structure:check` | 0; `structure/ SSOT checks passed` | Existing structure docs/manifest; not future edits. |
| `bun run privacy:scan` | 0; `Privacy scan passed` | Existing tracked tree; this currently untracked doc must be rescanned when staged. |
| `bun run test:changed` | 0; 0 tests selected (`origin/dev` merge base `bb3f3c2d0d`, 10 changed files not test-connected) | No: the docs-only/untracked plan changes are outside the import graph. This exit is not feature validation. |
| `bun test tests/server/account-pool-management-api.test.ts` | 1; 25 pass, 8 fail | Environment-only: the 8 Codex account-pool strategy cases attempt to remove `tests/server/.tmp-account-pool-mgmt-codex` under this worktree's real `~/.codex` home, and `src/lib/test-home-guard.ts:232-237` refuses that removal. This is not Kiro behavior evidence; hosted CI outside the protected home must supply this suite's result. |

At implementation C, run the four new test files above, the four existing focused files above, layout guards, `bun run typecheck` (named only now because it is slow), `bun run test:changed`, `bun run privacy:scan`, `bun run structure:check`, and the docs-site build mandated by `docs-site/AGENTS.md`. These future checks have **no exit code on the 070 change yet** and cannot be claimed as passed. Run the full suite before review readiness unless the documented resource exception applies; record focused scope and leave CI to cover the rest. Exact-head hosted CI is a separate post-push gate. `bun run test:changed` cannot find source-as-data/layout and fixture edges, so explicit files above remain required.

## Risks, rollback, out of scope, and 080 handoff

- Risk: the AGPL reference recognizes JSON `usage` but does not prove the Smithy header or whether repeated frames are cumulative. The last-value-per-turn rule never adds possibly cumulative frames and never guesses credits from tokens. It can undercount an incremental stream; a live capture is required to settle semantics. Metered credits may be absent on old or unusual streams.
- Risk: a final response can have token estimates and measured credits simultaneously; keep `estimated` scoped to tokens, never infer that credits are estimated. The final attempt's existing OAuth label must be checked after 030 rotation in all inbound protocols. A 6-hex digest collision and more than 32 accounts are deliberately omitted from gauges, not merged.
- Risk: previous layers may shift the import seams and quota verdict shape. Reconcile hunks against 060's actual HEAD before code; do not silently fork candidate eligibility or duplicate persisted verdicts. Metrics snapshot must stay synchronous, cached, and free of Lab imports from core paths. The explicit-off contract and opted-in capacity 503 must retain their separate precedence.
- Rollback: remove the additive credit field/parser, four gauges/cached projection, and list fields together; older JSONL rows and old quota disk rows naturally omit the new optional members. Keep 010's persisted quota/verdict store and 030's routing behavior intact. No destructive migration.
- Out of scope: token-to-credit multipliers (inventory U1), charge estimates, a live Kiro/AWS probe, changes to pricing, UI redesign, more endpoint dialects, or changing client wire usage. No AGPL code or structure is copied.
- `080_head_to_head_result.md` must compare **all** adopted rows S1b/B/P7, E5/E2/H/E6/E7, P4/I/P5/E3/A5/P9, P3/P1/P2, C1/N/C2/C3, A1/A2/A9, P8/J/K/L against landed `dev`; record exact merged SHAs, focused/full validation and CI limits, observed versus source-inferred behavior, and the rejected rows A3/A4/A6/A8, P6/P10, E1/E4/E8/E9, W1/W2, S2, U1, M parity. It must explicitly report whether Kiro credit frame shape, real provider egress, two-machine/live login, and per-account metrics labels were verified live or remain offline assumptions, and explain any unresolved parity gap without claiming a feature from this plan alone.

## Round-1 audit fold

- **r3-3 High** → JSON `usage` extraction now precedes the known-header filter and accepts an unexpected header; repeat frames keep the last value per logical turn, and one-shot fallback never sums credits (`070:30-52,63-91`). Exact positive, negative, coexistence, repeat and fallback tests are at `070:377-380,394`; live header/repeat semantics stay unresolved (`070:6,483`).
- **r3-4 High** → `autoSelectable` with closed `skipReason` replaces `routable` through candidate projection, API, CLI, field chain and documentation (`070:261-358,364-368,428-464`). Active-singleton and explicit-off/cap tests are at `070:383-385,396,399`.
- **r3-6 Medium** → gauge projection rejects `updatedAt > now`, after identity/TTL/reset gate through `kiroAccountEvidence(account, now)`; clock rollback test names the missing sample (`070:142-187,382,395`).
- **SD1′/SD2′** → `ProviderAccount.loginId` UUID on every login, legacy `addedAt` fallback, refresh stability, exact account-based identity hash, distinct quota/verdict times and one-time hydration are fixed at `070:142-187`; routing read sites and 050 identity fence at `070:371`.
- **SD3′/SD4′** → Kiro 429/400/403 in adapter-dispatch and run-turn share 030's sole refusal loop and retain the original response until replacement admission; non-Kiro order/counts are protected, explicit false prevents all movement, and opted-in capacity returns bounded retryable 503 when it cannot move (`070:305,384-385,399`).
- **SD5/SD6/SD7/SD8** → `autoSelectable` singleton-send proof (`070:396`); 050 context/management-host reuse (`070:371`); closed diagnostics and negative tests (`070:401`); installed-dependency verifier exits and the guarded `account-pool-management-api` environment failure (`070:466-479`).

## Round-2 audit fold

- **r3-R2-2 Medium** → Rebased the 070 eligibility hunk on 030's `eligibleIdsIn` filter and existing `cooldownSource: "kiro-suspension"` writes; `projectKiroAccountAutoSelection` maps active suspension to `skipReason: "suspended"` and ordinary rate/default cooldown to `"cooldown"` (`070:263-294,358`). The named candidate/list agreement test covers quarantine, refusal rotation, ordinary cooldown and expiry (`070:387`). Rebase-verify at this layer's P against the implemented 030 head.
