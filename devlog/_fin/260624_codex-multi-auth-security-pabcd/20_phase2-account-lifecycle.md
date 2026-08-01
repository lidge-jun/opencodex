# 20 - Phase 2: Account Lifecycle Transaction

Status: implementation-ready plan.

## Objective

Deleting or replacing a pool account must invalidate every account-bound runtime state. Refresh completion must not resurrect deleted or replaced credentials.

## Planned Changes

### NEW `src/codex-account-runtime-state.ts`

Create a lower-level runtime-state owner before wiring delete cleanup. This prevents a circular dependency between `src/codex-auth-api.ts` and `src/codex-routing.ts`.

Move or own:

- `markAccountNeedsReauth(accountId)`;
- `isAccountNeedsReauth(accountId)`;
- `clearAccountNeedsReauth(accountId)`;
- lifecycle cleanup orchestration that can call routing/quota/health purge helpers without importing `codex-auth-api.ts`.

`src/codex-routing.ts` must import reauth state from this lower-level module, not from `src/codex-auth-api.ts`. `src/codex-auth-api.ts` may call a lifecycle helper, but that helper must not import `codex-auth-api.ts`.

### MODIFY `src/types.ts`

Add an explicit persisted credential-record type. Prefer a wrapper so credential tokens can be absent on tombstone records:

```ts
export interface CodexAccountCredentialRecord {
  credential?: CodexAccountCredentials;
  generation: number;
  grantFingerprint?: string;
  deletedAt?: number;
  replacedAt?: number;
}
```

Tombstones are persisted as tokenless records with a bumped generation and `deletedAt`. A missing record means "never stored" or legacy/unmigrated; a tombstone means "known deleted generation".

### MODIFY `src/codex-account-store.ts`

Add credential metadata:

```ts
generation: number;
deletedAt?: number;
replacedAt?: number;
```

Add APIs:

- `readCodexAccountRecord(id)`
- `saveCodexAccountCredentialIfGeneration(id, generation, cred)`
- `tombstoneCodexAccount(id)`
- `replaceCodexAccountCredentialIfGeneration(id, generation, cred)`

Refresh flow:

- capture generation at refresh start;
- save refreshed credential only if generation still matches, then atomically bump generation/version on success;
- discard result after deletion/replacement.

### Refresh Race Safety

The in-process alias-scoped lock is not sufficient for shared homes or duplicate aliases.

Requirements:

- refresh lock key must be a verified grant/subject fingerprint, not the local alias;
- locking must work across processes sharing the same opencodex home, or storage must provide an atomic transaction with equivalent behavior;
- `saveCodexAccountCredentialIfGeneration()` must compare the current generation and bump generation in one atomic operation;
- concurrent refreshes with the same starting generation may result in at most one credential write;
- later refresh completions after delete/replacement must discard without rewriting tokens.

### MODIFY `src/codex-routing.ts`

Add account-state cleanup APIs:

- `clearThreadAccountMapForAccount(accountId)`
- `clearCodexUpstreamHealthForAccount(accountId)`
- `validateThreadAccountMapping(config, accountId)`

Affinity lookup must revalidate:

- account exists in config;
- credential exists;
- not tombstoned;
- not reauth-required unless policy explicitly allows old pinned threads.

Add TTL/LRU plan:

- max entries configurable later;
- default conservative bound for daemon safety;
- expired mapping returns clear affinity-expired behavior, not silent cross-account switch.

### MODIFY `src/codex-quota.ts`

Add:

- `clearAccountQuota(accountId?: string)` overload or new `clearQuotaForAccount(accountId)`.

### MODIFY `src/codex-auth-api.ts`

Delete endpoint must call one lifecycle operation:

1. tombstone/generation bump;
2. remove credential;
3. remove config entry;
4. clear active account if needed;
5. purge affinity/quota/health/reauth state;
6. save config.

### MODIFY WebSocket Binding

Any socket bound to a deleted account generation must close or fail subsequent turns closed. Phase 10 introduces `CodexSocketBinding`; Phase 20 makes it generation-aware and invalidates it during lifecycle cleanup.

## Tests

Add/update:

- `tests/codex-auth-api.test.ts`
- `tests/codex-routing.test.ts`
- `tests/codex-account-store.test.ts`
- `tests/ws-endpoint.test.ts`

Required cases:

- delete purges quota/health/reauth/affinity;
- old thread id cannot resolve deleted account;
- refresh after delete does not rewrite credential;
- replace while refresh pending keeps replacement;
- duplicate alias/duplicate grant refresh has one cross-process-safe winner;
- simulated two-process/shared-home refresh contention cannot corrupt a rotating refresh-token chain;
- WS bound to deleted account fails closed.

## Verification

```bash
bun test tests/codex-auth-api.test.ts tests/codex-routing.test.ts tests/codex-account-store.test.ts tests/ws-endpoint.test.ts
bun run typecheck
```
