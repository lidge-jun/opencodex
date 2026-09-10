# 000 — Research: the release version line and the catch-up chore

Design-only unit. Nothing here is implemented; this document records the current
state with file:line evidence, the exact recurrence, and the disposition of the
three options. Phase designs live in the decade documents (`010`+).

Verified against `codex/260904-anthropic-effort-ladder` at `85eb58567` on
2026-09-04. Every line number below was read in this worktree, not recalled.

## 1. Observed state, today

| Surface | Value | Evidence |
|---|---|---|
| `dev` `package.json` | `2.43.0` | `git show origin/dev:package.json` line 3 |
| `main` `package.json` | `2.42.0` | `git show origin/main:package.json` line 3 |
| `preview` `package.json` | `2.43.0-preview.20260904` | `git show origin/preview:package.json` line 3 |
| highest git tag | `v2.42.0` -> `48f818664` | `git tag --sort=-v:refname` |
| npm `latest` | `2.42.0` | `npm view @bitkyc08/opencodex dist-tags --json` |
| npm `preview` | `2.40.0-preview.20260902` | same |
| `dev` vs `main` | `main` IS an ancestor of `dev`; `dev` is 25 commits ahead | `git merge-base --is-ancestor`, `git rev-list --count` |
| `preview` vs `dev` | `preview` is NOT an ancestor of `dev` | `git merge-base --is-ancestor` |

Two facts in that table matter more than they look.

**The npm `preview` dist-tag is three minor lines behind the `preview` branch.**
The branch carries `2.43.0-preview.20260904`, npm carries `2.40.0-preview.20260902`,
and the tag set contains no `v2.41.0-preview.*` or `v2.42.0-preview.*` at all. Those
two preview version lines were opened on the branch and never published. So on
`preview`, the in-tree version already does **not** mean "the version this branch
published" — it means "the version this branch is open for". That reading is not a
proposal; it is the reading `preview` has been operating under for at least two
cycles. The scheme in `030` generalises it rather than inventing it.

**`dev` at `2.43.0` is currently legal only because `v2.43.0` does not exist yet.**
The moment `2.43.0` is published, `dev` is red — see §3.

## 2. The recurrence

Six commits, one per release, all doing the same thing:

```
ee2d19ad4 chore(release): move dev to 2.43.0 after v2.42.0        (PR #3434)
162d11e18 fix(release): move dev to 2.42.0 after v2.41.0          (PR #3354)
272ff6b11 fix(release): move dev to 2.41.0 after v2.40.0          (PR #3265)
3e0f99a19 chore(release): move dev to 2.40.0 after the v2.39.0 release (PR #3127)
71bd7bec6 chore(release): move dev to 2.39.0 after the v2.38.0 release (PR #3076)
a8c3a9633 chore(release): move dev to 2.38.0 after the v2.37.0 release (PR #3045)
```

Behind those sit the four hand repairs the tooling's own header names —
`32529c2b2`, `e4a85d134`, `076ad3036`, `befcac3e1`
(`scripts/bump-dev-version.ts:14`). `e4a85d134` is the one that ADDED the detector,
and two more repairs followed it. The script says so itself at
`scripts/bump-dev-version.ts:15-16`: "visibility was never the missing piece".

There is a **third** version-line commit per train that the problem statement does
not name, and it must be in scope or the design under-counts the chore:

```
3959e6d04 chore(release): promote main v2.42.0 onto preview and open 2.43.0-preview
```

Its body states the cause in the same vocabulary: "The version could not stay at
2.42.0-preview.20260903: v2.42.0 has published, and compareReleaseTags ranks that
prerelease BEHIND its own stable release (-1), which is what
tests/release-version-line.test.ts fails on."

So the real per-train cost is **three** version-line pull requests
(`promote-preview-*`, `promote-main-*`, `dev-version-*`), of which one
(`dev-version-*`) is pure post-hoc catch-up and one (`promote-preview-*`) is
post-hoc catch-up wearing a promotion's clothes.

## 3. Why it is worse than a chore

`tests/release-version-line.test.ts:88-120` compares `package.json` against the
highest local tag. Three outcomes:

- strictly ahead -> pass (line 112-119)
- equal -> legal **only** if that tag names HEAD (`tagPointsAtHead`, lines 68-81, applied at 100-110)
- behind -> fail

On `dev` after a stable publish, `package.json` equals the highest tag on a commit
that tag does not name, so the equality branch fails. The test runs in the ordinary
test jobs, and `tests/ci-workflows.test.ts:156-166` deliberately pins
`fetch-tags: true` on `test`, `platform-macos` and `platform-windows` so the tag
set is never empty. That is inherited red on `dev` **and on every pull request
opened against `dev`**, unfixable from a contributor's own diff.

