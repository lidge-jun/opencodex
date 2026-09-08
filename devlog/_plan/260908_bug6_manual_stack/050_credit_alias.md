# wp5: canonical reset-credit operation identity

Depends on wp4 for the owner-requested delivery chain. C4; no live credit consumption. Source PR #3965 at `6c1477d19c7d1a77a1866cabfd2b4411f1a210d7` carries #3919 by luvs01. Revalidate both source heads and current dev before implementation; do not rewrite their branches.

## Published patch to carry

- MODIFY `src/codex/auth-api.ts` at the reset consume handler: `const identity` becomes `let identity`; after execute admission assign `identity = { ...identity, operationId: opened.operationId };`. Upstream dispatch and both durable settlement paths then share the canonical operation ID. Authentication, admission failures, account binding and terminal replay stay before this assignment.
- MODIFY `tests/codex-integration/codex-auth-api.test.ts`: import the existing ledger opener, assert a settled alias replay consumes no additional credit, and construct truly pending canonical operations for thrown fetch, non-2xx and unknown-code alias failures. Assert the durable row becomes ambiguous while account key and canonical ID remain unchanged and terminal code remains null.
- MODIFY `docs-site/src/content/docs/reference/management-api.md`: carry the source paragraph distinguishing unfinished alias joins, known terminal replay and new explicit intent after settlement.

Retain `Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>` and original source commit references. Do not carry auto-redeem worker changes: #3970 is already on baseline.

## Verification

The public three-file patch is the diff authority: https://github.com/lidge-jun/opencodex/pull/3965/files . Each negative fixture begins pending, so it observes the changed failure-settlement path instead of rechecking an already ambiguous row. Existing no-operationId and ordinary terminal paths remain regression controls. Hosted CI runs the auth and ledger suites; local tests/typecheck/build/install are NOT RUN by owner instruction. A source/security reviewer verifies the exact carried head before merge. Existing source-PR CI failure is historical and must not be described as passing.

All additional unpublished security analysis lives in ignored `.tmp/bug6-01a07e9d/credit-plan.md` and later audit artifacts. It must not be copied into this public unit.
