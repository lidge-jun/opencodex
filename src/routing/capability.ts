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

import { modelInList, type OcxConfig } from "../types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { serviceTierSupportForModel } from "../providers/service-tier";
import { PROVIDER_REGISTRY } from "../providers/registry";
import {
  nativeInputModalities,
  nativeContextLimits, nativeOpenAiContextWindow,
  nativeParallelToolCalls,
  nativeReasoningEfforts,
} from "../codex/catalog/metadata";
import { readCatalog, readCodexCatalogPath } from "../codex/catalog/parsing";
import { modelRecordValue } from "../reasoning-effort";
import { statSync } from "node:fs";
import type { RouteCapabilityEvidence } from "./trace";

type CatalogModelRow = {
  /** Exact provider/native-id identity, from the provenance block. */
  provider: string;
  id: string;
  /** Only values a real source asserted; never a strict-parser default. */
  contextWindow?: number;
  inputModalities?: string[];
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
    // Read ONLY `opencodex_capability_provenance` (written by
    // applyCatalogModelMetadata). The row's own `context_window` and
    // `input_modalities` always exist because ensureStrictCatalogFields fills them
    // with compatibility defaults for Codex's strict parser, so reading them would
    // turn "nobody asserted anything" into a confident `image: false` and a
    // fabricated 128000 — the opposite of this module's contract. A row without
    // provenance contributes nothing.
    const rows = models.flatMap((model): CatalogModelRow[] => {
      if (typeof model !== "object" || model === null) return [];
      const provenance = (model as Record<string, unknown>).opencodex_capability_provenance;
      if (typeof provenance !== "object" || provenance === null) return [];
      const source = provenance as Record<string, unknown>;
      if (typeof source.provider !== "string" || typeof source.model_id !== "string") return [];
      return [{
        provider: source.provider,
        id: source.model_id,
        ...(typeof source.context_window === "number" && source.context_window > 0
          ? { contextWindow: source.context_window }
          : {}),
        ...(Array.isArray(source.input_modalities)
          ? { inputModalities: source.input_modalities.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(Array.isArray(source.capabilities)
          ? { capabilities: source.capabilities.filter((value): value is string => typeof value === "string") }
          : {}),
      }];
    });
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
  "command-code",
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
  const isNative = providerName === OPENAI_CODEX_PROVIDER_ID && !modelId.includes("/");

  // `modelRecordValue`, not a bare lookup: every runtime reader of these three maps
  // resolves them that way, so a `gpt-oss` entry covers `gpt-oss:120b`. Reading raw
  // made the evidence disagree with the resolver it claims to describe — and for the
  // window it did not even degrade to unknown, it fell through to the provider-wide
  // value, which is a definite wrong answer rather than an absent one.
  const rawContextWindow = modelRecordValue(provider?.modelContextWindows, modelId)
    ?? provider?.contextWindow
    ?? modelRecordValue(registryEntry?.modelContextWindows, modelId)
    ?? catalogRow?.contextWindow
    ?? (isNative ? nativeOpenAiContextWindow(modelId, nativeContextLimits(config)) : undefined);
  // Native rows go through the accessor (raise-to-ceiling + opt-in). Routed rows keep
  // the raw value; a provider cap on openai must not invent a window they do not have.
  const contextWindow = isNative
    ? (nativeOpenAiContextWindow(modelId, nativeContextLimits(config)) ?? rawContextWindow)
    : rawContextWindow;

  // `noVisionModels` is checked before the modality chain because that is the order
  // `isModelTextOnly` uses: it matches the no-vision list and returns true before it
  // ever reads `modelInputModalities` (`src/vision/index.ts:32`). So a `gpt-oss`
  // no-vision entry beats an exact `gpt-oss:120b` entry that lists "image", and
  // deriving `image` from the modality chain alone reported vision on a model the
  // runtime refuses it for. That matters more here than on the CLI surface fixed in
  // #2086: routing *acts* on this evidence, so it would select the candidate for image
  // work that execution then rejects.
  const noVision = modelInList(provider?.noVisionModels, modelId);
  const modalities = noVision
    ? ["text"]
    : (modelRecordValue(provider?.modelInputModalities, modelId)
      ?? modelRecordValue(registryEntry?.modelInputModalities, modelId)
      ?? catalogRow?.inputModalities
      ?? (isNative ? nativeInputModalities(modelId) : undefined));
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
    // The adapter protocol is positive evidence on its own. This was once gated
    // on `catalogRow === undefined`, which was only safe while the catalog lookup
    // never matched anything: once it matches, a row that simply does not
    // enumerate "tools" would silently revoke tool support for every openai-chat
    // and anthropic candidate.
    || (provider !== undefined && TOOL_CAPABLE_ADAPTERS.has(provider.adapter))
    || provider?.parallelToolCalls === true
    || undefined;

  const reasoningEfforts = modelRecordValue(provider?.modelReasoningEfforts, modelId)
    ?? modelRecordValue(registryEntry?.modelReasoningEfforts, modelId)
    ?? (isNative ? nativeReasoningEfforts(modelId) : undefined);

  const tierSupport = provider
    ? serviceTierSupportForModel(provider, modelId, providerName)
    : registryEntry ? serviceTierSupportForModel(registryEntry, modelId, providerName) : undefined;
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
