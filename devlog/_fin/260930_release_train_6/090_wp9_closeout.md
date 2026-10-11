# wp9 — closeout

1. Dispatch Cross-platform CI with `workflow_dispatch` on the final dev tip; read every job; classify
   each failure (regression / flake confirmed by rerun / environment) and fix regressions via PR.
2. Close issues whose fix is on dev (#6237, #6197, #6162, #6013, #6242, #6244, #6139 per its evidence
   rule) with a comment naming the landing PR; #6093 and #5679 are closed during wp2 hygiene.
3. Write 091_outcome.md: what landed (PR, dev SHA), what was deferred and why, CI evidence, known limits.
4. Complete 021_merge_ledger.md; move the unit to devlog/_fin only after the outcome is recorded.


## Execution notes (P of wp9)

Continuity: wp2's D concluded that all 13 selected PRs are on dev with exact-head CI evidence (022). The final dev-tip Cross-platform CI run 36629963702 (workflow_dispatch, lane all, b78bfb8f00) failed:

- windows 8/9: two `packaged keyring native binding` tests from #6161 compute simulated POSIX layouts with the Windows host's path module. Regression in test portability, not in packaged runtime behavior. Fix: #6261 (target-platform path rules in `src/lib/keyring-native.ts`), to be verified by a full-matrix `workflow_dispatch` run on its exact head (36633279616); it merges only after that run's Windows shards complete successfully.
- macos 1/2: two tests fail after about 2 s (`a mode-0600 plugin with an everyone-write ACL is refused`, `a setup that resumes after its deadline cannot leave registrations behind`). Both received `directory_untrusted`, matching the plugin directory ACL subprocess timeout (`src/plugins/loader.ts` around lines 62, 130-137, 274-275); the 20 ms setup deadline in the second test was never reached. Suspected cause: ACL inspection timeout on a loaded runner. An identical-SHA re-run is diagnostic evidence of intermittence, not proof of cause; if it passes, the failure is recorded as a suspected ACL-timeout flake with a follow-up, and a repeat failure is investigated before closing c-4.

After #6261 lands, a new dev-tip workflow_dispatch run is the evidence for criterion c-4. Then close the remaining issue (#6242 and the others are already closed), write 091_outcome.md, and leave #6244 open with the owner question.
