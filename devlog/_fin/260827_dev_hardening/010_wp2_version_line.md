# wp2 — move dev's version line past the published channel

Blocker 1 in `000_inventory.md`. Smallest change with the largest promotion impact.

## The change

`package.json` `version`: `2.32.1-preview.20260825` -> `2.34.0`.

One line. No other file carries the product version: a repo-wide search for the
current and neighbouring version strings, excluding `node_modules`, `.tmp`, `devlog`
and `gui/dist`, hits only `package.json:3`. `gui/package.json` is `0.0.0` and
unpublished; `docs-site/package.json` is `0.0.1`; `src/generated/*` are catalog
hashes, not semver; the install scripts check Node, not opencodex.

## Why `2.34.0` and not something else

| candidate | verdict |
|---|---|
| `2.32.1-preview.20260825` (current) | BEHIND `latest`; rejected by `assertChannelVersionMovesForward` |
| `2.33.0` | consumed — on npm, tagged `v2.33.0`, GitHub Release exists |
| `2.33.0-preview.*` | moves preview forward but strands the `2.33.0` core, which is already stable |
| `2.33.1` | mechanically legal, but labels 254 commits / 551 files / +44296 as a patch |
| **`2.34.0`** | free (`npm view` E404, no `v2.34.0` tag), forward on `latest`, matches the range's content |

The minor-not-patch choice follows the precedent recorded in `32529c2b2`: "2.27.0
rather than 2.26.1, because the range carries user-visible behavior changes and not
only fixes." This range carries new providers, new config surfaces, GUI work and
adapter contract changes.

## What this does NOT do

It does not publish, tag, or promote. `scripts/release.ts` refuses to run anywhere but
`main`/`preview`, and the actual release remains a maintainer action. This only stops
`dev` from carrying a string that is both a channel regression and, after promotion, an
unpublishable duplicate.

Do NOT "sync" by merging `main`/`preview` back into `dev`: that lands the consumed
`2.33.0` string on top of 254 newer commits and reintroduces the same trap.

## Regression test

`tests/release-version-line.test.ts` (new): assert the in-tree version is a valid
semver AND is strictly forward of the highest version reachable from
`origin/main`'s tags in the repository, so a future `dev` cannot silently sit behind
its own release branch again. This is the check `32529c2b2` fixed by hand once and
that nothing currently enforces.

If the test cannot read remote refs in CI, scope it to the local tag set and skip
cleanly when no tags are present, rather than asserting a hardcoded number that would
need editing every release.

## Verification

- `bun x tsc --noEmit`
- `bun test ./tests/release-version-line.test.ts` and `./tests/release-helper.test.ts`
- full suite on `ssh lidge` at the branch head
