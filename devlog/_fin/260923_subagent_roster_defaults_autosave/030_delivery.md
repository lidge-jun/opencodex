# 030 — Delivery

1. Push both branches; open PR1 (base `dev`) and PR2 (base PR1 branch) with the
   repository template. PR2 carries a screenshot hosted on `pr-assets`.
2. Inspect exact-head required CI for each head; queued, skipped, or cancelled
   checks are not passes.
3. Squash-merge PR1 into `dev`, retarget PR2 to `dev`, confirm its checks at the
   final head, squash-merge PR2. No rebase (user instruction).
4. Record the post-merge `dev` SHA and move this unit to `devlog/_fin/` in a
   later docs pass.
