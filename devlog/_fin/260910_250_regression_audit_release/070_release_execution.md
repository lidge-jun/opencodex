# 2.50.0 execution runbook (wp4)

The exact sequence, with the value each step must record. `020_release_plan.md` says why;
this says what to run. Every SHA below is written down as it is produced, because the next
step verifies against it rather than against "current".

## Fixed inputs

| Name | Value |
| --- | --- |
| Freeze SHA | `12c248f52bed88ea13be5b284c79a238feb592d1` |
| Freeze tree | `d8f5a7143bcd6cb86185c4e8d4c6a6c4ad0fa822` |
| Version | `2.50.0` |
| Previous release | `v2.49.0` at `main` `2f3f736299dca38861f8fb9c4326a4b4d7c664bc` |
| Default branch | `main` |

## Step 1 — pre-move `dev`

```sh
gh workflow run dev-version-bump.yml --ref main \
  -f intended-version=2.50.0 -f mode=pre-move
```

The workflow opens a pull request; it cannot push to `dev` because the `Protect dev`
ruleset requires review. Merge that PR, then confirm:

```sh
git fetch origin dev
git show origin/dev:package.json | head -3   # must read 2.51.0
```

Record: the bump PR number and the merged `dev` SHA.

Why this is first: `release.yml:242-249` runs
`bun scripts/version-line.ts assert-ahead <dev version> 2.50.0`, which fails while `dev`
is still 2.50.0. Doing it after the promotion would strand a published-but-refused release.

## Step 2 — promote the freeze SHA to `main`

```sh
git fetch origin main
git switch -c codex/release-250-main origin/main
git merge --no-ff 12c248f52 -m "release: promote verified 2.50.0 product tree to main"
git rev-parse HEAD^{tree}   # must equal d8f5a7143bcd6cb86185c4e8d4c6a6c4ad0fa822
```

If the tree does not match, a conflict resolution changed the product and the audit no
longer describes what would ship. Stop and re-derive rather than adjusting the expectation.

Open the PR into `main` using `.github/PULL_REQUEST_TEMPLATE.md`, merge it, then:

```sh
git fetch origin main
git rev-parse origin/main            # record as MERGE_SHA
git rev-parse origin/main^{tree}     # must still equal the freeze tree
```

Record: the promotion PR number, `MERGE_SHA`, and the confirmed tree.

## Step 3 — wait for the release-branch gates on `MERGE_SHA`

Both fire automatically on the merge push — `ci.yml` because `main` is in its push
branches and `src/**`/`gui/**` changed, `service-lifecycle.yml` because `package.json` and
`src/cli/index.ts` are in its push paths.

```sh
gh run list --workflow ci.yml --commit "$MERGE_SHA" --event push --json conclusion,url
gh run list --workflow service-lifecycle.yml --commit "$MERGE_SHA" --json conclusion,url
```

Both must reach `success`. If Windows shard 5/6 times out on the Log Guard reclaim test
again, rerun that job in place with `gh run rerun <id> --failed`; the gate reads the run's
conclusion, which a rerun updates. That is the recorded mitigation, not an improvisation.

## Step 4 — dry run, then publish

```sh
gh workflow run release.yml --ref main \
  -f version=2.50.0 -f tag=latest -f expected-sha="$MERGE_SHA" -f dry-run=true
```

A dry run still executes `prepublishOnly` (typecheck plus the GUI build), so a green dry
run is real evidence about the package, not a formality. Only then:

```sh
gh workflow run release.yml --ref main \
  -f version=2.50.0 -f tag=latest -f expected-sha="$MERGE_SHA" -f dry-run=false
```

## Step 5 — verify the artifacts independently

```sh
npm view @bitkyc08/opencodex dist-tags --json
npm view @bitkyc08/opencodex@2.50.0 version gitHead dist.integrity --json
git ls-remote --tags origin | grep v2.50.0
gh release view v2.50.0 --json tagName,isDraft,isPrerelease,createdAt
```

`gitHead` must equal `MERGE_SHA`. npm propagation lag shows a 404 or a stale `latest`
for a while; poll. **Never republish because a smoke step timed out** — inspect metadata,
provenance, and the tarball first, because npm may already have accepted the publish.

Record every value into the release-artifacts table in `030_evidence.md`.
