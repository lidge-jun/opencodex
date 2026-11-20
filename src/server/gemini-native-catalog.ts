import { resolveProtocolSettings } from "../protocols/settings";
import { resolveAntigravityEffortWireModel } from "../providers/antigravity-models";
import { effectiveGoogleMode } from "../providers/registry";
import type { RouteResult } from "../router";
import type { OcxConfig } from "../types";
import { routeAllowedByScope, type AdmissionModelScope } from "./admission-model-scope";
import { preflightOllamaRoute } from "./ollama-route-policy";

const PROVIDER = "google-antigravity";
const GEMINI_MODEL = /^gemini-[A-Za-z0-9._-]{1,120}$/;

function nativeWireModel(config: OcxConfig, route: RouteResult, effort?: string): string | undefined {
  const configured = config.providers[PROVIDER];
  const { providerName, provider, modelId } = route;
  if (providerName !== PROVIDER || route.routeReason === "blocked-model-redirect"
    || !configured || configured.disabled === true
    || (configured.authMode !== undefined && configured.authMode !== "oauth")
    || provider.authMode !== "oauth" || effectiveGoogleMode(providerName, provider) !== "cloud-code-assist"
    || !GEMINI_MODEL.test(modelId)) return undefined;
  const { wireModelId } = resolveAntigravityEffortWireModel(modelId, effort, provider.baseUrl);
  return GEMINI_MODEL.test(wireModelId) ? wireModelId : undefined;
}

function resolveNativeDestination(config: OcxConfig, req: Request, selector: string) {
  const preflight = preflightOllamaRoute(config, selector, req);
  if (!preflight.ok) return undefined;
  const wireModel = nativeWireModel(config, preflight.route);
  return wireModel ? { route: preflight.route, wireModel } : undefined;
}

export function nativeGeminiDestination(config: OcxConfig, req: Request, selector: string) {
  if (!resolveProtocolSettings(config).rollout.geminiNativeAntigravity) return undefined;
  return resolveNativeDestination(config, req, selector);
}

/** A native alias must route to the same wire ID and pass scope under its own resolved destination. */
function allowedWireAlias(config: OcxConfig, req: Request, alias: string, scope?: AdmissionModelScope): CatalogRow | undefined {
  if (!GEMINI_MODEL.test(alias)) return undefined;
  const destination = resolveNativeDestination(config, req, alias);
  if (destination?.wireModel !== alias || !routeAllowedByScope(scope, destination.route)) return undefined;
  return { selector: alias, route: destination.route };
}

type CatalogRow = { selector: string; route: RouteResult };

export function geminiNativeCatalogLookup(
  config: OcxConfig, req: Request, alias: string, rows: () => readonly CatalogRow[], scope?: AdmissionModelScope,
): CatalogRow | undefined {
  if (!resolveProtocolSettings(config).rollout.geminiNativeAntigravity) return undefined;
  const row = allowedWireAlias(config, req, alias, scope);
  return row && rows().some(({ route }) => advertisedWireModels(config, route).includes(alias)) ? row : undefined;
}

function advertisedWireModels(config: OcxConfig, route: RouteResult): string[] {
  return [undefined, "low", "medium", "high"].flatMap(effort => nativeWireModel(config, route, effort) ?? []);
}

export function geminiNativeCatalogAliases(
  config: OcxConfig, req: Request, rows: readonly CatalogRow[], scope?: AdmissionModelScope,
): CatalogRow[] {
  if (!resolveProtocolSettings(config).rollout.geminiNativeAntigravity) return [];
  const aliases = new Set(rows.flatMap(({ route }) => advertisedWireModels(config, route)));
  return [...aliases].sort().flatMap(alias => allowedWireAlias(config, req, alias, scope) ?? []);
}
