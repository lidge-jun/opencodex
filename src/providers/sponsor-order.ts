import { PROVIDER_REGISTRY } from "./registry";

export type SponsorTier = "main" | "standard";

const SPONSOR_RANK: Record<SponsorTier, number> = { main: 0, standard: 1 };

/**
 * SPONSORS.md promises sponsor presets sit near the top of the picker "in the dashboard and CLI".
 * The dashboard applies that in gui/src/components/provider-catalog/provider-presets.ts
 * (`pinSponsors`); this is the same order for the CLI surfaces: sponsor rows first, Main before
 * Standard, alphabetical by label within a tier, then every other row in the caller's order.
 * Alphabetical among sponsors is deliberate: it is the one order no sponsor can buy.
 */
export function pinSponsorRows<T>(
  rows: readonly T[],
  tierOf: (row: T) => SponsorTier | undefined,
  labelOf: (row: T) => string,
): T[] {
  const sponsors = rows.filter(row => tierOf(row) !== undefined);
  if (sponsors.length === 0) return [...rows];
  sponsors.sort((a, b) =>
    SPONSOR_RANK[tierOf(a)!] - SPONSOR_RANK[tierOf(b)!]
    || labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: "base" }));
  return [...sponsors, ...rows.filter(row => tierOf(row) === undefined)];
}

/** Registry sponsor tier by preset id; the registry field is the only thing that marks a sponsor. */
export function registrySponsorTier(id: string): SponsorTier | undefined {
  return PROVIDER_REGISTRY.find(entry => entry.id === id)?.sponsor?.tier;
}

/**
 * The `ocx init` menu prints a heading whenever the provider kind changes, and registry order
 * interleaves kinds, so the same heading appears more than once. Sponsor rows move, in pinned
 * order, to the start of the first run of their own kind: they stay under the right heading, sit
 * near the top of the menu, and no new heading is introduced. Every other row keeps its order.
 */
export function pinSponsorsWithinKind<T extends { id: string; label: string; kind: string }>(
  rows: readonly T[],
  tierOf: (row: T) => SponsorTier | undefined = row => registrySponsorTier(row.id),
): T[] {
  const sponsors = pinSponsorRows(rows.filter(row => tierOf(row) !== undefined), tierOf, row => row.label);
  if (sponsors.length === 0) return [...rows];
  const out: T[] = [];
  const placedKinds = new Set<string>();
  for (const row of rows) {
    // Record the kind at its first row, sponsor or not, so a run that opens with a sponsor
    // keeps its place instead of the sponsor moving to a later run of the same kind.
    if (!placedKinds.has(row.kind)) {
      placedKinds.add(row.kind);
      out.push(...sponsors.filter(sponsor => sponsor.kind === row.kind));
    }
    if (tierOf(row) === undefined) out.push(row);
  }
  return out;
}
