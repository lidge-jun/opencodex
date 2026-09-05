# 030 — Phase 3: move `dev` BEFORE the release, not after

`.github/workflows/dev-version-bump.yml` stops being a **repairer** that reacts to a
publish and becomes an **opener** that runs before one. Same script, same rule, same
reviewed pull request into `dev` — different moment. A gate in `release.yml` refuses
to publish when it has not run.

Depends on: `010`. Independent of `020` — either may land first.

## 1. The change

```
today:  publish vX  ->  dev is RED  ->  open PR  ->  review  ->  merge  ->  green
after:  open PR  ->  review  ->  merge  ->  promote  ->  publish vX  ->  never red
```

The number of `dev` commits does not grow: a pre-move is needed only when the
release would otherwise leave `dev` at or behind the new tag (`001_design.md` §1).
A preview cut, or a stable hotfix below `dev`'s line, needs none —
`decideDevVersion` returns `changed: false` and no pull request is opened
(`scripts/bump-dev-version.ts:120-126`).

What disappears is the interval during which `dev` and every open pull request carry
a failure no contributor can fix.

## 2. File change map

| Path | Action |
|---|---|
| `.github/workflows/dev-version-bump.yml` | MODIFY — trigger, input normalization, freeness check |
| `.github/workflows/release.yml` | MODIFY — delete the post-publish call; add the readiness gate (§5) and the ordering gate (§5a) |
| `scripts/version-line.ts` | MODIFY — add an `import.meta.main` CLI: `assert-ahead` (§6) and `assert-releasable` (§5a) |
| `tests/bump-dev-version.test.ts` | MODIFY — intended-version cases |
| `tests/ci-workflows.test.ts` | MODIFY — trigger, routing, and both gate assertions |
| `tests/version-line.test.ts` | MODIFY — `assert-releasable` ordering cases (§10 criterion 6) |

`scripts/release.ts` is **not** in this map and needs no change: the readiness gate
reads state the dispatch already carries, and no new dispatch input is introduced.

## 3. Trigger, and the one normalized input

The workflow today accepts `released-version` via `workflow_call`
(`dev-version-bump.yml:39-46`) and its decision step reads exactly that at line 86.

`workflow_call` is **removed**: §5 deletes its only caller, and a reusable-workflow
entry point with no caller is dead configuration. Its capability — repairing a
release that published without a pre-move — survives as an explicit `mode`, which is
reachable and testable rather than dependent on another workflow remembering to call
it.

```yaml
on:
  workflow_dispatch:
    inputs:
      intended-version:
        description: "Version about to be released (pre-move), or one already published (repair)"
        required: true
        type: string
      mode:
        description: "pre-move (default) or repair — repair allows an already-published version"
        required: false
        default: pre-move
        type: choice
        options: [pre-move, repair]
```

Even with one event the value is still **normalized into one output before the
decision step**, and a test asserts the routing. That is not ceremony: the
decision step, the freeness check and the PR body are three consumers, and having
them read the raw input independently is how a renamed or added input silently
reaches only some of them — the defect this unit already hit once.

```yaml
jobs:
  open-bump-pr:
    steps:
      # ... checkout, bun setup, install ...

      - name: Refuse a dispatch from a non-default ref
        run: |
          # A dispatched run executes the SELECTED ref's body. Pin it to the default
          # branch so a feature branch cannot run its own version of this job with
          # contents: write (dev-version-bump.yml:35-38).
          test "$GITHUB_REF" = "refs/heads/${{ github.event.repository.default_branch }}" || {
            echo "::error::this workflow may only be dispatched from the default branch"
            exit 1
          }

      # ONE value downstream. Both events terminate here; every later step reads
      # steps.target.outputs.version and nothing else. Without this the dispatch path
      # would reach bump-dev-version.ts with an empty argument and open no pre-move.
      - name: Resolve the target version
        id: target
        env:
          INTENDED: ${{ inputs.intended-version }}
          MODE: ${{ inputs.mode }}
        run: |
          set -euo pipefail
          target="${INTENDED:-}"
          if [ -z "$target" ]; then
            echo "::error::intended-version was not supplied"
            exit 1
          fi
          echo "version=${target}" >> "$GITHUB_OUTPUT"
          # Explicit if, not "${MODE:+x}${MODE:-y}": that form concatenates to
          # "x<value>" when MODE is populated, because the second expansion falls
          # back to MODE's own value rather than to nothing.
          if [ "${MODE:-pre-move}" = "repair" ]; then
            echo "mode=repair" >> "$GITHUB_OUTPUT"
          else
            echo "mode=pre-move" >> "$GITHUB_OUTPUT"
          fi
```

