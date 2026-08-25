import { effectiveGoogleMode } from "../providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";

const AI_STUDIO_CACHED_CONTENT = /^cachedContents\/[^/?#\s]+$/;
const VERTEX_CACHED_CONTENT = /^projects\/[^/?#\s]+\/locations\/[^/?#\s]+\/cachedContents\/[^/?#\s]+$/;

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
  if (mode === "cloud-code-assist") {
    return "provider_options.google is not supported on Google Cloud Code Assist routes";
  }
  if (route.adapterName !== "google" || (mode !== "ai-studio" && mode !== "vertex")) {
    return "provider_options.google is supported only on Google AI Studio or Vertex routes";
  }
  if (mode === "ai-studio") {
    const cachedContent = parsed.options.providerOptions.google.cachedContent;
    if (cachedContent && VERTEX_CACHED_CONTENT.test(cachedContent)) {
      return "provider_options.google.cached_content must use cachedContents/{id} on Google AI Studio routes";
    }
  }
  if (mode === "vertex") {
    const cachedContent = parsed.options.providerOptions.google.cachedContent;
    if (cachedContent && AI_STUDIO_CACHED_CONTENT.test(cachedContent)) {
      return "provider_options.google.cached_content must use projects/{project}/locations/{location}/cachedContents/{id} on Vertex routes";
    }
  }
  return undefined;
}
