import type { OcxProviderConfig } from "../types";
import type { ProviderApiKeySelection } from "../types/provider";

export function captureProviderApiKeySelection(provider: OcxProviderConfig): ProviderApiKeySelection {
  const activeReference = provider.apiKeyPool?.find(entry => entry.key === provider.apiKey && !entry.disabled)
    ?? provider.apiKeyPool?.find(entry => entry.key === provider.apiKey);
  return {
    entryId: activeReference?.id,
    reference: provider.apiKey,
    revision: provider.apiKeySelectionRevision,
  };
}
