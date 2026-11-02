# 261102 Codex pool affinity persistence — 050 plan revision (answers audit round 4: single writer)

Amends 040 (SQLite store). Items marked RESOLVED in rounds 3-4 stay: dedicated database separate from the config mutation lock,
fences captured at bind/issuance including `chatgptAccountId` (030/040), unknown issuer (030), observer/home ordering and narrowed
contract (020/030), passive rule, security table, deterministic pruning, regression-test approach. Issue: https://github.com/lidge-jun/opencodex/issues/8091

## Step back (loop-engineering, repeated reviewer FAIL)

Rounds 2-4 failed on the same root: several processes writing one store and reconciling stale memory. Instead of more ordering
machinery, the store gets exactly ONE writer per config home, enforced by the operating system, and only the proxy server writes.

## Arming: only the running proxy persists

- `armCodexAffinityPersistence()` (store module) sets a process flag; the store opens nothing and writes nothing until armed.
  `startServer` arms it synchronously (no await; preserves the Lab-activation window guard in `tests/lab/core-lab-boundary.test.ts`),
  via an existing non-capped startup helper in `src/server/index/*` if one fits, otherwise the single line of headroom in
  `src/server/index.ts` (cap 893, now 892). CLI processes, management passive reads and every test that does not arm behave
  exactly as today: no files, no handles. This also removes Windows open-handle teardown risk from existing tests.
- Tests that exercise the store arm explicitly and close it in teardown via `resetCodexAffinityStoreForTests()` (flush + close + disarm).

## Single writer: SQLite exclusive locking mode

- Open sequence (all inside `withConfigDirHardeningSettled(home, sync)`, scope check inside the callback): `assertNotRealHomeUnderTest`,
  ownership (below), dir 0700 + `hardenSecretDir` on Windows, `new Database(path, {create:true})`, chmod 0600, then
  `PRAGMA busy_timeout=0`, `PRAGMA locking_mode=EXCLUSIVE`, `PRAGMA journal_mode=WAL` (exclusive mode uses no `-shm`), `BEGIN IMMEDIATE`
  (acquires and, in exclusive mode, KEEPS the write lock until close), read `user_version`: 0 + empty -> create schema v1 and secret;
  1 -> continue; anything else -> ROLLBACK, close, disable (file untouched). COMMIT. Any failure -> rollback, close the handle, classify.
- Classification: SQLITE_BUSY/LOCKED at open = another process owns the store -> state `standby`; corrupt/NOTADB/symlink/non-regular/
  unknown version/ACL failure -> `disabled` for the scope (one identifier-free warning, file untouched).
- `standby`: affinity is process-local (today's behavior). The open is retried on a later affinity access at most every 2 s
  (no timer). This covers a restart whose old process is still exiting. While in standby, mutations are recorded in the pending
  log (below) bounded at 4096 key groups; on overflow the oldest key group (all ops for that rowKey) is dropped — the database then
  keeps its pre-gap state for that key, which is the state persistence intends to restore and is fence-checked on adoption.
- The lock is released on close and on process exit (OS file lock), so a crash never wedges the next start.
- Two-process tests: B opening while A holds the store gets standby and never writes; A closes -> B's retry acquires; A crash
  (kill) -> next process acquires.

## In-process write log (answers round-4 blockers 1-3)

- Ordered structural log: bind, deleteScope, deleteKey, deleteAccountPins, clearAll, clearIssuers, issuerSet, issuerDelete appended in
  call order. No per-key coalescing of structural ops; `clearAll` may drop entries before it (they are dominated), nothing else is dropped
  except the standby overflow rule above.
- Touch set (rowKey+scope -> latest, issuer rowKey -> latest), separate from the log. At flush, in ONE transaction: replay the log in
  order, then apply touches as `UPDATE ... SET last_used_at = max(last_used_at, ?) WHERE row_key=? AND scope=? AND account_id=? AND fence=?`.
  Bind-then-touch: the bind inserts, the touch updates it. Delete-then-touch: the touch matches nothing. A touch never inserts.
- With a single writer, commit order equals this process's call order, so stale cross-process writes cannot exist; validation-driven
  deletes are unconditional because nothing else can have replaced the row.
- Flush failure while open (disk full, I/O): rollback, keep log and touches, retry on the next flush. After 3 consecutive failures:
  close and unlink the database (an owned path) so no stale pins can be restored, disable for the process, warn once. If the unlink
  fails too, warn; the next start only adopts rows that pass the fence and are then re-checked by the resolver.

## Reads

On a live-map miss with a known anchor and the store open: if the log holds a delete/clear covering rowKey(K) -> absent; else
`SELECT` (we hold the only connection, so no BUSY). Valid -> adopt (030 validation, current generation, entry count + LRU). Invalid ->
append `deleteScope`. A per-scope "consulted" set prevents re-querying the same rowKey; read errors are not cached and do not disable
unless classified corrupt. In standby, misses do not read.

## Ownership (round-4 blocker 4)

- Add `codex-affinity.sqlite`, `codex-affinity.sqlite-wal`, `codex-affinity.sqlite-journal` (and `-shm` defensively) to
  `INITIAL_OWNED_PATHS` in `src/lib/config-ownership.ts`, next to the `config-mutation.sqlite*` entries. Every home created from now
  on owns the files from creation, with no manifest update and no race.
- Existing homes: `recordOwnedConfigPath` for each path before first create; a `false` result -> do not create the database (warn once).
  The residual race — another process holding an older cached manifest rewriting it — is a property of `recordOwnedConfigPath` shared by
  every config writer today (`atomicWriteFileNoFollow` default path, `config-mutation.sqlite`, the Anthropic affinity file); fixing that
  API is outside this lane and is noted in the PR as pre-existing. Tests: new home lists the paths; existing owned home records them;
  recording failure creates nothing; `removeOwnedConfigState` removes the db and sidecars.

## Handle lifetime

Closed on: scope retirement (home change), `resetCodexAffinityStoreForTests`, the shutdown hook (flush then close), the failure path.
Windows test: arm, use, reset, `removeTreeWithRetry` succeeds.

## Guards to extend/run

`tests/ci-workflows/test-home-guard.test.ts` (the new writer refuses before any filesystem mutation when pointed at the real home),
`tests/lab/core-lab-boundary.test.ts` (new imports do not reach Lab; startServer window scan), config-ownership tests (INITIAL list),
file-size ratchet, test-layout guards, plus the 020/030/040 test list adjusted: cross-process cases become single-writer cases above.
