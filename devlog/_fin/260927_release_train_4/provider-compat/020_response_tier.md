# Phase 2 — relay response-tier evidence

Dependency: merged `wp1` and refreshed `origin/dev`. Source candidate: #5497 by @hulkbig, final reviewed head `1152e3c9fc2130a0518e4dc5c79de8f16505607b`. Class C3 for configuration, Responses observation and pricing persistence. The feature does not enable Fast, alter the outbound `service_tier`, or decide a provider's actual bill; it marks whether a *response echo* is proof.

## Exact change map

| Path | Action | Before → after |
| --- | --- | --- |
| `src/types/provider.ts` | MODIFY | Add optional `responseTierAuthoritative?: boolean` to `OcxProviderConfig` and `AttemptTierOutcome`. Absent retains existing relay authority. Canonical ChatGPT forwarding stays observational even if a user sets `true`. |
| `src/config/schema/leaf-validators.ts`, `src/server/auth-cors.ts`, `src/providers/model-rename-fields.ts` | MODIFY | Validate a real optional boolean, admit it to the provider editor DTO/policy, and classify it as a non-model-keyed provider field during rename. Reject `"false"`, `0`, `null`, or object rather than silently changing meaning. |
| `src/providers/openai-tiers-destination.ts` | MODIFY | Add `responseTierAuthorityForProvider(provider)` returning `false` for canonical ChatGPT-forward destination and the declared boolean otherwise. Keep current `isCanonicalOpenAiForwardProvider` destination test and unrelated service-tier support logic. |
| `src/server/responses/core-normalize.ts` | MODIFY | Replace the current one-off `isCanonicalOpenAiForwardProvider(route.provider) ? false : undefined` observation argument with `responseTierAuthorityForProvider(route.provider)`. The final routed provider, not requested alias, owns the decision. |
| `src/providers/fastwire.ts` | MODIFY | Carry `context.responseTierAuthoritative` into the attempt outcome only when defined. Preserve raw sanitized response echo and current request decision logic. |
| `src/usage/log.ts` | MODIFY | `normalizeAttemptTierOutcome` validates, retains and rehydrates the optional boolean. Old records without it continue reading with legacy semantics. |
| `src/usage/cost.ts` | MODIFY | `serviceTierContextFromOutcome` consults raw `responseServiceTier` only when `responseTierAuthoritative !== false`. A non-authoritative echo remains in logs, while an eligible requested priority tier remains an assumption for an estimate. A local unsupported-route downgrade still stays downgraded. |
| `tests/routing/fastwire-response-authority.test.ts` | NEW | Copy the final candidate test from `1152e3c9fc21:tests/routing/fastwire-response-authority.test.ts` as the starting fixture, then adapt current test contracts. It covers JSON/SSE relay and official API sends, raw echo, assumption versus downgrade, persisted attempt/final entries, editor redaction, malformed config and pricing. |
| `tests/providers/model-rename-migration.test.ts` | MODIFY | Assert provider rename keeps the optional field with provider scope and never treats it as a model-keyed map. |
| `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` | MODIFY | Add the new routing test file to both explicit maps. Do not change file-size caps. |
| `structure/config.md`, `structure/providers-and-adapters.md`, `structure/runtime.md`, `structure/transports/responses.md`, `structure/gui-and-management-api.md` | MODIFY | State the optional observation policy, final-route ownership, log/price provenance and editor field round trip. Update only currently true statements; keep core routing and tier request policy intact. |
| `docs-site/src/content/docs/guides/codex-integration.md`, `docs-site/src/content/docs/reference/configuration/providers.md`, `docs-site/src/content/docs/zh-cn/reference/configuration/providers.md` | MODIFY | Explain the optional relay declaration, known canonical exception, raw echo versus confirmed grant and pricing estimates in English and directly affected translation. No promise that the relay bills at priority. |

This is one PR and one atomic runtime contract. Do not split observation from cost: current `src/usage/cost.ts:441-450` otherwise turns the raw echo back into pricing confirmation. Do not carry unrelated changes from the older branch blindly; compare every hunk with current `dev` before applying. Search the provider field name, the outcome field name and both boolean values across config serialize/deserialize, editor, rename, route, log and cost consumers. Creation: JSON/editor provider input. Serialization: saved provider config and attempt log. Deserialization: leaf validator and usage entry normalizer. Consumers: final route observation, Fastwire tracker, tooltip/price estimate. No new enum value is added.

