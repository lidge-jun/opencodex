/** ChatGPT/Codex wire id observed for the account-native Daybreak Blue surface. */
export const NATIVE_DAYBREAK_BLUE_MODEL = "gpt-daybreak-blue-latest";

/** Native ChatGPT/Codex ids whose availability is proven per authenticated account. */
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

export function nativeOpenAiCapabilitySourceSlug(slug: string): string {
  return NATIVE_OPENAI_CAPABILITY_SOURCES[slug] ?? slug;
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
 * `/models` roster to contain the slug. An unconfirmed or unentitled account never receives the
 * request. `disabledModels` remains the independent user visibility control.
 *
 * Devlog: 260816_codexrs_multiagent_v2_and_history_perf/011 §4-bis.
 */
export const NATIVE_OPENAI_MODELS = [
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  NATIVE_DAYBREAK_BLUE_MODEL,
];

export const SUPPORTED_NATIVE_OPENAI_SLUGS = new Set(NATIVE_OPENAI_MODELS);