The blast radius is not limited to CI colour. `tests/release-version-line.test.ts:8-29`
records the two real failure modes: `assertChannelVersionMovesForward`
(`scripts/release.ts:342-370`) refuses to cut from such a tree, and merging `dev`
into `main` resolves `package.json` to `main`'s side and silently republishes an
already-published version.

## 4. Where the coupling actually lives

One line creates the whole problem:

> `.github/workflows/release.yml:175-184` — `test "$PKG" = "$RELEASE_VERSION"`

The in-tree version must EQUAL the version being published. Combined with
`tests/release-version-line.test.ts`'s rule that in-tree must be **strictly ahead**
of every tag except on the tagged commit itself, the two constraints force a
state change on every branch that shares content with the release commit, the
instant the tag appears. `main` and `preview` can absorb it (see §5); `dev`
cannot, because it is protected and a bot cannot merge into it.

The asymmetry is the design's whole lever, and it is documented in the code:
`scripts/release.ts:112-130` explains that `main` and `preview` carry rulesets
whose admin bypass is `pull_request`, and that the carve-out is a dedicated write
deploy key registered as a `DeployKey` bypass actor **on those two rulesets**.
`.github/workflows/dev-version-bump.yml:12-15` states the converse for `dev`:
"It does not push to `dev`. It opens a pull request and a human merges it, because
ruleset `Protect dev` requires an approving review and code-owner sign-off that a
bot cannot supply."

**`main` and `preview` are machine-writable. `dev` is not.** Any scheme that
requires `dev`'s version line to move in response to a publish is therefore
structurally a human chore with a red window in front of it.

## 5. Current mitigation and why it does not close the hole

`.github/workflows/release.yml:67-80` CALLS `dev-version-bump.yml` after a
successful publish. The workflow decides a version
(`scripts/bump-dev-version.ts:101-142`), proves it is unused by running the
detector in a `dev` checkout (`.github/workflows/dev-version-bump.yml:94-101`),
and opens a pull request (lines 103-187).

It is a **prepared** repair, not a repair — the script's own header says so at
`scripts/bump-dev-version.ts:22-24`: "Until they do, the red persists." Two further
documented gaps, both in `MAINTAINERS.md:83-90`: the called workflow body resolves
from the caller's ref so it only takes effect once promoted to `main`, and a pull
request opened with `GITHUB_TOKEN` starts no `pull_request` workflows, so the bump
PR arrives with no CI at all.

## 6. Option C — rejected, and not revisited here

ima2-gen sends `main`, `dev` and the tag to one SHA in a single atomic push
(`/Users/jun/Developer/new/700_projects/ima2-gen/.github/workflows/release.yml:209-221`).
That works there because `dev` is machine-writable there. In opencodex it requires
relaxing `Protect dev`. Trading branch protection for chore removal is a bad
exchange, and the decision is already made: **out of scope, no phase proposes it.**

Worth carrying over from that repository anyway, because they are independent of
the atomic push: the release version is *computed* from a bump keyword
(`scripts/release-cut.mjs:169-185`), immutability is asserted before anything is
pushed (`assertCuttable`, lines 106-112), and the stable tag is a certificate that a
preview build already proved the exact SHA (`assertPreviewProof`, lines 115-122).

## 7. Option A — good, folded in, not sufficient

Today the maintainer hand-passes a version string: `scripts/release.ts:487-491`
parses `args[0]` as the version, and `.github/workflows/release.yml:9-14` takes it
as a dispatch input that must equal `package.json`.

Accepting `--bump patch|minor|major` and computing the number removes a class of
typo and makes "what is the next version" a function rather than a maintainer
judgment call. That is real value and `020` adopts it.

It does **not** fix the root cause. Whether the string `2.43.0` arrives typed or
computed, `release.yml:175-184` still demands the tree equal it, and `dev` still
has to move afterwards. Option A shortens the chore's input; it does not delete
the chore.

## 8. The complete consumer set

Searched with `rg` for `bump-dev-version`, `dev-version-bump`,
`release-version-line`, and for readers of `package.json.version` under `src/`.
The full list, including three consumers the task brief did not name:

