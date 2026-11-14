import type { OcxConfig } from "../types";
import { resolveAntigravityEffortWireModel } from "../providers/antigravity-models";
import { knownModelIdsForProvider } from "../router";
import { routeAllowedByScope, type AdmissionModelScope } from "./admission-model-scope";
import { geminiNativeError } from "./gemini-native";

/** Expose OC's known AGY catalog using Gemini resource names, filtered by the admitted key. */
export function geminiNativeCatalog(config: OcxConfig, url: URL, scope?: AdmissionModelScope): Response {
  const provider = config.providers["google-antigravity"];
  if (!provider || provider.disabled) return geminiNativeError(503, "Enable google-antigravity before listing native Gemini models");
  const wireIds = new Set(knownModelIdsForProvider("google-antigravity", provider, config)
    .flatMap(model => ["low", "medium", "high"].map(effort => resolveAntigravityEffortWireModel(model, effort, provider.baseUrl).wireModelId)));
  const models = [...wireIds]
    .filter(model => /^gemini-[A-Za-z0-9._-]{1,120}$/.test(model))
    .filter(model => routeAllowedByScope(scope, { providerName: "google-antigravity", modelId: model }))
    .sort().map(model => ({ name: `models/${model}`, displayName: model, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] }));
  if (url.pathname !== "/v1beta/models") {
    const name = url.pathname.slice("/v1beta/".length);
    const model = models.find(model => model.name === name);
    return model ? Response.json(model) : geminiNativeError(404, "Gemini model not found");
  }
  const sizeText = url.searchParams.get("pageSize") ?? "50";
  const tokenText = url.searchParams.get("pageToken") ?? "0";
  if (!/^\d{1,4}$/.test(sizeText) || !/^\d{1,9}$/.test(tokenText)) return geminiNativeError(400, "Invalid Gemini catalog pagination");
  const size = Number(sizeText), offset = Number(tokenText);
  if (size < 1 || size > 1000 || offset > models.length) return geminiNativeError(400, "Invalid Gemini catalog pagination");
  return Response.json({ models: models.slice(offset, offset + size), ...(offset + size < models.length ? { nextPageToken: String(offset + size) } : {}) });
}
