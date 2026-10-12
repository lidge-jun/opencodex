/**
 * Which configured provider rows can serve as a JEV decision service. Mirrors what the server
 * accepts (src/combos/types.ts comboConfigIssues) and what it will actually call
 * (src/combos/jev.ts jevDecisionEndpoint), so the dashboard never offers a row that a save would
 * reject or the runtime would silently ignore.
 */
import {
  CANONICAL_JEV_DECISION_PROVIDER,
  isSystemOneEndpoint,
} from "../../src/combos/jev-decision-contract";
import type { TKey } from "./i18n/shared";

export {
  CANONICAL_JEV_DECISION_PROVIDER,
  JEV_DECISION_TIMEOUT_DEFAULT_MS,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
} from "../../src/combos/jev-decision-contract";

export interface JevDecisionRow {
  adapter?: string;
  baseUrl?: string;
  disabled?: boolean;
  defaultModel?: string;
  models?: readonly string[];
}

/**
 * Why a self-hosted decision service is unusable. The management API rejects every issue on save;
 * config-file load rejects only `missing`, `notDecision` and `endpoint` (the runtime skips the rest).
 */
export type JevDecisionIssue = "missing" | "notDecision" | "disabled" | "endpoint" | "model";

export function jevDecisionRowIssue(row: JevDecisionRow | undefined): JevDecisionIssue | null {
  if (!row) return "missing";
  if (row.adapter !== "jev-decision") return "notDecision";
  if (row.disabled === true) return "disabled";
  if (!isSystemOneEndpoint(row.baseUrl ?? "")) return "endpoint";
  if (!row.defaultModel?.trim() && !row.models?.[0]?.trim()) return "model";
  return null;
}

/**
 * Whether a provider row offers "Create JEV Auto". The canonical `jev` row needs its TypeSafe
 * key; a self-hosted row may be keyless (e.g. a loopback Ollama endpoint) but must be usable.
 */
export function canCreateJevAutoFrom(row: JevDecisionRow & { name: string; hasApiKey?: boolean }): boolean {
  if (row.name === CANONICAL_JEV_DECISION_PROVIDER) {
    return row.adapter === "jev-decision" && row.disabled !== true && row.hasApiKey === true;
  }
  return jevDecisionRowIssue(row) === null;
}


export type JevDecisionMethod = "typesafe" | "systemone" | "model";

/** Stats rows and Test results name the backend that answered; unknown covers rows older than backends. */
export const JEV_BACKEND_LABEL_KEYS: Readonly<Record<string, TKey>> = {
  typesafe: "cws.jev.backend.typesafe",
  systemone: "cws.jev.backend.systemone",
  model: "cws.jev.backend.model",
  unknown: "cws.jev.backend.unknown",
};

/** Empty strings retain an unsaved method selection until its required field is filled. */
export function jevDecisionMethod(item: { decisionProvider?: string | null; decisionModel?: string | null }): JevDecisionMethod {
  if (item.decisionModel != null) return "model";
  if (item.decisionProvider != null && item.decisionProvider.trim() !== CANONICAL_JEV_DECISION_PROVIDER) return "systemone";
  return "typesafe";
}

export function jevDecisionModelForbidden(
  route: string,
  combos: readonly { id: string; alias?: string | null; model?: string; strategy: string }[],
  current?: { id: string; alias?: string | null; model?: string },
): boolean {
  const value = route.trim();
  const matches = (combo: { id: string; alias?: string | null; model?: string }) =>
    value === `combo/${combo.id.trim()}` || !!combo.alias?.trim() && value === combo.alias.trim()
    || !!combo.model?.trim() && value === combo.model.trim();
  return !!current && matches(current) || combos.some(combo => combo.strategy === "jev" && matches(combo));
}

/** Catalog models are independent of the target picker, which also injects provider defaults. */
export function jevDecisionModelOptions(
  models: readonly { provider: string; id: string; namespaced?: string; disabled?: boolean }[],
  providers: readonly (JevDecisionRow & { name: string })[],
  combos: readonly { id: string; alias?: string | null; model: string; strategy: string }[],
  current?: { id: string; alias?: string | null; model?: string },
): string[] {
  const enabled = new Set(providers.filter(row => !row.disabled && row.adapter !== "jev-decision").map(row => row.name));
  const routes = models.filter(row => !row.disabled && row.provider !== "combo" && enabled.has(row.provider))
    .map(row => row.namespaced?.trim() || `${row.provider}/${row.id}`);
  routes.push(...combos.filter(combo => combo.strategy !== "jev").map(combo => combo.model));
  return [...new Set(routes)].filter(route => !jevDecisionModelForbidden(route, combos, current))
    .sort((a, b) => a.localeCompare(b));
}
