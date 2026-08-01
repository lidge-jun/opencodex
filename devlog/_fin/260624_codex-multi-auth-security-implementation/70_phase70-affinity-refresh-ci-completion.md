# 70 - Phase 70 Plan: P1/P2 Stop-Audit Closure

Date: 2026-06-25

Status: planned after independent stop audit returned `NEEDS_MORE_WORK`.

## Objective

Close the remaining viable work from the 280 multi-auth security stop audit:

- bound and expire thread affinity state without silently remapping expired threads;
- bind affinity entries to credential generations;
- coordinate refreshes by a non-PII grant fingerprint rather than only by local alias;
- add an automated privacy scan to CI;
- update the final manifest with item-level evidence and explicit residual deferrals.

## Non-Developer Summary

The previous patch series fixed the biggest account-boundary bugs, but a reviewer found some state could still live forever or be coordinated by the local nickname instead of the real credential lineage. This phase gives session routing an expiry and max size, makes expired sessions stop instead of quietly jumping to a different account, and makes refresh locks shared by duplicate aliases that point at the same refresh grant. It also adds a CI privacy scan so raw emails, bearer-looking secrets, and local home paths do not drift back into the repository. The manifest will be changed from patch-only proof to item-by-item proof.

## File Change Map

```text
src/codex-routing.ts
  Map<string,string>
    -> Map<string,{ accountId, generation, createdAt, lastUsedAt }>
  + TTL/LRU constants
  + detailed resolver status for expired affinity
  + generation revalidation before affinity reuse

src/codex-auth-context.ts
  + CodexThreadAffinityExpiredError
  + resolve detailed affinity result

src/server.ts
  + safe 409 response for expired thread affinity on HTTP and WebSocket upgrade

src/codex-account-store.ts
  + refreshGrantFingerprint on stored records
  + grant-scoped in-process and file refresh locks
  + duplicate-grant fresh-token reuse after waiting behind another alias

src/types.ts
  + CodexAccountCredentialRecord.refreshGrantFingerprint

scripts/privacy-scan.ts
  + repository scan for local home paths, raw non-fixture emails, and bearer-like secrets with fixture-aware allowlists

package.json
  + privacy:scan script

.github/workflows/ci.yml
  + Privacy scan step

tests/codex-routing.test.ts
tests/codex-auth-context.test.ts
tests/server-auth.test.ts
tests/codex-account-store.test.ts
tests/codex-inject.test.ts
  + regression coverage

devlog/280_codex-multi-auth-security-patch-plan/10_final-verification-manifest.md
  + item-level mapping and residual deferrals
```

## External Basis

OAuth 2.0 Security BCP guidance treats rotating refresh-token chains as replay-sensitive. A duplicate alias using the same refresh token concurrently can cause replay/invalid-grant behavior, so coordination must be by grant fingerprint, not just local alias. The fingerprint is only a local lock key and must not be returned to APIs, logs, or UI.

## Acceptance Criteria

1. Thread affinity entries have a finite idle TTL and a max-entry LRU cap.
2. Expired affinity is not silently remapped to another account for the same thread id. HTTP returns a safe client-visible error before provider request construction.
3. Affinity reuse checks account existence, reauth state, cooldown, credential presence, and the stored credential generation.
4. Credential replacement/deletion invalidates old generation-bound affinity entries.
5. Refresh in-process promises and file locks use a stable `refreshGrantFingerprint` when available, with legacy fallback derived from the refresh token.
6. Two local aliases that share one refresh grant do not call the token endpoint concurrently. The second alias either observes a fresh credential for the same grant or safely waits/fails without replaying in parallel.
7. No raw refresh token, access token, account email, local alias, or fingerprint appears in API responses, request logs, durable error messages, or devlog evidence.
8. CI runs `bun run privacy:scan`.
9. `bun run privacy:scan` passes on the current tracked repository after the Phase 70 changes, including existing fixture emails and documentation template paths.
10. Manifest maps every 280 P0/P1/P2 requirement to implemented evidence or an explicit residual deferral.

## Diff-Level Plan

### MODIFY `src/types.ts`

Add to `CodexAccountCredentialRecord`:

```ts
  refreshGrantFingerprint?: string;
```

### MODIFY `src/codex-account-store.ts`