| Consumer | Role | Named in brief |
|---|---|---|
| `scripts/release.ts` | version arg, branch gate, channel/unused guards, bump+commit+push | yes |
| `scripts/bump-dev-version.ts` | the catch-up decision | yes |
| `.github/workflows/release.yml` | equality check, branch/version coupling, dist-tag, bump call | yes |
| `.github/workflows/dev-version-bump.yml` | opens the catch-up PR | yes |
| `tests/release-version-line.test.ts` | the invariant | yes |
| `tests/bump-dev-version.test.ts` | pins the catch-up rule | yes |
| `tests/ci-workflows.test.ts` | pins release.yml shape (`636-830`) and `fetch-tags` (`156-166`) | yes |
| `tests/release-helper.test.ts` | pins release.ts call order (`353-731`) | yes |
| **`scripts/release-notes.ts`** | `compareReleaseTags`, `selectReleaseBaseline`, `previousReleaseNotesTag` (`86-134`) | **no** |
| **`scripts/build-release-changelog.ts`** | baseline selection + notes text (`542-577`, `646-648`) | **no** |
| **`MAINTAINERS.md:76-90`** | documents the chore as policy | **no** |
| **`src/update/index.ts:49,59-64`** | reads in-tree version; `updateTag()` derives the channel from it | **no** |
| **`src/cli/version-skew.ts:34-46`** | compares CLI version against live proxy | **no** |
| **`src/server/management-api.ts:89`, `src/client/machine-listener.ts:21`** | report in-tree version at runtime | **no** |
| **`docs-site/src/content/docs/contributing.md:98-100`** (+7 locales) | documents `bun run release <version>` | **no** |
| **`structure/06_docs-and-release.md:181,240,253`** | architecture SoT for the release path | **no** |

`src/update/index.ts:59-64` is the one that changes user-visible behaviour rather
than tooling, and it is the sharpest constraint on any scheme that lets the in-tree
version drift away from the published one — see `010` §4 and `050` §3.

## 9. Two comparators, one question

`compareReleaseVersions` (`scripts/release.ts:303-337`) and `compareReleaseTags`
(`scripts/release-notes.ts`) both order releases. `bump-dev-version.ts:57` imports
the *latter*, and `tests/release-version-line.test.ts:27-29` records why: importing
`scripts/release` from a test kills the runner, because it parses `process.argv`
and calls `process.exit` at module scope (`scripts/release.ts:482-491`).

So the repository's ordering rule is implemented twice and the tests can only reach
one of them. That is a foundation defect, not a style nit: every phase below
depends on both agreeing. `010` fixes it first for that reason.

## 10. Open questions

Stated rather than papered over.

1. **Is the `preview` npm gap deliberate?** npm `preview` is `2.40.0-preview.20260902`
   while the branch is at `2.43.0-preview.20260904` and no matching tags exist. Either
   the last two preview cuts were abandoned, or previews stopped being published. The
   design in `030` is correct under both readings, but the migration in `050` differs.
   I could not determine which from the repository alone.
2. **Does anything outside this repository consume the tag-to-`package.json` identity?**
   Trusted-publishing provenance attests the workflow and commit, not file equality, so
   B1 (`010` §5) survives it in principle. I did not verify against a published
   attestation, so B1's cost is asserted from the npm docs model, not measured.
3. **`gui/package.json` and `docs-site/package.json`** are `0.0.0` / `0.0.1` and
   unpublished (`devlog/_plan/260827_dev_hardening/010_wp2_version_line.md:8-13`). I
   re-confirmed no second product version exists in tracked source. If one is added
   later this design does not cover it.
## 11. Audit round 1 — resolved facts (2026-09-04)

Amendments from an independent review whose findings I verified. These supersede
the corresponding open questions above.

### 11.1 Open question 2 — RESOLVED, provenance does not bind the tree

**Verified against the published attestation for `v2.42.0`**, not reasoned from the
model. The SLSA predicate binds:

- `subject` = the **tarball's** sha512
- `workflow` = `.github/workflows/release.yml`
- `resolvedDependencies` = git commit `48f8186647d9ffb108d226dcfa91a64225aae2a7`

It does **not** assert that the tarball byte-matches the git tree. npm additionally
reports `gitHead=48f8186...`, and `rg` finds **no** non-devlog consumer of `gitHead`
in `scripts/`, `tests/` or `.github/`.

So a publish-time divergence between tarball and tree would be an expectation
problem, not a broken attestation. Recorded as settled; the hedging in the original
`060` §5 is withdrawn. (This matters less than it did — the revised scheme in
`001_design.md` no longer creates such a divergence at all.)

### 11.2 The catch-up PR is the ancestry path — structural finding

This one invalidates the original scheme's central claim and is worth stating in
full, because §2 above under-read its own evidence.

```
ee2d19ad4  parent: 48f8186 (single parent — the v2.42.0 release commit)
c116dc532  merge of ee2d19ad4 into dev
```

