# Phase 3 — local gates, push, PR, live evidence, review response

Consumes phases 1 and 2. This is the only phase that touches the remote.

> **Amended after audit round 1** (`002_audit_synthesis.md`): a maintainer
> security review is an explicit gate here, not just bot review — `MAINTAINERS.md`
> requires it for GitHub Actions changes.

## 3a. Local gates before anything leaves the machine

Run in this order, because each one's failure makes the next one's output
meaningless:

```bash
set -euo pipefail
actionlint .github/workflows/ci.yml
bun x tsc --noEmit
bun test tests/ci-workflows.test.ts
bun run test
bun run privacy:scan
```

The full suite matters here specifically because this unit edits the file that
*tests the workflows*. A targeted run of `ci-workflows.test.ts` proves the new
pins pass; it does not prove nothing else read those workflows.

Re-prove shard tiling against the final matrix, since the divisor is now
written in two places (matrix list and `--shard=i/N`):

```bash
for s in 1 2 3 4; do
  bun test --shard=$s/4 --test-name-pattern '____never_match____' 2>&1 \
    | grep -oE '^tests/[^:]+\.test\.ts' | sort -u
done | sort | uniq -d
```

Empty output means no file is in two shards. Compare the union count against
`find tests -name '*.test.ts' | wc -l` for the other direction.

## 3b. Commit hygiene

Commits are the public record. None of them may carry a local absolute path, a
worktree directory name, a machine name, or an internal session reference.
Check before pushing:

```bash
# One pattern set for both checks, and the diff scan covers every path the
# branch touches — including devlog, which is exactly as public as the workflow
# files and was omitted from an earlier version of this command.
leak='/Users/|worktree|macmini|session|\.codex/'
git log origin/dev..HEAD --format='%B' | grep -nEi "$leak" || echo clean
git diff origin/dev..HEAD | grep -nEi "$leak" || echo clean
```

A hit is not automatically a leak — this plan legitimately contains the word
`worktree` when describing why the local test runner serializes. Read each hit
rather than trusting the exit code.

The devlog files are tracked and public by design (`AGENTS.md`: the devlog is a
public directory in a public repository), so they are held to the same standard
as the workflow files — which is why this unit's docs cite run IDs and file
paths relative to the repository root and nothing else.

## 3c. Push and PR

Target `dev`. `enforce-pr-target.yml` rejects PRs whose base is not `dev`, and
also rejects "empty, thin, or malformed descriptions" — so the description is a
gate, not a courtesy.

The description covers, in order:

1. **What changes** — Linux shards, aggregate gate, Windows moved to
   promotion/dispatch, macOS kept whole, packaging and GUI work area-scoped.
2. **The measured baseline** — run `30748690567`: ubuntu 5m 49s, macos 5m 23s,
   windows 16m 23s. The Windows leg set the critical path.
3. **The honest cost** — a Windows-only regression can reach `dev` and be
   caught at promotion instead of at PR. `dev` is not published; `main` and
   `preview` still gate on Windows.
4. **Why not a cost argument** — standard runners are free on public
   repositories. This is about feedback latency and the 20-job concurrency
   budget, not minutes billed. Claiming savings that do not exist would be the
   easier pitch and a false one.
5. **Required-check note** — `dev` currently has no branch protection
   configured. The new stable `ci` check is the one to require if that changes;
   individual shard names are not stable and are not meant to be required.
   Requiring `ci` also means dropping the workflow-level `paths:` filter (or
   moving the gate to an always-triggered workflow), because a docs-only PR
   currently triggers no run and would therefore never create the check.
6. **Review pointers** — the two failure modes worth a reviewer's attention:
   shard/divisor drift (some files silently stop running) and a gate that
   cannot fail.
7. **Concurrency trade** — jobs created per run go up (7 → 9-13) and peak
   simultaneous runners with them (6 → up to 10 for a source PR), while the
   critical path goes down. The exact figures are in `000`. Stated plainly,
   since "faster CI" usually implies "less CI" and here it does not.

## 3c-bis. Security review is required, not optional

`MAINTAINERS.md`: "Authentication, credential handling, GitHub Actions, release
automation, dependency installation, and other security-boundary changes
require explicit security review."

This unit is squarely inside that: it edits GitHub Actions workflows and adds a
third-party action. The PR therefore requests maintainer security review
explicitly rather than treating green bots as sufficient. Points to raise for
that review:

- `dorny/paths-filter` is a new third-party dependency, SHA-pinned; the
  no-dependency fallback is documented in `030`.
- The `changes` job takes `pull-requests: read`, a permission the workflow did
  not previously hold anywhere. It is scoped to that one job.
- `select-windows-runner` and its security commentary are unchanged; the
  self-hosted routing is not touched by this unit.
- No job gains `contents: write`, and no secret is newly exposed.

## 3d. Live evidence

After the PR run completes:

```bash
gh run list --workflow ci.yml --branch <branch> --limit 1
gh run view <id> --json jobs -q '.jobs[] | "\(.name) \(.conclusion) \(.startedAt) \(.completedAt)"'
```

What the evidence must show, stated before it is collected so it cannot be
read favourably after the fact:

- Four `test i/4` jobs, all success.
- No Windows test leg on the PR event.
- `platform-macos` present and green.
- `ci` gate green.
- Critical path materially under the 16m 23s baseline. If it is not, the
  restructure failed its own premise and the D summary says so rather than
  finding a flattering subset of the numbers.
- `npm-global-smoke` present (this PR touches `.github/**` and `tests/**`, so
  packaging is untouched — expect it **skipped**, and expect the gate green
  anyway; that combination is the phase-3 proof).

Then a `workflow_dispatch` run to prove the Windows leg still exists and still
passes. Without that, "coverage moved rather than dropped" is an assertion, not
a fact.

## 3e. Review-bot response

Codex and CodeRabbit both review this repository. Each comment gets one of two
dispositions, recorded:

- **Fixed** — a follow-up commit, named.
- **Rebutted** — with the reason, in English, on the thread.

Neither bot is authoritative about intent. Where a suggestion conflicts with a
decision recorded in `000_plan.md` or `011_platform_legs.md`, the answer cites
that reasoning instead of silently complying. Where a bot finds something those
documents got wrong, the document is updated too — a devlog that only records
the decisions that survived is a worse record than none.

Likely objections, anticipated:

| objection | response |
|---|---|
| "Dropping Windows from PRs reduces coverage" | Correct, and stated. Windows still runs on promotion and dispatch, and the Windows `npm-global-smoke` leg still runs on any PR touching a packaged input — which includes `src/**`. |
| "`dorny/paths-filter` is a third-party dependency" | Pinned to a full SHA; fallback to a plain `git diff` step is documented in `030`. |
| "The gate treats skipped as success" | Deliberate and required — an area-filtered job reports skipped, and GitHub reports skipped jobs as success anyway. |
| "Shard count is magic" | 480 files divide evenly by 4; the matrix and divisor are pinned to each other in the suite. |
| "A docs-only PR will hang on a required `ci` check" | True if `ci` is ever required while the workflow keeps `paths:`. Documented in `000` and in the PR body as a prerequisite for enabling protection. |
| "Peak concurrency went up" | Correct; the trade is stated in `000`'s table. Shorter critical path against a 20-job budget of short jobs. |

## 3f. Close-out

D summary records: the real terminal outcome, the measured before/after, what
did **not** improve, and which assumption would have to be wrong for this to be
the wrong call. The candidate for that last one is stated up front: if
Windows-only regressions turn out to be frequent on `dev`, the correct response
is to put Windows back on the PR lane, sharded, rather than to defend this
arrangement.
