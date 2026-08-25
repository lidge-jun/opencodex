import type { OcxConfig } from "../types";
import { routedSlug } from "./slug-codec";

export const MODEL_REMOVAL_GRACE_FETCHES = 3;
export const MAX_KNOWN_MODELS_PER_PROVIDER = 2_000;
export const MAX_RECENT_ARRIVALS_PER_PROVIDER = 50;

export type KnownModelBaseline = NonNullable<NonNullable<OcxConfig["modelDiscovery"]>["knownModels"]>[string];
export type NewModelPolicy = "on" | "off";

export interface NewModelPolicyResult {
  newIds: string[];
  nextBaseline: KnownModelBaseline;
  slugsToDisable: string[];
  arrivals: Array<{ id: string; at: string }>;
  overflow: boolean;
}

/**
 * Whether a transition actually changes persisted state.
 *
 * `updatedAt` moves on every successful fetch, so comparing whole baselines would report a
 * change every time and rewrite config.json on every catalog convergence — a write amplification
 * that also churns the config generation other writers revalidate against. Only the fields that
 * carry meaning are compared.
 */
function baselineDiffers(prior: KnownModelBaseline | undefined, next: KnownModelBaseline): boolean {
  if (!prior) return true;
  const sameList = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  if (!sameList(prior.ids, next.ids) || !sameList(prior.removed, next.removed)) return true;
  const priorMissing = prior.missing ?? {};
  const nextMissing = next.missing ?? {};
  const keys = new Set([...Object.keys(priorMissing), ...Object.keys(nextMissing)]);
  for (const key of keys) if (priorMissing[key] !== nextMissing[key]) return true;
  return false;
}

/** Pure successful-discovery transition. An absent baseline bootstraps without hiding anything. */
export function applyNewModelPolicy(options: {
  provider: string;
  discoveredIds: Iterable<string>;
  baseline?: KnownModelBaseline;
  policy: NewModelPolicy;
  hasSelectedModels?: boolean;
  now: string;
}): NewModelPolicyResult {
  const discovered = [...new Set(options.discoveredIds)].sort();
  const prior = options.baseline;
  if (!prior) {
    return {
      newIds: [],
      nextBaseline: { ids: discovered, removed: [], updatedAt: options.now },
      slugsToDisable: [], arrivals: [],
      overflow: discovered.length > MAX_KNOWN_MODELS_PER_PROVIDER,
    };
  }
  const active = new Set(prior.ids);
  const removed = new Set(prior.removed);
  const seen = new Set(discovered);
  const newIds = discovered.filter(id => !active.has(id) && !removed.has(id));
  const missing: Record<string, number> = {};
  for (const id of active) {
    if (seen.has(id)) continue;
    const count = (prior.missing?.[id] ?? 0) + 1;
    if (count >= MODEL_REMOVAL_GRACE_FETCHES) {
      active.delete(id);
      removed.add(id);
    } else missing[id] = count;
  }
  for (const id of discovered) active.add(id);
  const unionSize = active.size + removed.size;
  const overflow = unionSize > MAX_KNOWN_MODELS_PER_PROVIDER;
  const arrivals = newIds.map(id => ({ id, at: options.now }));
  return {
    newIds,
    nextBaseline: {
      ids: [...active].sort(), removed: [...removed].sort(), updatedAt: options.now,
      ...(Object.keys(missing).length ? { missing } : {}),
    },
    // A non-empty preset/custom allowlist already excludes arrivals. This explicit no-op is
    // deliberate: preset mode owns which matching flagships arrive on.
    slugsToDisable: !overflow && options.policy === "off" && !options.hasSelectedModels
      ? newIds.map(id => routedSlug(options.provider, id)) : [],
    arrivals,
    overflow,
  };
}

export function effectiveNewModelPolicy(config: OcxConfig, provider: string): NewModelPolicy {
  const local = config.providers[provider]?.newModelPolicy;
  if (local === "on" || local === "off") return local;
  return config.modelDiscovery?.newModelPolicy ?? "on";
}

/** Apply authoritative provider rows to a mutable convergence copy; degraded providers are omitted. */
export function reconcileSuccessfulModelDiscoveries(options: {
  config: OcxConfig;
  models: Iterable<{ provider: string; id: string; custom?: boolean }>;
  authoritativeProviders: Iterable<string>;
  now: string;
}): boolean {
  const byProvider = new Map<string, string[]>();
  for (const model of options.models) {
    if (model.custom) continue;
    const ids = byProvider.get(model.provider) ?? [];
    ids.push(model.id); byProvider.set(model.provider, ids);
  }
  let changed = false;
  for (const provider of options.authoritativeProviders) {
    const configured = options.config.providers[provider];
    if (!configured || configured.liveModels === false) continue;
    const discoveredIds = byProvider.get(provider) ?? [];
    const discovery = options.config.modelDiscovery ??= {};
    const known = discovery.knownModels ??= {};
    const result = applyNewModelPolicy({
      provider, discoveredIds, baseline: known[provider],
      policy: effectiveNewModelPolicy(options.config, provider),
      hasSelectedModels: (configured.selectedModels?.length ?? 0) > 0,
      now: options.now,
    });
    if (result.overflow) continue;
    const priorBaseline = known[provider];
    const baselineChanged = baselineDiffers(priorBaseline, result.nextBaseline);
    known[provider] = result.nextBaseline;
    // Keep the previous timestamp when nothing else moved, so a steady-state roster does not
    // make the baseline look dirty on the next comparison either.
    if (!baselineChanged && priorBaseline) known[provider] = priorBaseline;
    if (result.slugsToDisable.length) {
      const disabled = options.config.disabledModels ??= [];
      for (const slug of result.slugsToDisable) {
        if (disabled.includes(slug)) continue;
        disabled.push(slug);
        changed = true;
      }
    }
    if (result.arrivals.length) {
      const recent = discovery.recentArrivals ??= {};
      recent[provider] = [...(recent[provider] ?? []), ...result.arrivals]
        .slice(-MAX_RECENT_ARRIVALS_PER_PROVIDER);
      changed = true;
    }
    if (baselineChanged) changed = true;
  }
  return changed;
}