## Activation and observable checks

1. Relay with declaration `false`, eligible outbound priority request, response echo `default`: outbound wire remains priority, attempt is `applied/assumed`, raw echo remains `default`, no response-declined downgrade or confirmation in price provenance. Trigger in both JSON and SSE fixtures.
2. Same relay with response echo `priority`: still `assumed`, because the echo cannot prove a granted tier. This protects cost from a false confirmation.
3. Absent or `true` declaration with the same echo: legacy authoritative judgment is unchanged. Canonical ChatGPT forwarding remains observational even when the declaration says true.
4. Malformed value fails config validation; provider editor round-trips a valid value without returning the API key. Persisted new record retains the flag; old record lacking it remains readable.
5. Unsupported Fast route stays downgraded even when `false` is declared. The field cannot manufacture capability.

## Verification

Run `bun test tests/routing/fastwire-response-authority.test.ts tests/routing/fastwire-observability.test.ts tests/providers/model-rename-migration.test.ts tests/providers/provider-config-validation.test.ts tests/usage/usage-cost.test.ts tests/usage/cost-cap-unknown-evidence.test.ts`; these direct paths exercise the changed route, config and cost contracts. Also run `bun run test:changed`, `bun run typecheck`, `bun run privacy:scan`, `bun run structure:check`, `git diff --check`, and the docs-site frozen-install/build required by `docs-site/AGENTS.md`. The test fixture has a fake relay; it is not live evidence of a particular provider's billing. Record the resource exception for the local full suite and rely on completed exact-head required CI before merge. The PR credits @hulkbig with a `Co-authored-by` trailer, targets latest `dev`, and gets an independent review of the full current-dev diff.

## wp2 P stale check (2026-09-28)

Previous D (wp1): #6097 head `ad40e8d46a` verified (focused 19/19, `test:changed` 2,619 pass / 1 skip / 0 fail, sol security PASS); merge waits on exact-head CI. Direction kept: carry #5497 next.

A sol explorer re-mapped PR #5497 head `1152e3c9fc21` onto `origin/dev` `24b2f39b77`. No hunk is obsolete; the old docs anchors moved. Findings that amend the change map above:

- `src/providers/fastwire.ts:398` already reads `context.responseTierAuthoritative !== false`; the carry only copies the defined flag into `AttemptTierOutcome` near line 341.
- Context conflicts only (newer `fastEnabled` neighbours): `src/config/schema/leaf-validators.ts:299`, `src/server/auth-cors.ts:975` (editor roster is exhaustive at 1104; classify `"editor"`), `src/usage/log.ts:658,680`, `src/providers/openai-tiers-destination.ts:26`, `src/server/responses/core-normalize.ts:20`.
- `src/providers/model-rename-fields.ts:18` needs the field as provider-scoped `"none"`; its role union is exhaustive at 141.
- None of the grown files is listed in `tests/fixtures/file-size-baseline.json`, so no ratchet cap applies. The new `tests/routing/fastwire-response-authority.test.ts` needs both layout registries.
- Docs: English `reference/configuration/providers.md` (field row near 207; section before FastWire migration near 568, after the newer root `auto_review_model` section at 552), zh-cn providers (87, 175), and the Codex guide (134). `structure/gui-and-management-api.md` lost the old usage paragraph; place the note near lines 223/231.

Existing-user contract: omission keeps legacy authoritative relay semantics; canonical ChatGPT forwarding stays observational even with `true`; `false` changes evidence and pricing only, never the outbound tier or a local unsupported-route downgrade.

Audit amendment (sol reviewer, NEAR-PASS): `serviceTierContextFromOutcome` in `src/usage/cost.ts:441` checks the `canonical === "priority" && confirmation === "confirmed"` branch before the raw echo, and `normalizeAttemptTierOutcome` (`src/usage/log.ts:635`) does not tie the new flag to `confirmation`. The carry therefore gates **both** branches on `responseTierAuthoritative !== false`, as #5497's cost diff does, and the fixture covers a persisted record whose flag is `false` while `confirmation` says `confirmed`. No GUI, dashboard, usage-summary or CLI consumer needs a change: they read the outcome through the shared cost path.
