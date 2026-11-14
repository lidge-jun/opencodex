import type { ParsedUsageSource } from "../../usage/source-filter";

/**
 * `client=all&device=all` selects every row, so its report is the unfiltered one. Serving it from
 * the shared unfiltered aggregate keeps the dashboard off the filter index, whose candidate path
 * re-reads every row by offset and costs several full scans on a large ledger.
 */
export function selectsEverySource(source: ParsedUsageSource): boolean {
  return source.kind === "filtered" && source.filter.client === "all" && source.filter.device.kind === "all";
}

/** Shapes an unfiltered summary for its caller: the all-sources echo, or the legacy shape. */
export function presentUnfilteredUsageSummary<T extends { legacyUnclassifiedRequests?: number }>(summary: T, everySource: boolean) {
  if (everySource) {
    return { ...summary, sourceFilter: { client: "all" as const, device: { kind: "all" as const } }, legacyUnclassifiedRequests: summary.legacyUnclassifiedRequests ?? 0 };
  }
  const { legacyUnclassifiedRequests: _legacy, ...legacyShape } = summary;
  return legacyShape;
}
