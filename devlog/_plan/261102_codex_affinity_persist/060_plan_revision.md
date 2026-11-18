# 261102 Codex pool affinity persistence — 060 plan revision (answers audit round 5: reuse the existing single-writer lease)

Amends 050. Items resolved in rounds 3-5 stay (dedicated database, fences captured at bind/issuance incl. chatgptAccountId, unknown
issuer, observer/home ordering and narrowed contract, passive rule, security table, ordered structural log + UPDATE-only touch set,
deterministic pruning, regression-test approach). 050's own lease (locking_mode=EXCLUSIVE), standby queue, overflow drop rule and
failure unlink are REMOVED. Issue: https://github.com/lidge-jun/opencodex/issues/8091

## The product already has one serving writer per state directory

`src/lib/spend-ledger-owner.ts` holds a process-lifetime SQLite write transaction on `spend-ledger-owner.sqlite` (acquireSpendLedgerOwner:144).
`startServer` acquires it first (`src/server/index.ts:210` via `acquireSpendLedgerServerLifecycle`); a second server on the same home fails with
`SPEND_LEDGER_OWNER_BUSY` and does not serve; a restart child waits up to 5 s for the parent's release (restartHandoffWaitMs). Leases are
reference-counted per process; release hooks (`onSpendLedgerOwnerReleased`) run BEFORE the owner transaction is rolled back and closed
(leaseFor:200-213), i.e. while the lock is still held. `mintSpendLedgerStorage(fileName)` issues a storage token bound to the current owner
generation and `assertStorageOwned(token)` refuses it after any release/reacquire (lines 255-326). The affinity store uses exactly this.

## Activation and writes

- The store is active for a config home only while `mintSpendLedgerStorage("codex-affinity.sqlite")` succeeds (this process owns the lease for
  the current home). Otherwise affinity is process-local, exactly as today: CLI processes, passive reads, tests that never start a server.
  No separate arming call; no change to `src/server/index.ts`.
- Every open and every flush first calls `assertStorageOwned(token)`; NOT_HELD or a generation change retires the scope (close the handle,
  drop log/touches, memory-only) and writes nothing. A newer owner generation mints a new token and a new scope.
- One `onSpendLedgerOwnerReleased` hook (registered once): synchronously flush the pending log and touches, set `meta.clean = 1` in the same
  transaction, close the handle, retire the scope. It runs while the lease is still held, so no next owner can open the database before the
  final state is committed. If that flush fails, `clean` stays 0 (below). Mutations after release are memory-only (the server has stopped serving).
- Open (lazy, first affinity access while owned), synchronous like `prepareOwnerPath`: `assertNotRealHomeUnderTest` FIRST (before ownership
  initialization), `recordOwnedConfigPath` for the db and its `-journal`/`-wal`/`-shm` sidecars (every boolean checked; any false -> do not create,
  warn once), create with `openSync(path, "wx", 0o600)` tolerant of EEXIST, `assertPrivateFile`-equivalent (regular, not a symlink, nlink 1,
  owned by uid on POSIX), `hardenSecretPath(path, { required: true })` on Windows. Then `new Database(path)`, `PRAGMA busy_timeout = 0` (the lease
  guarantees no other writer; any BUSY is an anomaly -> disable), default rollback journal (no journal-mode change, so nothing is modified
  before the version check), `BEGIN IMMEDIATE`, read `user_version` and `sqlite_master`: empty v0 -> create schema v1 + `meta.secret` + `meta.clean=0`;
  v1 -> read `meta.clean`; if 0 (previous owner crashed or failed its final flush) DELETE all thread and issuer rows (fail closed: pins
  fall back to normal selection, never revive a release that was not committed); then set `meta.clean = 0` for this ownership; any other
  version/shape -> ROLLBACK, close, disable, file untouched. COMMIT. Any failure: rollback, close, classify, identifier-free warning.
- Flushes are synchronous SQLite transactions scheduled from a microtask (structural) or a 1 s unref'd timer (touches); no async ACL
  barrier is needed because no file is created after open (the transient `-journal` inherits the hardened directory, as for the owner db).
- Flush failure: rollback, keep the log, retry next flush. If the log exceeds 16384 entries or 3 consecutive flushes fail, the scope is
  POISONED: the log is dropped, nothing more is written, and `clean` is never set to 1 — the next owner discards every row. No unlink, no
  handoff race: the file stays under the lease until this process releases or dies.

## Why the round-5 blockers are closed

1. Standby replay: there is no standby. Only the lease holder writes, and a new holder can open only after the previous holder's release
   hook committed (or it died, in which case `clean = 0` discards everything). Decisions are never replayed across ownerships.
2. Close-then-unlink: removed. Invalidation is `clean = 0` + DELETE at the next open, serialized by the lease.
3. Dropped deletions: no drop rule. Overflow poisons the scope, which fails closed at the next start.
4. Ownership race for existing homes: REBUTTED as pre-existing and out of lane, with mitigation. New homes own the four paths from creation
   via `INITIAL_OWNED_PATHS` (no manifest update, no race). Existing homes use `recordOwnedConfigPath` before creation — the identical
   mechanism `spend-ledger-owner.sqlite` (prepareOwnerPath:93), `config-mutation.sqlite` (mutation-lock.ts:62) and every default
   `atomicWriteFileNoFollow` write rely on today. The stale-cache rewrite is a defect of that shared API; fixing it would change every
   writer and is outside this lane's scope. The PR states it as a residual: if another process's stale manifest rewrite drops the entry,
   uninstall can leave `codex-affinity.sqlite` (row digests + opaque pool ids, no tokens) behind. A follow-up issue will be filed for the API.

## Tests (storage-specific; replaces 050's cross-process list)

- Two-process restart through `resolveCodexAccountForThread` with real `startServer`-equivalent lease acquisition (or `acquireSpendLedgerOwner`
  directly) — red-on-old from a `git archive origin/dev` export.
- Not owned -> no file created, no handle; owned -> created 0600 with ownership recorded; INITIAL list contains the four names.
- Release hook: pending structural op made just before release is committed and `clean = 1`; next owner restores it.
- Crash: kill an owner subprocess with pending/committed rows -> next owner finds `clean = 0` and restores nothing.
- Poison: injected flush failures / log overflow -> next owner restores nothing.
- Release + reacquire in one process (generation change): old token refused, new scope, no writes from the old one.
- Second server on the same home is refused by the existing lease (document; existing test covers BUSY) and never opens the affinity db.
- Unknown version / non-v1 schema -> untouched bytes, disabled; symlink or non-regular path -> disabled.
- Windows: start, use, stop (release hook closes), `removeTreeWithRetry` succeeds.
- Everything else from 020/030/040 (fences, unknown issuer via responses/compact/retry, home switch, passive, bounds, privacy).
- Guards: test-home guard (real home refused before ownership init), core-lab boundary, config-ownership tests, file-size ratchet, test layout.
