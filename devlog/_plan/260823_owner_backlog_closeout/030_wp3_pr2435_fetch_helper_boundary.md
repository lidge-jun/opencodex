# 030 — wp3: PR #2435 and issue #2434, Responses fetch-helper boundary

## Item

`Ingwannu` PR #2435 `ingw/refactor-fetch-helper-boundary-2434` -> `dev`, head
`be6ea98a`. Closes issue #2434, "keep Responses fetch helpers on a
transport-only import boundary".

Removes stale runtime imports from `src/server/responses/fetch-helpers.ts` and
pins the permitted runtime edges with a regression test.

## Reviewer verdict

`gpt-5.6-sol` high, read-only, exact head `be6ea98a`:

- VERDICT PASS, disposition SQUASH_MERGE, risk low, no nits.
- Six focused files (`responses-fetch-helpers-boundary`, `fetch-header-timeout`,
  `request-pacing`, `upstream-http-version`, `ws-upstream`,
  `core-lab-boundary`) -> 71 passed, 1 skipped, 0 failed.
- CI 23 checks passed, 1 conditional Windows shard skipped, at the exact head.
- Complete export surface preserved, helper implementations byte-identical, the
  new guard at `tests/responses-fetch-helpers-boundary.test.ts:43` rejects
  computed dynamic-import bypasses. No cycle, no logging, credential, routing, or
  behavior change.

## Disposition

Squash-merge, then close #2434 by hand.


## Execution record

Squash-merged 2026-08-23 as `4fb0fbe7b` on `origin/dev`, branch deleted.
Issue #2434 closed by hand with the merge SHA and the reviewer's evidence.
