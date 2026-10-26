/**
 * Which models the runtime actually intercepts as shadow calls.
 *
 * Codex 0.154.0+ sends gpt-6-luna for helper calls; 0.145.0-0.153.x sent
 * gpt-5.6-luna, which the runtime still intercepts by default. Clients through
 * 0.144.x used gpt-5.4-mini, which operators can restore through `sourceModels`.
 * Memory consolidation is a separate background path: Codex asks for Terra
 * there, and `memoryModels.consolidation` owns that route. Terra is also a
 * normal foreground/subagent model, so it stays out of the shadow source set.
 * The GUI renders whatever the runtime reports rather than a baked-in label;
 * this fallback only covers a runtime too old to send `sourceModels`.
 */
const FALLBACK_SOURCE_MODELS = ["gpt-6-luna", "gpt-5.6-luna"];

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

/**
 * Compact inventory for the shadow-call row: the intercepted helper models plus
 * the memory-consolidation model, which is controlled by Memory-Routing rather
 * than by the shadow-call switch. The caller localizes `memoryLabel`.
 *
 * Terra is normally outside the source set, but an explicit `sourceModels`
 * entry can opt it in. In that case the source list already names Terra, and
 * appending the memory label would list the same model twice.
 */
export function shadowBackgroundModelBadge(
  sourceModels: string[] | undefined,
  memoryLabel: string,
  memoryModelId = "gpt-5.6-terra",
): string {
  const memoryAlreadyIntercepted = memoryModelId !== ""
    && shadowSourceModelList(sourceModels).some(prefix => memoryModelId.startsWith(prefix));
  const sourceLabel = shadowSourceModelBadge(sourceModels);
  return memoryAlreadyIntercepted ? sourceLabel : `${sourceLabel} (+ ${memoryLabel})`;
}
