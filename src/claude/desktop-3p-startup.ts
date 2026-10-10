/**
 * One build of the Desktop 3P alias registry from the startup discovery inputs.
 *
 * Startup builds the registry asynchronously so a slow provider cannot hold the proxy closed. A
 * consumer that needs decodable aliases before that build finishes — the Claude Code CLI picker,
 * whose catalog the CLI then caches for an hour — awaits the same in-flight build instead of
 * starting a second one, or starts it when none ran. Inputs match `/v1/models` (entitlement-admitted
 * native slugs plus catalog-visible routes), so both paths install the same registry.
 */
import type { OcxConfig } from "../types";
import { join } from "node:path";
import {
  buildDesktop3pRegistryPreserving,
  deriveDesktop3pWireMap,
  desktop3pRegistrySize,
  installDesktop3pWireMap,
  readDesktop3pWireMap,
} from "./desktop-3p";
import {
  isOwnedDesktopGatewayEntry,
  parseMetadata,
  resolveDesktop3pConfigLibraryPath,
  SAFE_DESKTOP_PROFILE_ID,
} from "./desktop-3p-library";

let pending: Promise<boolean> | null = null;
/** Set once a discovery build actually completed; a disk-seeded registry does not count as one. */
let discoveryInstalled = false;
let lastUnproductiveAt = -Infinity;
/** After a build fails or installs nothing, on-demand callers wait this long before retrying. */
export const DESKTOP_3P_REGISTRY_RETRY_MS = 30_000;

/** The owned profile id whose bytes the live Desktop config library currently applies, if any. */
function activeOwnedProfileId(libraryPath: string): string | null {
  try {
    const metadata = parseMetadata(join(libraryPath, "_meta.json"));
    const applied = metadata.entries.find(entry => entry?.id === metadata.appliedId && isOwnedDesktopGatewayEntry(entry));
    const owned = applied ?? metadata.entries.find(entry => isOwnedDesktopGatewayEntry(entry));
    const id = owned?.id;
    return typeof id === "string" && SAFE_DESKTOP_PROFILE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Seed the in-memory decoder from disk before discovery runs. Synchronous and network-free, so a
 * cold start whose upstream providers are not up yet can still decode the wire ids the on-disk
 * profile actually sends (managed wire ids that are neither date nor hash aliases, so an empty
 * registry cannot decode them). Two sources, in precedence order:
 *
 * 1. The persisted profile (`config.claudeCode.desktopProfile`) is replayed through the same
 *    slot allocator the writer used, so an install written before the sidecar existed still heals.
 * 2. The `.ocx-wire.json` sidecar (when present) overrides the derived rows with the exact table
 *    that was written, covering a route set the profile no longer reconstructs.
 *
 * Discovery then only ADDS. An absent library/profile is a silent no-op.
 */
export function seedDesktop3pRegistryFromDisk(config?: OcxConfig): void {
  try {
    // Match the writer's route set as closely as config alone allows. The writer renders the
    // catalog-visible routes, which exclude `disabledModels`; the profile's own assignments are the
    // remaining routes plus any stale ones. Dropping the same disabled routes keeps the replay's
    // slot allocation aligned with the bytes on disk for every route the operator has not since
    // removed from `providers`. A route deleted from `providers` while a slot is still reserved can
    // still shift a family's allocation; the sidecar covers that case exactly.
    const merged = config?.claudeCode?.desktopProfile
      ? deriveDesktop3pWireMap(config.claudeCode.desktopProfile, config.disabledModels ?? [])
      : new Map<string, string>();
    const libraryPath = resolveDesktop3pConfigLibraryPath();
    const id = activeOwnedProfileId(libraryPath);
    if (id) for (const [alias, route] of readDesktop3pWireMap(libraryPath, id)) merged.set(alias, route);
    installDesktop3pWireMap(merged);
  } catch {
    // Best-effort: an unreadable library just means discovery remains the only source.
  }
}

/** Build and install the registry; concurrent callers share one build. Resolves false on failure. */
export function initDesktop3pRegistry(config: OcxConfig): Promise<boolean> {
  pending ??= (async () => {
    // Seed from disk first: decodability of the on-disk profile's wire ids must not depend on
    // whether the upstream providers happen to be reachable at this instant.
    seedDesktop3pRegistryFromDisk(config);
    try {
      const { fetchAllModels } = await import("../server/management-api");
      const { desktopVisibleNativeSlugs } = await import("../codex/catalog");
      const { resolveAdmittedCodexModelEntitlements } = await import("../codex/model-entitlement-admission");
      const { buildDesktopDiscoveryInputs } = await import("./desktop-discovery-inputs");
      const [models, modelEntitlements] = await Promise.all([
        fetchAllModels(config),
        resolveAdmittedCodexModelEntitlements(config, { clientVersion: null }),
      ]);
      const inputs = buildDesktopDiscoveryInputs({
        config, models, modelEntitlements,
        desktopNativeCandidates: desktopVisibleNativeSlugs(config),
      });
      // Preserving: discovery only ADDS to the disk-seeded decoder, so a degraded discovery
      // cannot strip aliases the profile still sends. Mark discovery as installed only after a
      // real build, so a later on-demand caller still retries a cold start that ran while down.
      buildDesktop3pRegistryPreserving(inputs.nativeSlugs, inputs.routedModels, config.claudeCode?.desktopProfile, inputs.nativeContextCap);
      discoveryInstalled = true;
      if (desktop3pRegistrySize() === 0) lastUnproductiveAt = Date.now();
      return true;
    } catch {
      lastUnproductiveAt = Date.now();
      // Best-effort; model discovery can rebuild it. Never reflect credential or provider errors.
      console.warn("[opencodex] Claude Desktop model registry could not be initialized.");
      return false;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/**
 * Resolve once a build has installed the registry, starting one only when none ran or is running.
 * A failed or empty build is not retried on demand until the cooldown passes, so a broken provider
 * cannot turn every CLI catalog request into a fresh discovery and entitlement round.
 */
export async function ensureDesktop3pRegistry(readConfig: () => OcxConfig, now: () => number = Date.now): Promise<void> {
  if (pending) {
    await pending;
    return;
  }
  // A disk-seeded registry is decodable but not yet discovery-refreshed: keep the retry
  // available so a cold start that ran while providers were down still upgrades once they
  // recover. Only a completed discovery build short-circuits.
  if (discoveryInstalled) return;
  if (now() - lastUnproductiveAt < DESKTOP_3P_REGISTRY_RETRY_MS) return;
  await initDesktop3pRegistry(readConfig());
}
