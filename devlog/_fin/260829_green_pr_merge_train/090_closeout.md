# 090 — Merge train closeout

All eight target pull requests are on `dev`. Final head: `b9cb236560c25a9f64a722dd200e9f71146ee704`.

## What landed

| PR | Merge commit | Rebased onto | Rebase |
| --- | --- | --- | --- |
| #2429 test:changed | `d04f4f446` | `8d1dc1f5d` | clean |
| #2854 blocked model redirection | `db7606f30` | `d04f4f446` | clean |
| #2365 usage cache metrics | `7071b2d47` | `d04f4f446` | clean |
| #1756 Grok per-model reasoning effort | `c4fdc5e26` | `d04f4f446` | clean |
| #2050 combo routing strategies | `2c2cda32c` | `d04f4f446` | clean |
| #2364 Vercel AI Gateway routing | `aa5f711d7` | `d04f4f446` | clean |
| #2712 xAI x_search opt-in | `e308f13da` | `d04f4f446` | clean |
| #2827 trusted Responses request id | `b9cb23656` | `d04f4f446` | clean |

Every rebase replayed without a conflict, so no semantic reconciliation was needed anywhere in the set. The overlap matrix in `000_plan.md` predicted five file collisions; each one turned out to be additive on both sides.

## Two things the plan did not anticipate

**The #2827 fix had to move out of `src/server/auth-cors.ts`.** The design in `020` placed the expose-header in `withCors()`, which was correct about *behaviour* — `managementCorsHeaders()` builds on `corsHeaders()`, so the shared helper was the wrong home — but that file is on the restricted list in `.github/scripts/pr-sponsored-surface.cjs`. Editing it made a PR that touched no credential surface fail `unsponsored_surface`, and self-sponsoring a gate I had tripped myself would have been backwards.

The fix moved into `withRequestLogId` in `src/server/index.ts`, beside the header it names. That is a better home on its own merits: the name that is set and the name that is exposed now live two lines apart and cannot drift. It appends rather than overwrites, so a future data-plane exposure survives, and responses that never reach the wrapper stay untouched — which the existing `does not issue a request id before authentication and origin admission` test still proves.

The lesson generalizes: when a hygiene gate fires on a restricted file, the first question is whether the change *needs* to be there, not who can sponsor it.

**Two PRs did need genuine sponsorship.** #2364 and #2712 both legitimately touch `providerManagementConfigError()` in `auth-cors.ts`, and neither hunk can be dropped without leaving a new provider option unvalidated on every management write path. Both were reviewed as security boundaries and the review recorded on the PR before `maintainer-sponsored` was applied:

- #2364 adds a `vercelGatewayRoutingConfigError` call that can only ever add a rejection, plus two non-secret routing keys in `safeConfigDTO()`. Structurally identical to the existing OpenRouter pair.
- #2712 adds three lines rejecting a non-boolean `xaiResponsesXSearch`, beside the identical check for `responsesSnapshotRepair`. `safeConfigDTO()` untouched.

## Findings raised during rebase and dismissed with evidence

Two rebase jobs reported merge blockers. Both were checked against `dev` and neither was introduced by its PR.

- **#2365 usage classification.** The claim was that mixed combo attempts can be counted unmetered in totals while per-model rows still accumulate priced cost. The guard in `addEstimatedCost` is byte-identical to the current `dev` version, and `isPriced` is the direct successor of `dev`'s `estimate !== null`. Pre-existing behaviour; the PR only hoists cost derivation into a shared `EntryCostInfo`.
- **#2854 route reason.** `routeResult()` sets `routeReason` to `blocked-model-redirect`, and the policy and combo paths overwrite it with `policy-selected` and `combo-pick`. Real, but not a defect: `route.modelId` already carries the replacement model, so dispatch is correct and only the diagnostic label is lost. `routeReason` has no behavioural consumer — it feeds the decision trace and an alias-logging branch. Worth tightening when the trace grows a dedicated redirect field.

## CI flakes distinguished from regressions

Three macOS failures were environment timing, not code:

- #1756 failed `ocx launcher graceful shutdown > SIGINT ...` in `tests/shutdown-launcher.test.ts`. The PR touches `src/grok/*`, `src/server/index.ts`, docs, and three `tests/grok-*` files; it never reaches the launcher path.
- #2827 failed `CL-07 task effectiveness producer > inactivity timeout is bounded` in `tests/lab-fabric-task.test.ts` — Compatibility Lab, while the PR touches only server request-log files. The `ci` failure alongside it was the aggregate job reporting `platform-macos=failure`, not an independent signal.

Both passed on re-run of the failed job at the same head. The rule applied: a macOS failure is a flake only after naming the test, locating its file, and showing the diff cannot reach it.

## Verification

No local `bun run test` was executed at any point — user constraint. Evidence is GitHub Actions on each exact merged head, plus `bun x tsc --noEmit` and `bun run privacy:scan` in each rebase worktree. Every merge re-ran `git merge-tree` against the then-current `dev` and confirmed zero conflict markers before landing, which is what kept the derived order honest as `dev` moved eight times underneath it.

`dev` also advanced twice mid-train from another lane (#2875, #2876) plus #2861/#2862 landing earlier. That left the set two commits behind at one point — inside the gate's ten-commit tolerance, and re-verified per merge rather than assumed.

