import { discoveredNativeOpenAiModels } from "./native-models";
import { UPSTREAM_NATIVE_ENTRIES } from "./metadata";
import { readCatalogBackup, type RawEntry } from "./parsing";
import { isPlainObject } from "../../lib/plain-data";

// Private provenance, like opencodex_spawn_priority: Codex ignores unknown fields.
// This is always the unbanded source rank, independent of picker/guidance history.
export const OCX_NATIVE_SOURCE_PRIORITY_FIELD = "opencodex_native_source_priority";
export const NATIVE_SOURCE_PRIORITY_MAX = 1_000;

export interface NativePrioritySource {
  readonly baseline?: ReadonlyMap<string, unknown>;
  readonly retainedBySlug?: ReadonlyMap<string, unknown>;
}

/** Optional native provenance validates its rows without changing shared catalog parsing. */
export function readNativeBaseline(catalogPath: string): Map<string, number> {
  const baseline = new Map<string, number>();
  for (const row of readCatalogBackup(catalogPath)?.models ?? []) {
    if (isPlainObject(row) && typeof row.slug === "string" && !row.slug.includes("/")
      && typeof row.priority === "number" && Number.isFinite(row.priority)) {
      baseline.set(row.slug, row.priority);
    }
  }
  return baseline;
}

function validSourcePriority(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= 0 && value <= NATIVE_SOURCE_PRIORITY_MAX;
}

export function retainedNativeSourcePriorities(rows: readonly unknown[]): Map<string, unknown> {
  return new Map(rows.flatMap(row => isPlainObject(row) && typeof row.slug === "string" && !row.slug.includes("/")
    && validSourcePriority(row[OCX_NATIVE_SOURCE_PRIORITY_FIELD])
    ? [[row.slug, row[OCX_NATIVE_SOURCE_PRIORITY_FIELD]] as const] : []));
}

export function resolveNativeSourcePriority(slug: string, source: NativePrioritySource = {}): number {
  // This registry is the same pristine source upstreamNativeEntry clones. Reading one scalar
  // avoids cloning the full instruction payload a second time for every native row.
  const upstream = UPSTREAM_NATIVE_ENTRIES.get(slug)?.priority;
  if (discoveredNativeOpenAiModels().includes(slug) && validSourcePriority(upstream)) return upstream;
  const baseline = source.baseline?.get(slug);
  if (validSourcePriority(baseline)) return baseline;
  const retained = source.retainedBySlug?.get(slug);
  if (validSourcePriority(retained)) return retained;
  return validSourcePriority(upstream) ? upstream : 9;
}

/** Assign after derivation: finishUpstreamNativeEntry treats priority 9 as keep-upstream. */
export function applyNativePriority(
  entry: RawEntry,
  slug: string,
  rank: ReadonlyMap<string, number>,
  featuredCount: number,
  source?: NativePrioritySource,
): RawEntry {
  const priority = resolveNativeSourcePriority(slug, source);
  entry[OCX_NATIVE_SOURCE_PRIORITY_FIELD] = priority;
  entry.priority = rank.get(slug) ?? (featuredCount > 0 ? featuredCount + 100 + priority : priority);
  return entry;
}
