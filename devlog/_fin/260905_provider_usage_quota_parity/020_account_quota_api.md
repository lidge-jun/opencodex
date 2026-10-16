# 020 — Account quota API prerequisite for 030 UI

Status: proposed, awaiting parent audit; no production implementation or tests executed.
Work class: **C4**, because credential selection and management DTOs cross a security boundary.
Owner: parent runs one audited implementation cycle per layer; this document does not activate
or modify orchestration, goal, or loop state. This is a public feature contract derived from
existing source, not a vulnerability assessment or an advisory. Any new unreleased security
finding belongs in ignored scratch space, not this unit.

## 1. Required outcome and exclusions

All already-supported quota APIs are required, not optional follow-up work:

- Preserve Anthropic, Kiro, Antigravity per-account quota reads.
- Add explicit-account xAI, Cursor, Kimi, and Command Code quota reads using their existing APIs.
- Preserve Meta Muse's separate passive observation path, including account identity and age.
- Enrich API-key rows through the existing provider quota dispatch on isolated per-key config.
- Emit `quotaMode` on every OAuth/key row, including the cheap list, and settle explicit refresh
  only when enrichment finishes. Initial account controls must not wait for upstream requests.
- Keep provider/current-account reports distinct from a list of all credentials. Do not sum
  API-key quotas: different keys may share the same upstream balance or subscription.

No new provider, upstream endpoint, management pathname, dependency, auth/login flow, inference,
active-account switch, key activation, config persistence, or quota-routing strategy is added.
Ordinary account-scoped OAuth renewal may persist a rotated credential through the existing
OAuth owner; that is not permission to change `activeAccountId` or rewrite provider config.

The user's later contract request is authoritative: row-level mode is preferred; no top-level
mode is needed. `020_account_quota_api.md` precedes the parent's 030 UI plan. The older filenames
in `000_plan.md` need a parent-owned roadmap update; this bounded task changes only this file.

## 2. Grounded baseline and reuse decisions

Anchors refer to source inspected on 2026-09-05; refresh line numbers before implementation.

| Owner | Existing behavior / anchor | Reuse or precise delta |
| --- | --- | --- |
| `src/providers/quota.ts:2392` `maybeFetchProviderQuota` | Auth/name/destination dispatch; disabled providers return null | Preserve branch precedence; extract key-reader selection once for both capability and dispatch |
| `src/providers/quota.ts:2477` `fetchProviderQuotaReports` | Provider-wide cache and routing-cache publication | Never invoke this aggregator once per API key |
| `src/providers/quota.ts:1512` `supportsPerAccountQuota` | Anthropic, Kiro, Antigravity only | Add four dedicated readers before enabling their allowlist entries |
| `src/providers/quota.ts:1553` `hasPassiveAccountQuota` | Meta Muse only | Keep independent; never insert Muse into probe capability |
| `src/providers/quota.ts:1690` `getTokenForAccountQuotaProbe` | Stored token or account-scoped renewal; background local-CLI guard | Retain guard; build paired token/metadata context above it |
| `src/oauth/index.ts:569,582` | Account-scoped token/full-snapshot resolvers | Reuse, do not change OAuth renewal implementation |
| `src/providers/quota.ts:1701,1786` | Account TTL, in-flight joins, last-good, `Promise.all` roster | Add explicit dispatch, bounded workers and force-aware settlement |
| `src/server/management/oauth-account-routes.ts:254` | Cheap OAuth projection, opt-in quota and refresh | Add mode to cheap projection, then join enrichment by account id |
| `src/server/management/oauth-account-routes.ts:571` | Masked API-key list | Same pathname gains opt-in quota enrichment |
| `src/providers/api-keys.ts:66` `listProviderApiKeys` | Calls mutating `ensurePool`, even for a legacy GET | Make list projection pure; preserve virtual legacy row and mutation paths |
| `gui/src/hooks/useProviderAccountPools.ts:76,125` | Cheap OAuth list plus detached enrichment; key list only | 030 consumes mode, adds key enrichment and await-on-explicit-refresh |
| `gui/src/pages/Providers.tsx:225` | Refresh fires OAuth list for any provider and settles on provider report | 030 separates account enrichment outcome from provider-report outcome |
| `gui/src/components/provider-workspace/types.ts:43,58` | OAuth quota fields; key rows lack them | 030 mirrors additive common fields on both row types |
| `structure/05_gui-and-management-api.md:13,125-137` | Management admission, masked lists, active-key routing, unknown quota | Preserve admission; update contract documentation after implementation |

No-code options: doing nothing leaves missing required readers; deletion hides useful readings;
configuration cannot change account binding; reuse is selected for readers, token resolution,
normalizers, key resolution, report display and existing routes. A parallel HTTP client is not
justified. A per-roster worker mapper and isolated key-cache module are justified by scope:
`src/oauth/token-guardian.ts:115` has a private per-call worker loop, not a reusable global quota
limiter. Do not import token-guardian lifecycle into the quota path.

## 3. C4 feature security model and must-pass controls

This section specifies controls for the new feature, not claims that existing production code
has a newly discovered defect. No exploit steps, live account data, or severity assessment here.

