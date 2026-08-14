# 030 — Merge plan with per-PR verification gates

*Amended after the A-gate audit returned VERDICT: FAIL. The original gate treated
an agent's `MERGE-READY` disposition as merge authority; it is not.*

## Principle

A green CI badge is a precondition, not a decision — and an agent verdict is an
input, never the authority. `MAINTAINERS.md` L48-52 requires a real maintainer
approval plus successful required CI. No subagent disposition substitutes for
either.

## Gate sequence per candidate

1. `gh pr view <n> --json mergeable,mergeStateStatus,statusCheckRollup,reviewDecision`
   re-read at merge time, not from the WP1 snapshot.
2. **Required CI actually ran and succeeded on the exact head SHA**, checked with
   `gh api repos/<repo>/commits/<headSha>/check-runs` rather than the aggregate
   rollup. A rollup can read green while only policy automation executed.
3. **Maintainer approval exists** (`reviewDecision`), per `MAINTAINERS.md` L48-52.
4. **No unresolved blocking review thread**, checked with the GraphQL
   `reviewThreads` connection. REST `/pulls/<n>/reviews` cannot see thread
   resolution state and must not be used for this gate.
5. Reviewer disposition is `MERGE-READY` from the family reviewer that read the diff.
6. Base is `dev`. A stacked child targeting another PR head is never merged here.
7. Security-boundary check: a diff touching auth, credential/token handling, OAuth,
   workflows, release automation, or dependency installation leaves the routine lane
   and needs an explicit security read (`AGENTS.md` L230-236,
   `MAINTAINERS.md` L51-63).

## Outcome of applying the gate

The eight-family review found that **the overnight fork PRs have no test CI at
all**. Verified directly against the check-runs API per head SHA: #1636
(`8051979ef`), #1638 (`1b2a6b8e5`), #1632 (`7f2e2dfa9`), and #1637
(`23f4349af`) each report exactly four completed checks — `enforce-target`,
`hygiene`, `label`, `resolve-pr` — and nothing else. Cross-platform CI and
React Doctor sit at `action_required` with zero jobs, because fork contributors
cannot start repository CI.

So the WP1 candidate matrix was wrong in the optimistic direction, and gate 2
removes nearly the whole set. The reviewers independently found substantive
defects in the two most attractive candidates, which is what makes the gate load-
bearing rather than bureaucratic:

- **#1636** — the regression test is a bodyless `GET /healthz`; it stays green with
  the fix reverted, so it proves nothing about the 128-256 MiB boundary.
- **#1638** — the cache-hit predicate at
  `src/server/management/logs-usage-routes.ts:224-230` checks only `freshUntil`
  and never `expiresAt`, so the route can still serve the previous calendar day
  across midnight: the exact bug the PR claims to fix.
- **#1634** — two real correctness failures, including a create-then-edit fold that
  emits an Update File hunk for a file that does not exist.

**Final merge set: empty.**

#1618 was the last surviving candidate and it fails the gate too. Round-2 audit
caught what the rollup hides, confirmed directly via GraphQL on head
`f4cee1f4beaae6a76d9edef59caec2e815706fb3`:

- `reviewDecision: null` — no maintainer approval exists (gate 3).
- **7 unresolved, non-outdated review threads** (gate 4), two of them P2
  test-correctness findings from the Codex reviewer:
  `tests/responses-tool-conformance.test.ts:186` uses a string for a
  `tool_search_call.arguments` fixture that the bridge emits as an object, and
  `src/responses/parser.ts:567` preserves only object values — so the fixture is
  unrepresentative; and `:362` compares two bridge-derived outputs instead of a
  literal expected payload, which passes even if both sides corrupt the input
  symmetrically. CodeRabbit separately flags a vacuous-pass risk at `:300` where
  all three compared arrays can be empty.

A conformance test whose fixtures do not represent the real wire shape is exactly
the kind of thing that should not ride into a release unreviewed, so the gate is
doing its job rather than obstructing.

**This is the honest outcome of the cycle: nothing overnight is merge-ready.**
Every candidate either has no real CI, has a substantive defect a reviewer found,
or lacks the approval the repository requires. The release therefore carries the
Gemini 3.7 Flash work alone, landed as a maintainer commit with its own tests.

Excluded with reasons: #1623 (aggregate CI failed, plus a 1,939-line adapter-registry
refactor), #1568 (security-boundary release-credential change — merging release
machinery in the same breath as running the release is the wrong sequencing),
#1607 (targets `codex/routed-tool-discovery-devlog`, a stacked child),
#1618 (no maintainer approval, 7 unresolved threads including 2 P2 fixture defects).

## Ordering

With the merge set empty, WP4 has no merges to order. The Gemini 3.7 Flash work
(WP3) lands as a maintainer commit on `dev` with its own tests, and that commit
alone constitutes the release payload.

## Post-merge verification

`git fetch`, `git log --oneline origin/dev` for real SHAs, then `bun run typecheck`
and `bun run test` against the merged tree. Per-PR CI proves each patch against its
own base, not against the others.

## Rejection path

Every rejected candidate receives its reviewer's comment with the specific blocker
named. Nothing is closed. Issues linked by `Closes #n` are closed manually only
once the fix is confirmed on `dev` — these PRs target `dev`, and GitHub
auto-closes only from the default branch (`AGENTS.md` L162-169).
