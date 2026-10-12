// Carried from PR #6185 by yxr1995-maker and PR #6275 by codingbooo.
/**
 * Discovery of decision-capable models in the Codex catalog.
 *
 * A decision destination does not have to be configured by hand: gateways resell the System One
 * contract under their own model ids (the OpenCode zen gateway serves `jev-1.13`, an aggregator may
 * expose `typesafe-ai/jev`). This module answers the two pure questions such a search needs — which
 * catalog rows look like decision models, and where that provider's System One endpoint lives — so
 * the route only has to do the IO and the answer checks stay in one place.
 */

export interface DiscoveryModelRow {
  provider?: string;
  id: string;
  namespaced?: string;
  owned_by?: string;
  pricingStatus?: string;
  displayName?: string;
  disabled?: boolean;
}

/**
 * Spellings that name a decision service rather than a generating model.
 *
 * Deliberately conservative: a bare `decision` or `jev` token, `systemone`, and the hyphenated
 * spelling. Substring hits like `jeveux` do not qualify, because a false candidate costs a probe.
 */
export const DECISION_MODEL_HINT = /(?:^|[^a-z0-9])(?:jev|systemone|system-one|decision)(?:[^a-z0-9]|$)/i;

const normalize = (value: string) => value.trim().toLowerCase();

/**
 * True when a catalog row is worth probing as a decision model.
 *
 * An explicit query replaces the heuristic: an operator searching for a term knows what they mean,
 * and a search that silently keeps the built-in filter would hide the model they asked for.
 */
export function isDecisionModelCandidate(row: DiscoveryModelRow, query = ""): boolean {
  const term = normalize(query);
  const haystack = `${row.id} ${row.owned_by ?? ""} ${row.displayName ?? ""}`.toLowerCase();
  if (term.length > 0) return haystack.includes(term);
  return DECISION_MODEL_HINT.test(row.id) || DECISION_MODEL_HINT.test(row.owned_by ?? "");
}

/**
 * The System One endpoint for a provider, derived from its API prefix.
 *
 * TypeSafe serves it at `<base>/v1/systemone` and the OpenCode zen gateway at `<base>/zen/v1/systemone`
 * — in both cases the segment sits directly after the provider's own prefix, so appending is the
 * rule, and a baseUrl that already names it is returned unchanged. Anything that is not an absolute
 * http(s) URL yields `null` rather than a guess.
 */
export function systemOneEndpoint(baseUrl: string | undefined): string | null {
  const trimmed = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed.endsWith("/systemone") ? trimmed : `${trimmed}/systemone`;
}

/** Deduplicate by provider+model so a row that appears twice is probed once. */
export function uniqueDiscoveryCandidates(
  rows: readonly DiscoveryModelRow[],
  query = "",
): DiscoveryModelRow[] {
  const seen = new Set<string>();
  const candidates: DiscoveryModelRow[] = [];
  for (const row of rows) {
    if (!row?.provider || typeof row.id !== "string" || !isDecisionModelCandidate(row, query)) continue;
    const key = `${row.provider}/${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(row);
  }
  return candidates;
}
