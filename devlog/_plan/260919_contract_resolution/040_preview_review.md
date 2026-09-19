# Integration preview preparation review

Issue #5118 remains open and has not entered accepted implementation. Independent pre-build review found that the proposed planner must more precisely separate observation from mutation, bind every selected state input, and revalidate the bound operation before side effects. The owner received private source evidence and required roadmap corrections. Public detail is limited to the accepted product requirement: a value-free read-only preview, a complete state fingerprint, safe stale-plan refusal and unchanged authorized mutation semantics.

The server and confirmation-dialog layers both remain required. No local tests or runtime execution were performed, and no completion or disclosure of private review mechanisms is claimed here.

Visual-proof preparation revalidated against current CI and PR quality source: dashboard changes trigger the screenshot requirement by changed files. The CI preview artifact contains built static output and commit/tree fingerprints, not screenshots. Its workflow SHA can be the PR merge commit, so evidence must bind the artifact to the corresponding run/head and rendered tree. Owner was instructed to plan real browser capture without local builds, installation or proxy startup, and to keep visual evidence pending until actual capture exists.

Coordinator found that the transferred owner had copied detailed pre-build security working material into its local devlog while amending the plan. The owner was instructed to preserve those working copies in ignored scratch and retain only neutral public planning/status references before any publication. No such material was staged or published by this coordinator.

Verified that the transferred implementation owner preserved the full private planning copies under its ignored prebuild directory. The public campaign record remains neutral; detailed pre-implementation analysis was not added to the published checkpoint.

Draft server-layer [PR #5185](https://github.com/lidge-jun/opencodex/pull/5185) opened at `483ac7bc03271df71a92658d4664aa301ede7c73`, targeting dev. It currently contains only the common planning foundation and writer preflight extraction. Preview routes, fingerprint-bound mutation, profile adapters, regressions, ownership documentation and the dashboard child are explicitly incomplete. Coordinator attached the PR and assigned a bounded foundation review; no issue completion or merge readiness is claimed.

The draft foundation head483ac7 lacks the planned regression additions, so hosted hygiene correctly reports missing_regression_test. Owner was instructed to satisfy the planned meaningful coverage rather than waive the gate. Draft publication is not a verified standalone implementation layer.

Foundation review identified two required corrections before exposing the planner: completeness of state/eligibility fingerprinting and client-specific managed-path projection. Owner received precise source evidence in private working notes. Shared observation extraction otherwise preserves former mutation ordering, and explicit no-effects options avoid the inspected maintenance/recovery writes. The foundation is not accepted until the two corrections and regressions are reviewed.

Prepared foundation corrections8a6f7b4c95 and24a372dd41 bind the observed eligibility inputs and restrict projected paths to declared client templates. Independent re-review of the two original findings and their regressions was assigned at the immutable combined head. The remaining server/API, bound mutation, restore/profile and dashboard work remains required.

The two foundation production corrections passed re-review at24a372dd41. One coverage improvement remains: compare actual contribution-builder fragment paths against each client template rather than merely asserting template lists are nonempty. Current templates match source; the requested regression guards future drift. This does not replace the remaining preview/API/mutation/dashboard implementation.
