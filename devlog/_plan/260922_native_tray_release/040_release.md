# wp4 — Stable and preview delivery

Depends on wp3. User explicitly selected both main and preview publication.

## Changes and operations

- MODIFY `.github/PULL_REQUEST_TEMPLATE.md` sections in the actual PR body only: problem/result, exact-head validation, native screenshot, checklist and maintainer integration decision. Ordinary PR to dev, one branch with ordered commits; no native stack. Push/merge are authorized by the release request, subject to actual checks/review policy.
- READ latest `MAINTAINERS.md`, `scripts/release.ts`, release/dev-version-bump workflows, npm/GitHub published versions and branch rules before selecting versions. Record exact version matrix and promotion SHA.
- If dev does not outrank the intended release, use the repository's dev-version-bump PR flow before publication. MODIFY only version-bearing files selected by that canonical flow, no ad-hoc drift.
- Promote dev through PRs to main/preview following required review/branch policy. No direct protected-branch push or force push. Keep objections and security review separate; do not fabricate independent approval.
- Execute the canonical release command/workflow with exact expected SHA, branch, version and dist-tag. Stable and preview runs are serialized. A failed or pending workflow is not published success; reconcile before retrying.
- VERIFY GitHub release/tag and artifact inventory/checksums/signatures/updater manifest, npm versions/dist-tags/gitHead and required exact-head CI. Use hosted installed-artifact validation when runners exist. The authorized local app update preserves backup and runtime ownership, but local interaction, CLI and health probes remain NOT RUN under the latest instruction. Record artifact identity without claiming local execution proof.
- MODIFY this unit's `041_release_receipts.md`, then archive the unit to `devlog/_fin/` only once all cycles are terminal.

## Acceptance and rollback

Both channels have reachable verified artifacts at their recorded commits; the authorized app update is completed and local interaction remains explicitly unverified under the no-local-tests instruction. Keep the prior application backup and prior published version/digest so local rollback is reversible. Never republish the same version to repair a bad artifact; use repository release policy. If a protected promotion requires an independent maintainer action not available to this session, stop that publication step with the exact blocker while completing all independent preparation; no bypass inferred from beta status.

## Publication observation during wp3

On 2026-09-22 the official npm registry reports version2.60.0 exists with gitHead7c625fc9755c9824653ab944190e243091a2c85c, matching origin/main and the published GitHub v2.60.0 release. However the live npm tags are latest=2.59.0 and preview=2.55.0-preview.20260914. This was re-read with the explicit official registry and prefer-online; no dist-tag mutation was performed. Both requested channel deliveries must verify the actual final registry tags in addition to GitHub assets and version existence. Do not republish2.60.0 or silently count it as the current latest tag.

## Executable wp4 plan — 2026-09-22
The native tray and regression candidate is verified at 3d64bd3040b2da7953962da3c05be14f31991e56.
This phase integrates that exact candidate and publishes independently derived preview and stable
artifacts. Release notes and receipts distinguish source review, hosted execution and installation.

Loop: satisfy-spec, C4 release operations; trigger: explicit both-channel delivery and subsequent
dev admin-merge authorization. Goal: both channels published with verified artifacts and the
authorized app update. Non-goals: no local tests, typechecks, builds or QA probes; no live runtime
restart, credential changes or protection-rule mutation. Main executes, Sol reviews read-only.
No user-imposed time/token budget. Memory artifact: this unit and its release receipts, plus
ignored operational receipts in .tmp/native-tray-design. Success ends only after both channels
are verified; pending or partial publication remains unfinished. Escalate only actual unavailable
promotion authority, signing credentials or installation access, after completing independent work.

### Dependency order and file map
1. D1: Re-read PR #5490 head, all exact-head hosted results, automated reviews and maintainer
   objections. Explicit owner-authorized admin merge targets dev only. It is not an independent
   approval. Source/security review is recorded separately. Keep this plan amendment uncommitted
   until the delivery metadata commit; the remote PR head remains the verified candidate.
2. D2: Fetch the resulting dev merge SHA and freeze its immutable 2.61.0 RC branch/tree before
   changing the dev version. Confirm the merge contains the reviewed changes without unexpected
   product differences. Keep the source candidate pinned if dev advances.
3. D3: Dispatch dev-version-bump.yml from main with intended-version=2.61.0, mode=pre-move;
   review and merge its package-only PR after hosted checks. Confirm dev is 2.62.0.
4. D4-D6: Prepare preview through an ordinary promotion PR based on current preview plus the
   frozen RC. Use actual KST publication date in 2.61.0-preview.YYYYMMDD, adding an unused ordinal
   when necessary. MODIFY package.json, desktop/src-tauri/tauri.conf.json, Cargo.toml and Cargo.lock
   consistently; apart from release metadata, retain the frozen product tree. Observe final
   promotion-SHA push CI/service success. Dispatch release.yml dry-run then publication, serialized,
   tag=preview and exact expected-sha. Verify embedded desktop version in hosted artifacts and
   npm version/dist-tag/gitHead/integrity/provenance, tag/release target, asset set/checksums and
   updater signatures. Preview uses its tag-specific manifest; stable updater discovery is unchanged.
