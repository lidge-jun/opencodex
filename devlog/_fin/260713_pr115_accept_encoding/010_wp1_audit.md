# WP1: audit PR #115 and freeze integration

## Exact operations

- READ PR metadata, checks, reviews, issue #114, and `dev...origin/pr/115`.
- READ `src/server/responses.ts` owner and all `fetchWithHeaderTimeout` callers.
- DECIDE merge topology: `git merge --no-ff origin/pr/115` on `dev` so the contributor SHA remains an ancestor.
- AUDIT the plan with an independent reviewer before changing tracked source.

## Audit questions

1. Does `Accept-Encoding: identity` address the reported compressed SSE batching mechanism without changing response translation?
2. Is a global default at the shared upstream fetch boundary preferable to OpenRouter-only or stream-only branching?
3. Does object spread preserve all legal `HeadersInit` forms and explicit case-insensitive overrides? Expected answer: no; normalize with `Headers`.
4. Are tests able to prove the outgoing wire header rather than merely inspect source text?

## Audit disposition

- ACCEPT `global-nonstream-scope`: the follow-up passes an explicit streaming flag at all three shared-fetch call sites, so ordinary JSON keeps Bun's default negotiation.
- ACCEPT `functional-preview-gate`: the test suite will include a controlled gzip SSE cadence test, and preview-to-stable promotion will rerun it from the exact preview commit after npm preview registry smoke.
- ACCEPT changed-file ledger and wording nits: add `package.json` to WP4 and refer to merge-base movement/conflicts rather than a non-fast merge.

## Acceptance

- Reviewer returns `VERDICT: PASS` or a near-pass whose residuals are explicitly folded into WP2.
- Plan names exact source/test paths and activation evidence.

## Final audit evidence

- Reviewer: `019f5989-3619-7990-bfef-856f6a1f2441` (`gpt-5.6-sol`, high).
- Initial verdict: `GO-WITH-FIXES (blockers=2)` for missing functional preview gate and overly broad non-streaming scope.
- Repair: added controlled gzip SSE cadence proof, preview-to-stable rerun, stream-only opt-in, `package.json` ledger, and corrected merge wording.
- Re-review: `blocking_issues: []`.

> VERDICT: PASS
