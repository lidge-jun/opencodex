# 261102 Codex pool affinity persistence — 040 plan revision (answers audit round 3)

Replaces the STORAGE design of 010/020/030 (JSON snapshot, key file, merge, tombstones, config mutation lock). Everything the
round-3 audit marked RESOLVED stays as written in 020/030: identity fences captured at bind/issuance (030 R2-B1), unknown issuer
handling (030 R2-B2), observer/home ordering and the narrowed contract (030 R2-B3, 020 B), passive rule (030), security table (030),
regression-test approach (020 Tests 1). Issue: https://github.com/lidge-jun/opencodex/issues/8091

## Why the storage changes

Round 3 showed that a whole-file snapshot needs cross-process deletion evidence and a lock that config writes also use. A small
dedicated SQLite database gives both for free: every mutation is a row operation inside a transaction, a delete is a DELETE that
no other writer can undo by republishing its memory, and the database's own locking replaces the shared config lock. The Claude
store's properties are kept: config-home location, atomic commits, bounded rows, 24 h idle expiry, digested keys, identifier-free
warnings, private file mode and Windows ACL hardening.

## Storage: `<configHome>/codex-affinity.sqlite` (module `src/codex/routing/thread-affinity-store.ts`)

- Opened lazily per config-home scope with `bun:sqlite`. Setup mirrors `configMutationDatabasePath` in `src/config/mutation-lock.ts:38`:
  `assertNotRealHomeUnderTest`, dir 0700, `hardenSecretDir` on Windows (failure -> one identifier-free warning, persistence disabled for
  the scope), file chmod 0600. `PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout=0`. Its own file: no interaction with
  `config-mutation.sqlite`, so config and credential mutations are never blocked by this store (round-3 blocker 1).
- Ownership (round-3 blocker 3): before the first open, `recordOwnedConfigPath` for the db and its `-wal`, `-shm`, `-journal` sidecars;
  every call's boolean is checked. If any returns false the store does NOT create the database (warn once, identifier-free; affinity
  stays process-local for that scope). So any file this store creates is an owned path that uninstall (`removeOwnedConfigState`) removes.
  Test: existing owned home -> paths recorded; manifest recording failure -> no database created.
- Schema v1 (`PRAGMA user_version = 1`; unknown version -> warn, disabled, file untouched):
  - `meta(name TEXT PRIMARY KEY, value BLOB)` — row `secret`: 32 random bytes, created with `INSERT OR IGNORE` then read back, so
    concurrent processes converge on one secret atomically. Replaces the key file; no corrupt-key recovery path exists.
  - `threads(row_key TEXT, scope TEXT, account_id TEXT, fence TEXT, created_at INT, last_used_at INT, PRIMARY KEY(row_key, scope))`
  - `issuers(row_key TEXT PRIMARY KEY, account_id TEXT, fence TEXT NULL, last_used_at INT)`
  - `row_key` = HMAC-SHA256(secret, domain + anchor) hex as in 020; fence as in 030.
- Corrupt or unreadable database (open/pragma/query throws SQLITE_CORRUPT/NOTADB, symlink at the path, non-regular file): warn once,
  persistence disabled for the scope, the file is left in place.

## Writes: an ordered, coalesced in-process operation queue