| Dimension | Feature contract |
| --- | --- |
| Assets | OAuth/key secrets, paired project/user metadata, active selection, config, cached quota attribution |
| Entrypoints | Existing authenticated GET account/key routes and provider-report reads; local secret resolution; upstream quota payloads |
| Boundaries | Browser to management API; management to credential store; resolved credential to fixed provider destination; untrusted quota JSON to safe DTO/cache |
| Adversarial inputs | Unauthenticated calls, edited provider destinations, malformed quota payloads, redirect responses, duplicate refresh calls, concurrent credential/config changes |
| Assumptions | Existing management admission remains authoritative; same-OS-user malicious processes are not isolated by this feature (`structure/02_config-and-codex-home.md:64`) |
| Controls | Exact provider reader allowlist, canonical destinations, explicit account context, identity/epoch fences, bounded work, explicit safe serialization |

Before implementation, parent audits these must-pass checks:

1. Unauthorized/data-plane-only callers cause zero credential resolution or upstream quota calls.
2. A quota read never calls `setActiveAccount`, key activation, `saveConfig*`, login, or inference.
3. Only a reader matched by capability dispatch receives a token. Generic unsupported dispatch
   returns before resolving any credential; fallback is never another provider's reader.
4. Token and user/project metadata come from the same requested account and credential revision.
   Never reread `getCredential(provider)` after an await to discover current metadata.
5. Keep existing canonical origins/paths. New fanout must not follow redirects or accept a client
   supplied upstream URL; apply redirect rejection to the extracted readers without new hosts.
6. Serialize allowlisted quota numbers/windows, mode and safe flags only. No token, refresh token,
   token generation, secret digest, organization/user/project id, raw upstream error or headers in
   added DTO fields, logs, snapshots, screenshots, or fixtures committed with real credentials.
7. Non-finite/malformed quota, failed refresh, missing metadata and stale identity remain unknown
   or unavailable, never fabricated zero. A genuine zero is still a valid measured value.
8. Bound work across simultaneous account/key requests; preserve per-request JSON size/time bounds.
9. Renewals retain existing locks and generation rules; do not force OAuth renewal merely because
   the operator requested a fresh quota reading.

Security review remains pending until code, negative regressions and the parent's permitted
verification gates exist. Reading security guidance is not evidence that a patch is secure.

## 4. Additive row DTO contract (locked with UI owner)

Canonical source: `src/providers/quota-types.ts` (currently `ProviderQuota`, line 26).

```diff
 export interface ProviderQuota { /* existing shape unchanged */ }
+export type AccountQuotaMode = "probe" | "passive" | "unsupported";
+export interface AccountQuotaFields {
+  quotaMode?: AccountQuotaMode;
+  quota?: ProviderQuota | null;
+  quotaUnavailable?: boolean;
+}
```

Optional in the TypeScript/wire contract for older-server compatibility; the new server **always
emits `quotaMode`** on every cheap and enriched OAuth/key row. Omission by an older server means
unknown capability, not permission for a client to guess/probe. Existing `id`, alias/email masking,
`masked`, `active`, health fields, `activeAccountId` and key `activeId` retain their exact meaning.

| Response case | Fields added to a row |
| --- | --- |
| Cheap list, any mode | `quotaMode` only; omit `quota` and `quotaUnavailable` |
| Probe enrichment succeeded | `quotaMode: "probe"`, `quota`, `quotaUnavailable: false` |
| Probe returned authoritative empty | `quotaMode: "probe"`, `quota: null`, `quotaUnavailable: false` |
| Probe failed / not admitted / identity changed | `quotaMode: "probe"`, bounded last-good quota or null, `quotaUnavailable: true` |
| Passive with observation | `quotaMode: "passive"`, `quota` with original `updatedAt`; omit failure flag |
| Passive without observation | `quotaMode: "passive"`; omit both enrichment fields |
| Unsupported, even with quota/refresh query | `quotaMode: "unsupported"`; omit both enrichment fields; no probe |

Only an existing authoritative-empty sentinel proves empty. An arbitrary null, absent data or
malformed body is a failed/unknown probe, not an authoritative empty. Preserve existing terminal
failure behavior: drop last-good for that target and return null/unavailable. Never lose these
distinctions when converting `ProviderQuotaProbeResult` to a row.

Full shape propagation:

```text
quota-types.ts AccountQuotaMode + AccountQuotaFields + unchanged ProviderQuota
  -> quota.ts ProviderAccountQuota (internal accountId, quota, unavailable; add mode)
  -> oauth-account-routes.ts projectAccounts() / masked key projection
     unavailable -> quotaUnavailable, accountId/keyId -> existing row id join
  -> JSON {activeAccountId, accounts:[...]} / {activeId, keys:[...]}
  -> 030 useProviderAccountPools.ts OAuthAccount / ApiKeyEntry
  -> Providers.tsx accountSets / keyPools -> ProviderDetails -> ProviderAuthPanel
  -> 030 shared quota display, credits/details and explicit loading state

provider report path stays separate:
fetchProviderQuotaReports -> ProviderQuotaReport.quota + observed + aggregation
  -> ProviderWorkspaceShell -> freshQuotaReport* -> ProviderCapacityQuota
```

Backend `ProviderApiKeyInfo` can extend `AccountQuotaFields` via a type-only import; the list
owner does not import the runtime quota aggregator. The route decorates it with computed mode.
030 mirrors the shape using existing `AccountQuota`, which already admits the ProviderQuota
windows/credits shape; avoid a runtime GUI import of the server quota module.

