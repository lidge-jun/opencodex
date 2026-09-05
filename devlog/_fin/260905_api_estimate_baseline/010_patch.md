# API-only estimate baseline

Implementation record: focused checks 119 pass/0 fail; original baseline 118 pass/0 fail.
The three new policy scenarios were observed red before the table change, then green after it.
Typecheck/privacy/diff checks pass; docs build emits 425 pages. Direct production-estimator
invocation returned identical native/API costs (3.25 Standard / 6.50 Fast) for the documented
cache-heavy 300k fixture, with long-context classification and API cache-write pricing.
Consult the associated pull request for full-suite, current-head CI and landing status;
this implementation record does not certify that those stages have completed.

Review amendment: preserve `verified-derived` and an API-reference source on native Astra/Sol
rows, while API-key rows remain verified. Numeric API prices, Fast multipliers and long-context
bands remain identical. Regression assertions distinguish native estimate provenance from API
price verification, including normalized main/pool labels. No subscription billing rule returns.

C2 policy correction requested by the maintainer: all built-in display estimates use API pricing, not subscription credit conversion or subscription-only exceptions. No account settings, model metadata, provider destinations, releases or live services change.

Search/owners: `CODEX_FAST_CREDIT_MODELS`, `CODEX_PRICING`, `confirmedPriorityRelation`, `API-equivalent` in `src/usage/expected-prices.ts`, its request/attempt consumers in `cost.ts`, adjacent usage/FastWire tests, provider reference and catalog SoT. Delete the subscription overlay branch and reuse existing API declarations; no new abstraction or config switch.

File map:

- `src/usage/expected-prices.ts`: same verified Astra/Sol API tuples for both OpenAI identities; remove native 2.5x override; both identities use the existing API Fast map. Apply Astra >272k tier and Fast+long stacking to both identities, including both Daybreak Blue selectors. Preserve API-only virtual identities, other vendors and user override precedence.
- `tests/usage/usage-cost.test.ts`: identical native/API outcomes, raw-input boundary including cache, request/attempt/combo parity, API Fast+long composition and response-default precedence. Retain reseller and user-price negatives.
- `tests/routing/fastwire-observability.test.ts`: update only native Sol synthetic-price expectations from the subscription multiplier to API 2x; preserve attempt provenance assertions.
- `docs-site/src/content/docs/reference/configuration/providers.md`, `structure/03_catalog-and-subagents.md`: document one API-reference estimate policy; remove subscription-rate discussion from current behavior docs. Prior archived records remain history.

Verification: named usage/FastWire files, typecheck, privacy scan, docs frozen install/build, independent focused review, full suite on isolated macmini-cf checkout, current-head CI before authorized no-verify push/admin merge to dev. Verify merge SHA ancestry. No repository-wide suite on the workstation.

Source: https://developers.openai.com/api/docs/models/gpt-6-astra and https://developers.openai.com/api/docs/pricing (opened 2026-09-05 KST). Astra API 10/1/12.5/50 (input/read/write/output), long 20/2/25/75; Fast 2x applicable rates. This is a display-price policy, not a claim about a user's bill.