The decision step then reads the normalized value instead of the raw input:

```diff
       - name: Decide the version dev should carry
         id: decide
         env:
-          RELEASED_VERSION: ${{ inputs.released-version }}
+          RELEASED_VERSION: ${{ steps.target.outputs.version }}
         run: |
           set -euo pipefail
           bun scripts/bump-dev-version.ts "${RELEASED_VERSION}" package.json
```

Both remaining consumers — the freeness check (§4) and the pull-request body
(`dev-version-bump.yml:103-187`) — take the same normalized value, so the generated
PR names the version that was actually dispatched.

The §4 freeness assertion applies to `mode: pre-move` only. `mode: repair`
deliberately permits an already-published version, which is exactly the old catch-up
behaviour, retained for the case where a release somehow publishes without a
pre-move.

## 3a. The generated copy must match the mode

The commit subject and pull-request body are written for the catch-up world and say
so: `fix(release): move dev to ${NEXT_VERSION} after ${RELEASED_VERSION}`
(`dev-version-bump.yml:155,162`), and a body asserting that
"`${RELEASED_VERSION}` published, so `dev` would otherwise keep a version at or
behind a released one" (lines 166-169).

In pre-move mode every one of those statements is false: nothing has published, and
`dev` is not behind anything. Shipping that text would make the pull request argue
for itself with a reason the reviewer can see is untrue — which is how a reviewer
learns to skim these.

```yaml
          if [ "${MODE}" = "repair" ]; then
            subject="fix(release): move dev to ${NEXT_VERSION} after ${TARGET_VERSION}"
            reason="\`${TARGET_VERSION}\` has published, so \`dev\` is carrying a version at or behind a released one and \`tests/release-version-line.test.ts\` fails on \`dev\` and on every pull request opened against it. This is the post-publish repair."
          else
            subject="chore(release): open dev at ${NEXT_VERSION} before releasing ${TARGET_VERSION}"
            reason="\`${TARGET_VERSION}\` is about to be released. Merging this first means \`dev\` already outranks the new tag when it lands, so neither \`dev\` nor any open pull request ever inherits the version-line failure. \`release.yml\` refuses to publish until this has merged."
          fi
```

The Verification and Checklist sections (lines 175-186) are mode-independent and
unchanged. The freeness evidence differs — pre-move proves the target is *not yet*
published (§4), repair proves the chosen version is unused — so that one sentence
follows `mode` too.

## 4. Freeness, retargeted

`decideDevVersion(released, current)` (`scripts/bump-dev-version.ts:101-142`) asks
"given that `released` exists, what should `dev` carry?" The pre-move asks the same
question about a version that has not published yet. The rule is unchanged —
`nextDevelopmentVersion` keys off the version's *shape*
(`scripts/bump-dev-version.ts:38-42`), not its published-ness.

What must change is the freeness gate. `dev-version-bump.yml:94-101` runs
`tests/release-version-line.test.ts`, which compares against the local tag set; in a
pre-move the release tag does not exist yet, so it proves less than it does today.

```yaml
      - name: Prove the intended version is not already released
        if: ${{ steps.target.outputs.mode == 'pre-move' }}
        env:
          INTENDED: ${{ steps.target.outputs.version }}
        run: |
          set -euo pipefail
          git fetch --force --tags origin
          if git rev-parse -q --verify "refs/tags/v${INTENDED#v}" >/dev/null; then
            echo "::error::v${INTENDED#v} already exists; this is a catch-up, not a pre-move"
            exit 1
          fi
          if npm view "@bitkyc08/opencodex@${INTENDED#v}" version >/dev/null 2>&1; then
            echo "::error::${INTENDED#v} is already on npm"
            exit 1
          fi
```

A pre-move whose target already exists is a catch-up wearing the wrong name and must
fail loudly. `${INTENDED#v}` strips an optional `v` so both spellings work, matching
`asTag`'s tolerance in the script (`scripts/bump-dev-version.ts:68-70`).

## 5. Readiness gate, replacing the post-publish call

`release.yml:39-80` currently calls the bump workflow after publishing. That job and
its 28-line comment are deleted, along with the `permissions` block at lines 75-77
that existed only for it. In its place, a pre-flight assertion in the `publish` job:

