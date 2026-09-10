# Dispatch packet — L3 (revision 5)

Round unit: `devlog/_plan/260911_lane_dispatch_round` on `dev`. Base freeze: `origin/dev` `6d3ad12e3` (2.51.0).
Five audit rounds shaped this packet. The last one was a seven-lane feasibility check that asked whether each stack is implementable inside its owned paths; three lanes came back with gaps, and the fixes are folded here. `010_lane_partition.md` is the authoritative ownership list; `130_wp4_feasibility.md` records why each path was granted.


## Shared frame

**Repository.** Your worktree is named in your packet, already checked out on your lane branch, cut
from `origin/dev` `6d3ad12e3` (2.51.0). Work only there. Do not add, move, or remove a worktree.

**Loop.** Run `$codexclaw:cxc-loop` as HOTL for your lane: one work-phase per issue, in order. Your
goal ends when your last PR is green and reported, not when the code looks right.

**Subagents.** Unlimited `xai/grok-4.6` subagents, read-only, spawned with `spawn_agent`
(`model: "xai/grok-4.6"`). Use them to reproduce, to read the call sites you are about to change, to
find a second caller of a helper you are touching, and to review your staged diff adversarially
before you push. A finding enters your work only with an exact `path:line` anchor. Subagents never
write, commit, push, or call a mutating `gh`. Treat a `fail` verdict the way this round did: fold it
in and re-audit. This packet is at revision 3 because two audit rounds rejected revisions 1 and 2.

**MUST NOT.**

- No local product suite: no `bun test`, no `bun run test`, no `bun run test:changed`, no
  `bun run typecheck`, no `bun run build:gui`, no `bun install`. Report them as `NOT RUN`.
- No merge, no release, no force-push to a shared branch, no direct push to `dev`.
- No path outside your owned list, including paths a carried PR happens to touch. Dropping a hunk
  from a carried PR is expected; report what you dropped.
- No locale key in `gui/src/i18n/*`. If you need one, stop and report.
- No security write-up in `devlog/`; scratch space only, per `AGENTS.md`.

**MUST.**

- Prefix every mutating git command with `git -c core.hooksPath=/dev/null`. This repository's hooks
  can start a GUI install, typecheck, and build, which the no-local-suite rule forbids.
- Push with `--no-verify`.
- Write the focused regression test `AGENTS.md` requires for a behaviour change, in the domain
  directory beside the existing tests for that subsystem, and register it in both
  `scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json`. You
  will not run it; hosted CI will. Those two maps are append-only and other lanes are adding to them
  too; the orchestrator resolves the conflicts at merge, so do not skip the entry.
- Fill every section of `.github/PULL_REQUEST_TEMPLATE.md` and put `Closes #<issue>` in the body. In
  **Verification**, state that the local suite, typecheck, and build were `NOT RUN` by operator
  instruction and that hosted CI on the exact pushed head is the proof.
- When you carry another author's PR, add a `Co-authored-by` trailer in a branch commit. Resolve the
  address with `gh api users/<login> --jq '.id'` and use `<id>+<login>@users.noreply.github.com`.
- Keep a devlog unit under `devlog/_plan/260911_l<N>_<slug>/`.

**Stacking.** First PR targets `dev`; the second targets the first PR's head branch, the third the
second. Retarget a child to `dev` after its parent lands. No native GitHub stacks.

**Decisions already made for you.** Both audit rounds found items where the issue left a real choice
open. Those calls are recorded in your packet in bold. Implement the recorded decision; if you think
it is wrong, report the reason and stop.

**Stop conditions.** Stop and report when the fix needs a path you do not own, when it needs a policy
no issue has fixed, when a locale key is unavoidable, or when hosted CI fails for a reason outside
your diff.

**Report format.** Per PR: number, exact head SHA, CI run id and conclusion, the issue it closes, the
co-authors credited, the hunks you dropped from a carried PR, and any decision you made. Say
`NOT RUN` for local checks.

**Decision boundary.** You do not merge, do not close another author's PR, and do not rank your lane
against another. When your last PR is green, report and stop.

## L3 — Codex account pool

Worktree `~/.codex/worktrees/260911-l3/opencodex`, branch `codex/260911-l3-account-pool`.

Owned: `src/codex/account-usability.ts`, `account-pause.ts`, `account-store.ts`,
`account-runtime-state.ts`, `plan.ts`, `plan-from-token.ts`, `warmup.ts`, `model-entitlements.ts`, `auth-api.ts`, `routing.ts`
(all under `src/codex/`), plus `src/server/responses/codex-auth-error.ts`, `src/types/config.ts`,
the single key `codexPool.excludedPlans` in
`src/config.ts`, and `docs-site/src/content/docs/guides/codex-integration.md` and its seven locale copies under
`docs-site/src/content/docs/{fr,ja,ko,ru,tr,zh-cn,zh-tw}/guides/codex-integration.md`.

1. **#4126 — a newly created ChatGPT Free account fails Codex warmup with HTTP 404.** Carry PR #4188
   by `chilung-cgu` (open **draft**, `REVIEW_REQUIRED`, reset by the readiness gate rather than
   rejected). It carries `src/codex/warmup.ts`, its test, and eight `codex-integration.md` pages —
   all of which you own.
2. **#4212 — an account stuck on a failed credential refresh silently drops its models.** The ask is
   attribution, not new routing. **Decision: this round covers the refusal string
   (`codex-auth-error.ts:35`), the account-health surface, and the management route
   on the Codex account surface, which is `poolAccountDto` in `src/codex/auth-api.ts:377` under
   `/api/codex-auth/accounts`. The feasibility audit found the earlier grant of
   `oauth-account-routes.ts` was the wrong route: it serves the generic `/api/oauth/accounts` and
   `src/oauth/index.ts:331` excludes ChatGPT from it. The reporter's 503 is inlined at
   `responses/core.ts:2336` and `compact.ts:383`, which L1 owns, and the model-list drop is published
   from `catalog/sync.ts:1777`. Both are out of scope: write `Refs #4212`, not `Closes`,** and record
   them as follow-ups.
3. **#4211 — keep Free-tier accounts out of pool selection.** **Decision: ship**
   **`codexPool.excludedPlans` as an array, absent by default, filtered in `getEligiblePoolAccounts`**
   **at `src/codex/routing.ts:1248` rather than in `isCodexAccountUsable`, which is where pause already
   lives, and explicit namespace selection at `auth-context.ts:922` keeps working,** so an existing install sees no
   behaviour change. Do not ship `minimumPlan`: ranking plans needs an ordering this repository does
   not have. **Decision: this round ships selection only.** If the dashboard or CLI display the issue
   also asks for needs `src/cli/account.ts`, a GUI component, or a locale key, stop and report; write
   `Refs #4211` rather than `Closes #4211` when the display half is not included.

