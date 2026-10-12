# wp1 stale check and disjoint build contract

Previous D: roadmap lock 522e388b7, no production changes. Current tree still matches that code baseline. This P concretizes worker boundaries and the newly inspected sidecar caller.

## Lane A: provenance

Write scope: `src/codex/main-account-cache.ts`, `src/codex/quota.ts`, `src/codex/account-lifecycle.ts`; a NEW focused `tests/codex-integration/main-quota-provenance.test.ts` only. Main owns layout registration.

New cache exports (all no filesystem reads):
```ts
export type MainQuotaWriter = Readonly<{identityKey:string; identityGeneration:number}>;
export function observeMainQuotaIdentity(accountId:string): void;
export function captureMainQuotaWriter(accountId:string): MainQuotaWriter | undefined;
export function observeMainQuotaCredential(accessToken:string, accountId:string): MainQuotaWriter | undefined;
export function matchesMainQuotaCredential(accessToken:string, effectiveAccountId:string | undefined): boolean;
export function isMainQuotaWriterLive(writer:MainQuotaWriter): boolean;
export function getObservedMainQuotaIdentityKey(): string | undefined;
```
`observeMainQuotaIdentity` is called from existing owned identity reconciliation / confirmed transitions, never from untrusted caller data. `observeMainQuotaCredential` does NOT change observed physical identity; it only captures equality for an already matching account. HMAC tuple is generation-scoped and memory-only. Identity key may be stable SHA256 of account identity for disk comparison; never persist token hashes. Clearing main info invalidates credential equality and generation, not falsely certifies a new identity.

Quota exports: add optional fourth `mainWriter?: MainQuotaWriter` to the parsed setter/header applier; export `getMainPolicyQuota(): StoredAccountQuota | null`. Preserve public quota shape and legacy readers. Identity-tagged policy snapshot has separate lifetime from rotation TTL. Reject stale tagged writes and retain one shared merge semantics. Untagged main writes invalidate policy provenance; pool writes do not.

## Lane B: native admission and all outbound callers

Write scope: `src/codex/auth-context.ts`, `src/codex/account-usability.ts`, `src/server/responses/core.ts`, `src/server/responses/compact.ts`, `src/providers/openai-sidecar.ts`; NEW `tests/codex-integration/main-account-hard-lock-auth.test.ts`. Main owns layout registration.

Consume the cache/quotas API above and the main-owned helper below. Main-pool context adds optional `mainQuotaWriter?: MainQuotaWriter` for backward compatibility, captured from the owned returned token before sending. Carry it unchanged to all three quota-header writers (core twice, compact once). Reconcile physical identity on the already owned path; never add a physical read to caller-owned traffic.

Extend materializer options with optional config, and legacy `headersForCodexAuthContext(headers,ctx,config?)` likewise. Supply config at every actual core/compact and `openai-sidecar.ts` call. The `ws-bridge.ts` wrapper has no production caller (symbol search), so it is not an enforcement site. Direct sidecar currently bypasses `resolveCodexAuthContext`; pass config to `directSidecarHeaders` and through the canonical header materializer so it cannot bypass matched-main policy.

After awaited stored token refresh, observe credential only if matching already-owned identity, then evaluate current config/quota immediately before returning headers. Matched caller means exact credential equality AND effective outgoing account ID equality. Quota/config changes after selection are observable at materialization. A live socket is an already-admitted request; this work does not revoke its existing stream.

`CodexMainAccountHardLockError` extends the existing cooldown class, carries a safe policy message and no account PII. Canonical cooldown formatter recognizes the subtype and returns the policy-specific recovery instruction. Do not write upstream cooldown or mint probes for this error. If main is the only otherwise eligible account and is blocked, surface the policy error, not reauth.

## Main lane: config, status, policy and integration

Write scope: `src/types/config.ts`, `src/config.ts`, `src/server/management/config-routes.ts`, `src/codex/auth-api.ts`, NEW `src/codex/main-account-hard-lock.ts`, NEW `tests/config/settings-main-account-hard-lock.test.ts`, NEW `tests/codex-integration/main-account-hard-lock-policy.test.ts`, both test layout manifests, unit docs and structure SoT.

Policy API:
```ts
export interface MainAccountHardLockStatus {
  enabled:boolean;
  state:'off'|'unknown'|'ready'|'blocked';
  resetAt?:number; // Unix milliseconds for the selected blocking window, absent if unknown
}
export function getMainAccountHardLockStatus(config:Pick<OcxConfig,'codexMainAccountHardLock'>, now?:number): MainAccountHardLockStatus;
export function isMainAccountHardLocked(config:Pick<OcxConfig,'codexMainAccountHardLock'>, now?:number): boolean;
```
Read `getMainPolicyQuota`; no credential getters. Owner steering in013 selects short/5h first, otherwiseweekly, otherwisemonthly; never select a different window because the chosen reading expired. Recognize 99 exactly, never score unknown=101. Status shared in settings and main DTO.

At WHAM request construction, capture `observeMainQuotaCredential(tokens.access_token,tokens.account_id)` only if `requestAccountId === tokens.account_id`, then carry `mainWriter` over fetch and existing identity revalidation to the parsed quota setter. Incoming data never manufactures that provenance.

## Delegation/verification boundaries

All lanes read 010 + this contract and relevant skills. No local test suites, no commits/pushes/FSM/goals/delegation from workers. Write regression files but main runs static checks once after integration and CI runs all tests. Main independently inspects diffs and audits before publication. No lane may edit another lane's files; report necessary boundary changes instead.
