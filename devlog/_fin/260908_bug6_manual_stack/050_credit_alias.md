# wp5: canonical reset-credit operation identity

Historical phase record. Delivery is complete; see [071](071_delivery.md) and [072](072_final_proof.md) for terminal evidence.

Depends on wp4 for the owner-requested delivery chain. C4; no live credit consumption. Source PR #3965 at `6c1477d19c7d1a77a1866cabfd2b4411f1a210d7` carries #3919 by luvs01. Revalidate both source heads and current dev before implementation; do not rewrite their branches.

## Published patch to carry

- MODIFY `src/codex/auth-api.ts` at the reset consume handler: `const identity` becomes `let identity`; after execute admission assign `identity = { ...identity, operationId: opened.operationId };`. Upstream dispatch and both durable settlement paths then share the canonical operation ID. Authentication, admission failures, account binding and terminal replay stay before this assignment.
- MODIFY `tests/codex-integration/codex-auth-api.test.ts`: import the existing ledger opener, assert a settled alias replay consumes no additional credit, and construct truly pending canonical operations for thrown fetch, non-2xx and unknown-code alias failures. Assert the durable row becomes ambiguous while account key and canonical ID remain unchanged and terminal code remains null.
- MODIFY `docs-site/src/content/docs/reference/management-api.md`: carry the source paragraph distinguishing unfinished alias joins, known terminal replay and new explicit intent after settlement.

Retain `Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>` and original source commit references. Do not carry auto-redeem worker changes: #3970 is already on baseline.

## Verification

The final immutable three-file source range is `abb46a1599ec0d0bbfbe03905114178df92e67f5..62412d38606851f7cace76360f3c5737db9cae20`; the landed equivalent is `abb46a1599ec0d0bbfbe03905114178df92e67f5..402be7c1f88283eb8465c3aec8437ccecd2542ec`. These final pins supersede the initial intake head above. A live source-head mismatch requires renewed comparison before carry; the mutable PR files page is navigation, not patch authority. Each negative fixture begins pending, so it observes the changed failure-settlement path instead of rechecking an already ambiguous row. Existing no-operationId and ordinary terminal paths remain regression controls. Hosted CI runs the auth and ledger suites; local tests/typecheck/build/install are NOT RUN by owner instruction. A source/security reviewer verifies the exact carried head before merge. Existing source-PR CI failure is historical and must not be described as passing.

All additional unpublished security analysis lives in ignored `.tmp/bug6-01a07e9d/credit-plan.md` and later audit artifacts. It must not be copied into this public unit.

## wp5 P refresh

Previous wp4 D certified PR3993 head727683f44 with CI34185870948, source/security/GUI audits, QA and remote docs. Proceed canonical alias carry. Live refresh supersedes the prepared pin: #3965 merged at03:17:07Z with head62412d386 and merge402be7c1f; prepared bdb9f4bfe+9eb44cfb4 passed two source/security audits. All three target files on actual predecessor727683f44 equal preparedbase d1f61e933; intervening V2/GUI/test-harness deltas do not modify this owner. Keep exact3filecarry and original attribution. No real credentials/resetcredits and no localproductcommands. Actual adoption equality and hostedCI remain required.

## Verified landed disposition

Current origin/dev402be7c1f contains the #3965 merge402be7c1f. Its three target files exactly equal prepared candidate9eb44cfb4 (git diff exit0); PR CI34181771859 passed at exacthead62412d386, including Linux4/macOS2/gates. Thus the source item is already landed, not a new product fix. The initial A narrative retained the old OPEN assumption; this fresh source/API evidence corrects it before B.

NOOP for a new PR. Adopt the identical two contribution commits locally only as the prerequisite for wp6; preserve provenance and contributor credit. The final new recovery PR targets existing layer4 and explains the already-landed alias dependency in its base-relative diff. No duplicate fifth PR is created and no original branch is rewritten. c5 closes on live merged-state/CI/ancestry/file equality evidence; wp6 and final cumulative integration still run their full gates. The single product stack has five new PRs plus this independently landed sixth source item.
