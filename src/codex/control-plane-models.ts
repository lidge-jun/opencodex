/** Exact Codex control-plane ids routed to canonical OpenAI, outside the public native roster. */
export const CODEX_INTERNAL_OPENAI_MODELS: ReadonlySet<string> = new Set(["codex-auto-review"]);

export function isCodexControlPlaneModel(slug: unknown): boolean {
  return typeof slug === "string" && CODEX_INTERNAL_OPENAI_MODELS.has(slug);
}

/** Model IDs reserved for canonical OpenAI ahead of default provider routing. */
export function isBareOpenAiFamilyModel(modelId: string): boolean {
  return !modelId.includes("/")
    && (/^(?:gpt-|o1-|o3-|o4-)/.test(modelId) || CODEX_INTERNAL_OPENAI_MODELS.has(modelId));
}
