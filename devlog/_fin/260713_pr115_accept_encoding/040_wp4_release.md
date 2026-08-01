# WP4: preview and stable promotion

## Version selection

- Read current npm dist-tags and repository version after `dev` CI.
- Choose the next unused stable patch version and a unique `-preview.20260713.N` prerelease. Never overwrite an existing version.

## Promotion order

1. Create a clean sibling release worktree on `preview`.
2. Fast-forward `preview` to `origin/dev`.
3. Install locked dependencies in the clean worktree and run `bun run release <preview> --tag preview --publish`.
4. Verify preview CI, trusted-publishing workflow, npm dist-tag, tarball integrity, provenance, and GitHub prerelease.
5. Download the published preview tarball with `npm pack`, extract it to a temporary directory, and require SHA-256 equality between `package/src/server/responses.ts` and `git show $PREVIEW_SHA:src/server/responses.ts`. Then, from a worktree pinned to exactly `$PREVIEW_SHA`, rerun `bun test --isolate tests/fetch-header-timeout.test.ts`; both artifact identity and the controlled gzip SSE batching/incremental assertions must pass before stable promotion.
6. Switch the release worktree to `main`, fast-forward through preview, and run `bun run release <stable> --tag latest --publish`.
7. Verify stable CI, npm `latest`, provenance, and GitHub release.
8. Fast-forward `dev` and `preview` to stable `main`; push and wait for final preview CI.
9. Remove the clean release worktree.

## Planned version-only diff

- MODIFY `package.json` once on `preview` and once on `main` through `scripts/release.ts`.
- No lockfile change is expected or accepted.

## Rollback boundary

- Before npm publication, a failed gate stops promotion and leaves only a branch/version commit to inspect.
- Published npm versions are immutable. If registry smoke fails after publish, do not republish the same version; mark the exact stage and prepare a new patch only after re-planning.
- Record the prior preview dist-tag (`2.7.10-preview.20260713`) before dispatch.
- If the version commit and CI succeeded but npm was not published, do not rerun `scripts/release.ts`; redispatch `release.yml` against the unchanged release SHA with the same version/tag only after proving npm, Git tag, and GitHub release are all absent.
- If npm published but tag or GitHub release creation failed, first require npm `gitHead` to equal the release SHA. Repair metadata only: create/push the missing tag at that SHA and create/edit the matching GitHub release (with `--prerelease` for preview). Never invoke `npm publish` again for that version.
- If the post-publish cadence or tarball-identity gate fails, stable promotion stops. Fix the code and publish a new, unique preview prerelease; successful publication moves the `preview` dist-tag away from the rejected build. Do not restore or mutate an immutable package version.

## Acceptance

- npm `preview` and `latest` resolve to the newly published versions.
- GitHub prerelease/stable release target the matching commits.
- The preview commit passes the controlled compressed-SSE cadence test after registry publication and before stable promotion.
- The downloaded preview tarball's `src/server/responses.ts` hash equals the file at npm `gitHead`/the preview release commit.
- npm attestation reports SLSA provenance.
- Remote `dev`, `preview`, and `main` resolve to one stable release SHA.

## Captured evidence

- Independent release audit initially returned two blockers; after adding tarball identity and stage-aware recovery gates, the same SOL reviewer returned `blocking_issues: []` and `VERDICT: PASS`.
- Preview `2.7.11-preview.20260713`: release SHA `fe302b7944df47a269673881818304f8a28c158b`; CI `29224218117`; OIDC release `29224361796`.
- Preview npm tarball SHA-256 for `src/server/responses.ts` equaled `git show fe302b79:src/server/responses.ts`: `e23d8df9a72c270a0a035d7ac308e04750b246f005deff5dc45e75f423a37287`.
- Exact preview SHA cadence gate: 3 pass, 0 fail; compressed path batches while `identity` delivers the first SSE frame incrementally.
- Preview npm metadata: `gitHead=fe302b79`, SLSA provenance v1, dist-tag `preview`; GitHub release is a prerelease targeting the same SHA.
- Stable `2.7.11`: release SHA `e6d516ae0652f88aa3ef81a495a2b54586210190`; CI `29224504216`; OIDC release `29224642222`.
- Stable npm metadata: `gitHead=e6d516ae`, SLSA provenance v1, dist-tag `latest`; GitHub release is stable and targets the same SHA.
- Final `dev`, `preview`, and `main` all resolve to `e6d516ae`; preview/dev Cross-platform CI and Service lifecycle runs `29224718979`, `29224719112`, `29224737093`, and `29224737095` all passed.
- PR #115 is merged through `150873e6`; issue #114 is closed.