`ee2d19ad4` has **exactly one parent**, and that parent is the release commit. The
catch-up branch is cut *from* the release commit, so merging it is the **only path**
by which the release commit becomes an ancestor of `dev`.
`git merge-base --is-ancestor v2.42.0 origin/dev` returns true today *because of*
that pull request, not incidentally to it.

Consequence for any scheme that deletes the catch-up: it deletes the ancestry
propagation too. `scripts/release.ts:494` (`allowedBranches`), `:584` (pushes only
the release branch) and `.github/workflows/release.yml:412-421` (pushes only the
tag) confirm nothing else ever moves `dev`.

**Therefore: a reviewed commit into `dev` is required whenever a release would
otherwise leave `dev` at or behind the new tag.** It follows from `Protect dev` plus
a monotonically advancing tag set, and no in-tree version convention can remove it.

> **Correction (audit round 3).** An earlier wording here said "at least one reviewed
> commit per release", which is too strong. A preview cut, or a stable hotfix below
> `dev`'s line, needs none: `decideDevVersion` returns `changed: false` in exactly
> that case (`scripts/bump-dev-version.ts:120-126`). `001_design.md` §1 carries the
> corrected rule.

> **Superseded (audit round 3).** The paragraph above this correction described the
> catch-up pull request as the ancestry carrier into `dev`. That observation is
> factually true of `ee2d19ad4` but was **withdrawn as a design obligation**:
> measured across all 226 release tags, 10 are not ancestors of `origin/dev` (every
> one a preview), so "release tags are ancestors of dev" is already false today. The
> design does not preserve or assert ancestry — see `001_design.md` §0.

### 11.3 Preview succession can be a fixed point

Live state: `origin/preview` = `2.43.0-preview.20260904`, npm `preview` =
`2.40.0-preview.20260902`, highest stable tag = `v2.42.0`.

Publishing `2.43.0-preview.20260904` today gives
`nextDevelopmentVersion(X) = 2.43.0`, and a same-day stamp regenerates
`2.43.0-preview.20260904` — i.e. `N(X) == X`. Any successor function must be proven
**strictly monotonic**, not merely well-formed.

Second, related hazard: computing a bump from the **preview dist-tag alone** starts
from `2.40.0-preview.20260902` and can propose a `2.41.*` candidate that is behind
the published stable `v2.42.0`. A preview candidate must be computed against the
union of the stable tag set and the preview channel.

### 11.4 The compatibility manifest hashes `package.json`

Read directly: `scripts/generate-compatibility-version.ts:15` lists
`REQUIRED_ROOT_FILES = ["package.json", "bun.lock", "scripts/model-metadata.source.json"]`,
and `buildCompatibilityVersionManifest` (lines 44-83) hashes each file's
**working-tree bytes** via `git ls-files` + `sha256`.

Chain: `package.json:52` `prepublishOnly` -> `build:gui` (line 49) -> `prepare:package`
(line 50) -> `prepare-package.ts:4` -> `generateCompatibilityVersionManifest`.
Separately `gui/vite.config.ts:7` bakes the root `package.json` version into the GUI
bundle as `__APP_VERSION__`.

So **the version string is an input to Compatibility Lab route identity and to the
GUI bundle**, and both are regenerated by `prepublishOnly`/`prepack` — i.e. *after*
any pre-publish working-tree inspection. This is what makes publish-time version
rewriting far more invasive than it appears, and it is a decisive argument against
the original `030`.

### 11.5 Consumer inventory — additions

Missing from §8, found by the reviewer and confirmed:

| Consumer | Nature |
|---|---|
| `gui/vite.config.ts:7` | bakes root version into the GUI bundle (`__APP_VERSION__`) |
| `scripts/generate-compatibility-version.ts:15` | `package.json` bytes feed compatibility identity |
| `bin/ocx.mjs` | launcher version reporting |
| `src/server/gui-static.ts`, `src/cli/help.ts` | version display surfaces |
| `scripts/openai-provider-option-runtime-child.ts` | reads package version |
| `src/cli/star-prompt.ts:196` | per-version star deferral ("at most once per version") |

Most are display surfaces covered by the source-checkout caveat. The compatibility
manifest is **not** — it is a content-addressed identity, and a version change moves
it. The star deferral is a behavioural one: it re-arms per version string.

### 11.6 Comparator fallback is load-bearing

`scripts/release-notes.ts:66-70`: when either side fails `parseReleaseTag`,
`compareReleaseTags` falls back to `localeCompare(..., { numeric: true })` rather
than throwing. `scripts/build-release-changelog.ts:137` admits any `/^v\d/` tag into
the candidate set. A single malformed historical tag therefore sorts harmlessly
today; a throwing comparator would newly abort release-note generation.

Any consolidation must preserve the fallback at the `compareReleaseTags` boundary.
