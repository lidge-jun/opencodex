# Hosted verification and delivery

Prerequisites: independent implementation PRs. Scratch .tmp/cache-handoff/050_handoff.md records actual worktree, branches/PR URLs/full head SHA, source dispositions/credits, cycle receipts, remaining acceptance and reviews. Capture gh pr view/checks and gh run view JSON at each final independent tip; ordinary manual children only for real correction dependencies. No native membership mutation.

No product source changes planned here. If CI exposes a scoped defect, append a numbered repair plan and full PABCD cycle before implementation, then verify new exact head. Hosted workflow definition determines jobs actually executed; skipped/cancelled runs are never passes. No automatic workflow cancellation or protection edit. Local tests/build/typecheck/install remain NOT RUN. Only source/diff checks may be wrapped in cxc receipt and must retain their true label.

C: final head matches hosted run headSha; successful required jobs and skipped jobs recorded individually. D: finish handoff with source review gaps and Hermes field residual, no merge/issue closure. Parent decides integration.

Durable delivery: 060_handoff.md is the tracked safe index. Before any scratch cleanup, export exact final PR/head/CI and source-review evidence into the #4347 PR body, preserving parent annotations, and read it back. Terminal CI updates change that body only, so the verified source head remains stable. Private paths and raw security analysis never enter the public index or PR. Scratch is not the sole retained handoff.

Execution amendment: final evidence updates are committed on `codex/260912-60plus-cache-evidence` in the same managed worktree. This branch contains the tracked delivery artifact, with no new product logic. Product verification remains bound to the four delivered source heads, and the evidence branch's documentation checks are reported separately. Source-delta gating is not bypassed with a manufactured code change.
