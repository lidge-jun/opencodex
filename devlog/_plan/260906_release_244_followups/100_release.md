# Release verification and publication

Depends on all preceding delivery criteria. Class C4. No local test/build/typecheck run.

## Exact actions and file map

- MODIFY package.json via scripts/bump-dev-version.ts for pre-move: for target 2.44.0 dev must outrank target before publish (normally 2.45.0). Freeze feature RC before pre-move and pin it.
- Use existing scripts/release.ts authority and .github/workflows/release.yml, ci.yml, service-lifecycle.yml. No changes planned unless an evidenced defect blocks this train; add a dedicated phase for such repairs.
- Create bounded promotion branches from verified feature RC independently for preview/main; version-only preparation matches intended preview/stable targets. Never mix unrelated current-main state or overwrite the bound worktree. Reviewable promotion PRs include target exception and verified UI screenshot/link from current delta.
- Push --no-verify; merge --admin --match-head-commit after exact-SHA gates. Prefer merge ancestry on live stacks; squash only terminal branches with cascade accounted for.
- Dispatch ci.yml lane=all on the frozen candidate AND each exact preview/main publish expected-sha (version-only promotion commits are separate heads); require actual successful windows 1/6 through 6/6 plus Linux/macOS, gates/privacy/typecheck and package install jobs where applicable. Dispatch service-lifecycle.yml on exact final promotion heads if not triggered. Do not count skipped windows as passed. Wait for the main promotion head docs build from deploy-docs.yml before stable publication; it is separate from ci.yml, which does not build documentation.
- Dispatch release.yml using verified inputs version, tag, expected-sha, dry-run=false. Preview precedes stable; npm target @bitkyc08/opencodex. No helper rehearsal assumed nonmutating.
- Verify npm version metadata, dist-tags, tarball sha512, gitHead, signed provenance, git tag target and GitHub release for each channel. If publish succeeded but smoke failed, inspect before retry; never republish blindly.
- Close fully resolved issues and superseded source PRs with original-author credit and actual landing references. Keep #3644 open if network root cause remains unproved and clearly communicate its tested diagnosis outcome. Document Kiro live test absence.
- MODIFY this unit's numbered evidence/closeout; archive to devlog/_fin only after outcome is public. Complete goal only after E8 criteria and every D closure succeeds.

## Failure activation / proof

A failed exact-SHA run triggers log-based RCA and repair; newer dev invalidates ancestor assumptions and is fetched before merge. A missing service run is dispatched, not skipped. Registry already-published check prevents duplicate publication. Final source head, artifact head and tag head must match documented promotion topology. Rollback means redeploy prior known package/version; immutable npm version is not deleted or overwritten.

## Resources and security

GitHub Actions/OIDC and existing registry read access, no static npm secret introduced. Existing main/preview protection retained; per-user admin merge authorization applies to this train. Commands bounded at 30 minutes, polls <=60s, continue across CI windows with persistent evidence. Source runtime and artifact validation use remote CI only.

