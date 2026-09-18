# Eligibility hosted regression repair

Exact-head run34680496052 at a1f24df5ed90848f32d2499303b22620d91eed42 failed in Linux test4/4 job103523074988 and macOS2/2 job103523074889. The reset-ticket source oracle still required the old next-session guard without plan exclusion. The implementation correctly retained all health guards and added plan exclusion.

The oracle now also requires the plan-exclusion guard, preserving ticket co-render and all health checks. A rendered regression fixture confirms eligible accounts show next-session and tickets together; excluded accounts retain tickets and omit next-session. No production code changed. No assertion was removed or loosened. Local suites/build/typecheck/install NOT RUN; remote final-head verification follows.

Other failures in these runs concern Cline registry/localization/asset/test-layout and native history restoration. They are recorded in task scratch with exact job logs for owner integration; no other-lane files were changed. The parent-updated branch was fast-forwarded without rebase or merge commit. Hostgoal remains blocked and FSMB is unchanged; no new completed PABCD cycle is claimed for this source repair.
