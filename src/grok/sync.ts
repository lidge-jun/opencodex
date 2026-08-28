/**
 * Shared Grok Build config sync: gather the visible model catalog and (re)inject the
 * managed block into ~/.grok/config.toml. Used by `ocx start` (server process) and by
 * `ocx ensure` / `ocx restart` (parent process, after live discovery or child readiness)
 * so the fence exists deterministically once the proxy reports healthy.
 *
 * Deps are injectable (mirrors src/codex/sync.ts) so tests can run without a live proxy.
 */
import type { CatalogModel } from "../codex/catalog";
import type { OcxConfig } from "../types";
import { projectGrokCatalog } from "./catalog";
import { injectGrokConfig, type GrokInjectResult } from "./inject";

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
  let projection: ReturnType<typeof projectGrokCatalog>;
  try {
    const allRouted = await deps.fetchAllModels(config);
    projection = projectGrokCatalog(allRouted, config);
  } catch (err) {
    return {
      ok: false,
      changed: false,
      message: `Grok config sync skipped: model catalog unavailable (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  // Pass the FULL list plus the exclusion set: the writer allocates aliases over
  // everything and emits only what is switched on, so a model's alias never depends on
  // its neighbours' switches. Absent/empty selection keeps today's behaviour exactly.
  return deps.injectGrokConfig(port, projection.models, {
    ...(opts.hostname !== undefined ? { hostname: opts.hostname } : {}),
    ...(opts.grokHome !== undefined ? { grokHome: opts.grokHome } : {}),
    excluded: new Set(config.grokExcludedModels ?? []),
    catalogModelIds: projection.catalogModelIds,
    disabledProviderNamespaces: projection.disabledProviderNamespaces,
    comboPublicModelIds: projection.comboPublicModelIds,
  });
}
