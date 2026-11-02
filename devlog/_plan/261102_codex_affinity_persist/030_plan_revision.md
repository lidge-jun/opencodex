# 261102 Codex pool affinity persistence — 030 plan revision (answers audit round 2)

Amends 020_plan_revision.md; everything in 020 not changed here stands. Issue: https://github.com/lidge-jun/opencodex/issues/8091

## R2-B1 — fences captured at the credential event

- `ThreadAffinityEntry` gains an optional `identityFence?: string` (sha256hex of `"opencodex/codex-affinity/identity/v1\0" + quotaHistoryIdentity`).
  `bindThreadAffinityForScope` already reads the account record once to take `generation`; it takes the fence from that SAME
  record read, so the fence always describes the credential the binding was made under. `handOffThreadAffinityGeneration`
  keeps the fence (an owned refresh preserves `quotaHistoryIdentity`, account-store.ts:493,554). An entry without a fence
  (legacy record, `__main__`) is memory-only. Serialization writes the captured fence; it never reads the current record.
- Issuers: `rememberConversationStateIssuer(bindingKey, accountId, now?, credentialGeneration?)`. The fence is captured only when
  the record's current generation equals the dispatched `credentialGeneration` (one record read, under the same call); otherwise
  the issuer row is written without a fence. `rememberServingConversationStateIssuer` in `src/server/responses/account-change-state.ts`
  passes `authCtx.generation` for pool contexts (`CodexAuthContext` pool kind carries `generation`, auth-context.ts:300). Callers that
  pass no generation (routing.ts, compact) produce fence-less rows. A re-login while a response is in flight therefore cannot
  attach the new identity to state issued by the old credential.
- Restore: thread row adopted only if record live AND current `quotaHistoryIdentity` fence equals the stored fence; then it takes
  the record's current generation. Issuer row: fence equal -> issuer = accountId; fence missing or different -> UNKNOWN issuer
  (R2-B2). `__main__` issuer rows are not persisted at all (behaves exactly as today after restart).
- Orca/external rotation (account-store.ts:1157) preserves `quotaHistoryIdentity` only after verifying `chatgptAccountId` and
  `sourceSubject` are unchanged, i.e. the same upstream account; restoring across it is correct. Tested.
- Tests: re-login between bind and flush (row restored? no -> dropped); re-login between dispatch and issuer completion (issuer row
  has no fence -> unknown); owned refresh/handoff before flush (restored); Orca rotation (restored); delete + re-add same id (dropped).

## R2-B2 — unknown issuer is not proof of an account change for files

- `thread-affinity.ts` exports `CODEX_UNKNOWN_CONVERSATION_STATE_ISSUER` (a value no account id can equal; account ids match
  `^[A-Za-z0-9._-]{1,64}$` or `__main__`). `peekConversationStateIssuer` may return it only for a restored row.
- `applyAccountChangeConversationStateScrub`: unknown counts as changed (conservative continuation scrub; one cold turn).
- `accountChangeFileReferenceRefusal`: unknown issuer is ignored; refusal only when a KNOWN issuer differs or `priorAccountId`
  proves an in-request move. So persistence adds no file refusal that did not exist before.
- Tests: pool re-login (fence mismatch) + file reference -> scrub of continuation state, no 400; known pool move + file -> 400 as today;
  unchanged pool account -> neither.

## R2-B3 — home switching and observer ordering

- The anchor observer first resolves the active scope (`current()`: retire the old scope and clear live affinity maps if the home
  changed) and only then records the anchor in the new scope. So the first request under home B keeps its own anchor.
- Anchor cache: per scope, LRU, refreshed on every derivation, bound 4096 (2x the binding bound), same 24 h TTL. Session-bearing
  requests re-derive on every request, so their anchors are always present. A key that reaches routing without being observed in
  the current scope (recorded session-less lineage reused after an anchor eviction or after a home change, legacy keys, directly
  bound test keys) is memory-only: it is neither written nor matched. This is part of the documented narrowed contract.
