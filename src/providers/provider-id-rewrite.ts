import type { OcxConfig } from "../types";
import { deleteConfigTopLevelKey } from "../config/rebase-provenance";

export interface ProviderRewriteResult {
  /** Number of references re-pointed. */
  changed: number;
  /**
   * Sites where the destination key already held a value, left untouched. A
   * non-empty list means the caller must not treat the rewrite as complete —
   * merging two settings is not a decision this function can make. The function
   * is NOT transactional: earlier sites are already rewritten by the time a
   * collision is found, so a caller that receives collisions must discard the
   * config it passed in.
   */
  collisions: string[];
}

/**
 * Re-point every config reference from one provider id to another.
 *
 * Three shapes exist and the difference matters: routed model strings
 * (`"<provider>/<model>"`), bare provider ids (`customModels[].provider`,
 * `combos[*].targets[].provider`), and keys that ARE provider ids or routes
 * (`providerContextCaps`, `claudeCode.desktopProfile.assignments`). A rewrite
 * that handles only the first leaves an orphaned context cap and — worse — a
 * combo target naming a provider that no longer exists, which fails validation
 * in `src/combos/types.ts` and makes `loadConfig` discard the whole config.
 *
 * `providers[*].selectedModels` is deliberately NOT rewritten: those are
 * per-provider native model ids, and upstream ids may themselves contain a
 * slash, so a prefix rewrite could mangle an unrelated provider's allowlist. A
 * caller that moves a provider row handles its own allowlist, where the
 * destination catalog is known.
 */
export function rewriteProviderReferences(config: OcxConfig, from: string, to: string): ProviderRewriteResult {
  const prefix = `${from}/`;
  const collisions: string[] = [];
  let changed = 0;

  /** Routed string: rewrite only an exact `<from>/…` prefix, never a longer id. */
  const route = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
    changed += 1;
    return `${to}/${value.slice(prefix.length)}`;
  };

  /**
   * Rewrite a routed-string list in place. Assigning the result unconditionally
   * would add an own property with value `undefined` where the field was absent,
   * which breaks the no-op contract. The key type is an explicit union rather
   * than `keyof OcxConfig`: the latter also admits `customModels` and friends, so
   * `map` would infer a union array that is not assignable back.
   */
  type RoutedListKey = "disabledModels" | "subagentModels" | "subagentModelFallback";
  const routeListAt = (key: RoutedListKey): void => {
    const list = config[key];
    if (!list) return;
    config[key] = list.map(id => route(id) ?? id);
  };

  const routeRecordValues = (record: Record<string, string> | undefined): void => {
    if (!record) return;
    for (const [key, value] of Object.entries(record)) {
      const next = route(value);
      if (next) record[key] = next;
    }
  };

  if (config.defaultProvider === from) {
    config.defaultProvider = to;
    changed += 1;
  }

  routeListAt("disabledModels");
  routeListAt("subagentModels");
  routeListAt("subagentModelFallback");

  const scalarOwners: Array<[Record<string, unknown> | undefined, string]> = [
    [config as unknown as Record<string, unknown>, "injectionModel"],
    [config.shadowCallIntercept as Record<string, unknown> | undefined, "model"],
    [config.webSearchSidecar as Record<string, unknown> | undefined, "model"],
    [config.visionSidecar as Record<string, unknown> | undefined, "model"],
    [config.claudeCode as unknown as Record<string, unknown> | undefined, "model"],
    [config.claudeCode as unknown as Record<string, unknown> | undefined, "smallFastModel"],
    [config.claudeCode?.webSearchSidecar as Record<string, unknown> | undefined, "model"],
    [config.claudeCode?.visionSidecar as Record<string, unknown> | undefined, "model"],
  ];
  for (const [owner, key] of scalarOwners) {
    if (!owner) continue;
    const next = route(owner[key]);
    if (next) owner[key] = next;
  }

  routeRecordValues(config.claudeCode?.tierModels as Record<string, string> | undefined);
  routeRecordValues(config.claudeCode?.modelMap as Record<string, string> | undefined);

  // Bare provider ids.
  for (const model of config.customModels ?? []) {
    if (model.provider === from) {
      model.provider = to;
      changed += 1;
    }
  }
  for (const combo of Object.values(config.combos ?? {})) {
    for (const target of combo.targets ?? []) {
      if (target.provider === from) {
        target.provider = to;
        changed += 1;
      }
    }
  }

  // Keys. `providerContextCaps` is KEYED by provider id — a prefix rewrite would
  // silently orphan the cap — and a destination key may already be occupied.
  const caps = config.providerContextCaps;
  if (caps && Object.hasOwn(caps, from)) {
    if (Object.hasOwn(caps, to)) {
      collisions.push(`providerContextCaps.${to}`);
    } else {
      caps[to] = caps[from]!;
      delete caps[from];
      changed += 1;
    }
  }

  // `desktopProfile` is nested and asymmetric: `assignments` is KEYED by route
  // while `defaults` holds routes as VALUES.
  const profile = config.claudeCode?.desktopProfile;
  if (profile) {
    for (const key of Object.keys(profile.assignments ?? {})) {
      const next = route(key);
      if (!next) continue;
      if (Object.hasOwn(profile.assignments, next)) {
        changed -= 1; // `route` counted it; the move did not happen.
        collisions.push(`claudeCode.desktopProfile.assignments.${next}`);
        continue;
      }
      profile.assignments[next] = profile.assignments[key]!;
      delete profile.assignments[key];
    }
    const defaults = profile.defaults as Record<string, string | null> | undefined;
    if (defaults) {
      for (const [family, value] of Object.entries(defaults)) {
        const next = route(value);
        if (next) defaults[family] = next;
      }
    }
  }

  return { changed, collisions };
}

/**
 * Drop the custom-model rows that belonged to a provider being removed.
 *
 * The sibling of the rename pass above. `rewriteProviderReferences` already
 * carries `customModels[].provider` across a rename, so the array tracks the
 * provider lifecycle — but removal used to delete only `config.providers[name]`
 * and leave the rows behind. Those orphans still reach `/api/models` and the
 * generated Codex catalog, which key on the row rather than on provider
 * existence, so they surface as models that resolve to nothing (#1273).
 *
 * Only the rows are touched: the `customModelCatalogMigration` marker records
 * one-time ownership of pre-marker rows and must survive removal unchanged, or
 * an older binary's view of that ownership silently changes.
 *
 * Returns the number of rows dropped so callers can report it.
 */
export function dropProviderCustomModels(config: OcxConfig, provider: string): number {
  const existing = config.customModels;
  if (!Array.isArray(existing) || existing.length === 0) return 0;
  const kept = existing.filter(model => model.provider !== provider);
  if (kept.length === existing.length) return 0;
  // Match the add/remove routes: an emptied list is dropped rather than left as
  // `[]`, so the `customModels` field is absent either way. Only that field —
  // the `customModelCatalogMigration` marker is deliberately left in place.
  if (kept.length > 0) config.customModels = kept;
  else deleteConfigTopLevelKey(config, "customModels");
  return existing.length - kept.length;
}
