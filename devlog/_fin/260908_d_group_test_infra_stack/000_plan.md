# D-group test-infrastructure delivery as a single-CI manual stack

## Objective

Land the two D-group test-infrastructure items on `dev` as one dependency-ordered
branch chain whose **tip is the only pull request**, so the cumulative tree is
verified by exactly one Cross-platform CI run. Merge the tip once that run is
green, then settle the original pull requests and any linked issues.

| Layer | Source | Content |
|---|---|---|
| 1 (bottom) | PR #3924 by @luvs01 | `scripts/test.ts` keeps captured lane output after a timeout; runner regressions; contributing note |
| 2 (tip) | PR #3930 by @luvs01 | `tests/providers/cursor/cursor-stream-health.test.ts` load-scaled watchdog budgets |

Both source pull requests carry exactly one commit each, authored by `luvs01`
(`27862058+luvs01@users.noreply.github.com`), so `git cherry-pick -x` preserves
authorship without needing a reconstructed `Co-authored-by` trailer. The trailer is
added to the tip pull-request description anyway, because the repository squashes
and `.github/scripts/pr-carry-attribution.cjs` reads the trailer, not prose.

## Why a stack, and why only one pull request

`.github/workflows/ci.yml` triggers on a bare `pull_request:` with no base-branch
filter. That is deliberate — the comment in the file records that a
`branches: [main, dev]` filter once silently excluded stacked child pull requests.
The consequence for this unit is mechanical: **every open pull request starts a
Cross-platform CI run**, whatever its base. A two-pull-request stack therefore costs
two runs, and a child pull request based on the parent's head costs one more.

The only way to get a single run covering both changes is to give the stack exactly
one pull request, at the tip, based on `dev`. The lower layer is pushed as a branch
for provenance and review navigation, and never gets a pull request of its own.
Pushing a branch does not start CI either: `ci.yml`'s `push:` trigger is pinned to
`branches: [main, preview, dev]`, and this stack pushes neither.

The tip run covers the PR-enabled producers, not every job in the file. `changes`
sets `ci: true` for `tests/**` and `scripts/**` (`ci.yml:193-194`), which this stack
touches, so the four Linux shards, `gates`, `storage policy`, `api usage`,
`platform-macos`, `keyring` and `docker smoke` all execute. Three job families do
**not** run on a pull request and must never be reported as passing evidence:

| Job | Guard | Status on this PR |
|---|---|---|
| `windows <n>/6` | `github.event_name == 'workflow_dispatch' && (inputs.lane == '' \|\| inputs.lane == 'all')` (`ci.yml:742-743`) | SKIPPED BY WORKFLOW |
| `macos control` | `github.event_name == 'workflow_dispatch'` (`ci.yml:633`) | SKIPPED BY WORKFLOW |
| `npm-global <os>` | `needs.changes.outputs.packaging == 'true'` (`ci.yml:943`); the packaging allowlist (`ci.yml:215-229`) excludes all four files | SKIPPED BY WORKFLOW |

That exclusion is acceptable for this unit: nothing here ships in the package tree,
and `scripts/test.ts` is the test runner rather than runtime source. The Windows
lane is dispatch-only for every ordinary pull request in this repository, so
requiring it here would be a new policy, not this unit's job.

## Dependency order

Layer 1 is the runner change; layer 2 is a fixture that the runner executes. Ordering
them the other way would put a test-timing change under an unverified runner. The
order is a build-order statement, not an effort estimate.

## Work phases

| Phase | Outcome |
|---|---|
| wp0 | This roadmap: stack shape, single-trigger proof, merge/close order, attribution |
| wp1 | Build both layers locally on fresh `origin/dev` with `cherry-pick -x` |
| wp2 | Push both branches with `--no-verify`; open exactly one pull request (tip → `dev`) |
| wp3 | Record tip CI, merge the tip, settle #3924/#3930 and linked issues |

Diff-level detail for each phase: `010_phase1_stack_build.md`,
`020_phase2_publish.md`, `030_phase3_merge_and_settle.md`.

## Constraints in force

The owner set these for this unit, and they override the repository's default
verification habits:

- **No local suite.** No `bun run test`, `bun test`, `bun run test:changed`,
  `bun run typecheck`, or build used as a gate. Every such row is recorded
  `NOT RUN (owner instruction)`, never as a pass.
- **Push with `--no-verify`.** Local hooks are skipped by instruction.
- **CI on the tip only.** Never open a pull request for a lower layer.
- **One green run, then merge.** The tip's exact head SHA is the product gate.
- **Preserve original authorship** for carried work.
- **Close linked issues** at the moment the change is on `dev`.

## Verification model

The product evidence is the hosted Cross-platform CI run on the tip's exact head
SHA — run id, head SHA, per-job conclusions — read as a job matrix, not as the
aggregate `ci` summary alone. The three dispatch-only or packaging-gated job
families above are recorded SKIPPED BY WORKFLOW.

Merge additionally requires the current gate checks to be green on that same head:
`enforce-target` and `hygiene` (`enforce-pr-target.yml:679-692` folds deterministic
hygiene failures into its verdict; `pr-hygiene.yml:236-238` fails and labels on a
violation), plus resolution of any actionable automated review finding.

Landing evidence is the squash SHA GitHub returns, proven to be an ancestor of
fetched `origin/dev`, with its tree compared against the reviewed tip. Local checks
are `NOT RUN` by instruction and are never reported as passing.

A verifier honesty note, since this unit's plan names commands it will not run:
`bun run test` would observe `scripts/test.ts` and both test files, and
`bun run typecheck` would observe `scripts/test.ts`. Both are in scope for the
change and both are withheld by owner instruction, so their acceptance rows are
delegated to hosted CI rather than claimed locally.

## Terminal outcomes

- **DONE** — tip CI green on its exact head, tip merged into `dev`, #3924 and #3930
  settled with authorship preserved, linked issues closed, evidence recorded.
- **BLOCKED** — a required merge right is missing, or CI fails for a cause outside
  these four files.
- **NEEDS_HUMAN** — a policy decision beyond restoring existing behavior.