## 5. Capability selection and fail-closed dispatch

### 5.1 OAuth modes

`supportsPerAccountQuota(provider)` keeps its exported signature. Final probe set:
`anthropic`, `kiro`, `google-antigravity`, `xai`, `cursor`, `kimi`, `command-code`.
`hasPassiveAccountQuota(provider)` stays exactly `meta-muse`. Every other OAuth id is unsupported
for this API even if it supports login or inference. Canonical `openai` retains its separate Codex
account API and must not enter this generic fanout.

Add `providerOAuthAccountQuotaMode(provider: string): AccountQuotaMode` near these predicates:

```ts
if (hasPassiveAccountQuota(provider)) return "passive";
return supportsPerAccountQuota(provider) ? "probe" : "unsupported";
```

Capability means an implemented reader, not a guarantee that this account is authenticated or
has a measurement. Credential errors therefore return probe/unavailable, not unsupported.
Configured destination rejection is a no-send precondition, not a fallback opportunity.

```diff
-const wantQuota = queryQuota && supportsPerAccountQuota(provider);
-if (!wantQuota && !passiveQuota) return jsonResponse(projectAccounts());
+const quotaMode = providerOAuthAccountQuotaMode(provider);
+// projectAccounts always copies quotaMode onto each safe summary row.
+if (!queryQuota || quotaMode === "unsupported") return jsonResponse(projectAccounts());
+const rows = quotaMode === "passive"
+  ? readPassiveProviderAccountQuotas(provider)
+  : await fetchProviderAccountQuotas(provider, forceRefresh, config.providers[provider]);
```

### 5.2 API-key modes: one selector, not a second allowlist

Extract the existing key branches in `maybeFetchProviderQuota` into
`keyQuotaReaderForProvider(name: string, provider: OcxProviderConfig): KeyQuotaReader | null`.
`KeyQuotaReader = (name: string, provider: OcxProviderConfig) => Promise<ProviderQuotaProbeResult>`.
This pure selector checks existing name/auth/adapter rules **and each existing canonical URL
predicate**, but does not resolve a secret. It returns the existing fetcher (or the Kimi/Command
Code explicit-key adapter below), not a new implementation. `providerApiKeyQuotaMode(name,
provider)` returns probe iff the selector returns a reader; else unsupported. Never passive.

Preserve precedence and aliases from `quota.ts:2415-2469`:

| Existing gate | Reader retained |
| --- | --- |
| Explicit key + canonical Kimi Code base (any configured name) | `fetchKimiQuota` |
| `commandcode` + canonical Command Code base | `fetchCommandCodeQuota` |
| `registryEntryForProviderDestination(provider)?.id === "opencode-go"` | `fetchOpenCodeGoQuota` |
| Canonical A6API base (any configured name) | `fetchA6apiQuota` |
| `openrouter`, `deepseek`, `cline-pass` + corresponding canonical base | Their existing readers |
| `zai`, `glm`, `glm-cn`, `zhipu-bigmodel-coding` + canonical ZAI base | `fetchZaiQuota` |
| `minimax`, `minimax-cn` + canonical MiniMax base | `fetchMinimaxQuota` |
| `moonshot`, `venice`, `synthetic`, `deepinfra`, `neuralwatt` + respective canonical base | Their existing readers |

Default/missing auth stays key where the existing branches allow it; preserve Kimi's stricter
explicit-key gate. Reject disabled, OAuth, forward and local modes. Missing/unresolved key on an
otherwise supported destination is probe/unavailable; the predicate must not access keychain or
environment just to label a cheap row. Do not broaden name-based readers to arbitrary aliases
in this change. Do not infer quota capability from model catalog or pricing metadata.

## 6. OAuth reader signature changes and account context

### 6.1 One immutable account context

Keep `getTokenForAccountQuotaProbe(provider, accountId): Promise<string>` for its existing guarded
renewal behavior. Add private `resolveAccountQuotaContext(provider, accountId)` in `quota.ts`:

```ts
type AccountQuotaContext = Readonly<{
  provider: string;
  accountId: string;             // opaque local store handle
  accessToken: string;
  upstreamAccountId?: string;    // xAI metadata only; never DTO
  projectId?: string;            // Antigravity metadata only; never DTO
}>;
```

After the guarded token resolution, read `getAccountCredential(provider, accountId)` exactly
for that id, require `stored.access === accessToken`, and copy token + metadata synchronously
with no intervening await. Otherwise return unavailable (do not borrow active metadata or retry
another account). This avoids changing global `OAuthAccessSnapshot`, whose current fields do
not contain xAI's upstream user id (`src/oauth/index.ts:79`). Capture config generation and row
operation epoch before awaiting; recheck ownership before cache commit and HTTP projection.
Kiro stays on `kiroUsageContextForAccount(accountId)`, preserving its account-scoped metadata and
special CLI renewal behavior. Antigravity gets token/project from this paired context, not two
unrelated reads. Keep the existing background local-CLI guard; do not broaden token renewal as
an incidental capability change.

### 6.2 Exact before/after signatures

All listed functions are in `src/providers/quota.ts`; existing pure parsers remain unchanged.
The four dedicated readers receive required explicit credentials: no optional-token fallback.