- Tests: first B request persists under B; A -> B -> A with pending writes, both direct derivation and recorded lineage; no B row
  ever appears in A's snapshot or vice versa; anchor eviction then recorded-lineage lookup -> memory-only.

## R2-B4 — cross-process serialization

All durable writes happen inside `withConfigDirHardeningSettled(home, () => withConfigMutationLockSync(() => ..., home))`
(`src/config/mutation-lock.ts:104`: OS-backed SQLite `BEGIN IMMEDIATE`, `busy_timeout=0`, released on process exit). Under the lock:

1. Key: re-read the key file. Valid -> adopt it if it differs from ours (rows are derived lazily from anchors, so adoption is safe;
   restored rows hydrated under a different key are discarded). Missing -> write ours. Invalid regular file -> replace with ours
   and treat the existing snapshot as empty. Unreadable/symlink/non-regular -> `disabled`, no write. No `exclusive` publish is used,
   so atomic-write records ownership as it does for other config files (verify; otherwise call `recordOwnedConfigPath` and treat a
   `false` result as a one-time identifier-free warning, persistence continues).
2. Snapshot: read the on-disk snapshot (bounded) and MERGE: for each (rowKey, scope) keep the newest `lastUsedAt` of disk vs ours,
   then apply our pending tombstones recorded since our last successful publish: per-row deletes, per-account deletes
   (`{accountId, at}`: drop disk rows of that account with `lastUsedAt <= at`) and full clears (`{at}`: drop disk rows with
   `lastUsedAt <= at`). Trim to the bounds. Write atomically. Clear tombstones only after the write succeeds.
3. Lock busy -> nothing written, state stays dirty, retried by the next coalesced flush (1 s, unref'd). Repeated failure warns once,
   identifier-free.

Two proxies on one config home therefore never lose each other's newer rows and never publish under a key the other replaced.
Tests: two processes creating the key concurrently end with one key and both see it; concurrent invalid-key recovery; two writers
with disjoint rows -> union; writer A deletes a row writer B still has older -> stays deleted; lock held by another process -> retry.

## R2-B5 — reset and removal semantics

| Entry point | Effect on disk |
|---|---|
| `clearThreadAccountMap()` — config, provider, model, combo, agent-settings, logs-usage, oauth-account and shared management routes, server index (`rg -n clearThreadAccountMap src`) | full-clear tombstone; next publish writes a snapshot without those rows (issuers cleared too, as today) |
| `clearConversationStateIssuerMap()` | issuer table cleared on disk |
| `clearThreadAccountMapForAccount(id)` — account removal, auto-pause, plan exclusion, quota refusal, account-preservation | per-account tombstone for pins only; issuer history is preserved, as today (thread-affinity.ts:223) |
| account deletion without a clear | row fails the fence on restore and is discarded |
| uninstall (`removeOwnedConfigState`) | both files are owned config paths and are removed |

Clears bump the revision and fence pending writes (the publish serializes current state at callback time under the scope check).
Tests: restart after each row of the table.

## R2-B7 (partial) — passive

Under `isPassiveRead()`: no hydration, adoption, scope switch, anchor recording, scheduling or flushing. Tests with a populated
snapshot, an already scheduled write, passive getters and observer calls, and existing live maps.

## Security table corrections (non-blocking 1)

- Add rows: compact (`src/server/responses/compact.ts:1684` uses the ephemeral key as an in-memory issuer binding key only),
  previous-response replay (keyed by response ids and its own scope, not the affinity key — implementer confirms with file:line),
  advisor ledger (`src/advisor/state.ts:213` derives its own hash from `_cursorClientThreadId`, which stays ephemeral -> unchanged).
- Correct the linkability claim: anyone who can read two snapshots of the same home can link identical row keys and the plaintext
  pool account ids across restarts without the secret; the secret is needed only to test a candidate session id against a row.
  Both files are owner-only (0600 / config-dir ACL). The key file is itself a new durable artifact.

## Security review

Dedicated Terra security review before the PR; per MAINTAINERS.md security-sensitive changes also need explicit maintainer security
review — the PR says so and requests it.
