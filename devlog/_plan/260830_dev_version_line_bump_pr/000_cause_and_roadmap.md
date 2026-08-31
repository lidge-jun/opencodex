# dev version line: stop repairing it by hand

Unit: `devlog/_plan/260830_dev_version_line_bump_pr/`

Named for what it ships: a version-bump PULL REQUEST opened when a release publishes.
The unit was briefly called `..._autobump`, which an audit correctly rejected — the
workflow prepares the change and a human merges it, so nothing is automatic end to
end.
Goalplan: `repair-the-dev-version-line-and-add-a-post-relea`

## The symptom, today

`dev` head `df8b3882f` carries `package.json` version `2.36.0`. Tag `v2.36.0`
names `c7d8407d2`, which is `origin/main`. So the tree claims a version that is
already published from a different commit, and
`tests/release-version-line.test.ts` reports exactly that:

```
(fail) release version line > the in-tree version is never behind a released one
error: package.json version 2.36.0 equals release tag v2.36.0, but this commit is
not the one that tag names. The tree claims an already-published version:
publishing is refused as a duplicate. Bump package.json.
```

This fails CI jobs `test 2/4` and `macos` on `dev` itself (run 33312566315, cut at
`c2778ca3a` — `dev` has since advanced to `df8b3882f` and the failure still
reproduces there) and therefore on every PR opened against it. PR #3007 inherited
the same two red jobs for a two-file GUI change, and branch protection refused the
merge until it was overridden.

## Why a one-line bump is not the fix

The same defect has been repaired by hand FOUR times:

| commit | what it did |
|---|---|
| `32529c2b2` | `2.24.2` -> `2.27.0`, after dev trailed the published channel by two releases |
| `e4a85d134` | `2.32.1-preview.20260825` -> `2.34.0`; also ADDED `release-version-line.test.ts` |
| `076ad3036` | `2.34.0` -> `2.35.0`, right after v2.34.0 shipped |
| `befcac3e1` | `2.35.0` -> `2.36.0`, after v2.36.0-preview.20260829 shipped |

Note the second row: the detector was added DURING this sequence, and two more
hand-repairs followed it. Visibility was never the missing piece — that is the
finding that decided the design in `020`.

Four repairs of one cause is a missing actor, not four accidents. The cause is
structural and visible in `scripts/release.ts`: the release runs only on `main` or
`preview` (`allowedBranches = ["main", "preview"]`, line 496), bumps
`package.json` there, commits `release: v<version>`, pushes THAT branch, and
dispatches `release.yml`. The workflow ends at "Create GitHub release" — tag plus
GitHub release, nothing more. No step in either file ever advances `dev`. The
workflow declares `permissions: {}` at the top (line 32) and grants each job only
`contents: read` or `contents: write`, which is what makes an added `dev` write
there a security-review problem rather than a convenience.

So the version line on `dev` goes stale the moment a release publishes, and stays
stale until a human notices red CI on an unrelated PR. The cost lands on
contributors: inherited red they did not cause and cannot fix from their own diff.

What this unit can and cannot promise: it moves the repair from "someone eventually
remembers" to "a reviewable PR is waiting." It does not make the red impossible,
because the bump still needs a human merge — `Protect dev` requires an approving
review and code-owner sign-off, which a bot cannot supply. Claiming more than that
was the defect an audit caught in the first two drafts of `020`.

## Constraint that shapes the design

`dev` carries the NEXT STABLE version; the preview train adds its own suffix at
release time. That is the precedent `befcac3e1` states explicitly and the three
earlier repairs followed. A mechanism must preserve it — bumping dev to a preview
string would contradict every prior repair.

The existing test is already the right detector. It reads the local tag set, needs
no network, and distinguishes "equal on the release commit" (legal) from "equal
anywhere else" (duplicate). Nothing about the detector needs changing. What is
missing is anything that PREPARES the repair: today the detector reports the problem
to whoever happens to open the next PR, and the fix is left to memory.

## Phase map

Each decade doc below is one full PABCD cycle. Dependency-ordered: the version
repair lands first because it unblocks CI for everything else, then the actor that
prepares the next repair as a reviewable PR, then the ship.

- `010_version_repair.md` — move `dev` off the consumed `2.36.0` (wp2).
- `020_post_release_bump.md` — open the dev bump as a PR when a release publishes (wp3).
  Note: that workflow only runs once it reaches `main`, the default branch. Merging it
  to `dev` does not activate it.
- `030_ship.md` — PR against `dev`, CI evidence, merge (wp4).

## Audit record

TWO drafts of this roadmap were FAILED by an independent reviewer, and both verdicts
changed the design rather than the wording.

Round 1: `020` chose a printed notice inside the release script and called it an
autobump. The reviewer showed the existing test is already louder than any printout,
and that two hand-repairs happened AFTER it landed. It also caught a wrong
"highest tag" claim in `010` and a test plan citing a `--dry-run` flag and reusable
shim helpers that do not exist.

Round 2: the replacement PR-workflow design could not have worked. A `release` event
runs the workflow from the DEFAULT branch (`main`), which the scope forbade touching;
the named comparator `compareReleaseVersions` sits behind a module-scope
`process.exit` in `scripts/release.ts` and cannot be imported; and the "+minor" bump
rule contradicted `befcac3e1`, which moved `dev` to `2.36.0` on a
`v2.36.0-preview.*` publish. All three are fixed in the third draft, which imports
`compareReleaseTags` from `scripts/release-notes.ts` instead, records the `main`
promotion as a named follow-up in `030`, and replaces "+minor" with the two-branch
rule in `020`. The unit was also renamed.

Round 3 caught the sequel to that last fix: "lowest unused stable" is not a pure
function of the script's two inputs, because "unused" is a property of the tag set and
the registry. The rule is now split — shape arithmetic in the script, freeness in the
tag-aware detector that already exists. It also caught that the out-of-scope list
below forbade the very promotion `030` depends on.

Every rejected option and its reason stay in `020` so the decision is auditable.

## Out of scope

No publish, tag, or Release dispatch. No `main`/`preview` change IN THIS UNIT. No
merge of `main` back into `dev` to "sync" the version: `010_wp2_version_line.md`
names that as the trap that lands the consumed string on top of newer commits.

That `main` exclusion is a scope boundary, not a claim that `main` is irrelevant. The
workflow in `020` cannot run until an ordinary maintainer-controlled promotion carries
it to the default branch; `030` records that as the named follow-up. Two consequences
worth stating plainly:

- Merging this unit into `dev` fixes the red CI immediately (that is `010`) but arms
  nothing (that is `020`, dormant until promotion).
- The next release cut from the CURRENT `main` will still strand `dev` one last time.
  The loop closes on the release AFTER the workflow reaches `main`.
