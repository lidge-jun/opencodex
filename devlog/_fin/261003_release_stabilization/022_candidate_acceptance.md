# Candidate acceptance: GO after unchanged Windows rerun

Candidate `0818ea1812a028e1c14cd0b0511b44863407bc52` passed the complete
cross-platform gate. Run
[37162399902](https://github.com/lidge-jun/opencodex/actions/runs/37162399902)
attempt 2 re-ran only the failed `windows 8/9` job and the aggregate, with the
same command, assertions, test membership and removal retry schedule. The shard
passed and the run concluded success: 40 jobs, all nine Windows shards green, and
only the standalone `privacy gate` skipped because manual dispatch does not request
it (the privacy scan inside `gates` passed).

The attempt-1 failure is preserved in `021_candidate_first_run.md`. A separate
non-release Windows diagnostic (run
[37168238608](https://github.com/lidge-jun/opencodex/actions/runs/37168238608),
same runner image `20260925.250.1` and Bun 1.4.0) replayed the failing six-file
batch with instrumentation. The self-logout case's temp home was removed on the
first attempt, so the failure did not reproduce in isolation. That run is
diagnostic evidence only and was never treated as release proof; the diagnostic
branches are not merged.

What remains open: the cause of the intermittent teardown `EPERM` is not
established. The diagnostic replay changed the temp root from the profile's
8.3 short path to the runner temp drive, so it cannot exclude the lexical
alias gap in the Windows ACL reap matcher, where a short-name root does not
match long-name pending reaps. That gap is a real weakness, but nothing shows it
caused this failure. It is a follow-up for the test-cleanup path, and the
release gate did not depend on it.

The candidate is promoted unchanged: the `main` promotion merge `06841165f8`
(#6550) has the same tree as `0818ea1812`, after the version pre-move #6549
opened `dev` at 2.78.0. Publication is recorded in `031_publication_outcome.md`.
