# Final candidate verification

Depends on independent regression closure. NEW ignored candidate receipt JSON records the immutable
SHA, intended version, merged PR ledger, runtime delta and workflow observations.
MODIFY this unit with the GO/NO-GO decision; no unplanned product change belongs here.

1. Fetch dev, verify every scoped disposition and review thread after merge, and pin C.
   Inspect concurrent landed changes rather than silently adding an unreviewed release.
   C must match the regression-approved SHA. Any intervening product delta returns
   through affected regression checks and independent matrix review before candidate GO.
2. Run `gh workflow run ci.yml -R lidge-jun/opencodex --ref dev -f lane=all` only once
   the integration set is settled. Verify the created run's head SHA equals C. If the
   ref raced, preserve the receipt and obtain valid evidence for the actual candidate.
3. Observe run/attempt and jobs with bounded waits. Require Linux/macOS/Windows test
   shards, applicable package/keyring/helper jobs, docs/GUI/structure/privacy and
   desktop build proof. Record all skips distinctly. Use repository's existing
   `.tmp/train-recovery/verify-final-ci.py` only after inspecting its assumptions;
   otherwise inspect raw job and step data directly. The previous run is not proof.
4. Failure means a named repair task/cycle, regression evidence and rerun of affected
   coverage plus candidate consistency. Never increase caps or weaken assertions just
   to obtain green. Preserve the failed run and exact triggering command.
5. C is the code/version snapshot to promote. Later dev pre-move does not change C.
   Review the candidate-to-promotion delta and require only intentional version or
   history changes; additional product changes invalidate the candidate proof.

Existing #4956 is a CI-completion risk: an incomplete/hung required job blocks GO.
An issue remaining open alone is not a failed candidate. #6220/#6473 retain explicit
native evidence limits even if their administrative issue states are closed.

The final independent gate reads candidate SHA, coverage receipts, security dispositions,
remaining native limitations and source PR lineage. No GO with unresolved release blockers.
This full candidate run does not replace mandatory push-event CI on the main promotion SHA.
