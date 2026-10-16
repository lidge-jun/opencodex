# wp2 — Codex GPT-6.1 Sol 500k default context (native route)

Evidence: Tibo Sottiaux (OpenAI) 2026-10-11 https://x.com/thsottiaux/status/2109430343346581527 — default
context for GPT-6.1 Sol through Codex & Work raised to 500k from 272k; overrides still allowed; GPT-6.1 Sol
max context 1M. The bundled codex-rs catalog (main d63a9b8344) still ships 272000/872000.

Why a code change is needed: src/codex/catalog/metadata.ts:206 pins gpt-6.1-sol to NATIVE_GPT6_CONTEXT
(272k/872k/872k, native-models.ts:67), and live roster discovery excludes built-in natives
(native-models.ts:274, discovered-natives.ts:54), so no roster value can raise it.

Changes:
- MODIFY src/codex/catalog/native-models.ts: NEW export NATIVE_GPT61_SOL_CONTEXT = Object.freeze({
  ...NATIVE_GPT6_CONTEXT, contextWindow: 500_000 }) with the source comment; refresh comments at :47/:63.
- MODIFY src/codex/catalog/metadata.ts:205-206: gpt-6.1-sol uses NATIVE_GPT61_SOL_CONTEXT (import added).
  The configured-native fallback (:665) keeps NATIVE_GPT6_CONTEXT; gpt-6-sol/luna/astra unchanged.
- Max/input ceiling stays 872,000: the announcement gives "1M max" without the native field mapping;
  the existing contract couples maxContextWindow with maxInputTokens, so 1M would assert an unverified
  input allowance. Documented as a deliberate conservative limit.
- Projection: default row becomes context_window 500000, max_context_window 500000 (narrowed by
  parsing.ts:506-538), auto_compact_token_limit 450000; long-window opt-in tier 872k. parsing.ts:560
  discards a retained 244,800 threshold from the old window. Explicit user overrides keep winning.
- Pricing unchanged: native-route spend estimates are API-reference by documented policy
  (structure/catalog.md:333); the subscription no-long-context-fee statement does not alter that.
- API-key/reseller rows unchanged: openai-apikey 1,050,000 (entries-core.ts:701-708), kiro 272k,
  codebuddy 1M — none share the native constant.
- Tests: tests/codex-integration/gpt61-sol-rows.test.ts (effective tier 500k/872k; built row
  500k/500k/450k; lower override, long opt-in, provider cap, configured compaction; retained-row
  272k/244,800 -> 500k/450k); tests/codex-integration/gpt6-native-rows.test.ts (Sol/Luna/Astra stay
  272k/872k); tests/codex-integration/discovered-native-models.test.ts (a 500k/1M gpt-6.1-sol roster row
  still cannot overwrite built-in metadata); tests/claude-integration/claude-desktop-native-context.test.ts
  (native gpt-6.1-sol 500k). No additions to codex-catalog.test.ts (cap 7985).
- Docs: structure/catalog.md:321 (600-line budget; reflow in place) and
  docs-site/src/content/docs/reference/configuration/providers.md:149.


## Audit (Lagrange) NEAR-PASS — residuals folded
- Overrides: user/provider overrides keep precedence but are clamped to the 872k ceiling
  (metadata.ts:328-335); a 1M override resolves to 872k by design. Tests: per-model > provider override,
  provider cap, 1M -> 872k.
- Persisted cache: retained-row coverage goes through mergeCatalogEntriesFromObservedState
  (build-entries.ts:887-890) for bare and account-qualified rows, 272k/244,800 -> 500k/450k, and an
  explicit 272k override keeps 244,800.
- Desktop: assert the GPT-6.1 Sol DTO carries 500k and the generated supports1m behavior
  (claude/desktop-3p.ts:179, :218-224) rather than model existence alone.
