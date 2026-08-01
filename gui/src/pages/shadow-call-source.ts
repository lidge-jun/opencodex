/**
 * Which models the runtime actually intercepts as shadow calls.
 *
 * Codex's hard-coded helper slug moves between client versions (gpt-5.4-mini up
 * to 0.144.x, gpt-5.6-luna from 0.145.0), so the GUI must render whatever the
 * runtime reports rather than a literal baked into a label. The fallback only
 * covers a runtime too old to send `sourceModels`.
 */
const FALLBACK_SOURCE_MODELS = ["gpt-5.4-mini", "gpt-5.6-luna"];

export function shadowSourceModelList(sourceModels?: string[]): string[] {
  const cleaned = Array.isArray(sourceModels)
    ? sourceModels.filter(v => typeof v === "string" && v.trim() !== "").map(v => v.trim())
    : [];
  return cleaned.length > 0 ? cleaned : FALLBACK_SOURCE_MODELS;
}

/** Comma-joined source models for inline badges and warning text. */
export function shadowSourceModelLabel(sourceModels?: string[]): string {
  return shadowSourceModelList(sourceModels).join(", ");
}

/** Short badge form: drops the shared `gpt-` prefix to keep the row compact. */
export function shadowSourceModelBadge(sourceModels?: string[]): string {
  return shadowSourceModelList(sourceModels)
    .map(id => id.replace(/^gpt-/, ""))
    .join(", ");
}
