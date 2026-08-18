# WP2 — #1899 / harden-before-publish ordering (Wave 5A-2) — rev 2 after audit

> Rev 2 folds blocker 5. Rev 1 named three test files; two of them have no
> effects recorder to order, and both already carry #1881's guards on `dev`.

## Real state of #1899

`mergeable=CONFLICTING`, `mergeStateStatus=DIRTY`, head `8ab0aa8d0`. It conflicts
precisely because #1881 already landed two of its three files:
`tests/dsh-writer-lock.test.ts:173` already has the `existsSync` + win32 guard and
`tests/native-main-claim.test.ts:174` already carries the POSIX-only guard.

Its remaining unique value is one file: `tests/codex-catalog-writer.test.ts`,
where `dev` still uses unbound `effects.some(...)` checks (lines 242-246) that
would pass even if the harden and the publish touched different files. #1899
binds all three effects to one temp path.

## Correction to rev 1

Rev 1 claimed the ordering assertion was #1899 residue. It is not: #1899 asserts
set membership (`expect(effects).toContain(...)`), not index order. A writer that
published first and hardened after still passes #1899's diff. Index ordering is
therefore **new work**, and it is only implementable in the one file that has an
ordered `effects` array (recorder at `tests/codex-catalog-writer.test.ts:60-95`).

## File change map

| File | Change |
|------|--------|
| `tests/codex-catalog-writer.test.ts` | adopt #1899's temp-path binding, then add `indexOf(harden) < indexOf(publish)` for that same temp path |

Building effects recorders for the other two files is out of scope for Wave 5A;
their Windows/POSIX split is already correct on `dev`.

## Accept criteria

1. The ordering assertion fails when harden and publish are swapped.
   *Activation:* invert the order in a scratch edit, capture the red run, revert.
2. `bun test tests/codex-catalog-writer.test.ts` green afterwards.
3. No assertion duplicated from #1881.

## Closure

#1899 cannot merge as-is (CONFLICTING/DIRTY, head `8ab0aa8d0` — re-verified after a
transient `UNKNOWN` reading). Land the one-file residue as a direct commit on `dev`,
then close #1899 with a comment naming the commit, what was taken, and what #1881
already covered.

## Outcome (executed)

DONE. Two commits on `tests/codex-catalog-writer.test.ts`:

| Commit | Change |
|--------|--------|
| `fb5ceee35` | bind `temp:`/`harden:`/`publish:`\|`rename:` to one temp path; assert `hardenIndex < publishIndex` |
| `50a057e20` | state the scope limit the review asked for |

**Red proof.** Forcing the harden index above the publish index fails 4 of 9 tests;
restoring returns all 9 to green. An independent reviewer reproduced this with two
ablations on a scratch copy and found something the plan had not predicted: for the
two backup mutators the index comparison is the **only** detector. `publishNoReplace`
is `linkSync`, so a temp hardened after publication still shares the destination's
inode — `chmod` succeeds, `statSync` reads `0o600`, the leftover-`.tmp` check passes,
and every other assertion agrees nothing is wrong. Only the order disagrees.

**Scope limit, now written into the test.** `io` is an injected seam, so what is
asserted is production's call order (`src/config.ts:236`,
`src/codex/internal/catalog-writer.ts:147` both run write → harden → publish).
Supplying `io` bypasses `hardenSecretPath`, so this proves hardening is *requested*
on the temp before publication, not that it restricts. The Windows NTFS ACL is
covered in `tests/windows-secret-acl.test.ts`.
