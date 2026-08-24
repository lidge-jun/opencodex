import type { IncomingMeta, ProviderAdapter } from "./base";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { createResponsesPassthroughAdapter } from "./openai-responses";
import { isAzureIdentityProvider } from "../config/provider-validation";
import { getAzureAccessToken } from "../lib/azure-identity";

function stripAzureAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (normalized === "authorization" || normalized === "api-key" || normalized === "x-api-key") continue;
    clean[name] = value;
  }
  return clean;
}

export function createAzureAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough: true } {
  const inner = createResponsesPassthroughAdapter({
    ...provider,
    baseUrl: provider.baseUrl,
  });

  return {
    ...inner,
    name: "azure-openai",

    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta) {
      if (provider.authMode === "forward") {
        throw new Error("azure-openai does not support forward auth mode");
      }
      const identityMode = isAzureIdentityProvider(provider);
      if (!identityMode && (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "")) {
        throw new Error("azure-openai requires a non-empty apiKey");
      }

      const request = await inner.buildRequest(parsed, incoming);
      const unresolvedPlaceholder = request.url.match(/\{[^}]*\}/)?.[0] ?? request.url.match(/[{}]/)?.[0];
      if (unresolvedPlaceholder) {
        throw new Error(`azure-openai baseUrl contains unresolved ${unresolvedPlaceholder} — set your real resource URL`);
      }

      const headers = stripAzureAuthHeaders(request.headers);
      if (identityMode) {
        headers.Authorization = `Bearer ${await getAzureAccessToken(provider)}`;
      } else {
        headers["api-key"] = provider.apiKey!;
      }
      // The inner adapter always targets Azure's v1 API here, which needs no api-version query.
      return { ...request, headers };
    },
  };
}
