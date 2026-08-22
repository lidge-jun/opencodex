# Merge-order corrections (folds blocker 9 + medium findings)

Amends `060`, `070`, `080`, `090` after the round-1 audit. Read alongside them.

## Verifying merge ORDER (correction to 060 and 090)

`git merge-base --is-ancestor` cannot verify order: once both PRs are on `dev`,
each is an ancestor of the tip regardless of which merged first. Use
`git rev-list --topo-order --first-parent dev` and compare merge-commit positions.

## Wave 5B (060)

Order `#1888 -> #1902 -> #1884 -> #1892 -> #1904 -> #1898` is kept, but the stated
rationale was wrong. #1892 and #1904 both add the same two
`fastwire-characterization-*.test.ts` files as **byte-identical blobs** — #1904
already bundles the characterization suite. So "#1904 without #1892 has no
baseline" is false.

The real consequence: after whichever lands first, the other is an add/add conflict
or a no-op. Add an explicit rebase step between them and verify the surviving test
file once, rather than assuming both apply cleanly.

## Wave 5C (070) — the conflict surface

`src/adapters/cursor/live-transport.ts` is modified by **four** PRs in one train:
#1900, #1887, #1896, #1903. Further overlaps:

| Pair | Shared files |
|------|--------------|
| #1900 ∩ #1895 | `tool-definitions.ts` + its test |
| #1900 ∩ #1896 | `src/responses/parser.ts` |
| #1900 ∩ #1903 | `live-models.ts`, `cursor-hardening.test.ts` |
| #1887 ∩ #1896 | five `native-exec*.ts` files |
| #1887 ∩ #1903 | two docs files |

Every merge after the first will conflict textually. Mandatory per merge:
rebase onto the new `dev`, re-run the focused Cursor suite, and only then merge the
next. The #1887/#1896 consolidation removes one of the four, which is an additional
reason to do it before #1903.

## Wave 5D (080) — reorder, and two inverted facts

Corrected order: **`#1891 -> #1897 -> #1889`**.

#1889 and #1891 both rewrite `src/adapters/client-fingerprint.ts` and its test, so
they conflict either way — and #1889 is the only PR in the campaign with red CI
(5 failing checks). Putting it first holds the whole train hostage to it.

State corrections, both verified with `gh`:

- **#1836 is already CLOSED.** `080`'s "close as superseded" is a no-op; the only
  remaining question is whether its unique tests were migrated.
- **#1906 is OPEN (reopened).** `080` said it stays closed. Whether it should be
  closed depends on the undocumented-`v1internal` policy decision, which belongs
  to the user (see `090`).

## Wave 6 (090)

`bun run test` already runs `bun test --isolate` (`scripts/test.ts:144`), so the
two commands `090` distinguished are one command. The remote-execution preference
for the full suite stands on its own.
