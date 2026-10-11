# wp2 — merge train

Coordinator-only. Intake: no item enters wp2 in HANDOFF state (wp1 resolves them). For each PR in
the order in `000_plan.md`:

1. `gh pr view <n> --json headRefOid,mergeStateStatus,reviewDecision,reviews,statusCheckRollup` and
   `gh api repos/lidge-jun/opencodex/commits/<head>/check-runs`.
2. Fork runs in `action_required`: approve them (`pull_request` workflow, `contents: read`).
3. Gate, all on the current head: every required check completed successfully (the `ci` aggregate
   with its test shards executed, enforce-target, hygiene, react-doctor when triggered); skipped,
   cancelled, pending or older-head results do not count. Every active review finding is disposed:
   for #6203 and #6200 the `CHANGES_REQUESTED` P2 threads must be fixed and answered on the thread
   with the fixing commit; a maintainer change request that is not withdrawn blocks the merge.
4. C4 items (#6204, #6207, #6203, #6200, #6238, #6161, and any #6244 fix): an independent security review verdict is
   recorded in `021_merge_ledger.md` before merge.
5. Merge (squash; merge commit for #6204) as maintainer integration; record PR, head, CI run ids,
   review, method, resulting dev SHA.
6. Update downstream PRs that share files; re-read their CI.

Skip path: a conditional item (#6203, #6234, #6200, #6161, #6242; #6244 only if the owner decides a policy and a fix PR exists) that misses its gate within this
train is recorded as DEFERRED in the ledger with the unmet gate, its linked issue stays open, and
nothing in release notes or issue comments claims it fixed. Items after it in the hard order
(#6234 after #6203) are re-evaluated: #6234 does not depend on #6203's code and may proceed alone
if its own gate passes.


## wp2 cycle (retrospective gate audit)

Continuity: wp1's D concluded that all 13 selected items landed on dev while their lanes ran (merges were sequenced as each item cleared its gate, not in a separate cycle). This wp2 cycle therefore audits the merge train instead of performing it: for every landed PR, the merged head carries a completed successful `ci` aggregate with all four test shards executed (`.tmp/rt6/verify-ci.sh`), the merge commit is on dev (`.tmp/rt6/verify-ledger.sh`), security-sensitive items have a final APPROVE-SECURITY verdict, and each gate deviation is recorded in 021. Output: 022_ci_evidence.md. No design decision is made in this cycle, so no architect consultation was dispatched; an independent reviewer audits the evidence at A.
