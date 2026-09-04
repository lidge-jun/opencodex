# Astra parity implementation

Depends on verified evidence in `000_plan.md`; one work-phase, not separate backend/test/docs cycles.

## File-change map

- MODIFY `src/codex/data/upstream-models.json`: only Astra's Fast description `1.5x speed` -> `2x speed`, from current upstream. Keep existing pinned instruction bodies and local compatibility fields; a wholesale prompt refresh is outside configuration scope.
- MODIFY `src/codex/catalog/native-models.ts`, `metadata.ts`: remove obsolete leaked/not-shipped comments, preserve current visibility and context policy.
- MODIFY `src/providers/registry.ts`: add `gpt-6-astra` only to existing `openai-apikey` model seed, explicit context 1,050,000, max input 922,000 (window minus 128,000 output), text/image, API effort low/medium/high/xhigh/max. Do not invent `-pro`, ultra API effort, or third-party provider support. Existing native metadata remains separate.
- MODIFY `src/usage/expected-prices.ts`: Astra API verified and native verified-derived fallback tuples 10/50/1/12.5 in Cost4 order. Add provider-specific Astra Fast rules: native 2.5, API 2. Keep compatibility multiplier export API-oriented; native GPT-5.6 rules override to 2.5. Add only API Astra >272k rule; change API GPT-5.6 (including virtual variants) relation from exclusive to `stack`. Keep unrelated/native legacy context declarations unchanged.
- MODIFY `src/usage/cost.ts`: accept `stack` relation and apply Fast after the long band only for that relation in BOTH request and attempt estimators; preserve xAI lower-bound and legacy-exclusive semantics. Normalize wire alias `fast` with existing canonical tier helper for raw scalar and response provenance. Preserve response `default` overriding requested Fast and all user-price precedence.
- MODIFY adjacent `tests/usage/usage-cost.test.ts`, `tests/codex-integration/native-model-toggle.test.ts`, and `tests/adapters/openai/openai-api-virtual-models.test.ts`: pin independent price expectations, native/API distinction, API registry/catalog propagation, and native context invariants. Existing tests whose native Fast 2x expectation becomes wrong are updated with the new official 2.5x source; no deleted checks/skips.
- MODIFY `docs-site/src/content/docs/reference/configuration/providers.md` and `structure/03_catalog-and-subagents.md`: document native/API Astra identities, context and compaction controls, effort/tier config examples, and distinct pricing provenance. No other translated page currently documents Astra rates.

## Value chain and activation matrix

B alias/base verification exposed a stale nonzero generated Sol tuple (5/30 versus the independently verified current 4/20). Add provider-exact official Sol corrections via existing `VERIFIED_PRICE_OVERRIDES` for canonical native/API providers; do not edit generated vendor data or reseller rows. Existing custom-overlay test inputs remain unchanged; update the default shipped-rate assertion to the official tuple.

B review synthesis: accepted native Daybreak Blue mismatch (Medium). It aliases Sol and shares its native credit rates, so include it in the 2.5x native rule and test alias/base equality; API alias and compatibility export remain 2x. Unchanged legacy rules retain their original source/date rather than claiming fresh verification.

B propagation amendment: trusted API reconstruction discards prior Fast hints. Reapply only Fast capability/description after reconstruction from the already-captured provider authority, not the mutable registry and not all user hints (which would override trusted modality/effort policy). This covers reconstructed missing rows and explicit false overrides. Add positive/negative emitted-row assertions; no new service-tier permission.

B evidence amendment: the API snapshot omitted registry `modelMaxOutputTokens`, so Astra's explicit output ceiling vanished in trusted reconstruction (new test red). Add that optional map to `CatalogTrustedOpenAiApiPolicySnapshot` in `src/codex/convergence-types.ts`; capture/freeze it with sibling maps in `provider-fetch.ts` and pass the authoritative value to `routedMaxOutputTokens`, which preserves smaller user limits. The whole policy is included in existing canonical identity serialization; no external deserializer exists. Test actual gather/emitted rows plus configured lower ceiling. Also use the actual native opt-in key `providerContextCaps.openai`, not a new boolean.

A review synthesis: accepted the single Medium finding. Virtual `gpt-5.6-{sol,terra,luna}-pro` retains its selected ID in usage, so the implementation must add explicit API-only 2x Fast rules for those IDs with base-mapping provenance; test short/long request, attempt and combo pricing and negative native/reseller rules. Main verdict: near-pass with this concrete amendment; no unresolved blocker. Also seed explicit Astra max-output 128000 through the existing registry field.

Inventory amendment (independent reviewer, upstream SHA above): also MODIFY `src/codex/catalog/provider-fetch.ts` to pass `comboNativeLimits` into the native-alias max-input fallback; MODIFY `parsing.ts` to clear native `multi_agent_reasoning_effort` for unrelated routed rows; MODIFY `effort.ts` to preserve the pinned Fast description for canonical native-forward custom rows unless an explicit description is supplied. Extend `tests/codex-integration/codex-catalog.test.ts` for alias opt-in/caps/explicit target limits, custom-forward vs unrelated routed effort isolation, and speed copy. Persisted same-label Astra rows need a field-only repair of the exact old built-in Fast description at the existing native metadata application point; preserve custom descriptions and other row fields. No wholesale prompt migration, since prompt refresh is not configuration. Normal current Codex already maps Ultra to pinned xhigh; raw-client effort mapper changes are out of scope.

`ContextTier.confirmedPriorityRelation` is an internal compiled declaration, not serialized or user-configured. Creation: `CONTEXT_TIERS`; consumption: `applyContextTier` and request/attempt priority choice in `cost.ts`; deserialization N/A. New `stack` is read through the owning exact provider/model rule. No new external field or enforcement layer.

API model creation: registry -> provider derivation -> discovery metadata -> catalog normalization -> emitted JSON and picker/model-list consumers; existing config parser accepts model maps, no enum extension. Native config selection goes through existing native set, metadata and sync. Tests must exercise derived/emitted rows, not registry literals alone.

Activation scenarios:

1. Native Astra at 272000, 272001 and 800000: flat nonzero API-equivalent estimate; Fast 2.5, derived marker; account-pool labels normalize correctly.
2. API Astra at 272000 vs 272001: whole-request long input/cache x2 and output x1.5; raw input includes cache (300k total, 200k cache-read, 20k cache-write).
3. API Astra and GPT-5.6 long + response-confirmed `priority`/`fast`: long tuple multiplied by Fast 2; request/attempt/combo agree. Requested/configured Fast uses existing estimate semantics; explicit response `default` suppresses Fast.
4. Third-party same slug receives no OpenAI Fast/context policy. User price overlays still win base rates. xAI unknown combined pricing stays a lower bound.
5. Native Astra catalog retains 272k default, 872k opt-in, cap/clamped auto-compaction and low-through-ultra; API Astra emitted row has independent limits/effort/Fast capability and no virtual rewrite.

Verification: baseline focused command already 121/0. Extend/run the named files; `bun run typecheck`; `bun run privacy:scan`; docs frozen install/build; full `bun run test` in isolated macmini-cf checkout using locked Bun runtime, then exact-head GitHub checks. Review every changed file; no live inference required for deterministic metadata/cost changes. Rollback is ordinary revert of this scoped commit, not user configuration rollback.
