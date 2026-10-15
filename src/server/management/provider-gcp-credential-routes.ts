import { providerCredentialInputError } from "../../providers/api-keys";
import { commitProviderGcpCredentialRemoval } from "../../providers/gcp-credential-cleanup";
import { dropProviderCustomModels } from "../../providers/provider-id-rewrite";
import { forgetProviderContextCap } from "../../providers/context-cap";
import type { OcxConfig } from "../../types";
import { jsonResponse } from "../auth-cors";

/** Generic provider writes refuse credential JSON before any config mutation. */
export function providerGcpCredentialInputResponse(provider: { apiKey?: unknown; apiKeyPool?: unknown }): Response | null {
  const error = providerCredentialInputError(provider);
  return error ? jsonResponse({ error }, 400) : null;
}

/** Keep marker capture, provider removal and persistence in one synchronous locked operation. */
export function removeProviderWithGcpCredentials(
  config: OcxConfig,
  name: string,
  fallbackDefault: string | undefined,
  save: (config: OcxConfig) => void,
): number {
  return commitProviderGcpCredentialRemoval(config, name, () => {
    if (fallbackDefault) config.defaultProvider = fallbackDefault;
    delete config.providers[name];
    const dropped = dropProviderCustomModels(config, name);
    forgetProviderContextCap(config, name);
    save(config);
    return dropped;
  });
}
