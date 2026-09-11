# 130 — wp16: bug PRs opened after the 260825 triage

The original triage snapshot (`000_research_snapshot.md`) enumerated 16 bug-labelled PRs.
Five more carry the `bug` label and were not in it, either because they were opened later
or because the label moved after the snapshot was taken:

| PR | Title | Author | State at triage |
|---|---|---|---|
| #2595 | fix(combos): bound preflight retained chunk count | luvs01 | review-ready, closes #2592 |
| #2583 | fix(kiro): preserve keyword-named composed properties | luvs01 | review-ready, closes #2571 |
| #2575 | fix(pricing): map Daybreak cost overlays and preserve model identity in logs | riique | draft |
| #2430 | fix(gui): align the sidebar foot's four rows | olddonkey | review-ready |
| #2427 | fix(test): pass --parallel so the full suite finishes instead of reading as hung | olddonkey | review-ready |

## Why this is its own work-phase

The DONE criterion is "every bug-labelled PR is terminal", not "the sixteen I happened to
list yesterday". A snapshot taken at plan time is a starting inventory, not the scope. These
five are resolved on the same terms as the original sixteen: an independent review that
re-runs the focused suite against a merge with current `dev`, and a falsification pass that
reverts the production hunk to prove the regression test is load-bearing.

## Verification standard applied

Each PR was reviewed in its own worktree by a separate reviewer with no knowledge of the
others' conclusions. The merge into `dev` happened only after:

1. `git merge origin/dev` into the PR head resolved cleanly and `bun x tsc --noEmit` stayed at
   exit 0 — a PR green on its own base is not evidence it is green on the current one;
2. the focused suite covering the changed subsystem passed on that merge;
3. reverting the production hunk made the new test fail, and restoring it made the test pass.

Step 3 is the one that earns its keep. It has already caught a patch in this unit's history
(#2488) whose test passed with the fix reverted — the test was pinning behavior that already
held, so the "fix" was decoration. That patch was dropped and only the test kept.

#2430 additionally required a rendered check rather than a passing assertion: it is a CSS
alignment change, and a unit test that reads the stylesheet cannot see what the browser lays
out. The reviewer built the GUI, served `gui/dist`, drove it with a real browser, and measured
the four rows — text left edge at x=49, trailing controls ending at x=207, row height 35.5px
across all four.

#2427 is the highest-risk of the five because it rewrites the test runner every later
verification depends on. It was checked against a real `SIGKILL` of the lock owner
(`RECLAIMED acquired=true`), and the full suite was run through the new runner end to end:
14955 pass / 12 skip / 0 fail in 178s across seven lanes. A runner that reports green while
silently skipping lanes would be worse than the hang it replaces, so the lane totals were
summed rather than trusting the final line.

#2575 arrived as a draft with an unticked "resolved all Codex/CodeRabbit findings" box. The
review found no blockers, so it was marked ready and merged; the unticked box reflected an
author workflow state, not an outstanding finding.

## Outcome

All five merged into `dev`. Linked issues (#2592, #2571) closed by hand with the merge SHA
and the falsification result quoted, because GitHub only auto-closes on merges into `main`
and every PR here targets `dev`.
