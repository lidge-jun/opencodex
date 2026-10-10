# Moving-base quota provenance integration

Parent03ee2f119 had no Cross-platform CI run because newer dev changes conflicted in quota.ts and quota-auto-refresh.ts; only target/label/hygiene workflows appeared. Merge-tree against fresh dev808b3dca3 verified the conflict rather than treating missing CI as green or queued.

Rebase preserves dev's shortObservedAt provenance: fresh short usage stamps it; partial/credits-only writes keep it. The hard-lock merger still preserves a known short tuple when usage is unknown, and the policy disk decoder retains the new nonnegative timestamp without using age to silently release99. Canonical auto-refresh markers remain epoch milliseconds with legacy seconds normalization. The existing state leaf/public exports remain intact.

Own regression expectations are aligned with these new contracts, retaining exact assertions and seconds-input/milliseconds-output controls. Reserve's later quota-types extraction must retain shortObservedAt. No local suites; a new mergeable current-head CI run and source re-review are required before any merge.

Averroes source and five-file test-expectation re-review PASS, blocking_issues0. Root TypeScript and diff checks passed. No test execution occurred locally; freshness/carry/hydration and canonical marker behavior still require current-head CI.
