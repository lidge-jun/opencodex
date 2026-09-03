# wp3 — Preview release (`preview` dist-tag)

## Why the helper cannot run

`scripts/release.ts` preflight runs `bun test --isolate tests` plus seven
isolated files. The user forbade the local suite for this unit, so invoking
the helper would violate the constraint before it reached the bump. The helper
is not broken; it is simply out of bounds here.

## The manual path

Everything the helper does after its preflight is reproducible by hand, and
each step keeps its own gate. Steps 0 and 4 were added after audit round 1
(`005`); without them this path is strictly weaker than the helper it replaces.

0. **Prove the version is available BEFORE mutating anything.** The helper does
   this at `scripts/release.ts:513` — unused on npm, no existing tag or GitHub
   release, and greater than what the channel currently carries. The workflow's
   own duplicate check (`release.yml:303`) fires only after dispatch and never
   checks channel ordering, so skipping this means learning about a collision
   from a failed publish with the bump already pushed.

   Four checks, each of which must FAIL THE STEP rather than merely print. A
   command that only retrieves data is not a gate:

   ```bash
   V=2.41.0-preview.YYYYMMDD
   # 1. the exact version is unpublished
   npm view "@bitkyc08/opencodex@$V" version 2>/dev/null && { echo "published"; exit 1; }
   # 2. no git tag
   git ls-remote --tags origin "refs/tags/v$V" | grep -q . && { echo "tag exists"; exit 1; }
   # 3. no GitHub release
   gh release view "v$V" >/dev/null 2>&1 && { echo "release exists"; exit 1; }
   # 4. it moves the CHANNEL forward
   npm view @bitkyc08/opencodex dist-tags --json   # compare against .preview
   ```

   Check 4 is the one with no automated equivalent anywhere in the workflow:
   `release.yml` will happily publish a version that moves `preview`
   BACKWARDS, because its only duplicate check is exact-version equality. Read
   the current `preview` tag and confirm the new version sorts after it under
   semver.
1. Open a promotion PR from a branch **pinned to the reviewed SHA** (not the
   moving `dev` ref) into `preview`, and merge it with admin. `preview` is
   protected by a ruleset requiring a reviewed pull request, so promotion is by
   PR; #3260/#3261 and #3123/#3125 are the precedent. Expect `enforce-target`
   to flag the base — a promotion PR is exactly the case that check is not
   written for — and record the admin bypass rather than waiting for green.
2. `dev` already carries `2.41.0` (`package.json:3`), so the preview channel
   needs the prerelease suffix and nothing else: bump to
   `2.41.0-preview.<YYYYMMDD>` in a second PR onto `preview`. `release.ts`
   enforces the `-preview.` infix; the workflow enforces `version` equals
   `package.json`.
3. Record the release SHA (`preview` head after the bump merges) as the full
   lowercase 40-character hash. `release-dispatch-guard.cjs:14` rejects a short
   or upper-case SHA outright.
4. Wait for `ci.yml` AND `service-lifecycle.yml` to succeed on that exact SHA,
   **as push-event runs on `preview`** — `release.yml:222` will not accept the
   PR-event run that produced the same tree. The bump touches `package.json`,
   which is a service-lifecycle trigger path, and `release.yml`'s service gate
   requires an already-successful lifecycle run for the release SHA, so
   dispatching early races it.
5. Re-read the LIVE remote head (`git ls-remote origin preview`) and confirm it
   still equals the release SHA. The helper does this immediately before
   dispatch for a reason: `workflow_dispatch` resolves a mutable branch.
6. `gh workflow run release.yml --ref preview -f version=<v> -f tag=preview
   -f expected-sha=<sha> -f dry-run=false`.
7. Watch the run; verify `npm view @bitkyc08/opencodex dist-tags --json` moves
   `preview`, and that the GitHub prerelease tag resolves to the release SHA.

## Publishing is tokenless

There is no `NPM_TOKEN` to supply and none may be introduced. Publication runs
under OIDC Trusted Publishing: `id-token: write` (`release.yml:119`), npm
>= 11.5.1 (`:153`), and an npm Trusted Publisher binding for this repository and
workflow (`:285`). A failure there is a registry-side configuration problem,
not something to route around with a credential. `concurrency: group: release`
is shared with the stable publish, so the two channels serialize.

## Failure handling

If the dispatch fails after the bump is already pushed, do not re-bump. Re-run
the failed workflow once, confirm the remote SHA did not move, and re-dispatch
with the same `expected-sha`. The `validate-dispatch` job refuses a dispatch
whose `expected-sha` does not equal `GITHUB_SHA`, which is exactly the guard
that makes a re-dispatch safe.

That reuse is for a TRANSIENT failure — a runner fault, a flaked job, a race
with the lifecycle gate. If the publish actually reached the registry, the
version is spent: npm forbids republishing it, so the recovery is a new
version, not a retry. Check `npm view` before deciding which case you are in.

## Note on the automatic dev bump

`release.yml` calls `dev-version-bump.yml` after a non-dry-run publish. For a
preview publish it usually returns `changed=false` because `dev` already
carries the stable core. Expect that, and do not treat the skipped bump PR as
a failure.
