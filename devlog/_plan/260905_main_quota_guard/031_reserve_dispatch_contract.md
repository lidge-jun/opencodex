# Reserve P stale check and exact implementation contract

Base c79ddb237, following runtime PR3552 and UI PR3560. No Reserve production edits yet. This document supersedes030 where new source evidence changes its initial outline.

## Source decisions

1. Upstream backend-client/client/rate_limit_resets.rs sends `x-openai-codex-luna-reserve: 1` only for a Reserve-capable usage reader. Reusing the passive auth-api cache cannot establish a grant. A new bounded request consumes an ALREADY OWNED token/writer and reads the fixed WHAM endpoint; it never reads auth files.
2. No genuine full Reserve row was present in the current local cache or pinned upstream models file. Installed Desktop app-primary at byte7352039 copies the whole matching Reserve-or-Luna picker preset while replacing its model with gpt-reserve. Adopt that as an explicitly documented OCX compatibility adaptation: prefer real observed Reserve metadata, otherwise the existing pinned/derived Luna metadata, MAIN SELECTOR ONLY and effective authless opt-in only. This is not a claim that all backend capabilities are identical.
3. Metadata and permission are separate. Offline `ocx sync` cannot read a different proxy process's in-memory grant. Catalog construction therefore exposes a manual choice without claiming availability; every compatibility request requires fresh upstream permission. Adapted rows carry provenance and never become evidence of a genuine Reserve observation on a later sync.
4. Quota scopes are process-local typed Maps, not persisted enums. Only mapping, generic recovery allowlists and human-readable labeling need changes; global cooldown precedence stays unchanged.

## Structural decision

Current: catalog/sync and inject reference each other; loopback/credential-header predicates live inside inject. Importing inject from new catalog code creates an avoidable cycle, and copying the predicates would drift.
Chosen: extract the existing `isLoopbackHostname` and `shouldInjectApiAuthHeader` unchanged to `src/codex/loopback-target.ts`, retaining inject imports/re-exports. Add a pure effective-authless predicate there (flag true, non-client role, no required header under the existing loopback rule). Dependencies become inject -> leaf and catalog/reserve -> leaf; public exports remain compatible. This is a feature-scoped extraction, not an injection redesign. CI existing injection/admission tests and new configuration matrix verify unchanged behavior.
Also move StoredAccountQuota and WHAM wire types unchanged/extended as specified to `src/codex/quota-types.ts`, re-export from quota.ts and import types directly in main-account-cache and reserve-availability. This removes the quota/cache type cycle as a third consumer is introduced; runtime serialization stays identical. The new availability module must NOT import the quota/config facade at runtime: a required observer callback publishes ordinary quota through the existing auth-context owner, preserving the downward dependency direction.

## Main lane: availability boundary

Write: NEW reserve-availability.ts and quota-types.ts; MODIFY quota.ts types only and main-account-cache.ts type import; NEW tests/codex-integration/reserve-availability.test.ts; both layout manifests; docs/records. Main owns public English/Korean guide/SoT updates.

Exports:
```ts
export interface MainReserveAuthorization {
  readonly writer: MainQuotaWriter;
  readonly observedAt: number;
  readonly expiresAt: number;
}
export function getMainReserveAuthorization(
  input: {
    token: {accessToken:string;chatgptAccountId:string};
    writer: MainQuotaWriter | undefined;
    signal?: AbortSignal;
    observeOrdinaryQuota: (data:WhamUsageResponse, writer:MainQuotaWriter) => void;
  },
): Promise<MainReserveAuthorization | undefined>;
export function isMainReserveAuthorizationLive(value:MainReserveAuthorization | undefined, token:{accessToken:string;chatgptAccountId:string}, now?:number): boolean;
export function observeMainReserveRevocation(data:WhamUsageResponse, writer:MainQuotaWriter | undefined): void;
```
Use60s maximum cache age and existing WHAM_REQUEST_TIMEOUT_MS=8000 for the whole fetch/read budget; bound body to existing64KiB reader. Cache/flight keys include physical identity, generation AND a process-local HMAC of the exact owned bearer. Associate authorization objects with that credential key privately (e.g. a WeakMap), never public/disk fields. Every cache hit, join, publication and final materialization must match the exact current owned bearer/effective account; account identity alone cannot distinguish users sharing a workspace. Token replacement retires the old flight; refreshed tokens must obtain their own proof even for the same user. A caller's abort does not cancel another caller's shared read. Abort listeners and deadline timers are cleaned up. A late response cannot publish after deadline, identity/credential change or a newer revocation.