- Add `refreshGrantFingerprintForToken(refreshToken: string): string`.
- Preserve an existing `refreshGrantFingerprint` across refresh-token rotation.
- Set `refreshGrantFingerprint` for new and legacy-normalized records.
- Change `refreshLocks` and `withCodexRefreshFileLock()` keys from local alias to grant fingerprint.
- After waiting behind a grant lock, re-read the alias record. If it is still stale, look for another live record with the same `refreshGrantFingerprint` and a fresh credential, then save that credential to the waiting alias through generation CAS. This avoids a second replay of an already-rotated token.
- Keep all thrown errors generic and fingerprint-free.
- Explicit mutation sites:
  - `normalizeRecord()` backfills missing `refreshGrantFingerprint` for legacy flat credentials and generation-wrapper records that still have a credential.
  - `saveCodexAccountCredential()` stores a fingerprint for new credentials and preserves the current record fingerprint when the same local alias is replaced.
  - `saveCodexAccountCredentialIfGeneration()` preserves the current record fingerprint across refresh-token rotation.
  - `getValidCodexToken()` derives its in-process promise key and file-lock key from the record fingerprint, not from the local alias.

### MODIFY `src/codex-routing.ts`

- Change `threadAccountMap` value to:

```ts
type ThreadAffinityEntry = {
  accountId: string;
  generation: number;
  createdAt: number;
  lastUsedAt: number;
};
```

- Add constants:

```ts
export const CODEX_THREAD_AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
export const CODEX_THREAD_AFFINITY_MAX_ENTRIES = 2048;
```

- Add `resolveCodexAccountForThreadDetailed()` returning:

```ts
type CodexThreadResolution =
  | { status: "selected"; accountId: string }
  | { status: "none" }
  | { status: "expired"; accountId: string };
```

- Store the selected account generation when binding a thread.
- Revalidate stored generation with `isCodexAccountGenerationLive()` before reuse.
- Prune expired entries and LRU oldest entries before adding new affinity.
- Keep `resolveCodexAccountForThread()` as the public simple wrapper for existing tests and callers.
- Explicit affinity outcome taxonomy:
  - idle TTL expiry returns `{ status: "expired" }`, deletes the affinity, and does not remap that same thread;
  - generation mismatch, tombstone, reauth, cooldown, or missing credential deletes the stale affinity and may select a healthy fallback for compatibility with deletion/failover behavior;
  - new thread ids still auto-select according to quota/failure policy.
- Update `clearThreadAccountMapForAccount()` to compare `entry.accountId`.
- Update the bind site to store `{ accountId, generation, createdAt, lastUsedAt }` instead of a string.

### MODIFY `src/codex-auth-context.ts`

- Add `CodexThreadAffinityExpiredError`.
- Use `resolveCodexAccountForThreadDetailed()` instead of the simple wrapper.
- Throw `CodexThreadAffinityExpiredError` on `{ status: "expired" }` so auth does not fall back to main/inbound credentials.

### MODIFY `src/server.ts`

- Catch `CodexThreadAffinityExpiredError`.
- Return `409 invalid_request_error` with a generic message instructing the client to start a new Codex session.
- Add the same catch branch to the WebSocket upgrade auth resolution block before the generic `throw err`, so HTTP and WebSocket do not diverge.
- Add `CodexThreadAffinityExpiredError` to the existing `src/codex-auth-context.ts` import list.

### ADD `scripts/privacy-scan.ts`

- Use `git ls-files` to scan repository-tracked source/docs/config files.
- Fail on:
  - local home paths that expose a concrete username in non-fixture surfaces;
  - raw non-fixture email addresses outside `example.test`, `example.com`, `test.com`, `@test`, and other explicit test fixture domains;
  - bearer-looking high-entropy literals.
- Exclude generated build outputs, locks, binary assets, `devlog/**` historical worklogs, and the scan script's own fixture patterns.
- Permit documentation template placeholders such as `/Users/<user>/...` and known test fixtures such as `a@b.com` only inside `tests/**`.
- Permit documentation example usernames `/Users/me/...` and `/Users/user/...` inside `docs/**` only.

### MODIFY `tests/codex-inject.test.ts`

- Replace the stale local-home fixture `"/Users/jun/.codex/opencodex-catalog.json"` with a non-home fixture such as `"/tmp/opencodex-catalog.json"` because the test only verifies that stale root `model_catalog_json` is stripped, not a user-home path.

### MODIFY `package.json`

- Add:

```json
"privacy:scan": "bun scripts/privacy-scan.ts"
```

### MODIFY `.github/workflows/ci.yml`

- Add a `Privacy scan` step after tests:

```yaml
- name: Privacy scan
  run: bun run privacy:scan
```

### MODIFY tests

