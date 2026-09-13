export interface ProviderAdditionMetadata {
  /** Adapter returned by the completed activation, independent of the caller's stale config snapshot. */
  adapter?: string;
}

/** Native ZCode activation is protocol/catalog-only and must not start any quota read. */
export function refreshQuotasAfterProviderAddition(
  metadata: ProviderAdditionMetadata | undefined,
  refresh: (force: boolean) => unknown,
): void {
  if (metadata?.adapter === "zcode") return;
  refresh(true);
}
