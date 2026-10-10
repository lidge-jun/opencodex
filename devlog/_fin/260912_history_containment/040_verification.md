# Final evidence and Windows recovery disposition

MODIFY .tmp/history-lane/handoff.md with current branch/head, each original PR/issue disposition, carry URLs, exact hosted run IDs/results and remaining review/acceptance. No production change for #3522 without same-process evidence.

Read current #3522 comments and #3790 landed ancestry; inspect windows-secret-acl and responses/state recovery ownership. Compare alleged failure against existing tests without running local suites. Distinguish synthetic hosted Windows evidence from the reported live-process incident.

Run existing GitHub hosted CI against final carried tip(s), inspect failures with gh run view --log-failed, amend only justified defects, and repeat final-head CI when changed. Do not cancel workflows, change protections, or merge. Local tests/build/typecheck/install: NOT RUN. Text proof: git diff --check. Evidence JSON includes headSha, run id, event, status, conclusion and URL.
