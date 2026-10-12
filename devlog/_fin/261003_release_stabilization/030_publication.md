# Production promotion and publication

Depends on the accepted immutable candidate C. Intended next stable is provisionally
2.77.0, subject to fresh registry/tag ordering and concurrent release inspection.
No preview release is requested. Existing OIDC release workflow is the publication path.

## Version and branch changes

MODIFY exactly the four version sources through their owner command/workflow when needed:
`package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`,
`desktop/src-tauri/Cargo.lock`. Before: dev version equals target V. After: dev strictly
outranks V; candidate C and main promotion retain V. Do not manually rewrite lock content.

1. Confirm V is unused on npm, Git tags and GitHub releases and outranks global release
   tags under `scripts/version-line.ts`. Read live `MAINTAINERS.md` and rulesets.
2. Dispatch `dev-version-bump.yml` from main with `intended-version=V`, `mode=pre-move`.
   Review/merge its dev PR after applicable CI. If dev already outranks V, retain its
   explicit no-op result. Do not promote the advanced dev version by accident.
3. Prepare `codex/promote-main-V` from C. Reconcile main ancestry with documented
   promotion tooling while preserving the candidate tree. A history-only merge using
   the ours strategy is valid only after proving every main-only code delta is already
   present or deliberately reconciled; otherwise merge normally and revalidate.
4. Open a main-targeted promotion PR using the repository template and required GUI
   screenshot evidence from landed PR assets. Observe actual main review/ruleset policy;
   the dev-only self-integration exception does not authorize bypassing main approval.
   The owner's explicit release authorization for this unit is a separate promotion
   authority: current policy says release review by both maintainers is recommended
   when practical, not unconditionally required for a maintainer-authored promotion.
   Use the existing admin PR-only route only after independent review/CI and current
   actor entitlement are verified; record that owner authorization on the promotion PR.
   This follows the documented owner-authorized promotion procedure and does not alter
   rulesets, waive outstanding objections, or permit a direct main push.
5. After authorized promotion, capture exact main SHA R and its successful **push-event**
   Cross-platform CI and required Service lifecycle run. C's manual run is not a substitute.
6. Verify R still owns main immediately before dispatching the supported release workflow:
   `gh workflow run release.yml -R lidge-jun/opencodex --ref main -f version=V -f tag=latest
   -f dry-run=false -f expected-sha=R`. This is the same guarded publication workflow
   used by `scripts/release.ts`; no local npm publish or direct protected-branch push.

## Publication proof and recovery

Observe preflight, platform packaging, npm publication, GitHub asset attachment and
deployed docs. NEW ignored publication receipt records builder/run/attempt, exact source,
registry version/dist-tag/gitHead/integrity/provenance, release tag and all expected assets,
checksums, signed updater metadata and isolated install/launch smoke results.
Compare expected artifacts with the workflow and previous stable release, not a fixed count.
Do not upgrade the operator's installed proxy as an incidental smoke test.

If npm publication is acknowledged but a later job fails, retain that evidence and use
the explicit `resume-after-npm-publish=true` path only when official registry gitHead
matches R. Never republish an existing version or force-move a public tag.
Recovery keeps the prior stable package/artifacts available and does not downgrade
user data; if a bad new version requires withdrawal or a tag rollback, stop that mutation
for its separate concrete decision and prepare a forward fix within scope.

Completion: publication workflow and deployed surfaces verified, exact artifact proof
recorded, remaining platform limits stated, and this unit moved to `_fin/` only after
its public outcome exists. Release notes retain source-author attribution.
