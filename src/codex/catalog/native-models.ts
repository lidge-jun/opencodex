/** ChatGPT/Codex wire id observed for the account-native Daybreak Blue surface. */
export const NATIVE_DAYBREAK_BLUE_MODEL = "gpt-daybreak-blue-latest";

/**
 * Account-native aliases whose Codex capabilities track another pinned native row.
 *
 * This is catalog metadata inheritance only. Routing always preserves the requested
 * wire id, so the ChatGPT/Codex `gpt-daybreak-*` surface never collapses into the
 * separately billed API-key `daybreak-*-latest` surface or into `gpt-5.6-sol`.
 */
const NATIVE_OPENAI_CAPABILITY_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  [NATIVE_DAYBREAK_BLUE_MODEL]: "gpt-5.6-sol",
});

/** Account-scoped native ids that may inherit metadata but never enter the bare allowlist. */
export const NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS = Object.freeze(
  Object.keys(NATIVE_OPENAI_CAPABILITY_SOURCES),
);

export function isNativeOpenAiCapabilityAliasModel(slug: string): boolean {
  return Object.hasOwn(NATIVE_OPENAI_CAPABILITY_SOURCES, slug);
}

export function nativeOpenAiCapabilitySourceSlug(slug: string): string {
  return NATIVE_OPENAI_CAPABILITY_SOURCES[slug] ?? slug;
}

/** Native OpenAI model ids that this release can route and restore with authoritative metadata. */
export const NATIVE_OPENAI_MODELS = [
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];

export const SUPPORTED_NATIVE_OPENAI_SLUGS = new Set(NATIVE_OPENAI_MODELS);
