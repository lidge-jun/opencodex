# Authorized regression and release follow-up

Status: QUEUED after the current sixteen-issue implementation cycle. This is an authorization and scope record, not an executed release or a substitute for the next phase's detailed plan.

The maintainer explicitly requested full regression coverage from `main` through the final integrated changes, followed by `main` and `preview` promotion and a completed release. The existing no-local-suite restriction remains in force: full execution evidence must come from hosted CI. Existing commit/push conventions and protected-branch/release policies remain binding.

Request-time branch references:

| Branch | Commit |
| --- | --- |
| main | `134c92a01b120162f00c7275189cc47858720379` |
| preview | `48e1ddba0bb8da9ad39e32f8e20c1e4d7f1794da` |
| dev | `e64d6994eb179dbc6f9e5c073bb1f110503a6247` |

The immutable `main` baseline preserves the requested regression scope even if another authorized integration later advances a branch. The final target is captured after the campaign lands; no missing change may be dropped merely by choosing a newer comparison base.

At authorization time, the current work phase still needed to finish #5118 and its acceptance evidence. That implementation prerequisite is now complete; the still-open release work is tracked in [the separate plan unit](../../_plan/260920_regression_release/000_scope.md). After that cycle closes, the next Plan phase must inspect the current release authority, versions, branch ancestry and workflow inputs; write the complete regression/promotion/release plan; and register its remaining criteria before execution. Do not infer a release version or dist-tag before that inspection. Use the repository's required version ordering and promotion sequence.

Completion of the expanded request requires all original issue evidence plus the full regression result, verified `main`/`preview` promotions, release publication and post-publication evidence for the actual released version and commit. Keep those claims separate. The host goal must not complete at sixteen issue closures alone. Retain the heartbeat for the handoff and stop it only once all authorized follow-up work is verified.
