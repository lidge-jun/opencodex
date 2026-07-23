/**
 * Shared Grok Build config sync: gather the visible model catalog and (re)inject the
 * managed block into ~/.grok/config.toml. Used by `ocx start` (server process) and by
 * `ocx ensure` / `ocx restart` (parent process, after live discovery or child readiness)
 * so the fence exists deterministically once the proxy reports healthy.
 *
 * Deps are injectable (mirrors src/codex/sync.ts) so tests can run without a live proxy.
 */
import { visibleNativeSlugs, filterCatalogVisibleModels, type CatalogModel } from "../codex/catalog";
import type { OcxConfig } from "../types";
import { injectGrokConfig, type GrokInjectModel, type GrokInjectResult } from "./inject";

export interface GrokSyncDeps {
  fetchAllModels: (config: OcxConfig) => Promise<CatalogModel[]>;
  injectGrokConfig: typeof injectGrokConfig;
}

async function defaultFetchAllModels(config: OcxConfig): Promise<CatalogModel[]> {
  const { fetchAllModels } = await import("../server/management-api");
  return fetchAllModels(config);
}

/**
 * Build the model list and inject the fenced block. `hostname` should be the hostname the
 * RUNNING proxy actually bound (live.hostname from proxy-liveness for ensure's live branch;
 * config.hostname for a freshly spawned start) — a stale config.hostname could otherwise
 * name a host the process never bound.
 */
export async function syncGrokConfig(
  port: number,
  config: OcxConfig,
  opts: { hostname?: string; grokHome?: string } = {},
  deps: GrokSyncDeps = { fetchAllModels: defaultFetchAllModels, injectGrokConfig },
): Promise<GrokInjectResult> {
  let models: GrokInjectModel[];
  try {
    const routed = filterCatalogVisibleModels(await deps.fetchAllModels(config), config);
    models = [
      ...visibleNativeSlugs(config).map(id => ({ id })),
      ...routed.map(m => ({
        id: m.alias ?? `${m.provider}/${m.id}`,
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      })),
    ];
  } catch (err) {
    return {
      ok: false,
      changed: false,
      message: `Grok config sync skipped: model catalog unavailable (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  return deps.injectGrokConfig(port, models, {
    ...(opts.hostname !== undefined ? { hostname: opts.hostname } : {}),
    ...(opts.grokHome !== undefined ? { grokHome: opts.grokHome } : {}),
  });
}
