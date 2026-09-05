# 830 — Deliver the verified aggregate before post-merge regression

## Current user authority
The user's latest correction requires publishing this aggregate now, merging
to dev after exact-head CI and admin checks, then running at least two complete
main-to-merged-dev regression PABCD cycles. This supersedes800/810/820's earlier
prepublication ordering. Do not delay this PR for the post-merge cycles.
No release, main promotion, peer coordination or local suite is authorized.

## P/A/B/C/D for this delivery
- P/A: verify clean sourceef7914, completed first-cycle receipt/review and
  existing14head inventory; review this changed sequencing.
- B: add812_first_cycle_outcome.md from the reviewed evidence report, with
  the current sequencing notice; publish codex/closeout-split-train and open
  one PR targetingdev using every repository template section. No new source
  changes. Preserve original14PRs and refs until verified landing.
- C: watch actual PR checks on exact publishedH. Verify current PR head,
  required/logical check results, review findings and the tested merge tree.
  Do not rerun local suites. Capture a source-bound receipt around the actual
  hosted-CI verifier. Failed/cancelled CI is not PASS.
- D: admin merge only with explicit expectedH; verify actual tree equals
  tested integration tree and fetcheddev ancestry, observe post-merge CI.
  Close originals as superseded by this aggregate, not individually merged.
  Record delivered facts, then immediately enter840.

## Integration input
Source last verified at ef7914d4a51899f49baa141990f79750b4c75cf9.
Pinned first-cycle dev wasbf58ef182. Latest fetcheddev is
c4701938c102b534983ea2912b92d524edbb2c4c (#3662). Hosted merge-ref CI must
validate the actual integration with currentdev; old local proof is not
claimed to test this later base. No blanket claim that earlier unexplained
discovery stall or Fast opt-in ambiguity is fixed.

During final landing checks, dev advanced again to
ef9c538f36f94f0e95c7f4833642e5b03bd29e2e (#3664). The first PR head0d071d
passed CI33971079937 on tree739edf9d based on c470, but that result does not
certify the newer integration. Preserve0d071d as a checkpoint, merge the
new dev into this branch without conflict, and validate the updated final
head through the same PR before admin landing. This is required base-drift
handling, not the deferred post-merge regression cycles.

## Post-merge phase map
-840: consume820's exact new test/fixture/layout plan on the delivereddev;
 execute first full post-merge main comparison and deliver resulting evidence.
-850: second independent complete PABCD against finaldev, with fresh
 transport/config/rendered scenarios and full gates. Previous loop receipts
 are inputs, never substituted for this cycle's work.
