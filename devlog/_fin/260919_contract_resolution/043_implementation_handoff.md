# Implementation landing and release handoff

All sixteen original implementation issues are closed. The final server/dashboard pair is #5185 (`e64d6994eb179dbc6f9e5c073bb1f110503a6247`) and #5197 (`ed44e04a933f6d4d62d2e049bf7606f08d347b06`). The latter's actual merge tree is `62883f3d4de5bc8c1cb3b1fe30aa8b04b5fb1ef5`, equal to inspected hosted checkout `600618e45242b88931d23bae8fe0e5e3f0576be2`. Dev ancestry was verified; #5118 closure was reread at2026-09-20T03:00:00Z.

The source repair at278513a79e matches the independently approved six-file diff. All six added aggregate/bulk regression cases passed in hosted gates106006865376. The v3 hosted GUI artifact10596691936 was driven through twelve baseline states and aggregate toggle, aggregate partial failure/retry, Aside-only/mixed bulk, all-refused and partial-success/stale/refusal flows. Fifteen PNG hashes and actual operation/fingerprint request traces were checked; main directly viewed the captures. Fixture servers and owned browser tabs were cleaned up. This is fixture-rendered GUI evidence, with separate hosted backend regression evidence; it is not a live-backend or assistive-technology claim.

## Explicit timing exception

The owner requested immediate merge and release after the remaining platform status was reported. The coordinator integrated the reviewed current head under that timing direction while macOS jobs in run35483995896 remained unfinished. The decision is recorded at https://github.com/lidge-jun/opencodex/pull/5197#issuecomment-5747175119. This is not a complete CI-pass claim. Full hosted regression and release verification remain required before publication, and the current goal is not complete.

## Non-blocking follow-up observations

- ConsequenceDialog contains nested live regions; announcement behavior should be checked and the status markup simplified in a follow-up. This head does not claim that change.
- The retained bulk-refusal test's final substring assertion is weaker than a notice-specific assertion. The implementation and actual v3 flow retain partial failure state, but that assertion should be strengthened in a follow-up.

## Next authorized work

Use the request-time main baseline134c92a01b120162f00c7275189cc47858720379 through the final integrated candidate for full hosted regression. Verify the repository's release/version ordering, promote through protected main/preview pull requests, publish through the canonical release workflow and verify the resulting registry/tag artifacts. Local suites, builds, installation and product runtime remain prohibited. Keep the heartbeat active through this follow-up and do not mistake sixteen issue closures for release completion.

Later verification: run35483995896 attempt1 completed SUCCESS at source278513a79e, including all event-applicable jobs and both macOS shards. The earlier integration timing exception remains a historical fact; the formerly pending source-PR platform checks are now complete. Full main-through-candidate regression, promotion and release remain separate follow-up work.

The still-open follow-up lives in [the regression and release unit](../../_plan/260920_regression_release/000_scope.md); this archive contains only the completed implementation record and its handoff.
