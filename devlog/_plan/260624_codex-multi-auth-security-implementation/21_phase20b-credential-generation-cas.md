# 21 - Phase 20B Execution: Credential Generation And Refresh CAS

Date: 2026-06-24

Status: implemented and locally verified.

## Objective

Finish the account-lifecycle P0 by preventing stale refresh completions from recreating or overwriting deleted/replaced Codex pool credentials.

Phase 20A cleaned in-memory lifecycle state. Phase 20B hardens the persisted credential store with generation records, tombstones, and compare-and-swap refresh saves.

## Acceptance Criteria

- Existing legacy `codex-accounts.json` files shaped as `{ [id]: CodexAccountCredentials }` continue to read correctly.
- New writes use a wrapper record with:
  - `credential?: CodexAccountCredentials`;
  - `generation: number`;
  - `deletedAt?: number`;
  - `replacedAt?: number`.
- `getCodexAccountCredential(id)` returns `null` for tombstones or missing credentials.
- `listCodexAccountIds()` excludes tombstones.
- Delete writes a tokenless tombstone with a bumped generation instead of deleting the key outright.
- Refresh captures the generation at start and persists the refreshed credential only if the generation is unchanged and no tombstone/replacement occurred.
- A refresh finishing after delete must not recreate credentials.
- A refresh finishing after replacement must not overwrite the replacement.
- A refresh generation conflict must fail the current refresh/request without marking the account as reauth-needed when fresh replacement credentials already exist.
- Phase 20B does not implement grant-fingerprint duplicate aliases or cross-process file locks yet; those remain Phase 20C/manual-import hardening.

## File Plan

### MODIFY `src/types.ts`

Add:

```ts
export interface CodexAccountCredentialRecord {
  credential?: CodexAccountCredentials;
  generation: number;
  deletedAt?: number;
  replacedAt?: number;
}
```

`CodexAccountCredentials` stays unchanged for callers.

### MODIFY `src/codex-account-store.ts`

Change internal store shape from:

```ts
type CodexAccountStore = Record<string, CodexAccountCredentials>;
```

to a normalized record store:

```ts
type LegacyCodexAccountStore = Record<string, CodexAccountCredentials>;
type CodexAccountStore = Record<string, CodexAccountCredentialRecord>;
```

Add helpers:

```ts
function isCredentialRecord(value: unknown): value is CodexAccountCredentialRecord;
function normalizeRecord(value: CodexAccountCredentials | CodexAccountCredentialRecord | undefined): CodexAccountCredentialRecord | undefined;
function loadCodexAccountRecordStore(): CodexAccountStore;
export function readCodexAccountRecord(id: string): CodexAccountCredentialRecord | null;
export function saveCodexAccountCredentialIfGeneration(id: string, generation: number, cred: CodexAccountCredentials): boolean;
export function tombstoneCodexAccount(id: string): number;
export class CodexCredentialGenerationConflictError extends Error;
```

Backward-compatible public APIs:

- `loadCodexAccountStore()` should still return `Record<string, CodexAccountCredentials>` for existing callers/tests, excluding tombstones.
- `getCodexAccountCredential(id)` returns `null` when the record is missing, tombstoned (`deletedAt` set), or lacks `credential`. A buggy tokenful tombstone must still be treated as absent.
- `saveCodexAccountCredential(id, cred)`:
  - reads current record;
  - writes `{ credential: cred, generation: current.generation + 1, replacedAt: Date.now() if current credential existed or tombstoned }`;
  - clears tombstone by omitting `deletedAt`.
- `removeCodexAccountCredential(id)` should call `tombstoneCodexAccount(id)`.
- `listCodexAccountIds()` returns ids with credentials only.

Refresh flow:

```ts
const record = readCodexAccountRecord(id);
if (!record?.credential) throw new Error(...);
const startGeneration = record.generation;
...
const saved = saveCodexAccountCredentialIfGeneration(id, startGeneration, updated);
if (!saved) throw new CodexCredentialGenerationConflictError("Codex account changed during refresh");
```

CAS helper contract:

- Reload the store synchronously at write time.
- Return `false` unless:
  - current record exists;
  - `current.generation === expectedGeneration`;
  - `current.credential != null`;
  - `current.deletedAt == null`.
- On success, write `{ credential: updated, generation: expectedGeneration + 1 }`.
- Preserve `replacedAt` only when already present; do not add replacement metadata for ordinary refresh.