```yaml
      - name: Require dev to be ready for this release
        env:
          RELEASE_VERSION: ${{ inputs.version }}
        run: |
          set -euo pipefail
          git fetch origin dev --tags
          dev_version="$(git show origin/dev:package.json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).version)')"
          # dev must ALREADY outrank the version about to be tagged, or publishing
          # opens the inherited-red window this design exists to close.
          bun scripts/version-line.ts assert-ahead "$dev_version" "$RELEASE_VERSION"
```

## 6. The invocation, specified

An earlier draft left this open with a `scripts/version-line.js` path that does not
exist. It is settled here: **`bun scripts/version-line.ts <subcommand>`**, using the
`import.meta.main` guard pattern the repository already relies on
(`scripts/bump-dev-version.ts:144`, and `scripts/release-notes.ts`, whose CLI is
guarded exactly so a test can import the module without executing it —
`tests/release-version-line.test.ts:27-29`).

Two subcommands are needed, one per gate: `assert-ahead` for the readiness gate (§5)
and `assert-releasable` for the ordering gate (§5a). Both are thin wrappers over
exported pure functions, so the policy is unit-testable without a subprocess and the
CLI is testable for the wiring the pure function cannot cover.

```ts
/**
 * The ordering policy enforced at the publication boundary: a candidate must
 * strictly outrank every release tag.
 *
 * dryRunTagSha/headSha preserve release.yml:311-313's deliberate exception — a dry
 * run whose tag already points at THIS commit is a legitimate re-run, not a
 * regression. Without it this gate would break every post-release dry run.
 *
 * Pure: returns the offending tag rather than exiting, so a test can assert the
 * policy and the caller decides what a violation means.
 */
export function assertReleasable(input: {
  candidate: string;
  tags: readonly string[];
  /** True when this tag already names the commit under release and it is a dry run. */
  allowExistingTagAtHead?: boolean;
}): { ok: true } | { ok: false; blockedBy: string };

// Kept behind import.meta.main so importing this module from a test never executes a
// CLI, which is the property that made release-notes.ts importable and release.ts not
// (tests/release-version-line.test.ts:27-29).
if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "assert-ahead") {
    const [left, right] = rest;
    if (compareVersions(left!, right!) <= 0) {
      console.error(`::error::origin/dev carries ${left}, which does not outrank ${right}. Run the dev pre-move before releasing.`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (command === "assert-releasable") {
    const [candidate, ...flags] = rest;
    // Tag set on stdin: §5a pipes `git tag --list 'v*'` in. Reading it here rather
    // than spawning git keeps this module free of process spawning, matching how
    // release.yml:256-259 already pipes the tag list into scripts/release-notes.ts.
    const tags = (await Bun.stdin.text())
      .split("\n").map(line => line.trim()).filter(Boolean);
    const verdict = assertReleasable({
      candidate: candidate!,
      tags,
      allowExistingTagAtHead: flags.includes("--allow-existing-tag-at-head"),
    });
    if (!verdict.ok) {
      console.error(`::error::${candidate} does not outrank the current tag set (blocked by ${verdict.blockedBy}). Opening a preview for a higher core closes older stable patch lines — see devlog/_plan/260904_release_version_line/020 §4.0.`);
      process.exit(1);
    }
    process.exit(0);
  }

  console.error("usage: bun scripts/version-line.ts assert-ahead <a> <b> | assert-releasable <version> [--allow-existing-tag-at-head]");
  process.exit(1);
}
```

An earlier draft of this section specified only `assert-ahead` while §5a already
invoked `assert-releasable`. Implemented literally, every command but the first
would have fallen through to the usage error and **exit 1 — blocking every dry run
and every publish**, the exact inverse of the gate's purpose. Both subcommands are
specified here for that reason, and criterion 8 tests the CLI's stdin and exit
behaviour rather than only the pure function, because the pure function alone would
not have caught it.

Bun is already installed in this job by `./.github/actions/setup-project-bun`
(`release.yml:143-144`), and the workflow already runs `bun` directly
(`bun scripts/build-release-changelog.ts`, `release.yml:346`), so this adds no new
runtime dependency. Adding the CLI to `scripts/version-line.ts` is why that file
appears in this phase's change map.

## 5a. Enforcing the closed-patch policy at the publication boundary

`020` §4.0 refuses a stable patch bump when a higher-core preview exists, but that
refusal lives in `nextStableRelease` and only fires when a maintainer uses
`--bump`. **It is bypassable, and not hypothetically:**

1. a stable patch commit gets green exact-head CI **before** any higher-core preview
   tag exists;
