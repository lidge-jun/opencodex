/** Reserve wire identity, not a globally available native catalog registration. */
export const NATIVE_RESERVE_MODEL = "gpt-reserve";

/** ChatGPT/Codex wire id observed for the account-native Daybreak Blue surface. */
export const NATIVE_DAYBREAK_BLUE_MODEL = "gpt-daybreak-blue-latest";

/**
 * SHIPPED as of 2026-09-03: openai/codex `ed391d4dd` (#42607, bundled model catalog) and
 * `1f7b99922` (#42619, Amazon Bedrock catalogs). The registration is no longer speculative —
 * `src/codex/data/upstream-models.json` now pins the real row, so this slug is SELF-DESCRIBED
 * and must not borrow another model's capability metadata.
 *
 * Still NOT wire-normalized: unlike Daybreak the slug IS the wire id.
 *
 * Deliberately NOT account-gated (owner decision, 2026-09-04, reaffirmed during rollout).
 * Upstream `available_in_plans` lists 23 plans including `free`, but the model is rolling out,
 * so a given account's Codex surface may still answer
 * `"The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account."`
 * — the same refusal Daybreak returns. Gating on an entitlement roster would hide the row until
 * that roster catches up; listing it means the request dispatches and the real upstream status
 * is what the user sees. Evidence: devlog/_plan/260904_astra_release_alignment/021.
 */
export const NATIVE_GPT6_ASTRA_MODEL = "gpt-6-astra";

/**
 * Native ChatGPT/Codex ids whose availability is proven per authenticated account.
 *
 * Membership is expensive: it hides the row from the catalog, `/v1/models`, the dashboard and
 * the desktop projection until an authenticated `/models` roster confirms it, AND it makes
 * `auth-context.ts` refuse the request before it is sent. Both halves fail closed on ABSENCE of
 * evidence, not on a denial.
 *
 * The flagship models are deliberately NOT here (owner decision, 2026-09-04). #3442 made
 * discovery ask upstream under an adequate client version, which guarantees the QUESTION is
 * fair but cannot guarantee an ANSWER: an unconfirmed account, a timed-out fetch, or a shard
 * that has not caught up all produce the same silent disappearance, and a model vanishing from
 * the picker reads as "opencodex lost my model" rather than "upstream did not confirm it".
 * Listing them unconditionally means the request dispatches and the user sees the real upstream
 * status. `disabledModels` remains the visibility lever.
 *
 * The cost, accepted knowingly: Pool routing no longer prefers an account that owns the model,
 * so a multi-account user may take one upstream 400 and one alternate retry where they used to
 * be routed straight to the owner. Nothing unsafe — each account still sends its own credential
 * — and `gpt-6-astra` has shipped this way since 6f634eddc.
 *
 * `gpt-daybreak-blue-latest` stays gated. It has no shipped catalog row anywhere, so absence is
 * the only signal that exists for it, and the ungating decision was scoped to the flagships.
 * Evidence: devlog/_plan/260904_flagship_native_always_visible/.
 */
export const ACCOUNT_GATED_NATIVE_OPENAI_MODELS: ReadonlySet<string> = new Set([
  NATIVE_DAYBREAK_BLUE_MODEL,
]);

/**
 * Account-native aliases whose Codex capabilities track another pinned native row.
 *
 * This is catalog metadata inheritance only. Routing always preserves the requested
 * wire id for the separately billed API-key `daybreak-*-latest` surface, so the two never
 * collapse into each other.
 *
 * The ChatGPT/Codex surface is different: an account-gated request IS rewritten to its
 * canonical wire model before it leaves the process (`applyCodexAccountGatedWireNormalization`
 * in src/server/responses/core.ts), because the authenticated backend rejects the gated slug
 * on shards that do not carry it. The catalog keeps the product identity; only the wire moves.
 */
const NATIVE_OPENAI_CAPABILITY_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  [NATIVE_DAYBREAK_BLUE_MODEL]: "gpt-5.6-sol",
});

/**
 * Native slugs that carry their OWN pinned upstream row rather than an alias's borrowed one.
 *
 * Membership authorizes `upstreamNativeEntryForSlug` to return the pinned entry directly. It is
 * an explicit list, not a structural `PINNED_UPSTREAM_MODELS.has(slug)` predicate: the pin also
 * holds `gpt-5.5`, `gpt-5.4` and `gpt-5.4-mini`, and admitting those into
 * `UPSTREAM_NATIVE_ENTRIES` would newly authorize replacing their persisted catalog rows during
 * sync — an invariant that map's own comment reserves for the GPT-5.6 family.
 */
export const SELF_DESCRIBED_NATIVE_OPENAI_MODELS: ReadonlySet<string> = new Set([
  NATIVE_GPT6_ASTRA_MODEL,
]);

