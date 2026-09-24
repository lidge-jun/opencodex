import type { OcxProviderConfig } from "../types";
import { getProviderRegistryEntry } from "./registry";
import type { ProviderRegistryEntry } from "./registry/types";

/**
 * Whether a provider's Fast lane is switched off.
 *
 * `fastEnabled: false` turns Fast off on any provider. A registry entry marked `fastOptIn` bills its
 * Fast lane beyond the plan (Anthropic fast mode draws usage credits at 2x price), so it stays off
 * until the operator sets `fastEnabled: true`. Off is expressed as provider capability `false`,
 * which every Fast consumer already treats as a global denial.
 *
 * The registry entry is matched by name without a transport check on purpose: this can only turn
 * Fast off, so a custom endpoint that reuses the name loses nothing it could safely keep.
 */
export function fastSwitchOff(
  provider: Pick<OcxProviderConfig, "fastEnabled">,
  entry: Pick<ProviderRegistryEntry, "fastOptIn"> | undefined,
): boolean {
  if (provider.fastEnabled === false) return true;
  if (provider.fastEnabled === true) return false;
  return entry?.fastOptIn === true;
}

/** `fastSwitchOff` with the registry entry looked up by provider name. */
export function providerFastSwitchOff(
  providerName: string | undefined,
  provider: Pick<OcxProviderConfig, "fastEnabled">,
): boolean {
  return fastSwitchOff(provider, providerName ? getProviderRegistryEntry(providerName) : undefined);
}
