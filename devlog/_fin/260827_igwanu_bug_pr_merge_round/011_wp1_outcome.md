# 011 — wp1 outcome: roadmap lock

Docs-only cycle. No production code changed. Deliverable is the plan unit itself:
`000_plan.md` plus six decade docs, locked at `77635d8c9`.

## A-gate: two independent Sol-high reviewers, four rounds

| Round | Lane | Verdict | Result |
|---|---|---|---|
| r1 | facts | NEAR-PASS | 1 correction applied (`27b040931`) |
| r1 | judgement | **FAIL** | 2 blockers, both accepted |
| — | judgement re-verify | **FAIL** | 1 blocker incompletely closed |
| — | judgement re-verify | PASS | both closed |
| r2 | judgement confirm | PASS | rebound to the repaired files |

### What the facts reviewer independently re-derived

Re-ran `git merge-tree` for all 13 PRs from `dev@8b1b65b8d` and confirmed all 12
clean tree hashes matched `mtp/<n>^{tree}` exactly before typechecking, plus the
`#2497` conflict. Counted every changed path across all 13 PRs and confirmed the
contention map is exhaustive: `src/codex/auth-context.ts` (#2638, #2497) and
`src/server/responses/core.ts` (#2745, #2638, #2497), nothing else shared.

Its correction: the plan had collapsed two distinct shared defects into one per-PR
line. `test 3/4` and `macos` fail on `release version line`; `gates` fails on
`privacy:scan`; `ci` is the fan-in. #2747 has no `gates` failure at all because
its head predates the runbook document.

### What the judgement reviewer caught — the two that mattered

**1. I violated this repository's own security rule.** The plan reproduced the
unfixed #2745 credential-boundary defect — mechanism, activation sequence,
remediation direction — inside `devlog/`, a public tracked directory, while the PR
is open. `AGENTS.md` §"Security working notes" forbids exactly that, and says so in
a section written because maintainer-authored triage had done it before.

My error in reasoning: I treated the detail as publishable because the reviewer had
already written it in a public PR comment. But the rule keys on whether the **fix
has shipped**, not on where the analysis first appeared. An open PR means
pre-disclosure.

The first repair was incomplete — the `TESTS` section still named the regression
design, which carries the activation shape without the prose. The reviewer caught
that too. Both are now in `.tmp/2745-security-triage.md` (gitignored, confirmed via
`git check-ignore`).

**2. Every merge lane skipped the approval `MAINTAINERS.md` requires.** The plan
went from "CI green" straight to `gh pr merge`. `MAINTAINERS.md:57-59` requires
approval from at least one maintainer who is not the author, and
`.github/scripts/pr-sponsored-surface.cjs:52` lists `package.json` as a restricted
surface. All four Ingwannu PRs read `REVIEW_REQUIRED`. A round-level instruction
from the user is not an exact-head PR approval.

It also refuted the release-safety framing as incomplete rather than wrong: no
scheduled, push-triggered, auto-merge, or version-keyed publish path exists
(`release.yml` is `workflow_dispatch`-only and rejects any ref that is not `main`
or `preview`), but `package.json` is still a restricted surface needing review.

### Approval path, resolved

The operator is authenticated as `lidge-jun` (`gh auth status`), listed in
`MAINTAINERS.md:10` as project owner. `Ingwannu` is a separate maintainer. A
`lidge-jun` approval of an Ingwannu-authored PR is therefore a valid non-author
maintainer approval, confirmed by the reviewer against `MAINTAINERS.md:57-59`.
The gate is satisfiable without self-approval.

## Keystone verification (full suite, remote)

`mtp/2766` pushed as `codex/mtp-2766-probe`, checked out on `lidge`
(`~/ocx-ci/opencodex`), full `bun run test` under `ocx-run`:

```
k2766: OK rc=0   finished 2026-08-28T00:25:04+09:00
15334 pass / 0 fail
```

Focused, on the same merged tree:

```
tests/release-version-line.test.ts   3 pass / 0 fail
bun run privacy:scan                 Privacy scan passed (exit 0)
bun x tsc --noEmit                   exit 0
```

On plain `dev` the same scan fails on the runbook literal, and the same test fails
repository-wide. The keystone claim is proven on both sides.

## Gate honesty note

The typecheck gate was verified rather than trusted: 12 merged trees compiling in
~12s looked like a no-op, so a deliberate `const x: number = "str"` was injected
into a merged worktree — `error TS2322`, exit 1. The speed is real; this repository
runs the native TypeScript 7.0.2 compiler at ~0.44s for a full typecheck.

## Carried into wp2

1. Merge #2766 first; it is the only PR that can produce a trustworthy green
   matrix for the others. Approval at exact head `076ad3036` before merge.
2. Review, rebase, and verification of other PRs may proceed in parallel — only
   the merges serialize.
3. Follow-up outside this round's scope: the same pre-disclosure material exists
   in `devlog/_plan/260826_wp7e_presence_driven_oauth_failover/` and
   `devlog/_plan/260827_dev_hardening/`. Pre-existing, belongs to other active
   work streams, needs separate authority. **Escalate; do not silently rewrite.**
