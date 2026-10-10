# Policy input-boundary review

Maintainer re-review on f42d86fca identified two input-boundary corrections: raw numeric values outside0..100 must not become trusted policy after legacy clamping, and supplementary-only monthly usage cannot act as a governing monthly fallback. Keep legacy display/rotation parsing unchanged. The policy producer independently validates raw range and monthly provenance; invalid or empty filtered evidence retains an existing trusted block and is unknown when no trusted snapshot exists.

Equivalent WHAM/header regressions are required alongside valid monthly-only/primary-monthly controls and the existing99→invalid→0/rearm contract. No local suites. Root/focused TypeScript and independent review precede the parent push; both upper layers must cascade and every changed head must pass CI before merge.

Independent source review found no production blocker, but identified an older provenance assertion expecting supplementary monthly in policy. Corrected it to require retained weekly99, absent policy monthly and preserved legacy monthly5; the subsequent primary-monthly replacement control remains intact. No assertion was weakened to accept the old false block.

Final Averroes re-review PASS, blocking_issues0. Root TypeScript plus the three affected test-file TypeScript checks, privacy scan and diff check passed. No local suite or test execution. The new parent commit requires fresh exact-head CI and upper-layer cascade.