/**
 * Native ids whose capability metadata is inherited from another pinned native row.
 *
 * Membership here is about METADATA INHERITANCE only, and is independent of whether the
 * slug is also present in `NATIVE_OPENAI_MODELS`. `gpt-daybreak-blue-latest` is now in BOTH:
 * it inherits Sol's capability shape AND is a supported account-gated native id (owner decision,
 * devlog 260816_codexrs_multiagent_v2_and_history_perf/011).
 *
 * The maps that consume the union of these two lists (`PINNED_NATIVE_CAPABILITY_ENTRIES`,
 * `UPSTREAM_NATIVE_ENTRIES`) are keyed by slug, so an overlapping id collapses to one
 * entry. Catalog row generation iterates `NATIVE_OPENAI_MODELS`, then entitlement evidence limits
 * it to at most one bare row and one row per entitled account selector.
 */
export const NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS = Object.freeze(
  Object.keys(NATIVE_OPENAI_CAPABILITY_SOURCES),
);

export function isNativeOpenAiCapabilityAliasModel(slug: string): boolean {
  return Object.hasOwn(NATIVE_OPENAI_CAPABILITY_SOURCES, slug);
}

/**
 * Native slugs whose Codex-forward CUSTOM row inherits authoritative native metadata.
 *
 * Two shapes qualify and the distinction matters only to `upstreamNativeEntryForSlug`:
 * a capability ALIAS borrows another model's pinned row, while a SELF-DESCRIBED native has its
 * own. Every consumer that asks "does this custom row get real native capabilities and a real
 * product label" wants both, which is why they call this rather than the alias check —
 * `gpt-6-astra` stopped being an alias when its own row was pinned, and gating on
 * `isNativeOpenAiCapabilityAliasModel` alone would have silently demoted it to a bare-slug label
 * with no inherited ladder.
 */
export function hasNativeOpenAiCapabilityMetadata(slug: string): boolean {
  return isNativeOpenAiCapabilityAliasModel(slug) || SELF_DESCRIBED_NATIVE_OPENAI_MODELS.has(slug);
}

export function nativeOpenAiCapabilitySourceSlug(slug: string): string {
  return NATIVE_OPENAI_CAPABILITY_SOURCES[slug] ?? slug;
}

/**
 * Presentation identity per capability alias. Capability metadata (context, ladder, modalities)
 * is inherited from the source model; the NAME and description are the alias's own product
 * identity — hardcoding one alias's label would present every other alias as the wrong product.
 */
export const NATIVE_OPENAI_ALIAS_PRESENTATION: Readonly<Record<string, { displayName: string; description: string }>> = Object.freeze({
  [NATIVE_DAYBREAK_BLUE_MODEL]: {
    displayName: "Daybreak Blue",
    description: "Frontier general-purpose model with safeguards for defensive cybersecurity work.",
  },
});

export function nativeOpenAiAliasPresentation(slug: string): { displayName: string; description: string } | undefined {
  return NATIVE_OPENAI_ALIAS_PRESENTATION[slug];
}

/**
 * Native OpenAI model ids that this release can route and restore with authoritative metadata.
 *
 * `gpt-daybreak-blue-latest` is entitlement-gated upstream: it is absent from codex-rs's
 * bundled catalog and reaches a client only through an authenticated `/models` response.
 * It is listed here by explicit owner decision so the capability template exists without waiting
 * for an observation, because opencodex injects `model_catalog_json` and codex-rs therefore builds
 * a `StaticModelsManager` whose refresh is a no-op — an entitled account had no way to
 * discover it on a clean install.
 *
 * Availability is not static: catalog sync and Pool routing require the account's authenticated
 * `/models` roster to contain account-gated slugs. An unconfirmed or unentitled account never
 * receives the request. `disabledModels` remains the independent user visibility control.
 *
 * Devlog: 260816_codexrs_multiagent_v2_and_history_perf/011 §4-bis.
 */
export const NATIVE_OPENAI_MODELS = [
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  NATIVE_DAYBREAK_BLUE_MODEL,
  NATIVE_GPT6_ASTRA_MODEL,
];

export const SUPPORTED_NATIVE_OPENAI_SLUGS = new Set(NATIVE_OPENAI_MODELS);

/**
 * Natives that retain the physical main account as a read-free sentinel during a native-main
 * drain, instead of reading as unavailable and letting the subagent fallback chain advance.
 *
 * This used to be spelled `ACCOUNT_GATED_NATIVE_OPENAI_MODELS`, which was never what it meant:
 * the sentinel protects the atomic main claim so a routed fallback cannot bypass it, and that
 * has nothing to do with entitlement. The two sets were identical in practice, so the accident
 * went unnoticed until the flagships were ungated (2026-09-04) and the predicate would have
 * flipped false — letting a drain silently rewrite the operator's configured subagent model.
 *
 * It is an explicit list rather than `SUPPORTED_NATIVE_OPENAI_SLUGS`, which would have widened
 * the sentinel to `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` and `gpt-5.3-codex-spark` as well. Those
 * models were never covered, and widening would turn "fell back and answered" into a
 * maintenance error for the most commonly configured fallback slug in the repo. Membership is
 * the set the drain behaviour was actually reasoned about: the account-gated natives plus the
 * flagships that just left that set.
 */
export const NATIVE_MAIN_DRAIN_SENTINEL_MODELS: ReadonlySet<string> = new Set([
  ...ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  NATIVE_GPT6_ASTRA_MODEL,
]);
