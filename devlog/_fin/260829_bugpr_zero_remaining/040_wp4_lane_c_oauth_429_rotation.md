# wp4 — OAuth 429 rotation closeout

The stale #2807 branch was replaced by #2841, which landed the OAuth-origin rebind on
current `dev`; #2807 was closed as landed with a cross-reference. Independent review then
found three additional cross-account origin sites and found that caller credentials could
share the operator account's `__main__` health state. An invalid caller token could
therefore mark the operator's own account as needing reauthentication.

Those defects were repaired and regression-tested before closeout. The tests were checked
for anti-vacuity by restoring the faulty behavior and confirming that the focused
regression turned red. The separate #2852 follow-up belongs to the shadow-call lane and is
recorded in `060_wp6_lane_e_prless_bug_issues.md`.

This was a credential surface. The technical findings were posted publicly as review
comments and fixed, but the merge did not receive a formal non-author approval because all
available credentials authenticated as the repository owner. That remains a governance
gap rather than a satisfied review gate.