`CodexCredentialGenerationConflictError` must be distinct from `TokenRefreshError` so replacement/delete races do not get misclassified as upstream credential reauth failures.

### MODIFY `src/codex-auth-context.ts`

When `getValidCodexToken()` throws `CodexCredentialGenerationConflictError`, return a fail-closed `CodexAuthContextError` but do not call `markAccountNeedsReauth(accountId)`. Other token failures still mark reauth.

### MODIFY `src/codex-auth-api.ts`

In `fetchPoolAccountQuota()`, treat `CodexCredentialGenerationConflictError` as `{ quota: existing ?? null, needsReauth: false }`. `TokenRefreshError` remains `{ needsReauth: true }`.

### `src/codex-account-lifecycle.ts`

No code change required in this file if `removeCodexAccountCredential(accountId)` becomes tombstone-backed in `src/codex-account-store.ts`. Keep the lifecycle call site unchanged.

### MODIFY Tests

Update `tests/codex-account-store.test.ts`:

- legacy flat credential JSON loads through `getCodexAccountCredential()`;
- new save writes wrapper record with generation;
- remove/tombstone returns null through `getCodexAccountCredential()` and excludes id from `listCodexAccountIds()`;
- `readCodexAccountRecord()` exposes generation/tombstone metadata for internal tests;
- `saveCodexAccountCredentialIfGeneration()` succeeds only for matching live generation;
- stale generation cannot overwrite replacement;
- stale generation cannot recreate after tombstone.
- tokenful tombstones are still treated as absent, so `deletedAt` wins even if a malformed record retains credential material.
- mocked `getValidCodexToken()` refresh where delete happens while token fetch is in flight:
  - refresh rejects with `CodexCredentialGenerationConflictError`;
  - stale refreshed token is not persisted;
  - tombstone remains tokenless.
- mocked `getValidCodexToken()` refresh where replacement happens while token fetch is in flight:
  - refresh rejects with `CodexCredentialGenerationConflictError`;
  - replacement credential remains persisted.

Update `tests/codex-auth-context.test.ts`:

- generation conflict does not mark the account as reauth-needed.

Update `tests/codex-auth-api.test.ts` if needed:

- delete still returns credential null and runtime cleanup passes with tombstone-backed removal.
- quota refresh generation conflict does not set `needsReauth: true`.

## Verification

```bash
bun test tests/codex-account-store.test.ts tests/codex-auth-api.test.ts tests/codex-auth-context.test.ts tests/codex-routing.test.ts
bun run typecheck
bun test tests
cd gui && bun run build
git diff --check
```

## Implementation Evidence

Changed source:

- `src/types.ts`
- `src/codex-account-store.ts`
- `src/codex-auth-context.ts`
- `src/codex-auth-api.ts`

Changed tests:

- `tests/codex-account-store.test.ts`
- `tests/codex-auth-context.test.ts`
- `tests/codex-auth-api.test.ts`

Implemented behavior:

- added `CodexAccountCredentialRecord`;
- legacy flat `codex-accounts.json` still loads through the public credential projection;
- new saves write wrapper records with generations;
- remove/delete writes a tokenless tombstone and credential projections treat tombstones as absent;
- tokenful tombstones are covered by a regression test and stay absent from all public projections;
- `listCodexAccountIds()` excludes tombstones;
- refresh captures start generation and persists refreshed tokens only through generation CAS;
- refresh after delete or replacement throws `CodexCredentialGenerationConflictError` and does not rewrite stale tokens;
- generation conflicts do not mark accounts as reauth-needed.

Deferred:

- grant-fingerprint duplicate alias detection;
- cross-process file locking;
- live WebSocket registry close-on-delete.

## Verification Results

Fresh local verification on 2026-06-24:

```bash
bun test tests/codex-account-store.test.ts tests/codex-auth-api.test.ts tests/codex-auth-context.test.ts tests/codex-routing.test.ts
```

Result: 61 pass, 0 fail.

```bash
bun run typecheck
```

Result: `tsc --noEmit` passed.

```bash
bun test tests
```

Result: 268 pass, 0 fail.

```bash
cd gui && bun run build
```

Result: production build passed.

```bash
git diff --check
```

Result: no whitespace errors.

## Commit Boundary

One implementation commit for Phase 20B credential generation/CAS. Do not mix in local API authentication, safe DTOs, manual import identity, quota taxonomy, or cross-process locking.