```diff
-fetchXaiQuota(provider: string): Promise<ProviderQuotaReport | null>
+fetchXaiQuota(provider: string, context: Pick<AccountQuotaContext, "accessToken" | "upstreamAccountId">): Promise<ProviderQuotaReport | null>
-fetchCursorQuota(provider: string): Promise<ProviderQuotaReport | null>
+fetchCursorQuota(provider: string, accessToken: string): Promise<ProviderQuotaReport | null>
-resolveKimiQuotaBearer(config: OcxProviderConfig): Promise<string | null>
+resolveKimiQuotaBearer(config: OcxProviderConfig, accountId?: string): Promise<string | null>
-fetchKimiQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaReport | null>
+fetchKimiQuota(provider: string, config: OcxProviderConfig, accessToken: string): Promise<ProviderQuotaReport | null>
-resolveCommandCodeQuotaBearer(config: OcxProviderConfig): Promise<string | null>
+resolveCommandCodeQuotaBearer(config: OcxProviderConfig, accountId?: string): Promise<string | null>
-fetchCommandCodeQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult>
+fetchCommandCodeQuota(provider: string, config: OcxProviderConfig, bearer: string): Promise<ProviderQuotaProbeResult>
-fetchAccountQuota(provider: string, accountId: string, forceRefresh: boolean): Promise<AccountQuotaCacheEntry>
+fetchAccountQuota(provider: string, accountId: string, forceRefresh: boolean, providerConfig?: OcxProviderConfig): Promise<AccountQuotaCacheEntry>
-fetchProviderAccountQuotas(provider: string, forceRefresh = false): Promise<ProviderAccountQuota[]>
+fetchProviderAccountQuotas(provider: string, forceRefresh = false, providerConfig?: OcxProviderConfig): Promise<ProviderAccountQuota[]>
```

Existing public callers with two arguments stay valid. Kimi/Command bearer resolvers now require
an explicit id for OAuth: missing id returns null, never resolves the active account internally.
Key mode still resolves only the `config.apiKey` passed in. Account fanout already has its paired
context and passes its bearer directly, without a second resolution.

For Kimi/Command account fanout, use the supplied configured provider (copied before awaits).
If a legacy internal caller supplies no providerConfig, construct an ephemeral OAuth config
from the exact built-in registry entry's adapter/baseUrl. No disk config read/write, new default
origin, or arbitrary provider-name fallback. An explicitly supplied invalid destination is never
replaced by that default. The same canonical predicate inside the reader is retained.

| Reader / source anchor | Explicit account behavior; preserve existing protocol |
| --- | --- |
| xAI `1244`; `fetchXaiWeeklyCredits` `1218` | Remove active `getValidAccessToken("xai")` and `getCredential("xai")`; userId = context.upstreamAccountId or `xaiUserIdFromAccessToken(context.accessToken)`. Weekly billing credits first, monthly legacy fallback with the same token. Preserve source tags and Grok headers. No userId means skip only weekly and retain existing monthly fallback. |
| Cursor `2088-2248` | Remove active token resolution; reuse one passed token for current-period Connect RPC, usage summary, then auth usage. Preserve header/body shapes, precedence, reset calculation, custom windows, `reverseEngineered: true` and source tags. No account-dependent active-store reads. |
| Kimi `1919-1945` | Move bearer acquisition to caller; pass paired account bearer to canonical `/coding/v1/usages`. Preserve `parseKimiQuotaPayload` and `kimi:usages`; key adapter resolves only its isolated key. |
| Command Code `2027-2084` | Move bearer acquisition to caller; same token for whoami, credits, subscriptions and usage summary. Derive orgId only from that token's whoami; propagate the resulting orgQuery unchanged through `fetchCommandCodeSpend`. Preserve periodStart filter, purchased-credit expiry rule, null/terminal semantics and `command-code:credits`. |

`fetchXaiWeeklyCredits(accessToken, userId)`, `fetchCommandCodeJson(url, bearer)` and
`fetchCommandCodeSpend(bearer, credits, orgQuery)` already accept explicit context and keep their
signatures. No global organization cache is introduced. Optional spend failure must not discard
valid rolling windows or substitute lifetime spend for period spend.

### 6.3 Dispatch and current-account reports

```diff
-if (provider === "google-antigravity") { /* ... */ }
-else { quota = await fetchAnthropicUsageQuota(token); }
+switch (provider) {
+  case "anthropic": /* explicit Anthropic token reader */ break;
+  case "kiro": /* existing account-scoped Kiro snapshot */ break;
+  case "google-antigravity": /* paired project + bearer */ break;
+  case "xai": /* fetchXaiQuota(provider, context) */ break;
+  case "cursor": /* fetchCursorQuota(provider, context.accessToken) */ break;
+  case "kimi": /* fetchKimiQuota(provider, config, context.accessToken) */ break;
+  case "command-code": /* fetchCommandCodeQuota(provider, config, context.accessToken) */ break;
+  default: return unsupportedWithoutResolvingCredentials();
+}
```

The snippet denotes control flow, not invented production function names. Put the unsupported
guard before context resolution; the default branch independently fails closed. Convert report
results to quota entries without conflating sentinels. Optional internal source/reverseEngineered
fields may be retained where current-report reconstruction needs them; do not leak metadata.

