# 020 — Phase 2: land PR #3166 (closes #3157)

## What lands

PR #3166 `ingw/fix-request-owned-main-pin-3157` — head `17f01162ad404f1bcee7d7f00998fc0e143365e5`.

- MODIFY `src/codex/auth-context.ts` — honor an effective healthy manual `__main__` pin when
  a Pool-mode request carries its own forwardable Codex bearer; validate that caller
  credential's account-gated model roster; keep paused or quota-drained mains on the
  ordinary Pool promotion path.
- MODIFY `structure/08_openai-provider-tiers.md` — document the request-owned credential and
  pin boundary.
- MODIFY `tests/codex-auth-context.test.ts` — 68 passing cases including healthy main at 16%
  vs Pool at 100%, drained main vs healthy Pool, and caller entitlement denial with a
  model-only detour.

## The red check

`test 3/4` fails on `tests/responses-state.test.ts > Responses previous_response_id state >
late async spill completion cannot overwrite the shutdown fallback`:

    error: Response spill ACL budget exhausted
     code: "ETIMEDOUT"
       at nextSpillHardenDeadlineMs (src/responses/spill-store.ts:232:29)

That is a wall-clock ACL budget expiring on a loaded runner. The PR's diff does not reach
`src/responses/`. Treat it as an unrelated flake: rerun the failed job, continue the train,
and judge the result at the end rather than blocking the merge on it.

## Security note

This is a credential-selection change, so MAINTAINERS.md requires explicit security review.
The PR body records the trust boundary: no caller bearer is persisted, no Pool
affinity/health/entitlement state is written, and the physical main credential is not read.
The merging maintainer accepts that review.

## Execution

1. `gh run rerun <run-id> --failed` for the exact head, then continue and poll later.
2. `gh pr merge 3166 --squash --admin --delete-branch`.
3. ancestry proof plus `gh issue view 3157`.

## Verification (C)

- merge SHA is an ancestor of `origin/dev`.
- #3157 closed.
- rerun of the flaked job recorded: green, or still flaking with the same unrelated stack.

