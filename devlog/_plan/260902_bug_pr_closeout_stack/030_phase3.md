# 030 — Phase 3: land carry PR #2986, close #2083

## What lands

PR #2986 `codex/carry-2083-xai-imagine` — maintainer carry of #2083 by @zhou-zhichao,
8 commits cherry-picked onto `dev` with author credit preserved.

Surface: `src/images/` (artifacts, fulfill, index, plan, synthetic-tool, xai-client),
`src/responses/parser.ts`, `src/server/images.ts`, five locales of
`docs-site/.../guides/image-bridge.md` and `codex-integration.md`, plus six test files.

Relays Codex `image_gen` tool calls to xAI Imagine using Grok OAuth, gated behind exact
`images.bridgeEnabled === true`.

## Why the carry exists

#2083 is APPROVED with 24/24 green checks, but its head had drifted 35 commits behind
`dev` — past the repository's 10-commit freshness boundary — so the green run no longer
describes what would land. A maintainer cannot push to a contributor branch, hence the carry.

## Security review status

Recorded in the PR body, performed on the exact head: credentials pinned to
`https://api.x.ai/v1`, `redirect: "manual"` on the credentialed fetch, no prompt or
credential logging, opt-in gate fails closed with a fixed 400 before any fallback, artifact
reads require API admission plus Origin validation. Verdict PASS WITH NOTES — artifact
authorization is proxy-wide, matching the single-operator trust model.

## Execution

1. `gh pr view 2986 --json headRefOid,mergeStateStatus`; rebase onto current `dev` if the
   carry fell behind after phases 1-2.
2. `gh pr merge 2986 --squash --admin --delete-branch`.
3. `gh pr close 2083` with a landed-via-maintainer comment naming the merge SHA.

## Verification (C)

- merge SHA ancestor of `origin/dev`.
- #2986 MERGED, #2083 CLOSED with the crediting comment.

