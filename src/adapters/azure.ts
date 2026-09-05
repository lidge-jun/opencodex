import type { IncomingMeta, ProviderAdapter } from "./base";
import { getAzureOpenAiAccessToken } from "./azure-auth";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { createResponsesPassthroughAdapter } from "./openai-responses";

export function createAzureAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough: true } {
  const inner = createResponsesPassthroughAdapter({
    ...provider,
    baseUrl: provider.baseUrl,
  });
  const apiKey = typeof provider.apiKey === "string" && provider.apiKey.trim() !== ""
    ? provider.apiKey
    : undefined;

  return {
    ...inner,
    name: "azure-openai",

    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta) {
      if (provider.authMode === "forward") {
        throw new Error("azure-openai does not support forward auth mode");
      }

      const request = await inner.buildRequest(parsed, incoming);
      const unresolvedPlaceholder = request.url.match(/\{[^}]*\}/)?.[0] ?? request.url.match(/[{}]/)?.[0];
      if (unresolvedPlaceholder) {
        throw new Error(`azure-openai baseUrl contains unresolved ${unresolvedPlaceholder} — set your real resource URL`);
      }

      const headers = { ...request.headers };
      if (apiKey !== undefined) {
        headers["api-key"] = apiKey;
        delete headers["Authorization"];
      } else {
        if (new URL(request.url).protocol !== "https:") {
          throw new Error("azure-openai keyless authentication requires HTTPS");
        }
        let accessToken: string | undefined;
        try {
          accessToken = await getAzureOpenAiAccessToken();
        } catch {
          throw new Error("azure-openai DefaultAzureCredential failed to acquire an access token");
        }
        if (!accessToken) {
          throw new Error("azure-openai DefaultAzureCredential did not return an access token");
        }
        headers.Authorization = `Bearer ${accessToken}`;
        delete headers["api-key"];
      }
      // The inner adapter always targets Azure's v1 API here, which needs no api-version query.
      return { ...request, headers };
    },
  };
}
