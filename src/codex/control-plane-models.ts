/** Exact Codex control-plane ids routed to canonical OpenAI, outside the public native roster. */
export const CODEX_INTERNAL_OPENAI_MODELS: ReadonlySet<string> = new Set(["codex-auto-review"]);

export function isCodexControlPlaneModel(slug: unknown): boolean {
  return typeof slug === "string" && CODEX_INTERNAL_OPENAI_MODELS.has(slug);
}