Before dispatch, require writer still live and the supplied token/effective account matches the existing owned credential observation. JSON permission requires exact ordinary.allowed=false, banner=luna_reserve, exactly one reserve entry with allowed=true. Explicit account echo mismatch rejects; explicit user mismatch rejects when the owned access-token auth namespace provides chatgpt_user_id or user_id (per upstream login/token_data.rs). Missing echoes are not invented: trust comes from the authenticated account-scoped request plus the owned writer, not an arbitrary incoming header.
No token, response body, identity key or grant enters public DTO/log/disk. After identity/credential/deadline checks, invoke the required observer once for a genuine usage response; the auth-context callback uses captured config generation/writer with the existing parser/store. No Reserve percentage is folded into ordinary quota. Passive fresh ordinary.allowed=true or explicit Reserve.allowed=false revokes a cached authorization but can NEVER create one. A missing Reserve field on a non-capable passive read is not a grant or a revocation.

## Auth worker lane

Write: auth-context.ts, server/responses/core.ts and compact.ts plus NEW tests/codex-integration/reserve-auth-context.test.ts. No other lane files.
New compatibility handling is gated by effective authless opt-in and exact wire model gpt-reserve. Pin an unqualified Reserve request on a Codex-forward route to stored main; reject an explicit non-main account. Do not change unrelated/native-client default handling when the opt-in is off. Configured selectors use the existing router; no arbitrary bare native catalog expansion.
After existing ownership, pause/reauth/99% and global/Reserve cooldown admission, obtain the owned main token and writer, call getMainReserveAuthorization, then RECHECK99% policy (the WHAM read may have observed99) and cooldown before returning. No automatic fallback to another account or normal Luna. Existing user-configured combo behavior is not a new hidden fallback.
Caller-owned main can participate only when its token AND effective account match already-owned observation; reuse the supplied token/writer without a physical read. An unmatched caller gets an actionable unavailable error in this opt-in compatibility path.
Add optional reserveAuthorization to main/main-pool contexts only when handling Reserve. Actual materializers check isMainReserveAuthorizationLive against the ACTUAL outgoing token/effective account immediately before returning credential-bearing headers, alongside the existing hard-lock check. Refreshed context spreads do not vouch for a new credential: asynchronous materialization reacquires permission when the token changes. No global provider predicate weakening.
Custom-named canonical-forward routes skip resolveCodexAuthContext and synthesize kind:main. Thread `modelId` through the existing materializer options and all core/compact producer calls, including the final synchronous recheck. The transport predicate plus effective authless mode and exact model determine whether a proof is required; absence of a context marker cannot bypass it. Async materialization performs the same owned/matched-main-only permission and global/Reserve cooldown checks for this path; sync materialization refuses a missing/stale proof rather than guessing. Independently keyed providers still receive no policy config. Add actual-handler custom/gpt-reserve denial-with-zero-inference and keyed-provider success tests.
CodexReserveUnavailableError uses the existing cooldown-family mapping with its own safe actionable message (not a reauth or invented stored cooldown). It must not mint a probe or mark reauth. Add Reserve quota to an exhaustive Record<CodexQuotaScope,string> formatter. Keep unknown/global label semantics unchanged.

