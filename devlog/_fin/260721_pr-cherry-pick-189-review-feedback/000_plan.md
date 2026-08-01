# 000 — Cherry-pick #189 + Review Feedback

## Objective
Cherry-pick PR #189 (Alibaba Token Plan baseUrl override) onto dev and leave sol review feedback on 6 new PRs.

## Loop-spec
- Loop archetype: verifier-defined (tests pass, comments posted)
- Write scope: dev branch only (cherry-pick commit)
- Out of scope: fixing contributor code, PRs #187/#188/#169/#150
- Budget: single PABCD cycle

## Changes

### Cherry-pick PR #189 (commit b053cf4c from fix/alibaba-token-plan-base-url)
- MODIFY `src/providers/registry.ts`: add `allowBaseUrlOverride: true` to alibaba-token-plan entry
- MODIFY `tests/provider-registry-parity.test.ts`: add "alibaba-token-plan" to override allowlist assertion
- MODIFY `tests/router-template-baseurl.test.ts`: add alibaba-token-plan to OVERRIDE_PROVIDERS, change test URLs to .example.test

### Review feedback (GitHub comments, no file changes)
- #197: preserve_thinking wire flag missing
- #195: unredacted metadata, corrupt-tail handling
- #194: non-transient triggers soft avoid, late affinity delete
- #193: port=0 ephemeral regression
- #192: byte budget estimation, reserved cap bypass, dropped tool recovery
- #191: unresolved template persistence, merge conflicts, deprecated models

## Accept criteria
1. Cherry-pick applied to dev, `bun test` on affected files exit 0
2. Pushed to origin/dev
3. Review comments posted on all 6 PRs