2. the preview publishes, creating `vX.(Y+1).0-preview.*`;
3. a maintainer dispatches Release manually for that already-green stable SHA.

`nextStableRelease` never runs. `release.yml` refreshes tags during preflight
(`release.yml:303`, `git fetch --force --tags origin`) but the checks that follow
only test **duplicate** metadata — tag exists, GitHub release exists, npm version
exists (`:305-336`). Nothing tests current **ordering**. So the exact state §4.0
promises to refuse can still publish.

The gate therefore belongs after that fetch, in the same step or immediately after
it, using the shared strict comparator:

```yaml
      - name: Refuse a release the current tag set already outranks
        env:
          RELEASE_VERSION: ${{ inputs.version }}
          DRY_RUN: ${{ inputs.dry-run }}
        run: |
          set -euo pipefail
          # Runs AFTER the preflight tag fetch, so it sees tags created since this
          # commit's CI run. The resolver in scripts/version-line.ts enforces the same
          # policy, but only when --bump is used; a manual dispatch of an
          # already-green SHA bypasses it entirely. This is the enforcement point.
          #
          # The --allow-existing-tag-at-head flag preserves release.yml:311-313's
          # deliberate dry-run exception: re-running a dry run for an already-tagged
          # commit is legitimate, and a strict "outranks every tag" test would reject
          # it because the candidate EQUALS its own tag. Only granted when the tag
          # names this exact commit, matching the existing check's condition.
          allow=""
          existing_tag_sha="$(git rev-parse -q --verify "refs/tags/v${RELEASE_VERSION}^{commit}" || true)"
          if [ "$DRY_RUN" = "true" ] && [ -n "$existing_tag_sha" ] && [ "$existing_tag_sha" = "$GITHUB_SHA" ]; then
            allow="--allow-existing-tag-at-head"
          fi
          git tag --list 'v*' | bun scripts/version-line.ts assert-releasable "$RELEASE_VERSION" $allow
```

`assert-releasable` reads the tag set on stdin and refuses when the candidate does
not strictly outrank every existing tag — the same question
`tests/release-version-line.test.ts` asks of the tree, asked here of the version
about to be published, at the last moment before it becomes irreversible.

**The one exception is inherited, not invented.** `release.yml:311-313` already
permits a dry run when the release tag exists **and points at this exact commit**,
treating it as a legitimate re-run rather than a duplicate. A strict
"outranks every tag" rule contradicts that, because such a candidate necessarily
*equals* its own tag. The gate therefore carries the same condition rather than
silently removing a deliberate affordance — this preserves the existing behaviour;
it does not extend it. Real publishes are unaffected: `dry_run != true` means the
flag is never granted, and `release.yml:314-317` still refuses outright.

Reading tags from stdin rather than shelling out from inside the script keeps the
module free of process spawning and matches how `release.yml:256-259` already pipes
`git tag --list` into `scripts/release-notes.ts`. Precedent, not invention.

**Placement matters.** It must come after `release.yml:303`'s fetch — before it, the
runner's tag set is whatever the checkout brought and the gate would be checking
stale data, which is the same class of bug as the CI-green-before-preview sequence
it exists to catch.

This gate subsumes the `020` §4.4 global-floor assertion for stable releases: that
one runs at resolution time on a maintainer's machine, this one at publication time
on the audited SHA. Keep both — they answer the same question at different moments,
and only the second is on the path a manual dispatch takes.

## 7. Why the gate is safe in the publish job

It reads `origin/dev` and compares two strings. It grants no permission, mutates
nothing, and fails closed. Placed with the other pre-publish gates
(`release.yml:188-283`), before the preflight metadata step.

It asserts a version relationship and nothing more. It does **not** assert or imply
any ancestry between the release commit and `dev` — under this ordering the release
commit is created on `main` after promotion, so it is a descendant of the promoted
state and never an ancestor of it (`001_design.md` §0).

## 8. Honest limitation of the ref guard

The §3 dispatch check runs *inside* the already-selected body, so a malicious branch
could delete it. Tier E2 (workflow-internal), executing surface: the job itself,
known bypass: edit the step out on the dispatched branch, residual: accepted because
pushing such a branch requires repository write and the release branches are
protected. It is an **early warning against maintainer error**, not enforcement.

## 9. IN / OUT

IN: the workflow trigger and input normalization, the freeness assertion, the
readiness gate, the `version-line.ts` CLI, matching tests.

OUT: `scripts/release.ts`; the publish/pack path; the equality check at
`release.yml:175-184`, which stays exactly as it is; any deletion of
`bump-dev-version.ts` or its test; the `020` resolvers.

