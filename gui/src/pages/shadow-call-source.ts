/**
 * Which models the runtime actually intercepts as shadow calls.
 *
 * Codex 0.154.0+ sends gpt-6-luna for helper calls; 0.145.0-0.153.x sent
 * gpt-5.6-luna, which the runtime still intercepts by default. Clients through
 * 0.144.x used gpt-5.4-mini, which operators can restore through `sourceModels`.
 * Memory consolidation is a separate background path: Codex asks for Terra
 * there, and `memoryModels.consolidation` owns that route. Terra is also a
 * normal foreground/subagent model, so it stays out of the shadow source set.
 * The Terra generation changes with Codex; both `gpt-5.6-terra` and
 * `gpt-6.1-terra` are recognized here so the badge does not claim the memory
 * model is outside the sources after an operator opts one in.
 * The GUI renders whatever the runtime reports rather than a baked-in label;
 * this fallback only covers a runtime too old to send `sourceModels`.
 */
const FALLBACK_SOURCE_MODELS = ["gpt-6-luna", "gpt-5.6-luna"];

export type ShadowCallSourceRole = "helper" | "memory" | "legacy" | "custom";

/** One toggle the runtime offered; `sourceModelOptions` is the only source of truth. */
export interface ShadowCallSourceOption {
  id: string;
  role: ShadowCallSourceRole;
  defaultIntercepted: boolean;
}

export function shadowSourceModelList(sourceModels?: string[]): string[] {
  const raw = Array.isArray(sourceModels)
    ? sourceModels.filter(v => typeof v === "string" && v.trim() !== "").map(v => v.trim())
    : [];
  if (raw.length === 0) return FALLBACK_SOURCE_MODELS;
  // A routed model id can never match: the runtime hard-excludes slashes before
  // prefix comparison. Keeping one visible would let the next save send a value
  // the API rejects, so the effective list drops it here as well.
  return raw.filter(id => !id.includes("/"));
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

/** True when any configured prefix intercepts this option's model id. */
export function shadowSourceOptionActive(optionId: string, sourceModels?: string[]): boolean {
  return shadowSourceModelList(sourceModels).some(prefix => optionId.startsWith(prefix));
}

/** The configured prefix that covers this option, if any. */
export function shadowSourceOptionCoveringPrefix(optionId: string, sourceModels?: string[]): string | undefined {
  return shadowSourceModelList(sourceModels).find(prefix => optionId.startsWith(prefix));
}

export type ShadowCallSourceToggleResult =
  | { sourceModels: string[] }
  | { blocked: "last" }
  | { blocked: "covered"; prefix: string };

/**
 * Compute the next source list for one toggle.
 *
 * A broader custom prefix can cover several options. Removing that prefix here
 * would also switch off the siblings the operator did not touch, so the covered
 * option is blocked and the explanation names the prefix. The last active
 * source is never removed; stopping everything is the main switch's job.
 */
export function toggleShadowCallSource(
  option: ShadowCallSourceOption,
  sourceModels?: string[],
): ShadowCallSourceToggleResult {
  const selected = shadowSourceModelList(sourceModels);
  const broader = selected.find(prefix => prefix !== option.id && option.id.startsWith(prefix));
  if (broader !== undefined) return { blocked: "covered", prefix: broader };
  if (!selected.includes(option.id)) return { sourceModels: [...selected, option.id] };
  const next = selected.filter(prefix => prefix !== option.id);
  return next.length === 0 ? { blocked: "last" } : { sourceModels: next };
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
  memoryModelIds: readonly string[] = ["gpt-6.1-terra", "gpt-5.6-terra"],
): string {
  const selected = shadowSourceModelList(sourceModels);
  const memoryAlreadyIntercepted = memoryModelIds.some(id => id !== ""
    && selected.some(prefix => id.startsWith(prefix)));
  const sourceLabel = shadowSourceModelBadge(sourceModels);
  return memoryAlreadyIntercepted ? sourceLabel : `${sourceLabel} (+ ${memoryLabel})`;
}
