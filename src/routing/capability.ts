/**
 * Candidate capability evidence for policy routing (RI-05).
 *
 * Evidence comes from canonical local sources only - provider config maps,
 * the provider registry, the cached Codex catalog file, and the native-model
 * metadata helpers. No live network fetch happens at routing time.
 *
 * "Unknown is not zero": any dimension without canonical evidence stays
 * `undefined` (unknown) and the profile's `unknownEvidence` policy decides
 * how that affects eligibility.
 */

import type { OcxConfig } from "../types";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { PROVIDER_REGISTRY } from "../providers/registry";
import {
  nativeInputModalities,
  nativeOpenAiContextWindow,
  nativeParallelToolCalls,
  nativeReasoningEfforts,
} from "../codex/catalog/metadata";
import { readCatalog, readCodexCatalogPath } from "../codex/catalog/parsing";
import { statSync } from "node:fs";
import type { RouteCapabilityEvidence } from "./trace";

type CatalogModelRow = {
  provider: string;
  id: string;
  contextWindow?: number;
  inputModalities?: string[];
  reasoningEfforts?: string[];
  capabilities?: string[];
};

/**
 * Catalog rows memoized by path + mtime: the cached Codex catalog is stable
 * between refreshes, and re-reading/parsing the whole file per candidate on
 * the request path would multiply a synchronous disk + JSON cost by the
 * profile candidate count for every policy-routed request.
 */
let catalogCache: { path: string; mtimeMs: number; rows: CatalogModelRow[] } | null = null;

function cachedCatalogModels(): CatalogModelRow[] {
  try {
    const path = readCodexCatalogPath();
    const mtimeMs = statSync(path).mtimeMs;
    if (catalogCache && catalogCache.path === path && catalogCache.mtimeMs === mtimeMs) {
      return catalogCache.rows;
    }
    const catalog = readCatalog(path);
    const models = catalog?.models;
    if (!Array.isArray(models)) return [];
    const rows = models
      .filter((model): model is Record<string, unknown> & { id: string; provider: string } =>
        typeof model === "object" && model !== null && typeof model.id === "string" && typeof model.provider === "string")
      .map(model => ({
        provider: model.provider,
        id: model.id,
        ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
        ...(Array.isArray(model.inputModalities)
          ? { inputModalities: model.inputModalities.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(Array.isArray(model.reasoningEfforts)
          ? { reasoningEfforts: model.reasoningEfforts.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(Array.isArray(model.capabilities)
          ? { capabilities: model.capabilities.filter((value): value is string => typeof value === "string") }
          : {}),
      }));
    catalogCache = { path, mtimeMs, rows };
    return rows;
  } catch {
    return [];
  }
}

/**
 * Classify a hostname for locality evidence. `URL.hostname` keeps IPv6
 * literals bracketed (`[::1]`), so strip the brackets before matching.
 * Anything not positively local or private stays unknown: "unknown is not
 * zero", so an unrecognized host must never assert `remoteAllowed`.
 */
function classifyHostname(hostname: string): "local" | "private" | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") return "local";
  if (host === "::1" || /^127\./.test(host)) return "local";
  if (/^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host)
    || /^fe80:/.test(host)
    || /^::ffff:(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) {
    return "private";
  }
  return null;
}

/**
 * Adapters whose upstream protocol supports function/tool calling. Mirrors
 * the adapter ids the resolver accepts (including the `azure` alias for
 * `azure-openai`); `kiro` and `mimo-free` send/delegate tool calls.
 */
const TOOL_CAPABLE_ADAPTERS = new Set([
  "openai-chat",
  "openai-responses",
  "anthropic",
  "cursor",
  "google",
  "azure-openai",
  "azure",
  "kiro",
  "mimo-free",
]);

function localRemoteEvidence(baseUrl: string | undefined): Pick<RouteCapabilityEvidence, "localOnly" | "remoteAllowed"> {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return {};
  try {
    const hostname = new URL(baseUrl).hostname;
    if (!hostname) return {};
    const kind = classifyHostname(hostname);
    if (kind === null) return {};
    // Both booleans are emitted once classified: definitive negative evidence,
    // so a local host cannot satisfy `require.remoteAllowed` (or vice versa)
    // under `unknownEvidence.capability: "allow"`/`"penalize"`.
    return kind === "local" || kind === "private"
      ? { localOnly: true, remoteAllowed: false }
      : { remoteAllowed: true, localOnly: false };
  } catch {
    return {};
  }
}

/**
 * Assemble canonical capability evidence for one `provider/model` candidate.
 * Sources (in priority order): provider config maps, provider registry hints,
 * cached Codex catalog row, native-model metadata.
 */
export function candidateCapabilityEvidence(
  config: OcxConfig,
  providerName: string,
  modelId: string,
): RouteCapabilityEvidence {
  const provider = config.providers[providerName];
  const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === providerName);
  const catalogRow = cachedCatalogModels().find(model => model.provider === providerName && model.id === modelId);
  const isNative = providerName === "openai" && !modelId.includes("/");

  const contextWindow = provider?.modelContextWindows?.[modelId]
    ?? provider?.contextWindow
    ?? registryEntry?.modelContextWindows?.[modelId]
    ?? catalogRow?.contextWindow
    ?? (isNative ? nativeOpenAiContextWindow(modelId) : undefined);

  const modalities = provider?.modelInputModalities?.[modelId]
    ?? registryEntry?.modelInputModalities?.[modelId]
    ?? catalogRow?.inputModalities
    ?? (isNative ? nativeInputModalities(modelId) : undefined);
  const image = Array.isArray(modalities)
    ? modalities.includes("image")
    : undefined;

  const capabilities = catalogRow?.capabilities ?? [];
  // The catalog `capabilities` list is a positive per-model signal; a row
  // without "tools" is treated as unknown, never as a negative. Without a
  // catalog row the adapter protocol itself is the signal: tool-capable
  // adapters run single tool calls even when the parallel-call opt-in is
  // unset or false. `parallelToolCalls` stays a positive provider-level
  // override.
  const tools = capabilities.includes("tools")
    || isNative
    || (catalogRow === undefined && provider !== undefined && TOOL_CAPABLE_ADAPTERS.has(provider.adapter))
    || provider?.parallelToolCalls === true
    || undefined;

  const reasoningEfforts = provider?.modelReasoningEfforts?.[modelId]
    ?? registryEntry?.modelReasoningEfforts?.[modelId]
    ?? catalogRow?.reasoningEfforts
    ?? (isNative ? nativeReasoningEfforts(modelId) : undefined);

  const tierSupport = provider?.supportsServiceTier
    ?? registryEntry?.supportsServiceTier;
  const serviceTier = tierSupport === true
    ? "supported"
    : tierSupport === false ? "unsupported" : "unknown";

  const localRemote = localRemoteEvidence(provider?.baseUrl);
  // Only emit a definitive encryptedCodexTasks value when the provider is
  // present. An absent/unconfigured provider must stay unknown so
  // require.encryptedCodexTasks does not fail closed on missing config.
  const encryptedCodexTasks = provider === undefined
    ? undefined
    : isCanonicalOpenAiForwardProvider(provider);

  return {
    ...(typeof contextWindow === "number" ? { contextWindow } : {}),
    ...(typeof image === "boolean" ? { image } : {}),
    ...(typeof tools === "boolean" ? { tools } : {}),
    ...(reasoningEfforts !== undefined && reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
    ...(serviceTier !== "unknown" ? { serviceTier } : {}),
    ...localRemote,
    ...(typeof encryptedCodexTasks === "boolean" ? { encryptedCodexTasks } : {}),
  };
}
