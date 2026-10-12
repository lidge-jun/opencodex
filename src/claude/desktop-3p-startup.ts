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
import { buildDesktop3pRegistry, desktop3pRegistrySize } from "./desktop-3p";

let pending: Promise<boolean> | null = null;
let lastUnproductiveAt = -Infinity;
/** After a build fails or installs nothing, on-demand callers wait this long before retrying. */
export const DESKTOP_3P_REGISTRY_RETRY_MS = 30_000;

/** Build and install the registry; concurrent callers share one build. Resolves false on failure. */
export function initDesktop3pRegistry(config: OcxConfig): Promise<boolean> {
  pending ??= (async () => {
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
      buildDesktop3pRegistry(inputs.nativeSlugs, inputs.routedModels, config.claudeCode?.desktopProfile, inputs.nativeContextCap);
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
  if (desktop3pRegistrySize() > 0) return;
  if (now() - lastUnproductiveAt < DESKTOP_3P_REGISTRY_RETRY_MS) return;
  await initDesktop3pRegistry(readConfig());
}
