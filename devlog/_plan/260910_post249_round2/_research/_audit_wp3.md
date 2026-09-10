Read-only audit of #4156, #4158, and #4160 against `devlog/_plan/260910_post249_round2/`. Local product tests were not run.

## #4156 — #3666 free-only filter

Chosen fix matches the plan. `discoveredPricingStatus` reads provider `pricing.prompt|input` and `pricing.completion|output`, classifies only a complete non-negative numeric pair, and treats everything else as unknown. A `:free` suffix is ignored. `modelCosts` is still only a `manualPricing` marker and never feeds the classifier.

Unknown is omitted from `CatalogModel` (`pricingStatus?: "free" | "paid"`) instead of stored as `"unknown"`. Callers treat absence as not-free, which keeps the fail-closed rule and the existing deep-equal hint tests.

Filter order is correct on both surfaces: free-only runs, then search/sort, then `PAGE` / `CHIP_RENDER_CAP`.

**SHOULD-FIX** `gui/src/pages/Models.tsx:1405` and `:1475` — group header still counts `rows` / `activeCount` from the unfiltered set. Plan 050 said counts and empty states read the filtered set. Empty state does (`:1681`); the header does not.

**NOTE** `tests/gui/models-free-filter.test.ts:26` — pins the shared predicate, not `renderGroup` / `ProviderModelInventory` slice order. A later change that filtered after `slice(0, PAGE)` would still pass this file. Source order is correct today (`Models.tsx:1427-1435`, `ProviderModels.tsx:85-87,267`).

**NOTE** `src/codex/catalog/parsing.ts:158` — plan wrote `pricingStatus: "free" | "paid" | "unknown"`; the field is omitted when unknown. Behavior matches fail-closed.

Named classifier cases are present and would be red without the change: zero strings free (`catalog-free-pricing-status.test.ts:24-28`), priced pair paid (`:35-38`), Ollama unknown/absent (`:47-52`), one-sided/negative/non-numeric (`:55-70`), `:free` suffix not evidence (`:79-86`). Wire coverage landed here via `listManagementModelRows` rather than `tests/server/model-costs-management-api.test.ts`. No existing “must stay green” assertion was deleted.

## #4158 — #4075 discovery-dependency hint

Chosen fix matches. A failed group with rows now renders `DiscoveryDependencyHint` (`Models.tsx:1672`). The copy interpolates `pws.liveModels` (`models-provider-hints.tsx:54`) and navigates with `navigateHash("providers")` (`:55`). `models.discoveryFailedDependency` exists in all nine locale catalogs. Hint children are element-wrapped, so the header-child rule in `gui/tests/models-provider-head.test.ts` is not broken.

The named regression is in `gui/tests/models-discovery-failed-hint.test.tsx:123-139` (badge + new sentence + control name + settings link on a failed group with a row). Those assertions would be red without the hint. Healthy / missing discovery cases stay silent (`:141-151`). Plan asked for `tests/gui/` plus layout.json; the file sits next to the existing happy-dom harness under `gui/tests/` instead, which is the right place for a page mount.

**NOTE** this PR’s GitHub diff also includes `tests/codex-integration/catalog-free-pricing-status.test.ts` because #4158 is still based on `f4fae62ef` (first #4156 commit), while #4156 HEAD is `3ff57ce49`. That is stack drift of the #3666 wire-pin follow-up, not a #4075 plan miss. No #4075 “must stay green” test was weakened.

## #4160 — #3859 email mask toggle

Chosen fix matches, and the privacy default is not widened. `privacy.maskEmails` omitted/`true`/malformed stays masked; only literal `false` unmasks (`privacy.ts:22-23`, `config.ts:1151`). `getLoginStatus` takes a boolean and defaults to masked, with no config I/O (`oauth/index.ts:1816`). `oauth-account-routes` passes `emailMaskingEnabled(config)` and does not remask (`oauth-account-routes.ts:240,276`).

Existing masked assertions still assert the masked form:

- `tests/codex-integration/codex-auth-api.test.ts:1281-1305`
- `tests/oauth/oauth-status-privacy.test.ts:55-70`
- `tests/oauth/oauth-accounts-api.test.ts:260-269` (untouched)
- `tests/oauth/oauth-login-summary.test.ts:17` (untouched)
- `tests/cli/cli-status-oauth-health.test.ts:113` (untouched)
- `tests/gui/provider-workspace-auth.test.ts:51` (untouched)

Opt-out is new cases, not a rewrite of those (`oauth-status-privacy.test.ts:81-100`, `codex-auth-api.test.ts:1313-1358`).

The one rewritten test is the source-contains pin the plan already called brittle (`codex-auth-api.test.ts:5825-5834`). It now requires `projectEmail(..., maskFlowEmails)` at both login-status boundaries and forbids spreading raw `st.email`. That preserves the guarantee instead of deleting it.

**NOTE** `src/codex/auth-api.ts:2748` still calls `getLoginStatus("chatgpt")` with the default mask. That poll only reads `done` / `loggedIn`, so it is not a disclosure path.

No BLOCKER on this privacy surface: default remains masked, malformed values fail closed, tokens stay redacted on the unmask path.

## Lane A disjointness

None of the three diffs touch `src/server/responses/core.ts`, `src/claude/inbound.ts`, or `src/service.ts`.

#4156 PASS
#4158 PASS
#4160 PASS