## Scope worker lane

Write: routing.ts, auth-api.ts; NEW tests/codex-integration/reserve-quota-scope.test.ts (or extend existing cooldown test fixtures narrowly). No auth-context edits.
Add reserve to CodexQuotaScope and exact gpt-reserve mapping. Replace claim and settlement Spark-only exclusions with `scope === undefined || scope === 'shared'`. Do not modify global-first lookup, account-wide Retry-After/default handling or blanket success cleanup.
In the successful identity-validated main WHAM path, call observeMainReserveRevocation(data, mainQuotaWriter). It invalidates only matching cached grants from genuine newer evidence; no capability header or new grant is added to the passive reader.
Tests use an ADDED-account fixture to reach generic recovery claim filtering (main is never visited there), without enabling added-account Reserve requests. Check shared recovery preserves Reserve, independent-only starts no worker read, global/default wins, ordinary unleased success does not clear Reserve. Exact main cannot acquire a recovery probe; do not author an unreachable probe test.

## Catalog worker lane

Write: NEW catalog/reserve.ts and loopback-target.ts; MODIFY catalog/metadata.ts, catalog/sync.ts, catalog/native-models.ts (constant only), inject.ts (pure predicate imports/re-exports only); NEW tests/codex-integration/reserve-catalog.test.ts. No global native-list or capability-alias-map additions.
Export NATIVE_RESERVE_MODEL='gpt-reserve' from the existing native-models leaf. Auth/scope/main import the constant. Effective-authless helper must match actual loopback injection and refuse remote-client mode; reuse the extracted predicate, no heavy inject import from catalog.
The Codex-specific build input carries optional Reserve source and eligible main selectors. Under opt-in add only configured main-selector/gpt-reserve entries; added account selectors, bare discovery, API-key and generic Claude export stay unchanged. Prefer full actual Reserve raw source; otherwise derive/copy existing Luna metadata using established context caps. Mark fallback `opencodex_reserve_metadata_source:'gpt-5.6-luna'`; reject adapted rows as actual observations. Keep genuine source rows unmodified. Qualified supported_in_api=true means this OCX endpoint can accept the selector subject to permission, NOT public OpenAI API entitlement. Remove inherited plan/upgrade marketing.
Preserve marker/source through merge alignment and repeated normalization; do not widen Reserve efforts from generic models. Respect disabledModels including the exact selector. Existing strict generic-template selection must never choose Reserve.

## Acceptance/verification

Parent review prerequisites during B are specified in033/034: retained99 stays blocked past resetAt until fresh valid lower evidence; reject negative raw percentages as policy evidence before legacy clamping; the existing60s sweep performs bounded owned quota recovery while blocked, without a new periodic timer or inference. Hydrate before both merge-base reads and explicitly clear fixture timer ownership. Repair disable-save focus on the UI parent. Main commits repaired parents then cascades UI and Reserve branches before implementation. All changed heads require fresh final CI; no worktree identity change.

All lanes author focused tests but run no local suites. Main runs typecheck, scoped static checks and exact-head CI. Positive capability header + response drives actual authorized main dispatch; absent/stale/mismatch/duplicate/malformed/timeout evidence yields zero inference sends.99% selected-window block and global cooldown still win. Concurrent callers share a bounded read; one abort and stale writer do not corrupt another. Catalog fallback is deterministic without proxy memory and is marked adaptation; observed source wins; repeated sync stays main-only.
Credential-specific scenarios additionally include two distinct tokens/users selecting the same workspace, token replacement during an in-flight usage read, and refresh replay with an old spread authorization. None can reuse or publish another credential's grant.
No currently Reserve-active account was available, so live Reserve inference cannot be claimed. Source-based Desktop authless gate + fixture-backed integration prove the patch mechanics. Final delivery still requires all stack heads green, no unresolved reviews, bottom-up authorized admin merges and ancestry.
