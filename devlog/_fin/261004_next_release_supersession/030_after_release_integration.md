# Work phase 3 — Integrate after current main release

Depends on wp2 and the owner's verified release-completion condition. Lane merge authority remains false; coordinator conditional authority became active only at the release-satisfied record below.

## Changes and evidence
- NEW .tmp/next-release/release-gate.json: target version, release tag/commit, successful release-event run/attempt, published GitHub release, npm version/integrity/provenance where available, observedAt. Determine target from active release thread/source, not latest-version guessing. A tag or main promotion alone is insufficient.
- MODIFY prepared PR heads only as needed to reconcile final dev and reviewer feedback; lane-owned checkout operations stay with lane, or coordinator adopts an inactive checkout explicitly after confirming no writer remains.
- MODIFY GitHub PRs: draft to ready only on evidence; current required CI and explicit security review for applicable boundaries; no unresolved maintainer objection; maintainer integration decision under MAINTAINERS.md; sequential authorized merge into dev, no direct push.
- NEW 031_integration_results.md: per-PR head, actual tested SHA/event/run/attempt, required-job coverage, merge SHA/dev ancestry; post-merge regression status and issue closures where full acceptance met.

## Acceptance and failure paths
Release pending/failed -> no merge, continue independent preparation. Head/base change -> revalidate relevant delta and CI. Missing/skipped/cancelled/older checks -> not passing. Failed gate -> repair relevant defect, preserve assertions. Partial original issue acceptance -> keep issue open even if a PR merged. Main/preview promotion, package publication and installed runtime changes remain out of scope. Runtime behavioral verifier belongs to each lane; coordinator verifies actual hosted/merge evidence and preserved attribution. Resource scope unchanged; no user-set token/time budget.

## Independent audit amendment
Reviewer 01a1048c-c289-7a40-b964-811afb994551 identified that listing receipts alone did not require agreement. Accepted and fixed: before any merge, confirm the actual target version from the current release coordinator; require `.github/workflows/release.yml` completed successfully on the pinned main release SHA via workflow_dispatch with dry-run=false. Published tag and verification receipt must match that version/SHA. GitHub release must be published, non-draft and non-prerelease with all expected verified assets (derive set from workflow). Fresh npm exact-version metadata and integrity must agree with the source and `latest` must point to the confirmed target (or a later verified stable publication covering it). Missing, mismatched, dry-run-only or unconfirmed publication evidence keeps merges disabled. A later verified stable exception needs explicit reconciliation evidence, not an assumed numeric comparison.

Amendment re-review: same independent reviewer returned VERDICT: PASS; blocking_issues: none. This is plan approval, not release-completion or merge evidence.

## Cross-lane reconciliation map
Preparation snapshot identifies five shared paths: Claude/picker guide; Claude/retry provider guide; catalog/cache/retry layout registry and expected fixture; catalog/restart CLI index. Keep both independent documentation contracts and every test-registration addition. Recheck the file-size ratchet at the combined head; never raise its baseline. Typecheck the union after dependent base changes to catch exhaustive type/catalog drift. These overlaps create no cross-feature prerequisite; genuine catalog A1→A2→audit/healer and Claude tool→pool→defaults dependencies govern order. All merges remain serial and release-gated.

## Release gate satisfied
Observed 2026-10-04 02:50:53 UTC: v2.77.0 is published stable, release workflow37170949169 attempt1 completed success at main06841165f884a9176d701310638b2112aca7a514. Tag and verification receipt match. All24 expected files plus updater manifest are published; receipt verifies10checksums/4signatures. npm exact2.77.0 and latest both resolve to2.77.0 with matching gitHead; downloaded13,561,986-byte package matches registry SHA512. No installation occurred. Machine receipt: ignored .tmp/next-release/release-gate.json. Conditional owner authorization now permits dev integration; per-PR gates remain mandatory and new release publication is still out of scope.

## Executable integration decisions (architect NR-D01–D08)
Main accepts all decisions with one scoped clarification: post-merge checks means applicable workflows actually configured for dev; ci.yml does not run the full cross-platform suite on every dev push. Every later PR still needs fresh accepted head/base integration evidence, and any applicable post-merge red blocks further landing. No fabricated absent dev run.
- Order preference: independent6554→6557→6551→6555, then Claude6552→6559→6562, catalog6553→6558→6560→6563. Independent ready roots may fill waits; chain order cannot invert.
- Each PR merges individually into dev. Use merge commits for chain roots/layers to preserve ancestry; singles may squash. Keep every parent branch while an open child targets it. After parent lands, owner reconciles/retargets immediate child to dev, confirms intended remaining diff and fresh current-head/base checks. No deepest-child consolidation or native stacks.
- Checkout ownership remains with each dispatched lane. Main requests refresh/repair from the owning task; no cross-worktree edits or ref rewrites while any writer is active. Positive idle/handoff and clean/ref snapshots are required before any later adoption.
- Each merge packet records ready state, live maintainer actor/permission, exact head/base SHA and repo, native membership, technical/security review, no unresolved objections/findings, credit, validation, actual tested merge parents and relevant successful checks/run/event/attempt. Helper success alone and draft-skipped CodeRabbit are not enough.
- Mark ready only after current evidence supports it; record explicit maintainer-integration decision; reread head/base immediately before guarded merge. Check merged state/SHA/dev ancestry and applicable postmerge results. Stop on demonstrated regression, repair via PR without weakening assertions.
- Eleven accepted PRs target integration;6556 remains separately deferred. Full issue acceptance is still required to close issues after landing.

## wp3 P revalidation
Previouswp2Dverified9sourceclosures with no shippedclaims. This cycle consumes unchanged NR-D01-D08 executableplan and its actual architectALIGNED/reflection plus independentPASS. ReleasegatePASS remains at02:50:53Z; firstslot6554owner refreshed to89ae31b9ed on596525686b. Sourceowners keep checkoutwrites; every nextbase is revalidated. CurrentCI remains required, not implied bypublication orpriorheadgreen.

NR-D09 ancestry-only CI reuse was examined but is not selected for this run. Tree equality alone does not establish workflow applicability: Service lifecycle selects dev/main bases, and repository checks also consume tags/ancestry. No child was certified under the conditional proposal. The existing strict accepted-base/actual-tested-parent packet remains in force; owners refresh and receive new applicable CI after parent landings. No passing result is relabeled as execution against a different base.

Observed hostpolicy clarification: repo auto-delete-on-merge removed6552remotehead despite no delete request; GitHubsimultaneouslyretargetedimmediatechild6559todevwithoutclosingit. Do not changereposettings or recreate refs justtooverridehostpolicy. Preservecommitancestry/localrefs, verifychildOPEN/base/headandrefreshevidence. Agentstillneverexplicitlydeletesparentbranches.