Update the four corresponding `maybeFetchProviderQuota` OAuth branches: capture the active id
once at entry, resolve that account context, then call the explicit reader. After awaits, verify
that the same account still owns current selection before publishing a current-account report.
Do not discard a valid all-account row solely because active selection changed: its identity is
the requested account, not the global active cursor. Preserve existing Anthropic/Kiro cache
seeding and Codex report logic; do not create another current-account lookup in the reader.

Account field chain:

```text
requested provider + stored account.id
 -> getTokenForAccountQuotaProbe (existing guarded account renewal)
 -> same-id credential read + access equality -> copied AccountQuotaContext
 -> explicit provider switch -> existing canonical reader/parser
 -> typed probe result -> identity/operation fence -> account cache entry
 -> ProviderAccountQuota.accountId + quota + unavailable + quotaMode
 -> fresh safe account roster -> by-id join -> row DTO
```

## 7. API-key isolation, pure listing and shared dispatch

### 7.1 Pure cheap list; preserve virtual legacy key

Change `listProviderApiKeys` at `src/providers/api-keys.ts:66` to derive, not seed live config:

```diff
-const pool = ensurePool(provider);
-const activeId = activeEntryId(provider);
+const pool = provider.apiKeyPool?.length
+  ? provider.apiKeyPool
+  : provider.apiKey ? [{ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey }] : [];
+const activeId = (pool.find(entry => entry.key === provider.apiKey) ?? pool[0])?.id ?? null;
```

Keep `ensurePool` and active-key mirroring on explicit mutation paths. Existing legacy-list test
(`tests/providers/provider-api-keys.test.ts:44`) requires a masked row, not a config write. Add
assertions for unchanged in-memory config and unchanged disk content. Do not resolve environment
or keychain during the cheap list. An empty or absent legacy pool keeps identical wire identity.

### 7.2 New key-account owner, no aggregator recursion

Add `src/providers/quota-key-accounts.ts` for key-row snapshots/cache/fanout. Type-only quota
imports; inject a narrow probe callback from `quota.ts` to avoid a runtime import cycle. Keep
`fetchProviderApiKeyQuotas(config, name, forceRefresh = false)` as the quota facade export.
Internal output: `{ keyId: string; quota: ProviderQuota | null; unavailable?: true; isCurrent: () => boolean }[]`.
The closure captures the private resolved-credential/destination identity and clear epoch,
and revalidates them synchronously at the final route join. It is internal only: the route
copies `quota` and `quotaUnavailable` explicitly into the safe DTO, never spreads the internal
row or serializes its captured identity. A changed env/keychain value with the same row ID
invalidates the row. Test replacement between probe settlement and final projection.

```diff
 if (url.pathname === "/api/providers/keys" && req.method === "GET") {
   // existing name/config validation stays first
-  return jsonResponse(listProviderApiKeys(config, name));
+  const projection = projectKeyRowsWithMode(config, name);
+  if (!queryQuota || projection.keys.every(k => k.quotaMode !== "probe"))
+    return jsonResponse(projection);
+  const rows = await fetchProviderApiKeyQuotas(config, name, forceRefresh);
+  // Reproject live safe rows; do not revive a deleted key or apply old-key data.
+  return jsonResponse(joinStillMatchingKeyQuotaRows(config, name, rows));
 }
```

`projectKeyRowsWithMode` / `joinStillMatchingKeyQuotaRows` are proposed route-local helpers; they
copy only safe fields. No client-supplied key, account credential, provider object, URL, or org id
is accepted by GET. `?refresh=1` without `?quota=1` remains a cheap list, not an implicit probe.

Per-key probe callback uses the **existing uncached dispatch**, not report aggregation:

```ts
const isolatedProvider = {
  ...providerSnapshot,
  apiKey: resolvedSelectedKey,
  apiKeyPool: undefined,
};
const isolatedConfig = { ...configSnapshot, providers: { [name]: isolatedProvider } };
// name/auth/adapter/destination were admitted by keyQuotaReaderForProvider.
const result = await maybeFetchProviderQuota(name, isolatedProvider, isolatedConfig, false);
```

Create new objects, never assign into `config.providers[name]`. Resolve exactly the selected
pool entry through `resolveProviderApiKey`; an unresolved entry returns unavailable and must not
try another pool entry or the active key. Clear apiKeyPool in the isolated provider so no nested
reader can walk siblings. The key-only dispatch must not execute Codex/OAuth/passive branches.
Resolve before taking a cache identity so changed env/keychain values cannot reuse the previous
credential's row. Never serialize the isolated objects or pass them to persistence.

Key field chain:

```text
validated configured provider name -> read-only pool/legacy snapshot
 -> {entry.id, entry.key reference} -> resolve only that key -> private cache identity
 -> cloned provider(apiKey=that key, no pool) + cloned config -> existing dispatch
 -> report.quota / null / terminal / authoritative-empty -> isolated row cache
 -> still-matching live key identity -> existing masked projection + mode + quota fields
 -> keys[] -> 030 ApiKeyEntry -> ApiKeyRow -> ProviderAuthPanel
```

## 8. Cache attribution, bounded fanout and force semantics

### 8.1 Cache ownership

