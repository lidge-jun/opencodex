# wp5 — preview promotion and prerelease

Preview goes first because 248 commits is too large a step to take straight onto
`main`. The prerelease is the only place the changed config-injection path meets a real
user config before the stable channel does.

## Sequence

Decide the prerelease version and bump the dev version line so `release.yml`'s
`assert-ahead` check passes, promote dev into `preview` through a pull request because
the branch ruleset requires one, wait for the `preview` push-event `ci.yml` run to
report success, then dispatch the Release workflow with the preview dist-tag and the
exact release SHA pinned in `expected-sha`.

The workflow also demands a successful `service-lifecycle` run when service-related
files changed since the previous merged tag. That condition has to be checked against
the actual diff, not assumed.

## Exit

`npm dist-tag` `preview` points at the new prerelease and the publishing run is green.

## Resolved numbers

The prerelease is `2.52.0-preview.20260912`. `nextPreviewRelease` refuses a patch bump
while the higher-core preview `2.52.0-preview.20260911` is open, so the bump kind is
minor, and the UTC stamp is newer than the incumbent's so no ordinal suffix is added.
dev already carries 2.52.0, which outranks that prerelease, so `assert-ahead` passes with
no dev pre-move.

Promotion is a pull request. The `Protect preview` ruleset gives admin a
`pull_request` bypass only, so even an owner cannot push the branch directly; the
`DeployKey` bypass exists for `scripts/release.ts`'s version-bump push and nothing else.

The dispatch is
`gh workflow run release.yml --ref preview -f version=2.52.0-preview.20260912 -f tag=preview -f expected-sha=<40-char preview SHA> -f dry-run=false`.
Omitting `--ref` sends it to `main`.
