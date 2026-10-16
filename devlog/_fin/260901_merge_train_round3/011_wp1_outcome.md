# 011 — wp1 outcome: #3114 landed

`abcda8e134d7e3222d72877fe83c77fcb492a821`, merged 2026-09-01T03:57:16Z, squash.
6 files / +820 lines, all under `devlog/_plan/260831_bug_triage_nonprio70/`.

## Audit before approval

`010` required reading the unit rather than waving it through because it is docs-only.
Four checks, all clean:

| check | result |
| --- | --- |
| credential/identifier scan over the full diff | zero hits |
| `bun run privacy:scan` | Privacy scan passed |
| `bun test tests/repo-hygiene.test.ts` | 12 pass / 0 fail |
| pre-disclosure test on the one security-adjacent passage | cleared |

The fourth is the one that mattered. `070_outcome.md:213-216` describes #3000's
`libc.so.6` `dlopen` — which throws on musl, so credential publication would fail on
Alpine — and its `signal.aborted` check placed before `persistRefreshedMainAuthJson`,
discarding a grant the provider already rotated. `AGENTS.md` asks whether a public diff
already reveals the weakness. #3000 is `CLOSED` (2026-08-31T19:13:28Z) and was never
merged: the code never shipped, so there is no deployed weakness. The passage is a closure
rationale, and closure rationales are exactly what a `_fin`-bound record is for.

The repository answers this question mechanically too, and it agrees:
`tests/repo-hygiene.test.ts` asserts `no open devlog plan carries an unresolved security
verdict`, and it passes against the merged tree.

## Admin merge, and why

`gh pr review 3114 --approve` is refused by GitHub: *"Can not approve your own pull
request."* `dev` carries a ruleset requiring a reviewed pull request. A self-authored PR
therefore has no non-admin route, and this train was explicitly authorized to use one.

Worth stating plainly rather than burying: **admin merge is not review.** What stands in
for review here is the audit above, and it is weaker than a second pair of eyes would be.
For a 6-file docs-only change whose two mechanical gates both pass, that trade is
defensible. It would not be for the three code PRs later in this train.

## Residual

The remote branch was deleted; the local `codex/triage-round-devlog-pr` survives because
worktree `/Users/jun/.codex/worktrees/2a44/opencodex` still has it checked out. Left alone —
that worktree is not this train's to disturb.