## 10. Accept criteria

1. `bun test tests/ci-workflows.test.ts` green with: the dispatch ref guard present;
   the `bump-dev-version` job absent from `release.yml`; the readiness step present
   in `publish`; and **the routing assertion** — the decision step, the freeness
   step and the PR body all read `steps.target.outputs.version`, and no step reads
   `inputs.intended-version` directly except the resolver.
2. `bun test tests/bump-dev-version.test.ts` green with the intended-version cases.
3. `bun run typecheck`.
4. A dispatched pre-move against a real intended version opens a PR whose only
   changed file is `package.json` and whose title names that version — the existing
   branch-content check (`dev-version-bump.yml:139-143`) is unchanged and still
   applies.
5. A dispatched pre-move whose target already has a tag fails at §4's assertion.
6. **The bypass sequence is covered.** `tests/version-line.test.ts` drives
   `assert-releasable` through the §5a scenario as data — tag set
   `[v2.42.0, v2.43.0-preview.1]` with candidate `2.42.1` must be refused, while the
   same candidate against `[v2.42.0]` alone is allowed. That is the
   CI-green-before-preview / dispatch-after-preview case reduced to the two inputs
   that actually decide it.
7. `tests/ci-workflows.test.ts` asserts the §5a step exists **and sits after** the
   preflight `git fetch --force --tags origin` (`release.yml:303`). Position is the
   whole point: before the fetch it would read a stale tag set. Asserted by index
   comparison, the same technique the file already uses for step ordering
   (`tests/ci-workflows.test.ts:788-795`).
8. **The CLI is tested, not only the pure function.** `tests/version-line.test.ts`
   spawns `bun scripts/version-line.ts assert-releasable <version>` with a tag list
   on stdin and asserts exit 0 / non-zero, plus the same for `assert-ahead`, plus
   that an **unknown subcommand exits non-zero with the usage line**. A pure-function
   test cannot catch a missing CLI branch — that omission is exactly what round 5
   found, where §5a invoked a subcommand §6 never implemented and every release would
   have been blocked.
9. **The dry-run exception survives.** `assertReleasable` with
   `allowExistingTagAtHead: true` accepts a candidate equal to an existing tag, and
   rejects it without the flag. Pinning both directions keeps a future simplification
   from quietly breaking post-release dry runs.

Criteria 4 and 5 need a real dispatch. 5 is cheap and safe: dispatch with an
already-released version such as `2.42.0` and confirm the refusal.

Criteria 6 and 7 are the ones that make `020` §4.0 a policy rather than a
suggestion, and neither needs a dispatch: one is a pure-function test, the other a
workflow-text assertion.

Criterion 1's routing assertion is the specific guard against this phase's failure
mode — an input declared in `on:` that nothing downstream reads.

## 11. Activation grounding

| Path | Trigger | Observable |
|---|---|---|
| input normalization, default | dispatch with `intended-version`, no mode | `steps.target.outputs.version` equals it; `mode=pre-move` |
| input normalization, repair | dispatch with `mode: repair` | same output; `mode=repair`; freeness check skipped |
| version missing | malformed invocation | `intended-version was not supplied` |
| dispatch ref guard | dispatch from a non-default branch | `may only be dispatched from the default branch` |
| tag-exists refusal | dispatch `intended-version=2.42.0` | `v2.42.0 already exists; this is a catch-up` |
| npm-exists refusal | same | `already on npm` |
| readiness gate fails | release dispatched while `dev` trails | `origin/dev carries X, which does not outrank Y` |
| readiness gate passes | release after a merged pre-move | step succeeds, publish proceeds |
| ordering gate refuses | candidate `2.42.1` with `v2.43.0-preview.1` in the tag set | non-zero exit naming the outranking tag |
| ordering gate passes | same candidate, no higher-core preview | step succeeds |
| dry-run re-run allowed | dry run, tag exists at this SHA | flag granted, step succeeds |
| same state, real publish | `dry-run=false`, tag exists at this SHA | flag withheld; `release.yml:314-317` refuses |
| unknown subcommand | `bun scripts/version-line.ts nonsense` | non-zero exit, usage line |
| no-op pre-move | dispatch when `dev` already outranks | `changed=false`, no PR opened |

Row 7 must be shown firing: it converts the pre-move from a habit into a gate.
Exercising it means dispatching a release before the pre-move merges — safe under
`dry-run: true`, the workflow's default (`release.yml:22-26`).
