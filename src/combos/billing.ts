import { getProviderRegistryEntry } from "../providers/registry";
import { normalizedBaseUrl } from "../providers/openai-forward-destination";
import { comboProviderBilling, type ComboProviderBilling, type SuggestionProvider } from "./suggestion-channel";

/** Strict Combos require consent whenever the transport does not establish an included route. */
export function configuredComboProviderBilling(provider: SuggestionProvider): ComboProviderBilling {
  const registry = getProviderRegistryEntry(provider.name);
  const authMode = provider.authMode ?? registry?.authKind;
  const adapter = provider.adapter ?? registry?.adapter;
  const baseUrl = provider.baseUrl ?? registry?.baseUrl;
  if (authMode === "oauth" && registry?.authKind === "oauth" && registry.oauthFamily === "anthropic"
    && adapter === registry.adapter && baseUrl && normalizedBaseUrl(baseUrl) === normalizedBaseUrl(registry.baseUrl)) {
    return "subscription";
  }
  return comboProviderBilling({ ...provider, authMode, adapter, baseUrl });
}