- OAuth retains `accountQuotaCache`, disk hydration and existing passive persistence. Do not put
  API-key entries into `provider-account-quota-cache.json`, whose reconciliation is OAuth-only
  (`quota.ts:1625`, `account-quota-disk.ts:31`). No key-cache disk schema/migration is required.
- Key rows use a separate bounded process-local map. Private identity includes namespace, provider
  name, adapter, normalized base URL, auth mode, entry id and digest of the **resolved** key. The
  existing short `apiKeyPoolEntryId` is a row handle, not sufficient private identity. Use the
  existing crypto import pattern for a full digest; never emit it in DTOs/logs or persist it.
- Key TTL = existing `ACCOUNT_QUOTA_TTL_MS` (10 minutes); transient last-good display bound =
  existing `LAST_GOOD_MAX_AGE_MS` (30 minutes). Failure advances attempt TTL, not measurement
  `quota.updatedAt`. Null/terminal/authoritative-empty conversions follow section 4.
- Cap key cache at 256 entries, evict expired then least-recently-used settled entries on access
  or write. No new timer or scheduler queue. Bound key in-flight entries separately. Do not persist key rows.
- `clearProviderQuotaCache` invalidates key-flight commit authority as well as key settled rows.
  Use a module epoch; post-await commits check epoch and current entry ownership. A changed key,
  provider destination, removed row or replaced provider cannot publish stale enrichment even to
  the immediate response. Reproject and revalidate before the by-id join, not only cache writes.
- OAuth caches keep their routing key shape. The new four readers' entries additionally bind to
  their captured credential/context and destination identity for lookup/commit. Existing cache
  consumers still obtain quota, never token metadata. Reauth/replacement cannot reuse a previous
  principal's cache merely because the local row id survived. Persisted rows lacking new identity
  evidence are display hints only until validated/probed, not fresh cache hits for these readers.
- API-key enrichment never calls `replaceCachedProviderQuotas`, never seeds a provider-wide
  report with an inactive key, and never changes `activeId` or `provider.apiKey`. Current reports
  continue using the actual active credential; no key aggregation or account weighting is added.

### 8.2 Bounded roster reads — final scope

Use `mapQuotaRoster` in the key-account quota owner for at most four workers per roster,
preserving input order. This is not a process-wide HTTP concurrency guarantee. No global
scheduler module, queue, admission timer, or changes to provider-report scheduling are required.
Keep identity-keyed single-flight, bounded key-cache/in-flight maps, existing OAuth renewal
locks, 8-second wire deadlines and bounded response bodies. A reader may issue sequential or
parallel protocol calls; total roster latency can span multiple waves. These final requirements
replace the rejected global-scheduler proposal, rather than coexisting with it.

### 8.3 Force versus in-flight requests

Preserve the existing join semantics, with identity/clear guards for the new readers:

| Request | Cache / flight behavior |
| --- | --- |
| Ordinary | Reuse matching fresh settled entry, else join matching current flight, else read |
| Forced, no flight | Bypass positive and negative TTL and start one new read |
| Forced, any matching flight exists | Join that in-flight read and await settlement; no successor probe |
| Clear/remove/identity change | Invalidate old operation authority; no late cache or response publication under the replacement |
| Passive force | Cache read only, unchanged observation time, no token renewal |
| Unsupported force | Return mode only, no token resolution |

`finally` removes only its own flight entry. Apply the same semantics to the new key cache.
A current report cache hit is not evidence that all account rows refreshed. Forced quota
refresh does not mean renewing an otherwise valid token or requiring an extra successor read.

## 9. 030 handoff: precise load and refresh settlement

No UI implementation belongs in this backend cycle; these field chains are its consumer contract.

```diff
-fetchAccountSets(providers: string[]): Promise<boolean>
+fetchAccountSets(providers: string[], refresh?: boolean): Promise<boolean>
-fetchKeyPools(providers: string[]): Promise<void>
+fetchKeyPools(providers: string[], refresh?: boolean): Promise<boolean>
```

Initial load: cheap GET, paint controls and per-row modes, then background `quota=1` enrichment
for probe/passive modes. Passive cache reads may occur but never show a probe skeleton or a
"freshly probed" claim. Unsupported modes do not launch a follow-up read. Preserve request-
generation guards and mounted/alive checks. Use explicit enrichment-pending state, not the
absence of quota, so authoritative-empty and unobserved passive rows terminate cleanly.

Explicit refresh: select the endpoint from auth surface; send `quota=1&refresh=1`; await body
parsing, current-generation state acceptance and enrichment settlement. It may skip another
cheap GET if the roster is already loaded. Resolve false on HTTP/parser rejection, superseded
generation or any returned probe row with `quotaUnavailable: true`. Resolve true for settled
probe success/authoritative-empty. Passive/unsupported success means "check completed", never
"upstream quota refreshed". A successful empty roster is a completed check, not a measurement.

If the UI keeps a combined current + all-accounts refresh button, await both requests and use
their combined outcomes; never settle all-account refresh from the provider-report waiter alone.
The existing provider-report endpoint success proves only that its read completed, not that each
upstream refreshed. Prefer separate result wording rather than changing that endpoint's meaning.
The global overview refresh continues to refresh provider reports, not every stored credential.

