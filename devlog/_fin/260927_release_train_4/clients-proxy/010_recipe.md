# Phase 1: management API test recipe (#6051)

The preceding D concluded that the reviewed roadmap is locked at `ce5a406862`;
the next action is this bounded recipe carry. Depends on `000_plan.md`;
docs-only carry, then one ordinary PR. The source PR
adds `.agents/skills/testing-opencodex-management-api/SKILL.md` with a
disposable-home setup and correct Lab requests. It needs a repository entry
point before another agent can reliably discover it.

## Exact change map

- NEW `.agents/skills/testing-opencodex-management-api/SKILL.md`: carry the
  108-line source recipe from #6051 head `987b8097624e50e6c39b00aca145fe4755043c4b`
  with source-verified isolation and activation corrections after checking every command and path against current
  management routes. Preserve its disposable OS account/home, container, or
  VM prerequisite; redirect client homes and disable integrations before a
  smoke. `OPENCODEX_HOME` alone does not isolate client writes. Keep explicit
  token read, bounded process cleanup, and authorization before live-provider
  requests. No secret values or real account identifiers enter examples.
- MODIFY `AGENTS.md` near the Commands and `skills/ocx/` guidance: add one
  contributor-facing link to the test recipe. Before: only the runtime-control
  `skills/ocx/` reference is discoverable (`AGENTS.md:207-209`). After: one
  sentence identifies `.agents/skills/testing-opencodex-management-api/SKILL.md`
  as the development test recipe, while `skills/ocx/` remains the operating
  reference and `AGENTS_INSTALL.md` retains consent guidance. Do not change
  runtime imports, CLI capabilities, or the generated operating-surface map.
- MODIFY `010_recipe.md` with a short outcome addendum after validation,
  naming the carried source SHA, attribution, and exact command results. The
  carry commit or PR body
  must contain `Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>`.

## Acceptance and proof

Read the recipe's executable examples against
`src/server/management/lab-automation-routes.ts:119-180` and
`src/lab/automation/planner.ts:278-340`; POST fields are body fields and PUT
policy fields are supported there. `bun test
tests/lab/lab-automation-management-http.test.ts` ran at the base and passed
2 tests; it checks route cancel/pagination, not the prose or POST example.
Run a smoke only in a disposable OS account/home,
container, or VM with redirected client homes and integrations disabled;
the current desktop account does not meet this precondition, so record the
smoke as unrun. Confirm the carried file against the pinned PR head, its
frontmatter and link target. Stage every changed and new file before running
`git diff --cached --check` and `bun run privacy:scan`; the scan uses
`git ls-files`, so an untracked skill would be invisible. After commit run
`git diff origin/dev...HEAD --check`. Also run `bun run structure:check` and
`bun run typecheck`. These commands protect
the tree and paths; semantic correctness of the recipe needs source review.
`bun run test:changed` can select zero tests for a docs-only diff and is then
not passing evidence. A docs-only CI skip is recorded as skipped, not
as a passing suite. PR template Summary/Verification/Checklist, source author
credit, exact-head required checks, and post-merge `dev` CI still apply.

The architect proposed D1-R (carry the
isolation and route examples), D1-L (one AGENTS discovery link), and D1-V
(attribution and exact gates). All three are accepted. Putting the recipe in
`skills/ocx/` would confuse development tests with operating guidance; a
PR-only link would not be durable.

## Local carry outcome

Imported the recipe from #6051 head
`987b8097624e50e6c39b00aca145fe4755043c4b`; the initial `cmp`
against that Git object exited 0 at 108 lines. C-phase implementation review
then required two source-grounded corrections to the final copy: redirecting
Codex's SQLite home and disabling resume-history sync in the disposable
configuration, and activating Lab at startup before a separately authorized
live-route run. The isolation instructions also require `HOME` to point into
the disposable scratch root. The final recipe therefore intentionally differs from the
source PR. `AGENTS.md:212` links it beside
the operating reference. The same independent A reviewer first found that
an unstaged whitespace check would miss a staged change and the privacy scan
would miss an untracked skill; the plan now stages all files before both gates,
and the reviewer returned PASS.

After staging, `git diff --cached --check`, `bun run privacy:scan`,
`bun run structure:check`, and `bun run typecheck` exited 0. `bun test
tests/lab/lab-automation-management-http.test.ts
tests/lab/lab-automation.test.ts` passed 24 tests with 0 failures. These tests
cover the route and planner baseline, not the prose; route and planner source
were read against the example fields. `bun run test:changed` exited 1 because
the docs-only diff selected 0 tests. The live smoke was not run in this
desktop account: it lacks the disposable OS-home prerequisite. Full local
suite is omitted due to concurrent lane worktrees; CI remains the broader
gate. PR-head and post-merge `dev` CI evidence are recorded after publication.

After the C-phase corrections, the scratch `config.json` example parsed as
JSON with `syncResumeHistory: false`; `git diff --cached --check` and
`bun run privacy:scan` exited 0 on the staged revision. The independent
implementation reviewer rechecked the SQLite and Lab startup paths and
returned PASS. A separate token/isolation security reviewer also returned
PASS on the amended recipe. Neither reviewer ran the live smoke, and the
24-test route/planner run and typecheck predate only these documentation edits;
no runtime source changed between those checks and this revision.
