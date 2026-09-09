import type { OcxProviderConfig } from "../types";
import { isCanonicalOpenAiForwardProvider } from "./openai-tiers";

/** Whether this transport can consume the request's Authorization as its upstream credential. */
export function providerConsumesCallerAuthorization(provider: OcxProviderConfig): boolean {
  return isCanonicalOpenAiForwardProvider(provider)
    || (provider.adapter === "cursor" && provider.authMode !== "oauth" && !provider.apiKey?.trim());
}
