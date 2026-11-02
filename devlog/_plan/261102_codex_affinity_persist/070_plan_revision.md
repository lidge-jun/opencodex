# 261102 Codex pool affinity persistence — 070 plan revision (answers audit round 6)

Amends 060; everything else in 060 stands. Issue: https://github.com/lidge-jun/opencodex/issues/8091

## R6 blocker — final flush runs while ownership is still logically held

`leaseFor` (src/lib/spend-ledger-owner.ts:200-213) decrements references and nulls `activeOwner` before running `releaseHooks`, so a hook
cannot pass `assertStorageOwned`. Change (minimal, in spend-ledger-owner.ts):

- New `onSpendLedgerOwnerReleasing(hook: () => void): void` registry. In `release()`, when this is the FINAL reference
  (`owner.references === 1`), set a module flag `releasing = true`, run the releasing hooks (each in try/catch), clear the flag, then
  decrement, null `activeOwner`, run the existing `releaseHooks`, ROLLBACK and close as today. During releasing hooks the owner, its
  generation and the physical lock are unchanged, so `assertStorageOwned(token)` passes for the current-generation token only.
- While `releasing` is true, `acquireSpendLedgerOwner` and `mintSpendLedgerStorage` throw NOT_HELD (no reentrant acquisition or new tokens
  from inside a hook). Ordinary flushes after release fail `assertStorageOwned` exactly as before; stale tokens from an earlier generation
  are refused as before.
- Optional neutral alias: export `mintStateDirectoryStorage`/`assertStateDirectoryStorageOwned` as thin aliases of the spend-named functions,
  with a doc comment that the lease is the state directory's single-writer primitive. (Implementer may skip if maintainers' naming rules
  object; behavior is identical.)
- The affinity store registers ONE releasing hook: sync flush of log + touches, `meta.clean = 1` in the same transaction, close, retire scope.
  Hook failure -> rollback, `clean` stays 0, close, retire (fail closed). The existing `onSpendLedgerOwnerReleased` hook is used only to make
  sure the scope is retired if the releasing hook did not run (defensive).
- Tests: pending structural op committed and restored across a real final release (two leases in one process: first release does not flush/close,
  final does); stale-token refusal after release + reacquire; hook failure leaves `clean = 0` and the next owner restores nothing; acquire/mint
  inside a releasing hook is refused; existing tests/lib/spend-ledger-owner.test.ts and tests/server/spend-ledger-owner-startup.test.ts still pass.

## R6 residuals, accepted and specified

- Stop failure keeps ownership until process exit; abrupt exit has no release hook -> `clean = 0` path (pins discarded). Documented.
- The final transaction is synchronous and bounded (at most the pending log, itself bounded at 16384 entries + touches); filesystem stalls
  can still delay shutdown. Documented in structure.
- After final release, late async work is memory-only: the scope is retired, its token is invalid, nothing reopens under it and `clean` is never
  touched again by that scope.
- Multiple servers in one process share the lease; the store stays live until the last reference releases.
- Test isolation (060 wording corrected): tests that start a server AND exercise affinity will create `codex-affinity.sqlite` in their isolated
  home; the handle closes on the final server stop. Implementer runs every suite that starts a server and uses pool affinity
  (`rg -l startServer tests` intersected with affinity entry points), checks teardown order, and adds a Windows-safe close in any helper that
  resets state without stopping the server.
- Passive calls stay passive under a held lease: no open, adoption, scheduling or flush. Lazy open happens before any durable deletion that
  must invalidate an unadopted row (a delete for a key with a known anchor opens the store first when owned).
- Ownership race for existing homes: residual stated in the PR; a follow-up issue for `recordOwnedConfigPath` is filed before the PR opens
  and linked from it.
- Unsupported version/shape tests assert the application wrote nothing (no schema/meta change, no row change); they do not claim byte-for-byte
  identity where SQLite's own hot-journal recovery may touch the file.
