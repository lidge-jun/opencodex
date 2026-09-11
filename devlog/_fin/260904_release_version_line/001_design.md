# 001 — Design: move `dev` before the release so red is never inherited

This document is the current plan in full. It supersedes two earlier versions of
itself; the history lives in `000_research.md` §11 and is not needed to implement.

## 0. The contract, stated once

**This design has exactly one goal: `dev` and its open pull requests never inherit a
version-line failure.**

It does **not** preserve, restore, or assert any ancestry relationship between
release tags and `dev`. That claim appeared in an earlier draft and is **withdrawn**
— it was both unnecessary and unachievable. Reviewer option (i), chosen deliberately:

- **Unnecessary.** The finding that `ee2d19ad4`'s single parent is the `v2.42.0`
  release commit proves the catch-up PR *happened to be* the ancestry carrier. It
  does not show anything requires ancestry. Nothing in the build, test, release or
  promotion path reads it.
- **Unachievable under this design.** `scripts/release.ts:559-591` creates and pushes
  the release commit on `main` *after* promotion. Under a pre-move, `dev` moves and
  is promoted first, so the release commit is a **descendant** of the promoted state
  and can never be its ancestor.
- **Already false today.** Measured across all 226 release tags: **10 are not
  ancestors of `origin/dev`**, every one a preview tag (`v2.33.0-preview.20260825`,
  `v2.34.0-preview.20260827`, `v2.36.0-preview.20260829`, `v2.36.0-preview.20260830`,
  `v2.39.0-preview.20260901`, `v2.40.0-preview.20260902`, among others). An
  "every release tag is an ancestor of dev" assertion fails on today's repository
  before any of this lands.

So: **release commits live on `main` and are not carried into `dev`. `dev` receives
the version line, not the commit.** That is the honest description of what this
repository does, and this design does not change it.

## 1. What cannot be removed

A version-line commit into `dev` is required before any release that would otherwise
leave `dev` at or behind the new tag. This follows from three verifiable facts:

1. `Protect dev` requires an approving review and code-owner sign-off; a bot cannot
   merge (`.github/workflows/dev-version-bump.yml:12-15`).
2. Nothing in the release path writes to `dev`: `scripts/release.ts:494`
   (`allowedBranches = ["main", "preview"]`), `:584` (pushes only that branch),
   `.github/workflows/release.yml:412-421` (pushes only the tag).
3. The invariant requires the in-tree version to outrank every tag
   (`tests/release-version-line.test.ts:88-120`).

**The precise rule, corrected:** *one reviewed `dev` move before any release that
would otherwise leave `dev` at or behind the resulting tag.* Not "one per release".
A preview cut, or a stable hotfix, needs **no** `dev` commit when `dev` already
outranks it — `decideDevVersion` returns `changed: false` in exactly that case
(`scripts/bump-dev-version.ts:120-126`). With `dev` at `2.44.0`, releasing
`2.43.1` or `2.44.0-preview.*` requires nothing.

Option C (ima2-gen's atomic push to `dev`) is the only thing that removes the
commit entirely, and it is rejected: it trades branch protection for a chore.

## 2. The mechanism

```
today:  publish vX  ->  dev is RED  ->  open PR  ->  review  ->  merge  ->  green
after:  open PR  ->  review  ->  merge  ->  promote  ->  publish vX  ->  never red
```

Same pull request, same script, same rule. It runs before the release instead of
reacting to it, and a gate in `release.yml` refuses to publish when it has not.

Nothing about npm, tags, provenance, packing or the compatibility manifest changes.
The release commit still carries the published version, so
`.github/workflows/release.yml:175-184` stays exactly as it is.

## 3. Version semantics — unchanged

This design changes **when** `dev`'s version moves, not what any version means.

| Point | Meaning | Changed? |
|---|---|---|
| `dev` | next unpublished version this line works toward | no |
| release commit (`main`) | the version being published | no |
| release commit (`preview`) | the prerelease being published | no |
| git tag `vX` | names the commit whose `package.json` says `X` | no |
| npm tarball | `X`, packed from the tree | no |
| **timing of dev's move** | **before the release, not after** | **yes** |

`tagPointsAtHead` (`tests/release-version-line.test.ts:68-81`) is **retained**: the
release commit still equals its own tag, so the exception is still load-bearing.

## 4. Phase map

```
010  shared version algebra, channel-aware and fallback-preserving   [foundation]
  |
020  --bump, computed with channel-specific semantics                [needs 010]
  |
030  pre-move: open the dev PR before the release + readiness gate   [needs 010]
  |
040  documentation + retained invariant                          [needs 020 + 030]
```

`020` and `030` are independent of each other; either may land first. `040` needs
**both** — it documents the patch-line policy `020` implements and the ordering `030`
enforces. `050` covers migration, `060` rollback and failure modes.

## 5. Consumer reconciliation

| Consumer (file:line) | Disposition |
|---|---|
| `scripts/release.ts:303-337` `compareReleaseVersions` | delegates to shared module (`010`) |
| `scripts/release.ts:342-370` channel-forward guard | survives — argument-driven |
| `scripts/release.ts:372-391` unused-version guard | survives — argument-driven |
| `scripts/release.ts:494-511` branch gate | survives |
| `scripts/release.ts:559-591` bump/commit/push | survives — still commits `X` |
| `scripts/release.ts:615` dispatch | survives — no new input |
| `release.yml:175-184` equality check | **survives unchanged** |
| `release.yml:357-368` publish | survives unchanged |
| `release.yml:39-80` bump call | replaced by a readiness gate (`030`) |
| `dev-version-bump.yml` | repurposed: opener, not repairer (`030`) |
| `scripts/bump-dev-version.ts` | retained, retargeted (`030`) |
| `tests/bump-dev-version.test.ts` | retained, extended (`030`) |
| `tests/release-version-line.test.ts` | retained; **assertions unchanged**, header comment only (`040`) |
| `tests/ci-workflows.test.ts` | workflow assertions (`030`) |
| `tests/release-helper.test.ts` | `--bump` cases (`020`) |
| `scripts/release-notes.ts:66-70` | survives; **fallback preserved** (`010`) |
| `scripts/build-release-changelog.ts:137` | survives — tag-driven |
| `gui/vite.config.ts:7` | survives — no pack-time version change |
| `scripts/generate-compatibility-version.ts:15` | survives — no pack-time mutation |
| `src/cli/star-prompt.ts:196` | survives |
| `src/update/index.ts:49,59-64` | survives — tag checkout reports `X` |
| `MAINTAINERS.md:76-90` | documentation (`040`) |
| `structure/06_docs-and-release.md` | SoT sync (`040`) |

## 6. Honest assessment

This moves one pull request earlier. It does not delete work, and it does not
maintain ancestry.

What it buys: the inherited red — the one contributor-facing harm — stops existing,
and a gate makes forgetting the pre-move a blocked release rather than a silent
failure that ten releases in a row have paid for.

What it costs: a release now has an ordering requirement that a maintainer must
follow, enforced by a gate that can refuse at an inconvenient moment (`060` §3).
