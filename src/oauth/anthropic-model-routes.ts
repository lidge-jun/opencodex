import type { AnthropicModelRoute, OcxConfig } from "../types/config";

export interface AnthropicRouteDecision {
  /** One-based position in the saved rule list; safe for request logs. */
  position: number;
  accounts: readonly string[];
  fallback: boolean;
}

type ParseResult = { ok: true; routes: AnthropicModelRoute[] } | { ok: false; error: string };
export type AnthropicRoutesRead = { routes: AnthropicModelRoute[] | null; routesError?: string };
const MAX_ROUTES = 32;
const MAX_ACCOUNTS = 32;
const MAX_TEXT = 128;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PATTERN = /^[A-Za-z0-9_./:*?-]+$/;

/** Validate the stored rule, not current roster membership: re-adding an account restores it. */
export function parseAnthropicModelRoutes(raw: unknown): ParseResult {
  if (!Array.isArray(raw) || raw.length > MAX_ROUTES) {
    return { ok: false, error: `routes must be an array of at most ${MAX_ROUTES} rules` };
  }
  const names = new Set<string>();
  const patterns = new Set<string>();
  const routes: AnthropicModelRoute[] = [];
  for (const [index, value] of raw.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: `routes[${index}] must be an object` };
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !["name", "match", "accounts", "fallback"].includes(key))) {
      return { ok: false, error: `routes[${index}] has an unknown field` };
    }
    if (typeof row.name !== "string" || !NAME.test(row.name) || names.has(row.name)) {
      return { ok: false, error: `routes[${index}].name must be unique, nonempty and at most 64 safe characters` };
    }
    if (typeof row.match !== "string" || !row.match || row.match.length > MAX_TEXT
      || !PATTERN.test(row.match) || patterns.has(row.match)) {
      return { ok: false, error: `routes[${index}].match must be a unique model glob of at most ${MAX_TEXT} characters` };
    }
    if (!Array.isArray(row.accounts) || row.accounts.length < 1 || row.accounts.length > MAX_ACCOUNTS
      || row.accounts.some(id => typeof id !== "string" || !id || id.length > MAX_TEXT || id.trim() !== id || /[\x00-\x1f\x7f]/.test(id))
      || new Set(row.accounts).size !== row.accounts.length) {
      return { ok: false, error: `routes[${index}].accounts must contain 1-${MAX_ACCOUNTS} unique stored IDs` };
    }
    if (row.fallback !== undefined && typeof row.fallback !== "boolean") {
      return { ok: false, error: `routes[${index}].fallback must be boolean` };
    }
    names.add(row.name);
    patterns.add(row.match);
    routes.push({ name: row.name, match: row.match, accounts: [...row.accounts], ...(row.fallback === undefined ? {} : { fallback: row.fallback }) });
  }
  return { ok: true, routes };
}

/** A malformed hand edit stays on disk for correction, but must never look valid to readers. */
export function readAnthropicModelRoutes(raw: unknown): AnthropicRoutesRead {
  if (raw === undefined) return { routes: null };
  const parsed = parseAnthropicModelRoutes(raw);
  return parsed.ok ? { routes: parsed.routes } : { routes: null, routesError: parsed.error };
}

function matches(pattern: string, modelId: string): boolean {
  // Linear wildcard matching avoids regex backtracking on operator-declared glob strings.
  let p = 0;
  let m = 0;
  let star = -1;
  let resume = 0;
  while (m < modelId.length) {
    if (p < pattern.length && (pattern[p] === modelId[m] || pattern[p] === "?")) {
      p++; m++;
    } else if (pattern[p] === "*") {
      star = p++;
      resume = m;
    } else if (star >= 0) {
      p = star + 1;
      m = ++resume;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

export function resolveAnthropicModelRoute(
  config: OcxConfig,
  modelId: string,
): { decision: AnthropicRouteDecision | null; error?: string } {
  if (config.anthropicAccountPool?.enabled !== true) return { decision: null };
  const raw = (config.anthropicAccountPool as { routes?: unknown } | undefined)?.routes;
  if (raw === undefined) return { decision: null };
  const parsed = parseAnthropicModelRoutes(raw);
  if (!parsed.ok) return { decision: null, error: parsed.error };
  for (const [index, route] of parsed.routes.entries()) {
    if (matches(route.match, modelId)) {
      return { decision: { position: index + 1, accounts: route.accounts, fallback: route.fallback === true } };
    }
  }
  return { decision: null };
}

/** Preserve declared account order; widen only when the routed set is empty. */
export function routeCandidates(eligible: readonly string[], decision: AnthropicRouteDecision | null): string[] {
  if (!decision) return [...eligible];
  const available = new Set(eligible);
  const routed = decision.accounts.filter(id => available.has(id));
  return routed.length > 0 || !decision.fallback ? routed : [...eligible];
}
