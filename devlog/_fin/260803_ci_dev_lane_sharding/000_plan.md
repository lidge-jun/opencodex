# dev CI lane: shard on Linux, move Windows off the PR path

Opened 2026-08-03 against `dev@f9b9440c551e3d7f3e2041098caa2ee4de57698e` (v2.10.0).

## The problem this unit solves

`.github/workflows/ci.yml` runs one `test` job across a three-OS matrix, and
every leg runs the *whole* gate: install, typecheck, 480 test files under
`bun test --isolate`, GUI tests, privacy scan, release-helper build, GUI lint,
GUI build, CLI smoke. The three legs are not equal.

Measured on run `30748690567` (PR #880, `feat/cline-pass-provider`, all green):

| leg | wall clock |
|---|---|
| ubuntu | 5m 49s |
| macos | 5m 23s |
| windows | **16m 23s** |

The Windows leg is roughly 3x the other two and it alone decides when a PR
turns green. That is not a new observation — the `timeout-minutes: 30` comment
in `ci.yml` records the history: a 12-minute ceiling once let runner variance
decide review outcomes (#711 passed at 11.8min, #653 was killed at 12.0min,
issue #717), and the ceiling has been raised twice since rather than the gap
being closed.

Two consequences fall out of that:

1. **Feedback latency.** A contributor waits ~16 minutes for a verdict that
   Linux produced at minute 6.
2. **Concurrency.** Standard runners are free on public repositories, so the
   scarce resource is not money — it is the 20 concurrent jobs the Free plan
   allows, and the 5-job macOS cap. With ~20 pull requests open, six jobs per
   push (3 test legs + 3 npm-global legs) saturates that budget and PRs queue
   behind each other.

Corrected after audit: a run is **seven** jobs, not six — `select-windows-runner`
is one of them.

Jobs *created* per run is not the same as jobs *running at once*: the platform
legs wait on the selector, `gates` and the packaging smoke wait on `changes`,
and the gate waits on everything. Peak simultaneous runners, derived from the
dependency graph rather than by summing rows:

| | jobs per run | peak simultaneous |
|---|---|---|
| before | 7 | 6 (3 suite + 3 npm-global, after the selector) |
| after — non-packaging PR (tests/workflows/docs) | 9 | 7 |
| after — source or packaging PR | 12 | up to 10 |
| after — promotion | 13 | up to 10 |

"Peak" is the graph's maximum antichain, not the sum of the rows: `changes` and
`select-windows-runner` start alongside the four shards and macOS, while
`gates` and the packaging smoke wait on `changes`, and the gate waits on
everything. The upper bounds assume worst-case overlap; real overlap depends on
job durations.

Note which row an ordinary `src/**` PR lands in: **the packaging row**, because
`src` ships inside the npm tarball and is therefore a packaging input. So the
common case trades more concurrent short jobs for a much shorter critical path.
That is the right trade against a 20-job budget, but it is a trade, and calling
the change strictly cheaper would be false.

## What this unit changes

The dev/PR lane becomes a Linux lane. Windows verification does not disappear —
it moves to where a maintainer actually consumes it: promotion to `main` and
`preview`, plus `workflow_dispatch` on demand. macOS stays on the PR lane and
keeps running the **whole suite, unsharded** — it is the control that would
notice if the four Linux shards ever stopped being independent. What it drops
is the platform-independent work it used to repeat: typecheck, privacy scan,
GUI lint and build, release-helper syntax. Those now run once, in `gates`.

Stated as an invariant: **every platform that ships is still proven before it
ships; only the moment of proof moves.** A PR is proven on Linux, a promotion
is proven on every platform.

## Constraints discovered before planning

### `tests/ci-workflows.test.ts` is the real specification

This is not a workflow edit with a test that happens to cover it. The suite
pins the workflow's shape deliberately, and its comments say why each pin
exists — usually because an audit round deleted that exact thing and the suite
stayed green. Any restructure must move these pins forward *intentionally*:

- `ci.jobs["select-windows-runner"]["timeout-minutes"] === 2`
- `ci.jobs.test["timeout-minutes"] === 30`
- `ci.jobs["npm-global-smoke"]["timeout-minutes"] === 8`
- `count(workflow, "timeout-minutes:") === 3` — an exact count, so adding a job
  without updating this test fails the suite
- `workflow` contains `bun test --isolate tests`
- pinned action SHAs for checkout / setup-bun / setup-node, and no `@vN` refs
- `pull_request.branches` sorted equals `["dev", "main"]`
- `Object.keys(pull_request)` sorted equals `["branches", "paths"]`
- `push.branches` sorted equals `["dev", "main", "preview"]`
- an exact 14-entry path list, asserted identical for `push` and `pull_request`
- `- name: GUI lint`, `bun run lint`, `- name: GUI build`, `bun run build`

The path-list pin has its own history: "Round 16 dropped `src/**`, `tests/**`,
and both workflow self-references one at a time and the suite stayed green each
time." So the list is asserted element-by-element on purpose.

**Design consequence:** the test file is edited in the same phase as the
workflow it pins, and every pin change is justified in the diff rather than
relaxed. A pin that becomes meaningless (an exact `timeout-minutes:` count
across a matrix that now has more jobs) is *replaced by a stronger pin*, not
deleted.

### Path filtering must not sit at workflow level

GitHub's documentation is explicit: "If a workflow is skipped due to path
filtering, branch filtering, or a commit message, then checks associated with
that workflow will remain in a 'Pending' state. A pull request that requires
those checks to be successful will be blocked from merging."
([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax))

A *job* skipped by an `if:` condition behaves in the opposite way: "A job that
is skipped will report its status as 'Success'. It will not prevent a pull
request from merging, even if it is a required check."
([job conditions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions))

So affected-path scoping belongs on jobs, never on the workflow trigger. The
existing `on.pull_request.paths` list stays as a coarse "is this workflow
relevant at all" filter — it is already there and already pinned — and the new
per-area scoping happens inside the run.

### Required-check names are exact strings

"If you use branch protection rules that require specific status checks, make
sure that job names are unique across all workflows."
([protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches))

A sharded matrix produces `test (1)`, `test (2)`, … — names that change
whenever the shard count changes. The answer is a single aggregate job whose
name never moves, which `needs:` every real job and asserts their results.
Branch protection then names one stable check.

Right now `dev` has **no** branch protection configured (`GET
/repos/.../branches/dev/protection` returns 404 "Branch not protected"), which
matches `AGENTS.md`: approval and CI requirements are "enforced by convention
until branch protection is configured". That makes this the cheap moment to
introduce a stable gate name — nothing has to be re-pointed today, and whoever
enables protection later has one obvious check to require.

**Known coupling, recorded rather than fixed here.** The workflow keeps its
`on.pull_request.paths` filter (widened to 17 entries in phase 2), which means
a PR touching only `docs-site/**` or `devlog/**` does not trigger it at all — and
therefore creates no `ci` check. That is harmless today because nothing is
required. The moment `ci` becomes a required check, it stops being harmless:
a docs-only PR would sit pending forever.

Whoever enables branch protection must therefore also either drop the
workflow-level `paths:` filter or move the gate into an always-triggered
workflow. This unit does not do it now because removing that pinned 14-entry
list is a separate decision with its own blast radius, and bundling it into a
CI-speed change is the drive-by scope expansion this repository's guidance
warns against. It is written down here and in the PR description so it cannot
be discovered the hard way.

### Bun's sharding semantics, verified locally

Bun 1.3.13 added `--shard=i/n`. From the release notes: "Test files are sorted
by path for determinism and distributed round-robin across shards, keeping each
shard balanced to within one file of each other. The shard index is 1-based."
([Bun v1.3.13](https://bun.com/blog/bun-v1.3.13), 2026-04-20)

Verified on this tree with Bun 1.3.14 rather than taken on trust — see
`001_shard_evidence.md`. Four shards over the real suite give 120 files each,
union 480, zero overlap, zero loss.

### The suite serializes itself locally, and that is local-only

`scripts/test.ts` waits for other `bun test --isolate` runners on the same
machine before starting, because parallel worktrees on one developer box turned
a 210s suite into 13 minutes. That queue is keyed on `pgrep` of the local
machine; separate CI runners never see each other, so sharding does not
interact with it. CI already calls `bun test --isolate tests` directly, not the
wrapper script.

## Phase map

Dependency-ordered: each phase consumes the verified output of the previous one.

| phase | doc | delivers |
|---|---|---|
| 1 | `010_linux_shard_matrix.md` + `011_platform_legs.md` | one matrix job becomes four Linux shards, a `gates` job, two platform jobs, and the aggregate `ci` check |
| 2 | `030_affected_scoping.md` | per-job change detection; packaging and GUI work skips when its area is untouched |
| 3 | `040_ship_and_review.md` | local gates, push, PR, live timing evidence, security + bot review |

Phase 1 is deliberately **one commit covering two documents**. An earlier draft
split "shard Linux" and "move the platforms" into separate phases; that is not
implementable, because Windows and macOS are `include:` entries of the very
`test` job the sharding replaces. Splitting them would have deleted two
platforms in a commit whose own description claimed they were untouched. The
documents stay separate for readability; the delivery does not.

Phase 2 follows because it only adds conditions to jobs phase 1 defines. Phase
3 is the only phase that touches the remote.

## Scope boundary

**IN:** `.github/workflows/ci.yml`, `tests/ci-workflows.test.ts`, this devlog
unit, and — only if sharding demands it — `package.json` scripts.

**OUT:** `src/`, `gui/` source, release publishing, provider adapters, any
credential surface, `enforce-pr-target.yml` semantics. The self-hosted Windows
runner routing keeps its security reasoning verbatim: those comments explain
that the routing is a *cost* control and not a security boundary, and that the
fork-approval policy is what actually protects the box. Nothing here weakens
that.

## Accept criteria

1. `actionlint` exits 0 on every touched workflow.
2. Shards partition the suite: per-shard counts sum to the discovered file
   count with no file in two shards.
3. `bun run typecheck` exits 0; the full suite passes, including the workflow
   pins in `tests/ci-workflows.test.ts`.
4. The aggregate gate fails when any needed job fails, and succeeds when a
   needed job is skipped by area filtering. Both directions are asserted, not
   assumed — a gate that cannot fail is worse than no gate.
5. Live run evidence after push: dev-lane wall clock compared against the
   16m 23s baseline.
6. No local path, worktree name, or machine name appears in any pushed commit,
   workflow, or PR body.
7. Every shard runs green with the GUI dependencies installed — specifically
   the shard containing the JSX-importing tests, not an arbitrary one.
8. Windows still runs on `workflow_dispatch` and on promotion, proven by an
   actual dispatch run rather than by reading the condition.