Keep unavailable last-good bars visibly stale if 030 elects to display them; do not erase the
failure flag when merging. Replacement enrichment must clear an old `quotaUnavailable: true`
with `false` on successful probe. Passive uses original `quota.updatedAt` for observation age;
never stamp it with the click time. API-key rows remain a list, never a sum.

## 10. Dependency-ordered implementation layers and exact file deltas

The A-D rows below are implementation substeps of ONE parent-owned `quota-api` cycle,
not extra work phases. Do not enable a mode before its reader and
negative tests land. Production edits listed below are planned, not made by this document task.

| Layer | Files and changes | Dependency / acceptance |
| --- | --- | --- |
| A — row contract + dispatch foundation | `src/providers/quota-types.ts`: mode/fields; `src/providers/quota.ts`: mode predicates, explicit unsupported branch, pure key reader selector; `src/server/management/oauth-account-routes.ts`: cheap row mode; `src/providers/api-keys.ts`: pure legacy projection and type-only quota fields | Existing supported modes only until B; cheap GET does no upstream/secret/config writes |
| B — four OAuth readers | `src/providers/quota.ts`: exact signatures in section 6, paired context, active-report call sites, sentinel conversion, four allowlist additions and flight fences; reuse the per-roster mapper in the key-account owner | A; every dedicated reader is tested with at least two distinct accounts, no active switch |
| C — all key rows | `src/providers/quota-key-accounts.ts` (new): isolated config/cache/per-roster mapper; `src/providers/quota.ts`: facade and uncached callback, cache invalidation integration; `src/server/management/oauth-account-routes.ts`: key opt-in enrichment | A+B reader contracts; all supported key dispatch retained; no provider cache contamination |
| D — backend contract audit | Existing backend regression files below; `structure/05_gui-and-management-api.md`: row modes/query semantics/refresh outcome (parent scope); `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json` if new backend regression files are added | A-C; DTO/privacy/race checks and parent exact-head CI before 030 consumption |
| 030 — UI consumer, separately owned | `gui/src/hooks/useProviderAccountPools.ts`, `gui/src/components/provider-workspace/types.ts`, `gui/src/pages/Providers.tsx`, `ProviderDetails.tsx`, `ProviderAuthPanel.tsx`, `ProviderUsage.tsx`, `ProviderCapacityQuota.tsx`, `gui/src/provider-workspace/report.ts`, all affected i18n locales | Backend A-D; loading/refresh and current-vs-all rendering follows section 9 |

Keep new modules focused and under the dev modularity limits. `quota.ts` is already large;
do not append the independent key-cache implementation to it or opportunistically
move every existing provider parser. No changes to `src/oauth/index.ts`/store persistence are
required by this design. If paired context cannot be obtained with the existing account resolver,
parent must explicitly amend scope before changing auth internals.

## 11. Regression matrix (planned, not executed)

Extend existing files first. New files listed as new require both layout registry entries.
Use synthetic tokens and local mocked transports only; assertions must not print real secrets.

| File | Required trigger cases |
| --- | --- |
| `tests/providers/provider-account-quota.test.ts` | Replace the old xAI-is-unsupported expectation at line 205 with a truly unsupported OAuth provider; two-account xAI/Cursor/Kimi/Command rows; all explicit token bindings; unchanged active id; missing/expired token; metadata/token mismatch; missing project; preserved Anthropic local-CLI guard; success-failure-success flag clearing |
| `tests/providers/provider-quota.test.ts` | Existing current reports retain source/window/credit shape; active switch during await cannot publish old current identity; exact key destination/name/auth selector table; no-new-alias behavior; unknown/local/forward/disabled destination performs zero sends; provider current report unchanged after inactive key enrichment |
| `tests/providers/command-code-quota.test.ts` | Two tokens produce distinct whoami orgs; same token + org across credits/subscription/period summary; no active org leak; missing whoami preserves existing unscoped behavior; optional spend failure preserves windows; purchased credits suppress expiry; terminal failure clears last-good; key and OAuth readers agree for equivalent fixtures |
| `tests/providers/opencode-go-quota.test.ts` | Renamed canonical key provider remains supported; wrong adapter or lookalike destination stays unsupported; each isolated key gets its own usage |
| `tests/providers/provider-api-keys.test.ts` | Cheap legacy row without in-memory/disk mutation; masked serialization; `quota=1`, `quota=1&refresh=1`, refresh-only cheap behavior; two keys differing quota; inactive key does not become active; empty pool; unresolved active key never falls back to sibling; key read no token/keychain/config write |
| `tests/oauth/oauth-accounts-api.test.ts` | Cheap rows always carry mode, no quota work; opt-in probe merges after health reproject; same field names for initial/refresh response; request with unknown provider rejected before any probe; existing management admission preserved; row removed during probe stays removed |
| `tests/providers/muse-passive-quota-cache.test.ts` | Mode passive while supportsPerAccountQuota remains false; hydration before persistence; account revision fence; observed roster only; no-observation omitted, not error; restart retains observation |
| `tests/providers/muse-passive-quota-observation.test.ts` | Cheap list mode only; enriched passive row mode + original quota timestamp; forced read makes zero network/renewal calls; unobserved passive row has no unavailable flag; active/current selection remains distinct from stored-account observations |
| `tests/providers/provider-quota-observed-marker.test.ts` | Preserve provider-report observed marker and freshness exemptions |
| `tests/providers/kiro/kiro-account-quota.test.ts` | Existing Kiro context/CLI refresh, regional metadata and exhaustion-state commit remain intact after bounded roster mapping |
| `tests/providers/provider-account-quota-persistence.test.ts` | No API-key cache entries/digests in OAuth disk snapshot; OAuth/passive hydration unchanged; old persisted new-reader row cannot masquerade as a freshly verified identity |
| Existing `tests/providers/provider-api-keys.test.ts` | Extend for supported key-reader matrix, replacement/clear, frozen config, no provider/OAuth cache bleed, failure/empty semantics, cache caps and four workers per roster; no separate scheduler test file |

