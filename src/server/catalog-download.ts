/**
 * Shared serialization for the model catalog, used by both the management route
 * (`GET /api/catalog`) and the least-privilege data-plane route
 * (`GET|HEAD /v1/catalog`, issue #809).
 *
 * The point of the shared module is that the two routes must emit the *same
 * bytes*. A remote Codex client previously had to be handed an admin token just
 * to read the catalog, which is the least-privilege violation #809 is about; the
 * fix is a second route on the data plane, never a widened management boundary.
 * If each route serialized independently they would drift, and the data-plane
 * copy is the one nobody looks at in the dashboard.
 */
import { catalogEtag } from "../lib/catalog-etag";
import type { OcxConfig } from "../types";
import type { RawCatalog } from "../codex/catalog/parsing";

import { discoveredNativeOpenAiModels } from "../codex/catalog/native-models";
import { applyFullModelPickerOrder, buildCatalogEntriesFromObservedState } from "../codex/catalog/build-entries";
import { applyNativeVisibility, desktopAllowlistSuppressedNativeSlugs, nativeContextLimits,
    shouldIncludeNativeOpenAi, shouldIncludeAccountBoundNativeOpenAi, upstreamNativeEntry } from "../codex/catalog/metadata";
import { websocketsEnabled } from "../config/feature-flags";
import { resolveMultiAgentMode } from "../config/multi-agent-surface";

import { trustedAccountBoundNativeCatalogSlug, visibleCodexAccountSelectors } from "../codex/catalog/account-models";
import { discoveredNativeModelsGeneration } from "../codex/catalog/discovered-natives";

/** In-memory cache identity: only public projection policy, never credentials or full model rows. */
export function catalogProjectionKey(config: OcxConfig): string {
  if (config.runtimeRole !== "hub") return "persisted";
  return JSON.stringify(["hub", discoveredNativeModelsGeneration(), nativeContextLimits(config),
    config.disabledModels, [...desktopAllowlistSuppressedNativeSlugs(config)], shouldIncludeNativeOpenAi(config),
    shouldIncludeAccountBoundNativeOpenAi(config), visibleCodexAccountSelectors(config), config.subagentModels,
    config.modelPickerOrder, websocketsEnabled(config), resolveMultiAgentMode(config), config.keepNativeChatGptOnV1]);
}

export { catalogEtag };

/**
 * Upper bound for the REMOTE route only.
 *
 * The first version of this used 32 MiB and applied it to both routes, which was
 * wrong twice over. The repository supports up to 2,000 discovered models, and a
 * 2,000-row catalog serializes to roughly 92 MB — so 32 MiB rejected a valid
 * supported catalog, and applying it to `/api/catalog` turned a working
 * management response into a 507 for those operators.
 *
 * 256 MiB clears the supported bound with room to spare while still refusing a
 * file that could only be corrupt or hostile. The management route is not
 * subject to it at all: it is a local dashboard read whose behavior predates
 * this module and must not change.
 */
export const MAX_REMOTE_CATALOG_BYTES = 256 * 1024 * 1024;

export interface SerializedCatalog {
  /** Serialized catalog JSON, or null when no catalog could be materialized. */
  body: string | null;
  /** Strong ETag over `body`, present only when `body` is. */
  etag?: string;
  /** Byte length of `body`, present only when `body` is. */
  bytes?: number;
}

/**
 * Read the persisted catalog and overlay server-owned hub discoveries.
 *
 * Returns `{ body: null }` for every unreadable case — absent file, unreadable
 * file, malformed JSON — because `readCatalog` already collapses those into
 * `null` and the routes render them identically as a 404. Distinguishing them
 * here would invite one route to leak a filesystem path in an error message.
 *
 * Deliberately does NOT apply a size ceiling: a size policy belongs to the route
 * that serves the bytes, not to the shared serializer both planes depend on.
 */
export async function serializePersistedCatalog(config?: OcxConfig): Promise<SerializedCatalog> {
  const { readCatalog, readCodexCatalogPath } = await import("../codex/catalog");
  const persisted = readCatalog(readCodexCatalogPath());
  const catalog = config?.runtimeRole === "hub" ? projectHubDiscoveries(persisted, config) : persisted;
  if (!catalog) return { body: null };
  const body = JSON.stringify(catalog);
  const bytes = Buffer.byteLength(body, "utf8");
  return { body, etag: catalogEtag(body), bytes };
}

/** Project server-owned discovery without materializing or rewriting the host's Codex files. */
export function projectHubDiscoveries(catalog: RawCatalog | null, config: OcxConfig): RawCatalog | null {
  if (!catalog) return null;
  const existing = catalog.models ?? [];
  // Converged rows already carry runtime clamps, account policy and user presentation.
  // Fill gaps only: discovery must never replace those finalized rows.
  const occupied = new Set(existing.map(entry => String(entry.slug)));
  const suppressed = desktopAllowlistSuppressedNativeSlugs(config);
  const selectors = shouldIncludeAccountBoundNativeOpenAi(config) ? visibleCodexAccountSelectors(config) : [];
  const slugs = shouldIncludeNativeOpenAi(config)
    ? discoveredNativeOpenAiModels().filter(slug => upstreamNativeEntry(slug) !== null).sort() : [];
  if (slugs.length === 0) return catalog;
  const entries = buildCatalogEntriesFromObservedState({
    template: null, gptSlugs: slugs, goModels: [], featured: config.subagentModels,
    wsEnabled: websocketsEnabled(config), multiAgentMode: resolveMultiAgentMode(config),
    keepNativeChatGptOnV1: config.keepNativeChatGptOnV1 === true,
    exactComboSlugs: new Set(), accountSelectors: selectors, suppressedBareNativeSlugs: suppressed,
    disabledNativeAccountSlugs: new Set((config.disabledModels ?? []).filter(slug => suppressed.has(slug))), multiAgentV2Enabled: false,
    openaiContextCap: nativeContextLimits(config),
  }).filter(entry => typeof entry.slug === "string" && !occupied.has(entry.slug)
    && slugs.includes(trustedAccountBoundNativeCatalogSlug(entry) ?? entry.slug));
  applyNativeVisibility(entries, new Set(config.disabledModels ?? []), selectors.length > 0);
  applyFullModelPickerOrder(entries, config.modelPickerOrder ?? []);
  return { ...catalog, models: [...existing, ...entries] };
}

/**
 * The authoritative Codex version for a catalog response, or undefined.
 *
 * Never fabricated: when no runtime is persisted the header is omitted rather
 * than guessed, so a client cannot mistake "unknown" for a specific version.
 */
export async function persistedCodexVersion(): Promise<string | undefined> {
  const { loadPersistedCodexRuntime } = await import("../codex/runtime");
  return loadPersistedCodexRuntime()?.selectedVersion ?? undefined;
}
