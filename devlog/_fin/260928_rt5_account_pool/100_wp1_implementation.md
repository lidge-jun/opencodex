# WP1 — implementation lanes

Previous cycle (WP0) conclusion: the roadmap and five decade docs are locked,
audited near-pass after three rounds; direction is one independent PR per item,
ordered #6154 → #5831 → #5099 → #5561 → #5956. WP1 implements all five in
parallel lanes and verifies each locally. WP2 publishes the PRs and drives Ubuntu
CI to green.

Base: `origin/dev` `cbe0d40daf` (two CI/desktop-only commits past the planning
base `eb7f0f0970`; none touches a lane file).

| Lane | Worktree | Branch | Decade doc | Executor write scope |
|---|---|---|---|---|
| quota-backoff | /private/tmp/rt5-ap/quota-backoff | codex/rt5-account-pool-quota-backoff | 010 | files in 010's change map |
| main-lock | /private/tmp/rt5-ap/main-lock | codex/rt5-account-pool-main-lock | 020 | files in 020's change map |
| antigravity | /private/tmp/rt5-ap/antigravity | codex/rt5-account-pool-antigravity | 050 + roadmap fold-backs 1-2 | 050's map plus the Logs roster and ten locale catalogs |
| anthropic-routes | /private/tmp/rt5-ap/anthropic-routes | codex/rt5-account-pool-anthropic-routes | 040 | 040's map |
| low-quota | /private/tmp/rt5-ap/low-quota | codex/rt5-account-pool-low-quota | 030 + roadmap fold-backs 3, R2-2, R3-3 | 030's map |

Each lane is a separate linked worktree, so executors never share a HEAD or an
index. Each executor may commit on its own branch and must not push, fetch into
shared refs, rebase other branches, or touch another worktree.

Per-lane acceptance (each must hold before WP1 C):

1. Carried contributor commits keep authorship or the PR carries the exact
   `Co-authored-by` trailer named in the decade doc.
2. The decade doc's focused tests exist, fail without the change where a
   red/green check is meaningful, and pass with it.
3. `bun run typecheck`, the decade doc's focused `bun test` files,
   `bun run test:changed`, `bun run structure:check` and
   `bun run privacy:scan` exit 0 in the lane worktree.
4. No cap in `tests/fixtures/file-size-baseline.json` is raised; any new test file
   is registered in both layout maps.
5. Owning `structure/` docs and `docs-site/` pages named in the decade doc are
   updated.

Cross-lane checks at WP1 C: `git merge-tree` of quota-backoff with main-lock
(expected conflict only in the shared recovery test), and of antigravity with
anthropic-routes (shared Responses dispatch files).

## Precedence (from the WP1 architect reflection)

The reflection returned ALIGNED for 040 and MISALIGNED for 010, 020, 030 and
050. Every gap was a spot where the decade doc predated the roadmap's
dispositions and fold-backs. Executors apply this order: `000_roadmap.md`
("Main dispositions" and every "Audit fold-back" section), then this document,
then the decade doc. Concretely:

- 010: an unusable HTTP 200 body is a failed read and keeps pacing. The
  status-only alternative is closed.
- 020: build from `dev` independently of #6154. Before push, verify the union
  with the quota-backoff branch.
- 030: the async flush drains before closing, runs before owner release, and is
  followed by the owner-generation fence. It requires both the normal-stop
  persistence test and the timeout cancellation test.
- 050: one per-request auth-refusal flag is shared by 401 and 403 and set before
  rotation. It requires the three-account 403 chain and 401-then-403 tests, plus
  the `oauth-account-403` roster, Logs and locale work.

## WP1 audit fold-back (GO-WITH-FIXES, blockers=3) and coordinator criteria

1. **Plan source for executors (High, folded).** Lane worktrees predate the
   plan commits. Each executor packet pins the plan with
   `git -C /Users/jun/.codex/worktrees/cbaa/opencodex show <sha>:devlog/_plan/260928_rt5_account_pool/<doc>`,
   using the commit that contains this section. Executors read the plan and
   never write it.
2. **Lane-specific gates (Medium, folded).** Acceptance criterion 3 also covers
   every extra verifier the decade doc names: for 050, `bun run lint:gui` and
   `bun run build:gui`; for 040, `bun run skill:surface:check` plus the CLI
   parity and skill tests; for 010 and 020, the docs-site build when MDX or docs
   pages change (`cd docs-site && bun run build`); plus the explicit
   source-oracle and layout tests each doc lists.
3. **Quota union (Medium, folded).** At WP1 C, a scratch worktree merges
   quota-backoff, then main-lock, then low-quota onto `dev`. It runs
   `bun run typecheck` and the union of the three lanes' focused quota, pause
   and hard-lock tests. A conflict or failure there becomes a lane fix before
   push.

Coordinator criteria (2026-09-28), which apply in WP2. Before a PR counts as
done:

- Any CHANGES_REQUESTED review from a listed maintainer (for example
  @Ingwannu) is fixed and answered on the thread.
- Correct findings from the Codex review bot (`chatgpt-codex-connector`) are
  fixed.
- PR-triggered jobs, including `desktop shell` and macOS legs when paths
  trigger them, finish green.

CodeRabbit stays ignored, and the lane never dispatches the manual
`workflow_dispatch` cross-platform run.

## Maintainer rule change (2026-09-28): no local tests

The coordinator relayed a user order: no local `bun test`, `bun run test`,
`test:changed`, `typecheck`, GUI or docs builds, or verification proxies. PR CI
on GitHub is the only test evidence. The lane stopped its own in-flight
`test:changed` runs. `pkill -f 'bun scripts/test.ts'` was machine-wide and may
also have ended other lanes' runs, which the same order forbids anyway.
Acceptance criterion 3 now reads "exits 0 in PR CI". Local checks are limited to
`structure:check`, `privacy:scan` and `git diff --check`. Each PR's
Verification section states that local tests were skipped by maintainer
instruction and that CI is the evidence. The WP1 C gate and the quota-union
check use the CI results of the pushed branches, plus a local `git merge-tree`
for conflicts.

Build-time scope expansions:

- quota-backoff: `codex-auth-api.test.ts` is added to scope. Same-key concurrent
  callers join the in-flight read and share its settled outcome, so exactly one
  dispatch occurs and fresh proof still reaches the post-reset path.
- antigravity: `src/lib/request-failure-model.ts` maps `oauth-account-403` to
  `credential-rejected`. Other exhaustive roster consumers are checked too.
