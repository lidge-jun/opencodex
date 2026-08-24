import { effectiveGoogleMode } from "../providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";

export function googleProviderOptionsRouteError(
  parsed: Pick<OcxParsedRequest, "options">,
  route: {
    providerName: string;
    provider: OcxProviderConfig;
    adapterName: string;
  },
): string | undefined {
  if (!parsed.options.providerOptions?.google) return undefined;
  const mode = effectiveGoogleMode(route.providerName, route.provider);
  if (route.adapterName === "google" && (mode === "ai-studio" || mode === "vertex")) return undefined;
  if (mode === "cloud-code-assist") {
    return "provider_options.google is not supported on Google Cloud Code Assist routes";
  }
  return "provider_options.google is supported only on Google AI Studio or Vertex routes";
}
