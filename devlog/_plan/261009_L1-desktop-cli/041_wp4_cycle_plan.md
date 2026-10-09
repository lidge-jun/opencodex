# 041 — wp4 cycle plan (decision record + CI closeout for PR A and PR C)

**Continuity.** wp3 D (039): "next wp5 guards, then wp4 closeout". The goalplan cursor selects wp4 before wp5
(registration order; wp4 depends only on wp2/wp3). This cycle therefore covers the parts of wp4 that do not need
PR B: the Desktop PATH CLI decision record and exact-head CI for #6802 and #6807. PR B's CI and the final lane report
belong to the wp5 cycle that follows; criterion c-5 is met only after all three PRs are green.

Deliverables (B):
1. Finalize `040_path_cli_decision_closeout.md` with the outcome: decision unchanged (no Desktop PATH installer in this
   lane), evidence that PR A covers the CLI section of the desktop guide and PR C names the Desktop CLI in launcher
   failures; follow-up design kept as written.
2. CI: rerun only failed jobs of #6802 run 37873621613 (`macos 1/2` timed out in a `tests/ci-workflows` batch whose
   12 files all pass alone; no changed module is in that batch). If the rerun fails again in the same place, compare
   with dev's run; a real regression goes back to a fix in wp5's branch base (PR A).
3. Watch #6807 CI at its current head.

Check (C): both PRs' required checks green at their exact heads (`gh pr checks`), recorded with run ids.
Out of scope: merging, other lanes, PR B.


Audit (reviewer 01a11e4b): GO-WITH-FIXES (blockers=1), folded:
- Review evidence is recorded here for A and C: #6802 independent review PASS (round 3, reviewer 01a11e61, head
  e866bf0815 → rebased 1718fcad8b, content-identical); #6807 independent review PASS (reviewer 01a11e61, head 73f166f08a).
  PR B's review and the three-PR reconciliation transfer to wp5's C/D.
- 039 now exists on this branch too (copied from the launcher branch; identical content).
- The macos 1/2 failure is retried as a whole failed job after the run completes; a repeat in the same batch is
  treated as real and investigated, not retried again.

Check amendment (at B): run 37873621613 still had 10 queued/running jobs (Windows runner backlog), so its failed job
cannot be retried yet and #6807's CI is pending. This cycle's C therefore checks the decision record (privacy and
structure gates over the changed docs) and records the CI snapshot; the green-at-exact-head requirement for all three
PRs is verified in wp5's C/D before c-5 is met. Nothing about c-5 is weakened.
