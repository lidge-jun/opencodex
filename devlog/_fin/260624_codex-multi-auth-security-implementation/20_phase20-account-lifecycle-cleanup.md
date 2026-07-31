# 20 - Phase 20A Execution: Account Lifecycle Cleanup

Date: 2026-06-24

Status: implemented and locally verified.

## Objective

Implement the first account-lifecycle hardening slice from `devlog/280_codex-multi-auth-security-patch-plan/00_patch_plan.md`: deleting a Codex pool account must clear every account-bound in-memory state that can keep routing or presenting that account after deletion.

This slice intentionally handles runtime cleanup and stale binding rejection first. Persisted credential generations, tombstones, compare-and-swap refresh writes, grant-fingerprint locking, and cross-process refresh locking remain Phase 20B because they require a storage format migration and broader race-test harness.

## Acceptance Criteria

- Delete removes the account credential, config entry, and active account selection as before.
- Delete also clears:
  - quota state;
  - reauth state;
  - upstream health/failover state;
  - all thread affinities bound to the deleted account.
- A stale thread id that previously mapped to a deleted account must not resolve that deleted account again.
- A WebSocket frame with a stored pool auth context for a deleted or credentialless account must fail closed before upstream fetch, even though the socket stored selected headers at upgrade time.
- `src/codex-routing.ts` must not depend on `src/codex-auth-api.ts` for runtime reauth state.
- Existing main-mode and non-deleted pool routing behavior must remain backward-compatible.

## File Plan

### NEW `src/codex-account-runtime-state.ts`

Own in-memory account runtime flags that lower-level routing/auth modules need without importing `codex-auth-api.ts`.

Exports:

```ts
export function markAccountNeedsReauth(id: string): void;
export function isAccountNeedsReauth(id: string): boolean;
export function clearAccountNeedsReauth(id: string): void;
```

Initial implementation moves the existing `reauthAccounts` set from `src/codex-auth-api.ts` unchanged.

### NEW `src/codex-account-usability.ts`

Own the shared account usability predicate as a leaf module so lifecycle, routing, and auth-context code can share the same rule without circular imports.

Imports only:

- `getCodexAccountCredential` from `src/codex-account-store.ts`;
- `isAccountNeedsReauth` from `src/codex-account-runtime-state.ts`;
- `OcxConfig` type from `src/types.ts`.

Exports:

```ts
export function isCodexAccountUsable(config: OcxConfig, accountId: string): boolean;
```

The predicate returns true only when:

- config still contains the pool account;
- the credential exists;
- the account is not marked reauth-required.

`src/codex-routing.ts` must import this leaf module directly; it must not import `src/codex-account-lifecycle.ts`.

### NEW `src/codex-account-lifecycle.ts`

Coordinate delete cleanup without creating cycles.

Exports:

```ts
export function purgeCodexAccountRuntimeState(accountId: string): void;
export function deleteCodexAccount(runtimeConfig: OcxConfig, accountId: string): void;
```

Responsibilities:

- `purgeCodexAccountRuntimeState()` clears quota, reauth, thread affinity, and upstream health for one account.
- `deleteCodexAccount()` removes credential, config entry, active selection, and calls the runtime purge.
- It may import routing cleanup helpers, quota cleanup, runtime-state cleanup, and account-store removal.
- It must not be imported by `src/codex-routing.ts`.

### MODIFY `src/codex-auth-api.ts`

Before:

```ts
const reauthAccounts = new Set<string>();
export function markAccountNeedsReauth(id: string): void { reauthAccounts.add(id); }
export function isAccountNeedsReauth(id: string): boolean { return reauthAccounts.has(id); }
export function clearAccountNeedsReauth(id: string): void { reauthAccounts.delete(id); }

removeCodexAccountCredential(id);
runtimeConfig.codexAccounts = ...filter...
if (runtimeConfig.activeCodexAccountId === id) runtimeConfig.activeCodexAccountId = undefined;
saveRuntimeConfig(config, runtimeConfig);
```

After:

```ts
export { markAccountNeedsReauth, isAccountNeedsReauth, clearAccountNeedsReauth } from "./codex-account-runtime-state";
import { deleteCodexAccount } from "./codex-account-lifecycle";

deleteCodexAccount(runtimeConfig, id);
saveRuntimeConfig(config, runtimeConfig);
```

Also remove direct `removeCodexAccountCredential` import from this file if no longer needed.

### MODIFY `src/codex-routing.ts`

Before:

```ts
import { getAccountQuota, isAccountNeedsReauth, markAccountNeedsReauth } from "./codex-auth-api";
```

After:

```ts
import { getAccountQuota } from "./codex-quota";
import { isAccountNeedsReauth, markAccountNeedsReauth } from "./codex-account-runtime-state";
```

Add:

```ts
export function clearThreadAccountMapForAccount(accountId: string): void;
export function clearCodexUpstreamHealthForAccount(accountId: string): void;
export function getCodexUpstreamHealth(accountId: string): { consecutiveFailures: number; lastFailureStatus?: number; lastFailureAt?: number } | null;
```

Change `resolveCodexAccountForThread()` so a cached thread mapping is revalidated before returning. If the mapped account is no longer present in config, lacks a credential, or needs reauth, delete the mapping and proceed with normal active-account resolution.

The active account path should also avoid selecting a deleted/credentialless/reauth account. If no usable active or fallback pool exists, return `null` rather than a stale deleted account id.

Use `isCodexAccountUsable()` from `src/codex-account-usability.ts` for the shared predicate. Do not import `src/codex-account-lifecycle.ts` from routing.

### MODIFY `src/codex-quota.ts`

Before:

