# Plan exclusion completion

Built on already-landed #4238, independently from current dev d6fb87197a. Existing normalized predicate is shared with the account DTO; both preview and real automatic fallback reject excluded plans when no eligible account remains. Explicit account-qualified routes retain normal auth, pause and entitlement checks. Native main remains exempt.

CLI and dashboard display the policy's routing-plan reason separately from credential health and a possibly newer display-only plan. The automatic Set-as-next action is suppressed for excluded rows because pinning does not bypass this policy; explicit account-qualified routes remain available. All nine UI locale catalogs and eight affected integration guides are synchronized. Source ownership docs link the canonical plan-exclusion contract.

Regression sources cover all-excluded preview/resolve, renewal, explicit route with pause/reauth, API reasons, CLI normalization and card display/renewal. No new test file or dependency. Local suites/build/typecheck/install: NOT RUN. Hosted CI and rendered preview remain pending. Source searches: isCodexAccountPlanExcluded, getPoolAccountPlan, poolAccountDto, CodexAccountEntry, selection guards and excludedPlans docs; reused the existing predicate rather than a parallel policy.

Prior callback cycle delivered PR4352 and remains pending hosted verification. This is an independent dev PR, with no callback code and no manual chain dependency.