- `tests/codex-routing.test.ts`
  - expired affinity returns no account through the simple wrapper;
  - detailed resolver reports `expired`;
  - LRU cap evicts the oldest entry;
  - generation replacement invalidates the mapped entry.
  - existing account deletion/failover behavior is either updated or explicitly preserved according to the taxonomy above.
- `tests/codex-auth-context.test.ts`
  - expired affinity throws `CodexThreadAffinityExpiredError` and never resolves to main.
- `tests/server-auth.test.ts`
  - expired affinity produces HTTP 409 before passthrough fetch;
  - expired affinity on WebSocket upgrade returns 409 instead of throwing a generic 500.
- `tests/codex-account-store.test.ts`
  - same refresh token aliases share one lock path/fingerprint;
  - second alias waits behind first and reuses the fresh same-grant credential without a second upstream refresh.
  - existing lock-path helper and stale-lock tests are migrated from alias-hash expectations to grant-fingerprint expectations.
- `tests/codex-inject.test.ts`
  - local-home fixture is replaced with a non-home fixture so CI privacy scanning has no known username baseline exception in tests.
- Add focused tests for `scripts/privacy-scan.ts` only if the script has non-trivial parsing helpers exported; otherwise verify by running the script itself.

### MODIFY `devlog/280_codex-multi-auth-security-patch-plan/10_final-verification-manifest.md`

- Add Phase 70 implementation commit after it exists.
- Add an item-level matrix for the 280 plan:
  - P0 blockers;
  - P1 required hardening;
  - P2 privacy/maintainability.
- Explicitly defer only live upstream behavior, push/remote CI execution, production deployment, and high-volume soak testing.

## Verification Plan

Run locally:

```bash
bun run typecheck
bun test tests/codex-routing.test.ts tests/codex-auth-context.test.ts tests/server-auth.test.ts tests/codex-account-store.test.ts
bun run privacy:scan
bun test tests
cd gui && bun run build
git diff --check
git status --short
```

Independent verification:

- Dispatch Backend read-only verifier to inspect the Phase 70 implementation and challenge whether the prior stop-audit gaps are closed.

## Implementation Evidence

Implemented in B:

- `src/codex-routing.ts`
  - `threadAccountMap` now stores account id, credential generation, creation time, and last-used time.
  - Added `CODEX_THREAD_AFFINITY_IDLE_TTL_MS` and `CODEX_THREAD_AFFINITY_MAX_ENTRIES`.
  - Added `resolveCodexAccountForThreadDetailed()` with `selected`, `none`, and `expired` outcomes.
  - TTL-expired affinity returns `expired`/`null` without silently remapping that same thread.
  - Existing deletion/reauth/cooldown/generation invalidation still deletes stale affinity and can select a healthy fallback.
- `src/codex-auth-context.ts`
  - Added `CodexThreadAffinityExpiredError`.
  - `resolveCodexAuthContext()` throws on expired affinity before main fallback.
- `src/server.ts`
  - HTTP and WebSocket upgrade auth resolution both return safe `409 invalid_request_error` for expired affinity.
- `src/codex-account-store.ts`
  - Added `refreshGrantFingerprintForToken()`.
  - Credential records preserve a non-PII `refreshGrantFingerprint` across refresh-token rotation.
  - In-process and file refresh locks use the grant fingerprint instead of the local alias.
  - Duplicate aliases sharing one grant wait behind the same refresh and reuse a fresh same-grant credential without a second parallel token refresh.
- `scripts/privacy-scan.ts`, `package.json`, `.github/workflows/ci.yml`
  - Added `bun run privacy:scan` and wired it into CI.
  - Scan covers tracked source/docs/config files for local home paths, non-fixture emails, bearer-looking literals, and token-looking literals.
- Tests updated:
  - `tests/codex-routing.test.ts`
  - `tests/codex-auth-context.test.ts`
  - `tests/server-auth.test.ts`
  - `tests/codex-account-store.test.ts`
  - `tests/codex-inject.test.ts`

## Verification Evidence

Fresh local checks:

- `bun run typecheck` passed.
- `bun test tests/codex-routing.test.ts tests/codex-auth-context.test.ts tests/server-auth.test.ts tests/codex-account-store.test.ts tests/codex-inject.test.ts` passed with 77 pass, 0 fail.
- `bun run privacy:scan` passed.
- `bun test tests` passed with 351 pass, 0 fail.
- `cd gui && bun run build` passed.
- `git diff --check` passed.

## Out Of Scope

- Live upstream account refresh-token replay testing.
- Push/remote GitHub CI execution.
- Production deployment.
- Large multi-process soak testing beyond deterministic file-lock/CAS tests.
