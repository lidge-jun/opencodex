# Explicit Reserve alongside independently routed models

Loop archetype: spec satisfaction. Trigger: original owner request2; grounded by installed Desktop/source findings in001. Consume runtime provenance and settings contracts. No installed application mutation, synthetic exhaustion or forged ordinary_usage_allowed. Existing authless config is the explicit user-selected client mode; never enable it automatically.

## Contract

NEW `src/codex/reserve-availability.ts`: memory-only, identity-generation-bound Reserve observation. The passive WHAM reader is insufficient: upstream backend-client/client/rate_limit_resets.rs:75 sends x-openai-codex-luna-reserve:1 only for capable clients. Use a dedicated bounded WHAM request with that header and an already-owned token/MainQuotaWriter; it introduces no credential-file reader. Require fresh matching identity, ordinary rate_limit.allowed=false, rate_limit_upsell.banner_type=luna_reserve, and exactly one additional entry limit_name=gpt-reserve with allowed=true. Reject contradictory explicit account/user identifiers. Missing/stale/failed observations never grant access. Cache at most60seconds in memory, share a bounded8second flight for the current identity, and isolate caller cancellation. No persisted entitlement grant or unrelated pool probing.

MODIFY `src/codex/quota.ts` WHAM types to retain the optional allowed/banner/identity fields and additional Reserve window shape without folding it into ordinary percentages. Field chain: authenticated WHAM input -> reserve parser/recorder with MainQuotaWriter -> memory observation -> fresh availability getter -> catalog and explicit-main request gate -> safe DTO. Ordinary quota parser stays ordinary; no new use of Reserve percentages in99% policy.
Keep the passive auth-api reader/cache unchanged; its only required edit is the recovery-scope allowlist below. The dedicated capability-aware request may publish its genuine ordinary quota through the existing parser/provenance setter, then the99% policy is rechecked before dispatch. Main identity changes invalidate Reserve observations through the existing generation API. Expose a safe status only if a real consumer needs it; no speculative DTO fields.

## Independent quota semantics

MODIFY `src/codex/routing.ts`:
```diff
-type CodexQuotaScope = 'shared' | 'spark';
+type CodexQuotaScope = 'shared' | 'spark' | 'reserve';
 const NATIVE_MODEL_QUOTA_SCOPES = {
   'gpt-5.3-codex-spark': 'spark',
+  'gpt-reserve': 'reserve',
 };
```
Creation: exact native wire model mapping. Serialization/deserialization: no persisted or JSON-decoded scope enum exists; scoped health/affinity and claims are process-local typed values. Consumers: global-first cooldown lookup, scoped health writes, affinity/pool cursor, probe claim/settlement and status/error formatting. Existing independent-scope predicates already cover non-shared; the two ordinary-recovery Spark exclusions become an explicit undefined/shared allowlist. The cooldown label table includes Reserve. No other blanket scope rewrite is needed.
Global Retry-After/default throttles remain account-wide and win over scope-specific evidence. A shared reset-derived cooldown does not imply Reserve exhaustion. Generic recovery claim and auth-api settlement currently exclude only spark; exclude reserve too so an ordinary success cannot clear Reserve health. Do not add an automatic Reserve recovery worker in this first slice.

## Catalog and exact request gate

MODIFY `src/codex/catalog/metadata.ts` observed account-native filter to preserve an actual full-shape gpt-reserve row despite supported_in_api=false, without relaxing other unknown models. Preserve raw upstream metadata; availability is a separate fact. Project only the configured main selector through `src/codex/catalog/account-models.ts` and existing catalog assembly owner, and only when fresh Reserve permission and explicit authless mode are active. Do not expose Reserve on added-account selectors or OpenAI API-key rows. If current source provides Reserve as a generated preset rather than a roster row, use only that source-defined preset after documenting its exact fields at the stale check; do not silently invent capability metadata.
MODIFY `src/codex/auth-context.ts`: exact main/gpt-reserve request must revalidate fresh owned Reserve availability before dispatch, keep main hard-lock/pause/reauth/global cooldown checks, and use reserve quota scope. Refuse missing grant with an actionable safe error. No fallback to normal Luna, another account or an external provider. Bare/automatic client handling stays outside the explicit compatibility contract unless the next P proves a necessary source-defined route.
Existing `src/router.ts` already accepts main/gpt-* namespaces; do not broaden all unknown bare routes. Existing `codexDesktopAuthless` injection disables the Desktop native Reserve-only picker gate, but also its automatic Reserve behavior. Document manual Reserve selection and restart requirement truthfully.

## Tests and public documentation

NEW focused Reserve tests in tests/codex-integration (register both layout manifests): positive/absent/stale/contradictory/identity-change grants, exact-main route, no native fallback, external model availability, main99 lock still wins, global throttle wins, shared reset-derived scope independence, ordinary recovery/success does not clear Reserve cooldown, catalog only observed/source-defined metadata and eligible main selector.
MODIFY docs-site English/Korean guides/codex-integration.md and structure/08_openai-provider-tiers.md: opt-in command, its native-account UI tradeoff, manual Reserve selection and upstream eligibility requirement. No new top-level toggle unless existing setting truly lacks a supported entrypoint.

Verification: source/built catalog and recorded-grant scenarios, static checks, exact-head CI, isolated mixed-picker projection. Live upstream Reserve success is not currently testable because no Reserve-active account was observed. Do not exhaust an account to manufacture it; label that live test unavailable, and never present it as passed. Stop/ask if implementation needs a materially different installed-app patch or unknown upstream permission. Scope/freshness/API details are revalidated in its own P before any code in this decade.
