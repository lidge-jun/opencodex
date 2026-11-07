import { getDefaultConfig } from "./proxy-env";
import { DESKTOP_FAMILIES } from "../claude/desktop-profile";

const REMOVED_PROVIDER = "opencode-free";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Load projection, like the OpenCode wire upgrades: the next configuration save persists it. */
export function sanitizeRemovedOpenCodeFreeForLoad(parsed: unknown): boolean {
  const config = record(parsed);
  if (!config) return false;
  const providers = record(config.providers);
  const retiredProviders = new Set([REMOVED_PROVIDER]);
  const retiredRoutes = new Set<string>();
  let changed = false;
  if (providers) {
    for (const [name, value] of Object.entries(providers)) {
      const provider = record(value);
      if (name !== REMOVED_PROVIDER && ![provider?.adapter, provider?.type, provider?.id, provider?.preset, record(provider?.preset)?.id, provider?.presetId, provider?.providerType].includes(REMOVED_PROVIDER)) continue;
      retiredProviders.add(name);
      if (typeof provider?.alias === "string") retiredProviders.add(provider.alias.trim());
      delete providers[name];
      changed = true;
    }
  }
  const retired = (value: unknown): boolean => typeof value === "string"
    && (retiredProviders.has(value.trim()) || retiredProviders.has(value.trim().split("/")[0]!) || retiredRoutes.has(value.trim()));

  // Prune references in arrays/maps as well as structured provider/model targets. A decision
  // model is required operator intent: disable that combo instead of choosing another service.
  function prune(value: unknown, preserveContainer = false): unknown {
    if (retired(value)) { changed = true; return undefined; }
    if (Array.isArray(value)) return value.map(item => prune(item)).filter(item => item !== undefined);
    const row = record(value);
    if (!row) return value;
    if (!preserveContainer && [row.provider, row.model, row.decisionModel, row.decisionProvider].some(retired)) {
      changed = true;
      return undefined;
    }
    const hadTargets = Array.isArray(row.targets) && row.targets.length > 0;
    const hadCandidates = Array.isArray(row.candidates) && row.candidates.length > 0;
    const hadSourceModels = Array.isArray(row.sourceModels) && row.sourceModels.length > 0;
    for (const [key, child] of Object.entries(row)) {
      // Descriptions and credential/transport data are not model references.
      if (["note", "description", "displayName", "label", "modelProfile", "headers", "apiKey", "apiKeys", "baseUrl", "modelDisplayNames"].includes(key)) continue;
      const next = retired(key) ? undefined : prune(child);
      if (next === undefined) { delete row[key]; changed = true; }
      else row[key] = next;
    }
    // Empty combos/profiles cannot pass schema validation or execute a request.
    if ((hadTargets && Array.isArray(row.targets) && row.targets.length === 0)
      || (hadCandidates && Array.isArray(row.candidates) && row.candidates.length === 0)
      || (hadSourceModels && Array.isArray(row.sourceModels) && row.sourceModels.length === 0)) return undefined;
    return row;
  }

  // Register removed public aliases before pruning remaining references, including a
  // combo whose decision model points to another combo disabled later in the map.
  let removedRoute: boolean;
  do {
    removedRoute = false;
    for (const [section, namespace] of [["combos", "combo"], ["routingProfiles", "policy"]] as const) {
      const routes = record(config[section]);
      if (!routes) continue;
      for (const [id, value] of Object.entries(routes)) {
        const alias = record(value)?.alias;
        if (prune(value) !== undefined) continue;
        delete routes[id];
        retiredRoutes.add(`${namespace}/${id}`);
        if (typeof alias === "string") retiredRoutes.add(alias.trim());
        changed = removedRoute = true;
      }
    }
  } while (removedRoute);
  // A retired default falls back to the standard built-in OAuth route, without moving a
  // user's choice to a different billable provider. Preserve any configured OpenAI row.
  if (retired(config.defaultProvider)) {
    const defaults = getDefaultConfig();
    config.providers = { ...defaults.providers, ...providers };
    config.defaultProvider = defaults.defaultProvider;
    changed = true;
  }
  const depletedFallbacks = new Set(Object.entries(record(config.subagentModelFallbackByModel) ?? {})
    .filter(([, chain]) => Array.isArray(chain) && chain.some(retired)).map(([model]) => model));
  const desktopProfile = record(record(config.claudeCode)?.desktopProfile);
  const desktopAssignments = record(desktopProfile?.assignments);
  const desktopDefaults = record(desktopProfile?.defaults);
  const retiredDesktopRoute = Object.keys(desktopAssignments ?? {}).some(retired)
    || Object.values(desktopDefaults ?? {}).some(retired);
  if (retired(config.injectionModel)) {
    delete config.syncCodexSubagentDefaults;
    delete config.injectionEffort;
  }
  // These sidecars default on or inherit global settings when absent. Preserve the
  // off switch at both supported owners before pruning their retired model target.
  for (const owner of [config, record(config.claudeCode)]) {
    for (const key of ["visionSidecar", "webSearchSidecar"]) {
      const sidecar = record(owner?.[key]);
      if (!sidecar || !retired(sidecar.model)) continue;
      sidecar.enabled = false;
      delete sidecar.model;
      changed = true;
    }
  }
  for (const [key, value] of Object.entries(config)) {
    if (key === "providers" || !/model|provider|combo|routing|claudeCode|fallback|redirect|compaction|autoReview|advisor|tokenGuardian|images|codexRoleTiers|sidecar|shadowCallIntercept/i.test(key)) continue;
    const next = prune(value, key === "claudeCode");
    if (next === undefined) delete config[key];
    else config[key] = next;
  }
  // Desktop defaults require a member of their family, or null for an empty family.
  // Repair only profiles affected by this migration; unrelated invalid input still degrades.
  if (retiredDesktopRoute && desktopAssignments && desktopDefaults) {
    for (const family of DESKTOP_FAMILIES) {
      const current = desktopDefaults[family];
      if (typeof current === "string" && record(desktopAssignments[current])?.family === family) continue;
      desktopDefaults[family] = Object.keys(desktopAssignments)
        .filter(route => record(desktopAssignments[route])?.family === family).sort()[0] ?? null;
    }
  }
  if (providers) {
    for (const provider of Object.values(providers)) {
      const row = record(provider);
      if (!row) continue;
      for (const key of ["defaultModel", "autoReviewModel", "autoReviewModelOverrides"]) {
        const next = prune(row[key], key === "autoReviewModelOverrides");
        if (next === undefined) delete row[key];
        else row[key] = next;
      }
    }
  }
  const fallbacks = record(config.subagentModelFallbackByModel);
  if (fallbacks) {
    for (const [model, chain] of Object.entries(fallbacks)) {
      if (depletedFallbacks.has(model) && Array.isArray(chain) && chain.length === 0) delete fallbacks[model];
    }
  }
  return changed;
}
