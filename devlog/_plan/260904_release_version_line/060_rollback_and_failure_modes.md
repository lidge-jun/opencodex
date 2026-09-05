# 060 — Rollback and failure modes

## 1. Rollback

The design changes when an existing pull request is opened. It adds no publish-time
mutation, no dispatch input, and deletes no gate.

| Landed through | To revert | Blast radius |
|---|---|---|
| `010` | revert the PR | none; behaviour-neutral |
| `020` | revert the PR | none; `--bump` is additive, the typed form still works |
| `030` | revert the PR | the workflow returns to post-publish catch-up; the red window returns |
| `040` | revert the PR | one test case and two documents |

**No phase is irreversible and none strands a published artifact.** The release
commit still carries the published version and the tarball is still packed from the
tree, so a rollback at any point leaves every release, tag and attestation exactly as
it would otherwise have been.

One asymmetry: reverting `030` after `040` leaves `MAINTAINERS.md` describing a
pre-move that no longer runs. Revert both, or fix the document — a documentation
inconsistency, not a broken release path.

## 2. Failure modes

**F1 — The pre-move can be forgotten.** The scheme is an ordering convention.
*Guard:* the readiness gate (`030` §5) refuses to publish when `dev` does not
outrank the release version, converting a forgotten step from silent inherited red
into a blocked release. *Residual:* the gate can be removed, or `dev` moved by hand
— but `dev` is protected, so the manual path is itself a reviewed PR, which is the
pre-move.

**F2 — The readiness gate can block a release.** See §3; this is the one that will
actually be felt.

**F3 — Two version-line PRs could race.** The pre-move opens a PR into `dev` while
development continues. *Guard:* existing idempotency (`dev-version-bump.yml:114-157`)
checks for an open PR and validates branch content before reuse;
`concurrency: dev-version-bump` (lines 49-51) serialises runs. *Residual:* low; the
repository releases serially.

**F4 — The dispatch ref guard is bypassable.** `030` §3's check runs inside the
already-selected workflow body, so it is an early check, not an independent
authorization boundary. Current `main` and `preview` rulesets require a reviewed
pull request with code-owner review and block force-pushes and deletion: ordinary
repository write permission does not allow directly rewriting those protected refs.
Configured administrator/deploy-key bypasses remain a separate trust boundary.
The mutable workflow remains a residual risk for an actor able to change the
authorized workflow; a separately protected publish environment would be defense
in depth, not a property supplied by this guard. This change neither configures an
environment nor claims that the inline check is unbypassable.

**F5 — The service-lifecycle gate depends on the release commit touching
`package.json`.** `release.yml:268` includes `package.json` in its trigger regex and
the release commit still edits it. Unchanged by this design, recorded because the
dependency is implicit.

## 3. The readiness gate's real cost

An earlier draft claimed this gate would block ordinary hotfixes. **That was wrong**
and the correction matters, because it changes whether the gate is acceptable.

After a compliant release, `dev` carries `2.44.0`. A `2.43.1` hotfix satisfies
`2.44.0 > 2.43.1`, so the gate at `030` §5 **passes without any pre-move**. The same
holds for preview cuts (`050` §3). The gate blocks only when `dev` is *already* in
the state the invariant forbids — i.e. when publishing would create inherited red.

So the friction is narrower than described: it appears when `dev` has drifted behind,
which is precisely the condition this design exists to prevent.

**On an override input.** If an override is ever added, it must be understood for
what it is: used when `dev <= X`, it **explicitly reopens the red state** — `dev` and
every open pull request go red the moment the tag lands, exactly as they do today. It
is not a convenience flag. If added, it should log loudly and name the consequence.
I do not recommend adding one until a real release is actually blocked by the gate.

A silent patch-release exemption is rejected outright: it would skip the check for
the releases most likely to be cut in a hurry.

## 4. What this design does not introduce

- no divergence between the tarball and the tagged tree
- no publish-time working-tree mutation
- no new required dispatch input
- no change to compatibility-manifest identity or the GUI bundle version
- no change to what a source checkout of a tag reports
- no ancestry obligation between release tags and `dev` (`001_design.md` §0)

## 5. Verified facts

Both were open risks in earlier drafts and are now settled.

**npm provenance does not bind the tree.** The published attestation for `v2.42.0`
binds the tarball's sha512, the workflow path, and source commit
`48f8186647d9ffb108d226dcfa91a64225aae2a7` as a resolved dependency. It does not
assert tarball/tree byte-equality, and no non-devlog consumer of npm's `gitHead`
exists in `scripts/`, `tests/` or `.github/`. Moot for this design, which creates no
such divergence; recorded because it would have decided the withdrawn stamping
approach.

**`npm version` accepts a downgrade.** `npm version 2.43.0 --no-git-tag-version`
against a tree at `2.44.0` exits 0 and writes `2.43.0`. Probed directly. This retires
the top implementation risk in `050` §2 — `scripts/release.ts:559-573` needs no
change.

## 6. What could still make me wrong

1. **Whether the readiness gate's friction is acceptable in practice** (§3). An
   operator judgment, best made after the gate has run for a release or two.
2. **Whether previews are still published at all** (`050` §5). If not, `020`'s
   preview resolver is untested-in-anger code solving a problem nobody has.
3. **Same-day preview ordinals** rely on SemVer ordering that the comparator at
   `scripts/release.ts:323-335` implements. Unit-tested in `020` §6, never exercised
   in a real release, because the repository has never cut two previews in one day.

## 7. Out of scope

- Relaxing `Protect dev` (option C).
- Making releases automatic; `release.yml` stays dry-run by default
  (`release.yml:22-26`).
- Changing the dist-tag model, the branch layout, or `expected-sha` binding.
- ima2-gen's `assertPreviewProof` (stable tag as a certificate that a preview build
  proved the same SHA). A good idea, orthogonal to this unit, and worth its own unit
  — folding it in here would make the diff impossible to review as one idea.
