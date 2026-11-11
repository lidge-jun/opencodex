
import { PROVIDER_REGISTRY } from "./registry";

export function effectiveProviderAlias(
  providerName: string,
  provider?: Pick<OcxProviderConfig, "alias">,
  config?: Pick<OcxConfig, "providers">,
): string | undefined {
  if (provider && provider.alias !== undefined) {
    const trimmed = provider.alias.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const regAlias = PROVIDER_REGISTRY.find(e => e.id === providerName)?.alias;
  if (!regAlias) return undefined;
  if (config?.providers) {
    const lower = regAlias.toLowerCase();
    const claimedByOther = Object.entries(config.providers).some(([name, p]) =>
      name !== providerName && (
        name.toLowerCase() === lower
        || (typeof p.alias === "string" && p.alias.trim().toLowerCase() === lower)
      )
    );
    if (claimedByOther) return undefined;
  }
  return regAlias;
}

export function effectiveProviderAliasDecision(
  providerName: string,
  provider?: Pick<OcxProviderConfig, "alias">,
  config?: Pick<OcxConfig, "providers">,
): string | null | undefined {
  const active = effectiveProviderAlias(providerName, provider, config);
  if (active !== undefined) return active;
  const hasRegistryAlias = Boolean(PROVIDER_REGISTRY.find(e => e.id === providerName)?.alias);
  const hasConfiguredAlias = provider?.alias !== undefined;
  if (hasRegistryAlias || hasConfiguredAlias) {
    return null;
  }
  return undefined;
}

import type { OcxConfig, OcxProviderConfig } from "../types";

import { expandAliasTemplate, MODEL_ALIAS_PATTERN, type AliasTemplateSkip } from "./alias-template";

export { MODEL_ALIAS_PATTERN };

/** Ordered, most-specific-first built-in aliases. Updated with the provider registry. */
export const DEFAULT_MODEL_ALIASES: ReadonlyArray<{ match: RegExp; alias: string }> = [
  { match: /^claude-opus-5/, alias: "opus" },
  { match: /^claude-sonnet-5/, alias: "sonnet" },
  { match: /^claude-haiku/, alias: "haiku" },
  { match: /^gemini-3(?:\.\d+)?-pro/, alias: "g3p" },
  { match: /^gemini-3(?:\.\d+)?-flash/, alias: "g3f" },
  // Ordered before the V4 rule on purpose: `builtinRule` takes the first match, and
  // `/^deepseek-v4/` also matches `deepseek-v4.1-flash`.
  { match: /^deepseek-v4\.1/, alias: "ds41" },
  { match: /^deepseek-v4/, alias: "ds4" },
  { match: /^deepseek-flash/, alias: "dsf" },
  { match: /^grok-4/, alias: "grok" },
];

export interface EffectiveModelAlias { alias: string; source: "user" | "builtin" | "template" }

function builtinRule(id: string): { match: RegExp; alias: string } | undefined {
  const tail = id.slice(id.lastIndexOf("/") + 1);
  return DEFAULT_MODEL_ALIASES.find(rule => rule.match.test(id) || rule.match.test(tail));
}

export function defaultAliasesEnabled(config: Pick<OcxConfig, "defaultModelAliases">, provider: OcxProviderConfig): boolean {
  return provider.defaultAliases ?? config.defaultModelAliases ?? false;
}

/** The parts of the config an alias view reads; `providers` and `combos` only matter to templates. */
export type AliasViewConfig = Pick<OcxConfig, "defaultModelAliases"> & Partial<Pick<OcxConfig, "providers" | "combos">>;

/**
 * Manual aliases, then built-in ones (when enabled), then the provider's opt-in template (#7705).
 * The template applies only when `providerName` is given, so a caller that does not pass it sees
 * exactly the view it always did.
 */
export function effectiveModelAliases(
  config: AliasViewConfig,
  provider: OcxProviderConfig,
  knownIds: Iterable<string>,
  providerName?: string,
): Map<string, EffectiveModelAlias> {
  const known = [...knownIds];
  const result = new Map<string, EffectiveModelAlias>();
  for (const [id, alias] of Object.entries(provider.modelAliases ?? {})) {
    if (typeof alias === "string" && MODEL_ALIAS_PATTERN.test(alias)) result.set(id, { alias, source: "user" });
  }
  if (defaultAliasesEnabled(config, provider)) {
    const claims = new Map<string, string[]>();
    for (const id of known) {
      if (result.has(id)) continue;
      const rule = builtinRule(id);
      if (!rule) continue;
      const key = rule.alias.toLowerCase();
      claims.set(key, [...(claims.get(key) ?? []), id]);
    }
    for (const [alias, ids] of claims) {
      if (ids.length !== 1) continue;
      const id = ids[0]!;
      // Catalog drift must skip, never shadow, a native id or explicit user alias.
      if (known.some(candidate => candidate.toLowerCase() === alias)) continue;
      if ([...result.values()].some(value => value.alias.toLowerCase() === alias)) continue;
      result.set(id, { alias: builtinRule(id)!.alias, source: "builtin" });
    }
  }
  if (providerName !== undefined && provider.aliasTemplate) {
    for (const [id, alias] of templateAliasPlan(config, provider, providerName, known, result).accepted) {
      result.set(id, { alias, source: "template" });
    }
  }
  return result;
}

export interface TemplateAliasPlan {
  accepted: Map<string, string>;
  skipped: Array<{ id: string; candidate?: string; reason: AliasTemplateSkip | "collision" | "reserved" }>;
}

/**
 * Template candidates for ids that have no manual or built-in alias. Every name already claimed is
 * reserved first: this provider's native ids and aliases, every built-in alias name, every
 * provider name and provider alias, other providers' manual aliases, and combo ids and aliases.
 * Two candidates that collide are both skipped, so the result does not depend on roster order;
 * nothing is ever renamed to make it fit.
 */
export function templateAliasPlan(
  config: AliasViewConfig,
  provider: OcxProviderConfig,
  providerName: string,
  knownIds: readonly string[],
  existing: ReadonlyMap<string, EffectiveModelAlias>,
): TemplateAliasPlan {
  const plan: TemplateAliasPlan = { accepted: new Map(), skipped: [] };
  const template = provider.aliasTemplate;
  if (!template) return plan;
  const providerAlias = config.providers
    ? effectiveProviderAlias(providerName, provider, config as Pick<OcxConfig, "providers">)
    : (provider.alias?.trim() || undefined);
  const reserved = new Set<string>();
  const reserve = (value: unknown) => { if (typeof value === "string" && value.trim()) reserved.add(value.trim().toLowerCase()); };
  for (const id of knownIds) reserve(id);
  for (const value of existing.values()) reserve(value.alias);
  for (const rule of DEFAULT_MODEL_ALIASES) reserve(rule.alias);
  for (const [name, other] of Object.entries(config.providers ?? {})) {
    reserve(name);
    reserve(other.alias);
    // A registry alias (`agy` for google-antigravity) names the provider even when it sets none.
    if (config.providers) reserve(effectiveProviderAlias(name, other, config as Pick<OcxConfig, "providers">));
    if (name !== providerName) for (const alias of Object.values(other.modelAliases ?? {})) reserve(alias);
  }
  for (const [id, combo] of Object.entries(config.combos ?? {})) { reserve(id); reserve((combo as { alias?: unknown }).alias); }
  const candidates = new Map<string, Array<{ id: string; alias: string }>>();
  for (const id of [...new Set(knownIds)].sort()) {
    if (existing.has(id)) continue;
    const expanded = expandAliasTemplate(template, providerAlias, id);
    if ("skip" in expanded) { plan.skipped.push({ id, reason: expanded.skip }); continue; }
    const key = expanded.alias.toLowerCase();
    candidates.set(key, [...(candidates.get(key) ?? []), { id, alias: expanded.alias }]);
  }
  for (const [key, rows] of candidates) {
    if (rows.length > 1) {
      for (const row of rows) plan.skipped.push({ id: row.id, candidate: row.alias, reason: "collision" });
    } else if (reserved.has(key)) {
      plan.skipped.push({ id: rows[0]!.id, candidate: rows[0]!.alias, reason: "reserved" });
    } else {
      plan.accepted.set(rows[0]!.id, rows[0]!.alias);
    }
  }
  plan.skipped.sort((a, b) => a.id.localeCompare(b.id));
  return plan;
}

export function resolveModelAlias(
  config: AliasViewConfig,
  provider: OcxProviderConfig,
  knownIds: Iterable<string>,
  requested: string,
  providerName?: string,
): string | undefined {
  const needle = requested.toLowerCase();
  return [...effectiveModelAliases(config, provider, knownIds, providerName)]
    .find(([, value]) => value.alias.toLowerCase() === needle)?.[0];
}