- Every mutation of the live maps enqueues an operation keyed so that the last operation per key wins:
  - `bind(rowKey, scope, accountId, fence, createdAt, lastUsedAt)` -> `INSERT ... ON CONFLICT DO UPDATE` (a real placement decision).
  - `touch(rowKey, scope, accountId, fence, lastUsedAt)` -> `UPDATE threads SET last_used_at = max(last_used_at, ?) WHERE row_key=? AND scope=? AND account_id=? AND fence=?`.
    A touch can never create or revive a row: if another process deleted or rebound it, the touch is a no-op (round-3 blocker 2:
    a stale in-memory pin in process B cannot undo A's clear).
  - `deleteScope`, `deleteKey` (all scopes), `issuerSet` (upsert), `issuerTouch` (UPDATE-only, same rule), `issuerDelete`.
  - `clearAccountPins(accountId)` -> `DELETE FROM threads WHERE account_id=?` (issuer history preserved, as today).
  - `clearAll` -> `DELETE FROM threads; DELETE FROM issuers`; `clearIssuers` -> `DELETE FROM issuers`.
  - A `clearAll` discards every queued operation before it; a `clearAccountPins` discards queued thread ops for that account.
- Flush: structural ops (bind, deletes, clears, issuerSet) schedule an immediate microtask-deferred flush; touches schedule a coalesced
  flush after 1 s (unref'd timer). Read-time touches capture the in-place `lastUsedAt` writes in `src/codex/routing.ts` (at its size cap)
  because the touch reads the entry's `lastUsedAt` at flush time. A flush runs the whole queue in ONE `BEGIN IMMEDIATE` transaction inside
  `withConfigDirHardeningSettled(home, syncCallback)` with an in-callback `scope.active && getConfigDir() === scope.home` check, then prunes:
  `DELETE` rows idle > 24 h or future-dated, and rows beyond the newest 2048 per table (ORDER BY last_used_at DESC, row_key, scope —
  deterministic, detour scopes evicted first for threads, mirroring `pruneLruThreadAffinities`).
- Contention: SQLITE_BUSY -> nothing committed, queue kept, retry on the next coalesced flush; one identifier-free warning after repeated
  failure. Queue bound: one entry per key (coalesced) plus per-account and full clears; if it exceeds 16384 entries (persistent failure),
  drop queued touches first, then convert the remainder to `clearAll` + binds of current live rows — the failure direction loses pins
  (today's behavior), never revives a deleted one.
- Same-row conflicts between processes resolve in commit order (SQLite serializes writers); equal timestamps need no tie rule.
- Best-effort shutdown flush via `registerOptionalShutdownHook("codex-affinity", ...)`; `trackBackgroundWork` around flushes; the db handle is
  closed on scope retirement and in a test reset export.

## Reads: lazy adoption straight from the database

- No hydrated restored map. On a live-map miss for key K whose anchor is known in the current scope:
  1. If the queue holds a delete/clear covering rowKey(K) (or a pending `clearAll`), treat as absent.
  2. Otherwise `SELECT` the rows for rowKey(K) (WAL readers are not blocked by writers; a BUSY/error read is treated as absent).
  3. Validate each: TTL, not future-dated, scope rules (020), account record live with matching `quotaHistoryIdentity` fence (030). Valid ->
     adopt into `threadAccountMap` with the record's current generation, count it in `threadAffinityEntryTotal`, run the existing LRU prune.
     Invalid -> enqueue `deleteScope` for it.
  4. Remember per scope that rowKey(K) was consulted (bounded set, same TTL) so a second miss does not query again.
- Issuers: same on `peekConversationStateIssuer` miss; fence mismatch or null -> `CODEX_UNKNOWN_CONVERSATION_STATE_ISSUER` (030).
- Because writers go through the queue and reads check it first, a delete in this process can never be re-adopted from disk before it
  is flushed, and a delete in another process is visible as soon as it commits.

## Issuer fence capture (residual from round 3)

`rememberServingConversationStateIssuer` passes `{ generation, chatgptAccountId }` from the pool auth context; the fence is captured only if the
record's current generation AND `credential.chatgptAccountId` both match (as `account-store.ts:382` does for dispatched credentials).

## Tests (adds to/replaces 020+030 test list where storage-specific)

- Two-process restart through `resolveCodexAccountForThread` (red-on-old from a `git archive origin/dev` export).
- Cross-process: A deletes/clears (row, account, issuer, full) and commits; B, holding the stale pin in memory, touches and flushes; a fresh
  process restores nothing. B re-binds after A's clear (a real placement) -> row exists. Concurrent first open -> one secret.
- A process holding a write transaction on `codex-affinity.sqlite` does not block a real config mutation (`withConfigMutationLockSync`) or
  a credential save.
- BUSY on flush -> retry succeeds later; queue overflow -> no deleted row revived.
- Ownership: paths recorded; recording failure -> no db created. Corrupt db / symlinked path / unknown user_version -> disabled, untouched.
- Bounds: >2048 rows per table keeps newest; idle and future rows pruned; worst-case UTF-8 detour scopes accepted.
- Everything else from 020/030 (fences, unknown issuer with files via responses and compact, priorAccountId retry, home A->B->A, passive,
  privacy: no raw ids in db, warnings identifier-free, db 0600).

## Docs

structure/providers/openai-tiers.md "Durable Codex pool affinity" describes the SQLite store (file, schema, secret, fences, queue, touch
semantics, bounds, ownership, contract limits). Rest as in 010/030.
