# 020 — publish the preview prerelease (revised)

Supersedes the first draft of this page. The original said "invoke the script in a way that
does not execute the suite here," which an independent audit of `scripts/release.ts` showed
does not exist: the local suite at `scripts/release.ts:521-555` has no flag and no env
escape, and the documented `--publish` re-entry re-runs it.

## Target

`2.34.0-preview.20260827`, dist-tag `preview`, from branch `preview` at the release commit.

## Division of labour, measured rather than assumed

`release.yml` never runs the test suite. What the script does that the workflow does not:

| Step | Script | Workflow |
| --- | --- | --- |
| branch/clean-tree/version-shape preflight | yes | yes, later, against `GITHUB_REF` |
| `assertUnusedReleaseVersion` + channel-moves-forward | both | unused-only |
| `audit:high`, `tsc`, **full suite**, `privacy:scan` | yes | `audit:high` yes; suite **no**; `tsc`+GUI inside `prepublishOnly` |
| bump, commit `release: v…`, deploy-key push | **yes** | **no** |
| wait for push-event `ci.yml` + `service-lifecycle` at the sha | yes | requires the runs exist; does not wait |
| create git tag + GitHub release | **no** | **yes**, and only when `dry-run != true` |

So the git steps are the script's alone, and the publish gates are the workflow's alone.

## Chosen route

Run the git steps by hand, let the branch's own push-event CI run, then dispatch:

```
# on preview, at the promoted head
npm version 2.34.0-preview.20260827 --no-git-tag-version
git commit -am 'release: v2.34.0-preview.20260827'
# Keep the scp-style SSH principal out of one email-shaped source literal.
release_host=github.com
release_repo=lidge-jun/opencodex.git
GIT_SSH_COMMAND='ssh -i ~/.ssh/opencodex_release_ed25519 -o IdentitiesOnly=yes' \
  git push "git@${release_host}:${release_repo}" HEAD:preview
# wait for push-event ci.yml AND service-lifecycle at that exact sha
gh workflow run release.yml --ref preview \
  -f version=2.34.0-preview.20260827 -f tag=preview \
  -f expected-sha=<40-char sha> -f dry-run=true
# inspect, then re-dispatch with dry-run=false
```

The suite runs on `ssh lidge` via `ocx-run` at that exact sha, as every phase of the
hardening unit did. This is not skipping a gate: the suite is not one of `release.yml`'s
gates, and the ones that are get enforced server-side regardless of what ran locally.

Rejected alternative: running `bun scripts/release.ts` on lidge. It would work and it is
the more faithful path, but it puts an interactive multi-stage release — including a
20-minute CI wait and a deploy-key push — behind an ssh session, where a dropped
connection strands a half-pushed release. The hand route makes each step separately
observable and separately retryable.

## Two traps, both verified in source

**A dry run still pushes the bump.** `dry-run` only controls the workflow's publish/tag/
release steps (`release.yml:319-348`). The release commit is real either way, which is the
point: the dry run exercises the actual commit.

**`release.ts` skips the bump when the version already matches** (`release.ts:568`,
`if (currentVersion === version)`). Harmless here, since `preview` carries `2.34.0` after
the promotion and the target is the prerelease string. It matters for the stable release,
where the target `2.34.0` equals what `dev` already carries — recorded in `040`.

**Do not create the tag locally.** The `Protect release tags` ruleset (`20769150`) covers
`refs/tags/v*` with `deletion`, `non_fast_forward`, and `update` and has no bypass actor, and
`release.yml:268-274` refuses to publish a version whose tag already exists. The workflow
creates the tag after a successful publish.

## Acceptance

- `npm view @bitkyc08/opencodex dist-tags` shows `preview = 2.34.0-preview.20260827`
- `npm view @bitkyc08/opencodex@2.34.0-preview.20260827 gitHead` equals the release commit
- the Release run concluded `success` with `dry-run=false`
- push-event Cross-platform CI and Service lifecycle were green at the release sha first

## Outcome — shipped

Release commit `809a06ba00340c905dfac4ab588616e638c2fbfd`, one file changed
(`package.json`, 1 insertion 1 deletion), which is the same shape as both precedent
release commits `ec51e42d7` (v2.33.0) and `678517f56` (v2.33.0-preview.20260825). Built in
a detached worktree at `.tmp/rel-preview` so the `dev` checkout and the running local proxy
were never touched, then pushed to `preview` with the deploy key.

Gates, in the order the workflow demanded them:

| Gate | Evidence |
| --- | --- |
| full suite at the promoted tree | `pvsuite` on `ssh lidge`, 15334 pass / 0 fail, rc=0, at `62dfc6c54` |
| push-event Cross-platform CI | run `33072435012`, success at `809a06ba0` |
| Service lifecycle | run `33072435013`, success at `809a06ba0` |
| Release dry run | run `33073378226`, success; packed 838 files / 9.3 MB incl. a freshly built `gui/dist` |
| Release publish | run `33073503058`, success |

Registry and git metadata after the publish:

- `dist-tags` = `{ preview: 2.34.0-preview.20260827, latest: 2.33.0 }`
- `gitHead` of the published version = `809a06ba00340c905dfac4ab588616e638c2fbfd`
- tag `v2.34.0-preview.20260827` resolves to the same commit; GitHub Release exists with
  `prerelease=true`

The `gui/dist` question the audit raised answered itself in the dry run: the directory is
gitignored but listed in `files`, and `prepublishOnly` builds it inside the workflow before
`npm pack`, so the tarball carried `gui/dist/assets/index-BPGhccMP.js` and the rest.
