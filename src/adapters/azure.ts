import type { ProviderAdapter } from "./base";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { createResponsesPassthroughAdapter } from "./openai-responses";

export function createAzureAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough: true } {
  const inner = createResponsesPassthroughAdapter({
    ...provider,
    baseUrl: provider.baseUrl,
  });

  return {
    ...inner,
    name: "azure-openai",

    async buildRequest(parsed: OcxParsedRequest) {
      if (provider.authMode === "forward") {
        throw new Error("azure-openai does not support forward auth mode");
      }
      if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
        throw new Error("azure-openai requires a non-empty apiKey");
      }

      const request = await inner.buildRequest(parsed);
      const unresolvedPlaceholder = request.url.match(/\{[^}]*\}/)?.[0] ?? request.url.match(/[{}]/)?.[0];
      if (unresolvedPlaceholder) {
        throw new Error(`azure-openai baseUrl contains unresolved ${unresolvedPlaceholder} — set your real resource URL`);
      }

      const headers = { ...request.headers };
      headers["api-key"] = provider.apiKey;
      delete headers["Authorization"];
      // The inner adapter always targets Azure's v1 API here, which needs no api-version query.
      return { ...request, headers };
    },
  };
}