5. D7-D9: Prepare main independently from the same RC, never from preview or post-bump dev.
   All four version authorities remain 2.61.0. Repeat final-SHA push CI/service, canonical dry-run
   and publication with tag=latest. Verify both dist-tags, all assets and the stable latest manifest.
   Use hosted installed-artifact validation where configured. Local update is authorized but local
   execution checks remain NOT RUN under the latest prohibition; preserve the prior app backup,
   user configuration and running proxy. Do not represent installation alone as interaction proof.
6. D10: If publication is partial, inspect the actual registry/tag/release state. Resume only an
   acknowledged npm publication at the identical version/SHA using the canonical source-bound
   resume path. Missing/mismatched provenance or signing evidence refuses completion.
7. D11: Promotions retain current MAINTAINERS.md rules. Record any explicitly authorized owner
   override as an override, never an independent approving review. Do not weaken rulesets.
8. UPDATE 041_release_receipts.md with exact SHAs, versions, URLs and observable limitations;
   archive the unit only after both channels and acceptance criteria are terminal.

### Reachable verification and failures
- GitHub gh run view/watch reads exact head/status/jobs: the wp3 PR, all-platform and service runs
  completed successfully; receipt command exit0 was observed at the clean candidate. These are
  read-only hosted-result queries, not local tests.
- New release/promotion runs are NOT RUN yet. Their workflow definitions read checkout/version,
  expected-sha, CI/service history, signing inputs, generated bundle bytes and registry state.
  Actual triggers are workflow_dispatch on the selected protected branch with a full expected-sha.
- Branch movement must fail the dispatch identity check; existing consumed versions must fail
  fresh publication; missing signing inputs or invalid assets must fail before publish; registry
  source mismatch must fail resume. Do not activate destructive failures against public versions.
- No local verification command is implied by this plan. Windows/macOS skipped jobs, cancellation,
  old-commit runs and review comments are not substituted for current execution evidence.

### Architect consultation
Architect: Newton (01a0c744-11eb-7dd2-9af9-37d2b735b545), read-only Sol. Proposal D1-D11 accepted.
Main amendment to D9: latest no-local-tests instruction excludes local probes; use hosted artifact
checks and report local execution unverified. Promotion authority remains explicit per D11.
Same-architect reflection and independent audit are recorded before execution.

### D0 — integration-review correction before D1
GitHub Codex review at the verified head reported comment4070117466: a committed gateway write
followed by unreadable first-party settings returns before persisting the gateway mode and apply
fingerprint. Accepted for correction in this integration phase, without invalidating the prior
wp3 evidence at its recorded head. MODIFY the CLI apply path and both management paths to persist
committed gateway bookkeeping before reporting cleanup failure, while keeping the failed cleanup
visible and preserving any separate bookkeeping warning. Add focused cases to the existing
Claude Desktop first-party suite: start from first-party, make settings unreadable, apply gateway,
observe failure/partial cleanup and persisted gateway mode/fingerprint, and confirm a subsequent
default apply selects gateway. Include API, native-toggle and CLI paths as applicable. Update the
owning Desktop contract. Require Sol read-only review and fresh exact-head hosted CI before merge;
the previous head's green result does not certify this correction. No local tests are allowed.

Architect reflection disposition: D0-D5 and D7-D11 aligned. D6 amendment accepted: preview
verification explicitly requires GitHub prerelease=true and npm latest unchanged from the
recorded pre-preview value. Main records that before stable publication changes latest.
Final same-architect reflection: Newton returned ALIGNED for D0-D11 after the D6 amendment;
no remaining architecture gap. Independent A audit follows.

Latest owner steering: Latest owner instruction ci 걍 무시하고 머지해 executed: PR5490 admin squash merged to dev6c2f7676dcedba21bdbacf4fb84a7b2c286d1ee6 at2026-09-22T09:24:09Z. Priorcandidate3d64 hadPR/allplatform/serviceSUCCESS. D1 now precedesD0 by explicituseroverride; no fabricated B order. D0reviewfinding gatewaypartialbookkeeping remains narrowfollowup beforefreezeRC/publish. Bothpreview+stabledeployment remainsauthorized. No-local-tests andno-verify unchanged.

Independent A audit: Volta NEAR-PASS. Both text gaps are folded: D0 explicitly requires credential-boundary security review under MAINTAINERS.md in addition to ordinary source review; the original local-verification wording above now matches the latest no-local-execution restriction. New promotion drafts #5510/#5511 are provisional and will receive the corrected RC. No release has been published.
