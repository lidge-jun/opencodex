# 260827 bug-PR merge round — close-out

All 12 PRs dispositioned. `dev` advanced from `9b838d062` to `77e037077`.

| PR | lane | state | evidence |
|---|---|---|---|
| #2672 | L1 | MERGED | `2a9c18dc5` in `2feffbdc3` |
| #2674 | L1 | MERGED | `e3b136fb7` in `2feffbdc3` |
| #2671 | L1 | MERGED | `17aadf88e` + added test `4a4df12f2` |
| #2684 | L1 | MERGED | `2c85dd48d` in `2feffbdc3` |
| #2639 | L3 | CLOSED, partially landed | status half in `64c6d642b`; `created_at` held back |
| #2647 | L3 | CLOSED, landed | three ladders in `64c6d642b` |
| #2663 | L2 | CLOSED, landed | squashed `cb9bb9b76` in `cebe005db` |
| #2690 | L4 | CLOSED, landed | `669efd568` in `77e037077` |
| #2694 | L4 | CLOSED, NOOP | superseded by #2663; proven by probe |
| #2693 | L4 | **OPEN — BLOCKED** | upstream question posted |
| #2638 | L4 | **OPEN — NEEDS_HUMAN** | auth surface, security review |
| #2497 | L4 | **OPEN — NEEDS_HUMAN** | OAuth surface + 5-file conflict |

## What the round actually caught

Two PRs were not what their GitHub status claimed. #2694 was review-ready with five
green checks, a ticked "all CI tests are green on my local testing" box, and five
`tsc` errors including a call to a function defined nowhere. #2693 was a test-only
diff whose test failed on its own branch. Neither was caught by CI, because the five
checks those PRs ran compile and test nothing.

That is the round's most transferable finding: **on this repository, "checks are
green" is not evidence of health unless the list includes `ci` / `test N/4` /
`macos`.** For draft and contributor PRs it usually does not.

## What the round got wrong, and who caught it

Independent reviewers audited three lanes and returned FAIL twice. Seven of my own
claims were wrong or overstated:

1. Compile-gated stale PR heads instead of merged trees (heads were 4-294 commits behind).
2. Claimed #2684 and #2690 "do not textually conflict" — they do, provably.
3. Cited "#2663 CI is green" — the same five non-compiling checks I had just discredited.
4. Invented a CI mechanism ("full matrix only on maintainer PRs") — #2639 has all 27 checks and a non-maintainer author.
5. Called #2690 an L3 cherry-pick when its fix imports the module its refactor creates.
6. Framed the status/created_at split as principled when it survives on fixture contents.
7. Justified unverified effort ladders by a self-correction mechanism that does not function.

Number 7 is the one worth remembering. I read `refreshCommandCodeReasoningEfforts`,
saw it re-read the profile and replace the row, and cited that as the reason unverified
data was acceptable. The reviewer ran it against the live site: every profile page
returns 200 with an empty `reasoningEfforts` array and no parseable prose, for every
row in the table. **A safety net that exists in the code is not a safety net that
functions.**

The reviewers also found two real defects in code I had already verified: a `queued`
response marking unstarted messages `completed`, and a regenerated fixture
resurrecting a deliberately removed model behind a count-only assertion.

## Sequencing paid off once, concretely

Landing #2684 before #2690 was decided by `git merge-tree`, not preference. #2690
deletes the region #2684 edits, so the 92-line host-scoped change went first and the
larger extraction became a clean rebase the author performed themselves. The other
order would have forced #2684 to be rewritten.

## Operational notes

- `dev` is push-protected; every lane travelled through a `codex/` branch and a PR.
- The full suite belongs on `ssh lidge` via `ocx-run`, not this workstation.
- Do NOT set `OCX_TEST_NO_QUEUE=1` to bypass a stuck lock: it leaks into the child
  process `tests/test-runner.test.ts` spawns and fails the three machine-lock cases.
  A stale root-owned `/tmp/opencodex-bun-test.lock` should be removed instead.
- `cxc receipt test` flipped `core.bare` to true twice on long runs, making the main
  checkout report as bare. Recovered with `git config --local core.bare false`; no data
  lost. Cause not established.

## Open follow-ups

1. `parsedProfileEfforts` cannot read commandcode.ai profiles — dead for every row.
2. Field backfill mutates verbatim passthrough bodies; `status` and `created_at`
   should be decided together.
3. #2671's "probed 2026-08-26" provenance is unverified on a merged change.
