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
      return true;
    } catch {
      // Best-effort; model discovery can rebuild it. Never reflect credential or provider errors.
      console.warn("[opencodex] Claude Desktop model registry could not be initialized.");
      return false;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** Resolve once a build has installed the registry, starting one only when none ran or is running. */
export async function ensureDesktop3pRegistry(readConfig: () => OcxConfig): Promise<void> {
  if (pending) {
    await pending;
    return;
  }
  if (desktop3pRegistrySize() > 0) return;
  await initDesktop3pRegistry(readConfig());
}