Additional reader fixtures within those files must force each existing protocol branch:

1. xAI weekly success, missing upstream user id with monthly fallback, token-derived user id,
   weekly failure then same-token monthly fallback, malformed/non-finite amounts.
2. Cursor period total versus secondary custom windows, summary fallback, auth-usage fallback,
   each with distinct two-account tokens, date parsing, and redirect rejection.
3. Kimi custom/standard window parsing, canonical configured base, explicitly invalid base,
   OAuth token versus isolated coding-plan key, missing/invalid payload.
4. Force bypasses positive and negative ten-minute TTL but joins a matching in-flight read;
   concurrent forced requests share it. Remove/clear during a flight cannot revive a row.
5. One failed row does not drop healthy siblings; one malformed upstream body cannot serialize raw
   fields. Real 0%, empty/no windows, unsupported and unavailable remain four distinct cases.

030 regression consumers: `gui/tests/provider-quota-refresh-controls.test.tsx`,
`gui/tests/provider-quota-refresh-settle.test.tsx`, `gui/tests/auth-panel-refresh-render.test.tsx`,
`gui/tests/provider-capacity-shell.test.tsx`, `gui/tests/provider-capacity-credits.test.tsx`,
`gui/tests/provider-quota-observed-freshness.test.ts`, `gui/tests/quota-observed-age.test.tsx`.
Required UI cases: initial controls paint before delayed quota; explicit refresh awaits delayed
account AND key enrichment; partial failure is not success; passive no skeleton/probe; unsupported
no follow-up; success clears stale failure; credits-only/coverage-only renders; no key summation;
provider navigation rejects an old generation's enrichment; all locale keys follow GUI policy.

## 12. Verification ownership and handoff gate

No local tests or suites are permitted by `000_plan.md` or this task. The parent owns remote
exact-head CI and the audit cycle. Candidate focused CI invocations (not run here):

```sh
bun test tests/providers/provider-account-quota.test.ts tests/providers/provider-quota.test.ts tests/providers/command-code-quota.test.ts
bun test tests/providers/provider-api-keys.test.ts
bun test tests/oauth/oauth-accounts-api.test.ts tests/providers/muse-passive-quota-cache.test.ts tests/providers/muse-passive-quota-observation.test.ts
bun test tests/providers/kiro/kiro-account-quota.test.ts tests/providers/provider-account-quota-persistence.test.ts tests/providers/provider-quota-observed-marker.test.ts tests/providers/opencode-go-quota.test.ts
```

Parent may run its approved static checks (existing documented direct TypeScript checker and
privacy scan), never use these command examples as permission to run local tests. Existing
exact-head CI owns broader platform/layout/privacy gates; no new workflow or dependency here.

020 is ready for 030 implementation only after the parent has evidence for all of:

- [ ] Cheap OAuth and key rows emit the agreed mode without upstream work or config mutation.
- [ ] Seven probe OAuth readers and passive Muse are distinct and account-correct.
- [ ] Every existing supported key reader works per isolated key, with bounded fanout and no sum.
- [ ] Explicit force settles enrichment with correct cache/in-flight/failure semantics.
- [ ] Tokens/metadata/digests never enter added response fields; canonical destinations preserved.
- [ ] Current provider reports remain unchanged by inactive-account/key reads.
- [ ] Parent security audit and exact-head regression evidence are attached to its ledger.

This document's readiness is design-only. No box is checked by writing the plan.

## 13. Parent scope lock (supersedes broader scheduling proposals above)

Keep the feature focused on credential-scoped retrieval and DTO correctness. A new global
queue/admission framework and forced-successor protocol are not required by the user outcome.
Do NOT add quota-probe-scheduler.ts, queue timers, global provider-report scheduling changes,
or its proposed test file. Reuse a local four-worker roster mapper (existing concurrency helper
if found); per-identity single-flight deduplicates concurrent reads. State the guarantee as
four workers per roster, not a global HTTP concurrency guarantee.

Force bypasses settled positive/negative TTL but may join an already-running same-identity
upstream read, matching the existing account-read contract. No extra successor probe is needed.
The new key cache remains bounded, process-local, credential/destination keyed and invalidated
on clear; late results must not contaminate replacement identity. Preserve existing Anthropic,
Kiro and Antigravity renewal/cache semantics; new readers bind their token plus metadata to
the selected account. Do not retrofit a new persisted OAuth identity schema in this feature.

Section 9's options object is advisory; 030's `(providers, refresh = false)` signature is the
locked GUI interface. `refresh=true` awaits enrichment; initial loads enrich in the background.
Probe requests can join in-flight work but cannot report completion before it settles.
