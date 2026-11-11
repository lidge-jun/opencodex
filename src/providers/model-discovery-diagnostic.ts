/**
 * Safe operator guidance for malformed upstream model lists.
 *
 * A diagnostic is present only for a row-level failure of a generic `/models` envelope, and it
 * already names the first invalid row and how many rows are invalid (never row contents). For those,
 * the guidance names the per-provider `modelDiscovery.skipInvalidRows` opt-in (#7910) next to the
 * static-roster recovery; once the opt-in is on, reaching here means no row survived.
 */
export function invalidModelDiscoveryHint(diagnostic?: string, skipInvalidRows = false): string {
  const pending = "A newly added API-key provider can keep its model selection pending while discovery fails";
  const staticRoster = "a static models list with liveModels: false avoids discovery for gateways publishing invalid rows.";
  if (!diagnostic) return `. ${pending}; ${staticRoster}`;
  if (skipInvalidRows) {
    return ` (${diagnostic}). modelDiscovery.skipInvalidRows left no usable row, so the listing stays rejected. ${pending}; ${staticRoster}`;
  }
  return ` (${diagnostic}). ${pending}; set modelDiscovery.skipInvalidRows: true on this provider to skip invalid rows and keep the valid ones, or use a static models list with liveModels: false to avoid discovery for gateways publishing invalid rows.`;
}

const skippedRowWarnings = new Map<string, string>();

/**
 * Whether a successful listing that skipped invalid rows should be logged. The warning is one-time
 * per provider for an unchanged skipped/received count; a clean listing resets it so a recurrence
 * is reported again. Keyed by provider name, so it is bounded by the configured providers.
 */
export function shouldWarnSkippedModelRows(provider: string, skipped: number, rawCount: number): boolean {
  if (skipped <= 0) {
    skippedRowWarnings.delete(provider);
    return false;
  }
  const signature = `${skipped}/${rawCount}`;
  if (skippedRowWarnings.get(provider) === signature) return false;
  skippedRowWarnings.set(provider, signature);
  return true;
}
