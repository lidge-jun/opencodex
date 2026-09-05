# 040 — Phase 4: documentation, and one retained invariant

The smallest phase, and documentation-only in effect. It corrects the release policy
that currently instructs maintainers to do the chore in the wrong order, syncs the
architecture SoT, and records why the invariant's equality exception is retained
rather than removed.

Depends on: `020` **and** `030`, both landed, with `030` exercised by one release.
`020` is required because §4a documents the patch-refusal policy that `020`
implements; documenting a rule the code does not yet enforce would be worse than
documenting nothing.

## 1. File change map

| Path | Action |
|---|---|
| `tests/release-version-line.test.ts` | MODIFY — header comment only; **no assertion changes** |
| `MAINTAINERS.md:76-90` | MODIFY — ordering correction |
| `structure/06_docs-and-release.md` | MODIFY — SoT sync |

**No deletions, and no ancestry test.** An earlier draft proposed asserting that
every release tag is an ancestor of `dev`. That is withdrawn: it is false on today's
repository (10 of 226 tags are not ancestors, all previews), it cannot hold under the
pre-move ordering, and nothing depends on it. `001_design.md` §0 states the contract.

## 2. The invariant keeps its exception

`tests/release-version-line.test.ts` is correct as written. Its three outcomes —
ahead, equal-on-the-tagged-commit, behind — remain right, and `tagPointsAtHead`
(lines 68-81) is retained: the release commit still equals its own tag.

No new comparator case is added. An earlier draft proposed asserting
`compareReleaseTags("v2.42.0", "v2.42.0") === 0`, which is tautological: it exercises
the comparator, not `tagPointsAtHead`, and would pass against a build that had
deleted the exception entirely.

What actually exercises the exception is acceptance criterion 1 (§6): running the
invariant on a checkout of the newest tag, where `ordering === 0` and the test passes
**only** because `tagPointsAtHead` returns true. That path already exists and needs
no new code.

The change here is therefore documentation-only: the file header (lines 8-29) gains
one sentence recording that the repair moved from after the release to before it, so
a future reader does not reconstruct the catch-up as the intended design. The
assertions are untouched.

## 3. `MAINTAINERS.md`

Lines 76-90 currently open "**Closing out a release includes moving `dev`'s version
line forward.**" That instruction is the cause of the recurrence: done at closing
time, it is always too late.

```diff
-- **Closing out a release includes moving `dev`'s version line forward.** A published
-  release leaves `dev` carrying a version at or behind it ...
+- **Opening a release starts by moving `dev`'s version line forward.** Before cutting
+  a release, `dev` must already outrank the version being released; `release.yml`
+  asserts this and refuses to publish otherwise. Dispatch
+  `.github/workflows/dev-version-bump.yml` with the intended version, merge the pull
+  request it opens, then promote and release. When `dev` already outranks the target
+  — a preview cut, or a stable hotfix below `dev`'s line — no move is needed and the
+  workflow reports `changed=false`.
+
+  Done AFTER the publish, as this repository did for ten releases (`32529c2b2`,
+  `e4a85d134`, `076ad3036`, `befcac3e1`, then #3045, #3076, #3127, #3265, #3354,
+  #3434), it leaves `dev` and every open pull request carrying a failure
+  contributors cannot fix from their own diff. The pull request itself does not go
+  away — `Protect dev` requires a reviewed merge. Design:
+  `devlog/_plan/260904_release_version_line/`.
```

Note what this does **not** claim: nothing about ancestry, and not "one PR per
release". The conditional phrasing matches `decideDevVersion`'s actual no-op
behaviour (`scripts/bump-dev-version.ts:120-126`).

## 4. `structure/06_docs-and-release.md`

Lines 181, 240 and 253 describe the release path. They get the same ordering
correction and a pointer to this unit. Per `AGENTS.md`, the unit moves to
`devlog/_fin/` when the work closes — it is a design record of shipped work at that
point and contains no security material.

## 4a. The patch-line consequence must be documented

`020` §4.0 chose global cross-channel ordering, which means **publishing a preview
for a higher core closes the older stable patch line**: once `v2.43.0-preview.1`
exists, `2.42.1` ranks below the highest tag and cannot be released.

That is operator-visible policy, not an implementation detail, and it is surprising
enough that discovering it from a refusal message would be a bad experience. Both
`MAINTAINERS.md` and `structure/06_docs-and-release.md` state it plainly:

> Opening a preview for the next core ends the current patch line. After
> `vX.Y.0-preview.*` is tagged, a fix ships as part of `X.Y.0`, not as
> `X.(Y-1).(Z+1)`. The release helper refuses such a bump rather than producing a
> version the repository would reject.

`020` documents the same consequence in `docs-site` for contributors; this phase
covers the maintainer-facing files.

## 5. IN / OUT

IN: the test file's header comment, and the two documentation files.

OUT: any code change; any assertion change; any deletion; any ancestry assertion;
the workflow (`030`).

## 6. Accept criteria

1. `bun test tests/release-version-line.test.ts` green, including on a checkout of
   the newest tag — via the retained exception.
2. `bun run typecheck`.
3. `rg -n 'Closing out a release includes moving' MAINTAINERS.md` returns nothing.
4. `rg -n 'ends the current patch line' MAINTAINERS.md structure/06_docs-and-release.md`
   finds the §4a wording in both files.

The repository-wide suite is not warranted: this phase deletes nothing and imports
nothing new. `AGENTS.md` still requires it before the PR is marked review-ready,
which is a separate gate from this phase's acceptance.

Criterion 1 is the phase's real gate and the only thing that exercises
`tagPointsAtHead`: on a tagged checkout `ordering === 0`, and the test passes only
because the exception returns true.

## 7. Activation grounding

| Path | Trigger | Observable |
|---|---|---|
| equality on the tagged commit | checkout `v2.42.0`, run the invariant | passes via `tagPointsAtHead` |
| equality off the tagged commit | `dev` at a published version | fails with the existing message |

No conditional code is added, so there is nothing further to activate.
