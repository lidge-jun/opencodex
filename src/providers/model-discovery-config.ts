import type { OcxProviderConfig } from "../types";

/** Keys a `providers.<name>.modelDiscovery` block may carry (#7910). */
const PROVIDER_MODEL_DISCOVERY_KEYS = new Set(["skipInvalidRows"]);

/**
 * Validate a provider's `modelDiscovery` block at the management write boundary. The loader
 * degrades a malformed block to absent (strict discovery), so this is where a bad value is
 * refused loudly instead of being stored and then ignored.
 */
export function providerModelDiscoveryConfigError(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "modelDiscovery must be an object such as { \"skipInvalidRows\": true }";
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !PROVIDER_MODEL_DISCOVERY_KEYS.has(key))) {
    return "modelDiscovery accepts only skipInvalidRows";
  }
  if (record.skipInvalidRows !== undefined && typeof record.skipInvalidRows !== "boolean") {
    return "modelDiscovery.skipInvalidRows must be a boolean";
  }
  return null;
}

/** Whether the provider opted into skipping invalid `/models` rows. Anything but `true` is strict. */
export function providerSkipsInvalidModelRows(
  provider: Partial<Pick<OcxProviderConfig, "modelDiscovery">>,
): boolean {
  return provider.modelDiscovery?.skipInvalidRows === true;
}
