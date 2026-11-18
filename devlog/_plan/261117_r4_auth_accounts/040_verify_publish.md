# 040 verify the MERGE-READY pair, publish, report

## MERGE-READY verification (no lane commits)

For #8808 (5a76b97368) and #8802 (65db67235d): build the merge with `origin/dev` in a scratch worktree under `.tmp/`, run the PR's focused files there with temporary HOME/OPENCODEX_HOME:

- #8808: `tests/codex-integration/native-main-credentials-retention.test.ts`, `tests/lab/core-lab-boundary.test.ts`.
- #8802: `tests/adapters/google/vertex-model-discovery.test.ts`, `tests/adapters/google/vertex-catalog.test.ts`, `tests/server/management-provider-model-discovery.test.ts`.

Then build the merge commit (`git commit-tree <merge-tree> -p origin/dev -p <head>`), check it out detached in the lane worktree with a clean tree, run `bun run test:changed` (covers callers of `src/codex/account-lifecycle.ts`, `src/codex/main-account.ts`, `src/codex/catalog/provider-models.ts`), and return to the lane branch.

A failure downgrades the item to CARRY. A pass leaves the item for maintainer merge on its existing PR; `REVIEW_REQUIRED` and the MAINTAINERS.md security review for auth surfaces stay open, and the report says so.

## Lane gates on the final head

`bun run typecheck`, focused files from 010-030, `bun run test:changed`, `bun run structure:check`, `bun run privacy:scan`; full `bun run test` if the host allows, otherwise the AGENTS.md resource exception in the PR.

## Publish

Push `triage/r4-auth-accounts`, open one PR to `dev` with the template sections, `Supersedes #8758`, `Supersedes #8814`, `Supersedes #8806`, the Co-authored-by trailers, and the item table. Observe the required checks on the exact head; fix real failures. Then `origin.report`.

