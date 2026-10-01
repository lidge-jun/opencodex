import { resolveComboId } from "../../combos/identifiers";
import { comboDependsOnProvider } from "../../combos/types";
import { previewRouteModel } from "../../router";
import type { OcxComboConfig, OcxConfig, OcxProviderConfig } from "../../types";
import { parseSyntheticRowId } from "../fast-row";

/** Resolve synthetic selectors using the same prospective config as route preview. */
export function normalizeDecisionModelSelector(config: OcxConfig, model: string): string {
  const parsed = parseSyntheticRowId(model, config);
  return parsed.fastRow?.baseId ?? parsed.effortRow?.baseId ?? model;
}

/**
 * Whether deleting provider `name` would leave `combo` invalid. Beyond the lexical check in
 * `comboDependsOnProvider`, a decision model is resolved the way routing resolves it, so a
 * provider alias (`judge/model`) or an unqualified model served by the default provider still
 * counts as a dependency instead of silently falling through to whatever routes it next.
 */
export function comboDependsOnProviderRoute(config: OcxConfig, combo: OcxComboConfig, name: string): boolean {
  if (comboDependsOnProvider(combo, name)) return true;
  if (typeof combo.decisionModel !== "string" || !combo.decisionModel.trim()) return false;
  const selector = normalizeDecisionModelSelector(config, combo.decisionModel.trim());
  const slash = selector.indexOf("/");
  const prefix = slash > 0 ? selector.slice(0, slash).toLowerCase() : "";
  if (prefix && (prefix === name.toLowerCase() || prefix === config.providers[name]?.alias?.toLowerCase())) return true;
  try {
    return previewRouteModel(config, selector).providerName === name;
  } catch {
    return false;
  }
}

/** Save-time validation uses preview routing, so it never advances combo selection state. */
export function decisionModelRouteError(config: OcxConfig, comboId: string | undefined, model: string): string | null {
  // Standalone decision-test probes have no saved combo identity yet.
  const subject = comboId ? `combo "${comboId}" decisionModel` : "decisionModel";
  const selector = normalizeDecisionModelSelector(config, model.trim());
  const referenced = resolveComboId(config, selector);
  if (referenced === comboId || (referenced && config.combos?.[referenced]?.strategy === "jev")) {
    return `${subject} must not reference ${referenced === comboId ? "itself" : "a JEV combo"} (combo "${referenced}")`;
  }
  try {
    const route = previewRouteModel(config, selector);
    // Match shadow-call validation: a qualified typo must not silently use the default row.
    if (route.routeKind === "default-provider" && selector.includes("/")) {
      return `${subject} must resolve to a configured provider`;
    }
    if (route.provider.adapter === "jev-decision") {
      return `${subject} must not route to a jev-decision provider`;
    }
    if (route.combo && (route.combo.comboId === comboId || config.combos?.[route.combo.comboId]?.strategy === "jev")) {
      return `${subject} must not route to JEV combo "${route.combo.comboId}"`;
    }
    return null;
  } catch {
    return `${subject} must resolve to a configured provider`;
  }
}

/** Adapter edits cannot turn a referenced inference row into a decision-only service. */
export function decisionModelProviderPatchError(config: OcxConfig, name: string, candidate: OcxProviderConfig): string | null {
  if (candidate.adapter !== "jev-decision") return null;
  const prospective = { ...config, providers: { ...config.providers, [name]: candidate } };
  for (const [id, combo] of Object.entries(config.combos ?? {})) {
    if (typeof combo.decisionModel !== "string") continue;
    const selector = normalizeDecisionModelSelector(config, combo.decisionModel.trim());
    const slash = selector.indexOf("/");
    const prefix = slash > 0 ? selector.slice(0, slash).toLowerCase() : "";
    const explicit = !!prefix && (prefix === name.toLowerCase() || prefix === config.providers[name]?.alias?.toLowerCase());
    // Unrelated unusable routes remain runtime fail-open cases. A qualified dependency
    // still counts when the old row is disabled and preview cannot resolve it.
    if (!explicit) {
      try { if (previewRouteModel(config, selector).providerName !== name) continue; }
      catch { continue; }
    }
    const error = decisionModelRouteError(prospective, id, combo.decisionModel);
    if (error) return error;
  }
  return null;
}
