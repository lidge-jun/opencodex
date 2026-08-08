/** Native OpenAI model ids that this release can route and restore with authoritative metadata. */
export const NATIVE_OPENAI_MODELS = [
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];

export const SUPPORTED_NATIVE_OPENAI_SLUGS = new Set(NATIVE_OPENAI_MODELS);
