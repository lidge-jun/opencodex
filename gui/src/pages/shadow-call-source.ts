/**
 * Which models the runtime actually intercepts as shadow calls.
 *
 * Codex 0.145.0+ uses gpt-5.6-luna for helper calls. Older clients through
 * 0.144.x used gpt-5.4-mini, which operators can restore through `sourceModels`.
 * The GUI renders whatever the runtime reports rather than a baked-in label;
 * this fallback only covers a runtime too old to send `sourceModels`.
 */
const FALLBACK_SOURCE_MODELS = ["gpt-5.6-luna"];

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
