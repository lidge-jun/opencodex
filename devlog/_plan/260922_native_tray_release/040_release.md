# wp4 — Stable and preview delivery

Depends on wp3. User explicitly selected both main and preview publication.

## Changes and operations

- MODIFY `.github/PULL_REQUEST_TEMPLATE.md` sections in the actual PR body only: problem/result, exact-head validation, native screenshot, checklist and maintainer integration decision. Ordinary PR to dev, one branch with ordered commits; no native stack. Push/merge are authorized by the release request, subject to actual checks/review policy.
- READ latest `MAINTAINERS.md`, `scripts/release.ts`, release/dev-version-bump workflows, npm/GitHub published versions and branch rules before selecting versions. Record exact version matrix and promotion SHA.
- If dev does not outrank the intended release, use the repository's dev-version-bump PR flow before publication. MODIFY only version-bearing files selected by that canonical flow, no ad-hoc drift.
- Promote dev through PRs to main/preview following required review/branch policy. No direct protected-branch push or force push. Keep objections and security review separate; do not fabricate independent approval.
- Execute the canonical release command/workflow with exact expected SHA, branch, version and dist-tag. Stable and preview runs are serialized. A failed or pending workflow is not published success; reconcile before retrying.
- VERIFY GitHub release/tag and artifact inventory/checksums/signatures/updater manifest, npm versions/dist-tags/gitHead and required exact-head CI. Install the final macOS artifact locally, preserving backup; verify native popup interaction, bundled CLI resolve and proxy ownership/health. Record running application path/hash and source/build identity.
- MODIFY this unit's `041_release_receipts.md`, then archive the unit to `devlog/_fin/` only once all cycles are terminal.

## Acceptance and rollback

Both channels have reachable verified artifacts at their recorded commits; native popup is installed and usable. Keep the prior application backup and prior published version/digest so local rollback is reversible. Never republish the same version to repair a bad artifact; use repository release policy. If a protected promotion requires an independent maintainer action not available to this session, stop that publication step with the exact blocker while completing all independent preparation; no bypass inferred from beta status.

## Publication observation during wp3

On 2026-09-22 the official npm registry reports version2.60.0 exists with gitHead7c625fc9755c9824653ab944190e243091a2c85c, matching origin/main and the published GitHub v2.60.0 release. However the live npm tags are latest=2.59.0 and preview=2.55.0-preview.20260914. This was re-read with the explicit official registry and prefer-online; no dist-tag mutation was performed. Both requested channel deliveries must verify the actual final registry tags in addition to GitHub assets and version existence. Do not republish2.60.0 or silently count it as the current latest tag.