```ts
export function clearAccountQuota(): void {
  accountQuota.clear();
}
```

After:

```ts
export function clearAccountQuota(accountId?: string): void {
  if (accountId) accountQuota.delete(accountId);
  else accountQuota.clear();
}
```

### MODIFY `src/codex-auth-context.ts`

Add:

```ts
export function isCodexAuthContextUsable(ctx: CodexAuthContext, config: OcxConfig): boolean;
```

Main context is always usable. Pool context delegates to `isCodexAccountUsable(config, accountId)` from `src/codex-account-usability.ts`.

Also repoint `markAccountNeedsReauth` from `src/codex-auth-api.ts` to `src/codex-account-runtime-state.ts` so auth context no longer imports the API layer for runtime flags.

### MODIFY `src/server.ts`

Inside `handleResponses()`, immediately after the `resolveCodexAuthContext()` / `options.authContext` block and before `applyCodexAuthContextToProvider()`, fail closed when the context is no longer usable:

```ts
if (!isCodexAuthContextUsable(authCtx, config)) {
  return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
}
```

This protects WebSocket frames that reuse an upgrade-time pool context after the account has been deleted.

### MODIFY Tests

Update:

- `tests/codex-auth-api.test.ts`
  - delete clears quota, reauth state, active account, config account, and credential.
- `tests/codex-routing.test.ts`
  - stale thread mapping to deleted account is purged and never returns the deleted id;
  - upstream health for a deleted account is cleared by lifecycle cleanup.
- `tests/codex-auth-context.test.ts`
  - main context usability always returns true;
  - pool context usability returns true with config account + credential;
  - pool context usability returns false after credential deletion or config removal.
- `tests/session-affinity.test.ts`
  - seed `codexAccounts` entries and credentials anywhere a test expects an active pool account id to be returned;
  - add or keep an explicit stale-mapping-after-delete case in `tests/codex-routing.test.ts` if that is the more local routing harness.
- `tests/codex-account-store.test.ts`
  - keep existing CRUD behavior passing.

If WebSocket server integration is too heavy for this slice, assert the server-protecting predicate through `isCodexAuthContextUsable()` and document the residual integration gap. Full live WS deletion invalidation remains Phase 20B/transport hardening.

## Verification

```bash
bun test tests/codex-auth-api.test.ts tests/codex-routing.test.ts tests/codex-auth-context.test.ts tests/codex-account-store.test.ts tests/session-affinity.test.ts tests/ws-endpoint.test.ts
bun run typecheck
bun test tests
cd gui && bun run build
git diff --check
```

## Implementation Evidence

Changed source:

- `src/codex-account-runtime-state.ts`
- `src/codex-account-usability.ts`
- `src/codex-account-lifecycle.ts`
- `src/codex-auth-api.ts`
- `src/codex-auth-context.ts`
- `src/codex-routing.ts`
- `src/codex-quota.ts`
- `src/server.ts`

Changed tests:

- `tests/codex-auth-api.test.ts`
- `tests/codex-auth-context.test.ts`
- `tests/codex-routing.test.ts`
- `tests/session-affinity.test.ts`

Implemented behavior:

- moved reauth runtime flags out of the API layer;
- added a leaf account-usability predicate shared by routing/auth-context/server without lifecycle/routing cycles;
- delete now removes credential/config/active selection and purges quota, reauth state, affinity, and upstream health;
- thread affinity is revalidated before reuse and stale deleted mappings are purged;
- active pool accounts that still exist in config but lack credentials do not fall through to main; they are returned so the auth context fails closed;
- WebSocket stored pool contexts are rechecked in `handleResponses()` before provider application and upstream fetch.

Deferred to Phase 20B:

- persisted credential generations and tombstones;
- compare-and-swap refresh writes;
- grant-fingerprint and cross-process refresh locking;
- live WebSocket connection registry/close-on-delete.

## Verification Results

Fresh local verification on 2026-06-24:

```bash
bun test tests/codex-auth-api.test.ts tests/codex-routing.test.ts tests/codex-auth-context.test.ts tests/codex-account-store.test.ts tests/session-affinity.test.ts tests/ws-endpoint.test.ts
```

Result: 83 pass, 0 fail.

```bash
bun run typecheck
```

Result: `tsc --noEmit` passed.

```bash
bun test tests
```

Result: 258 pass, 0 fail.

```bash
cd gui && bun run build
```

Result: production build passed.

```bash
git diff --check
```

Result: no whitespace errors.

## Independent Verification

Read-only Backend verification returned DONE with no findings.

Verified:

- reauth runtime state is owned by `src/codex-account-runtime-state.ts`;
- routing/auth-context no longer import `src/codex-auth-api.ts` for reauth flags;
- no circular dependency was found among lifecycle/routing/usability/runtime-state/auth-context/auth-api/quota;
- delete purges credential, config, active account, quota, reauth state, thread affinity, and upstream health;
- stale thread affinity is revalidated before reuse;
- configured active pool accounts with missing credentials fail closed through auth context rather than falling back to main;
- WebSocket stored pool contexts are guarded by `isCodexAuthContextUsable()` in `handleResponses()`;
- Phase 20B symbols for tombstone/generation/CAS/grant-fingerprint/cross-process locking were not partially implemented.

Residual risks accepted for Phase 20B:

- no live end-to-end WebSocket deletion test yet;
- no live connection registry/close-on-delete yet;
- persisted tombstones, credential generations, compare-and-swap refresh writes, and cross-process refresh locking remain unimplemented by design.

## Commit Boundary

One implementation commit for Phase 20A lifecycle cleanup. Do not mix in manual import identity changes, local API auth, safe DTOs, quota taxonomy, or persisted refresh-generation migration.
