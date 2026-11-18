/**
 * Turns a role's sized tier and effort into a concrete model and reasoning level. Deterministic:
 * the sizing model never names a model, and nothing here asks one.
 *
 * Tier of a candidate model, first rule that applies:
 * 1. codexRoleTiers in the opencodex config lists it under fast, standard or frontier.
 * 2. At least two candidates have a measured score in the role's task domain. Measured candidates
 *    are ranked by that score and split across the tiers the same way price splits them below;
 *    unmeasured ones are left out rather than placed among measured ones by price.
 * 3. It has a known price. Priced candidates are ranked by input plus output USD per 1M tokens.
 *    Three or more split evenly across the three tiers by rank, cheapest in fast. Fewer than three
 *    cannot fill every tier, so the ranking is anchored at the top: the dearest is frontier,
 *    because it is the strongest model on offer, and each cheaper one sits one tier lower. One
 *    priced model is frontier; two are standard and frontier. The tier left empty is fast, so a
 *    fast role steps up to the cheapest model and a standard role keeps it instead of jumping to
 *    the dearest, which keeps every role on the cheapest sufficient model on offer.
 * 4. Otherwise it is unclassified and never proposed.
 *
 * A role gets the cheapest sufficient model: the lowest tier at or above what it was sized for,
 * then the lowest price, then the higher measured score, then the model the role already uses when
 * it is one of the tied models, then the picker's own order. The picker lists native models first,
 * so without the current-model step a role on a routed model moved to a native one priced and
 * tiered the same.
 *
 * Effort binds to positions on the chosen model's ladder: glance is the floor, measured is the
 * model's default or the middle rung, exhaustive is the ceiling, and thorough is the rung above
 * measured when that rung is not the ceiling. When no such interior rung exists, thorough
 * collapses to the nearer of measured and the ceiling; the two are equally near, and the one
 * above wins because thorough asks for more than the everyday setting. Nothing resolves outside
 * the ladder.
 */
import { SIZING_TIERS, type RoleSizingOutcome, type SizingDomain, type SizingEffort, type SizingTier } from "./role-sizing";
import { CODEX_REASONING_LEVELS } from "../reasoning-effort";

export type RoleTierMapping = Partial<Record<SizingTier, readonly string[]>>;

export interface RoleModelCandidate {
  readonly model: string;
  /** Input plus output USD per 1M tokens, or null when no price is known. */
  readonly unitPrice: number | null;
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
}

export interface ClassifiedCandidate extends RoleModelCandidate {
  readonly tier: SizingTier | null;
  readonly tierSource: "mapping" | "measured" | "price" | null;
  /** The measured score the tier came from, or null when it came from elsewhere. */
  readonly score: number | null;
}

const LADDER_ORDER = ["none", "minimal", ...CODEX_REASONING_LEVELS.map(level => level.effort)];

export function effortLadder(efforts: readonly string[]): string[] {
  return [...new Set(efforts)]
    .filter(effort => LADDER_ORDER.includes(effort))
    .sort((a, b) => LADDER_ORDER.indexOf(a) - LADDER_ORDER.indexOf(b));
}

export function mapEffortToLevel(intent: SizingEffort, efforts: readonly string[], defaultEffort?: string): string | null {
  const ladder = effortLadder(efforts);
  if (ladder.length === 0) return null;
  const top = ladder.length - 1;
  const measured = defaultEffort !== undefined && ladder.includes(defaultEffort)
    ? ladder.indexOf(defaultEffort)
    : Math.floor(top / 2);
  switch (intent) {
    case "glance": return ladder[0]!;
    case "measured": return ladder[measured]!;
    case "thorough": return ladder[Math.min(measured + 1, top)]!;
    case "exhaustive": return ladder[top]!;
  }
}

/** Split items ranked weakest first across the tiers; fewer than three are anchored at the top. */
function tierByRank<T>(ranked: readonly T[]): Map<T, SizingTier> {
  const top = SIZING_TIERS.length - 1;
  return new Map(ranked.map((item, rank) => [item, SIZING_TIERS[ranked.length < SIZING_TIERS.length
    ? top - (ranked.length - 1 - rank)
    : Math.round((rank * top) / (ranked.length - 1))]!]));
}

export function classifyRoleModelCandidates(
  candidates: readonly RoleModelCandidate[],
  mapping: RoleTierMapping = {},
  measured: ReadonlyMap<string, number> = new Map(),
): ClassifiedCandidate[] {
  const mapped = new Map<string, SizingTier>();
  for (const tier of SIZING_TIERS) {
    for (const model of mapping[tier] ?? []) if (!mapped.has(model)) mapped.set(model, tier);
  }
  const unmapped = candidates.filter(candidate => !mapped.has(candidate.model));
  const scored = unmapped.filter(candidate => measured.has(candidate.model));
  const scoreTiers = tierByRank([...new Set(scored.map(candidate => measured.get(candidate.model)!))].sort((a, b) => a - b));
  const byScore = scored.length >= 2
    ? new Map(scored.map(candidate => [candidate.model, scoreTiers.get(measured.get(candidate.model)!)!] as const))
    : new Map<string, SizingTier>();
  const byPrice = byScore.size > 0
    ? new Map<string, SizingTier>()
    : tierByRank(unmapped
      .map((candidate, order) => ({ candidate, order }))
      .filter(({ candidate }) => candidate.unitPrice !== null)
      .sort((a, b) => a.candidate.unitPrice! - b.candidate.unitPrice! || a.order - b.order)
      .map(({ candidate }) => candidate.model));
  return candidates.map(candidate => {
    const fromMapping = mapped.get(candidate.model);
    if (fromMapping) return { ...candidate, tier: fromMapping, tierSource: "mapping" as const, score: null };
    const fromScore = byScore.get(candidate.model);
    if (fromScore) return { ...candidate, tier: fromScore, tierSource: "measured" as const, score: measured.get(candidate.model)! };
    const fromPrice = byPrice.get(candidate.model);
    return fromPrice
      ? { ...candidate, tier: fromPrice, tierSource: "price" as const, score: null }
      : { ...candidate, tier: null, tierSource: null, score: null };
  });
}

export function cheapestSufficientCandidate(
  classified: readonly ClassifiedCandidate[],
  tier: SizingTier,
  current: string | null = null,
): ClassifiedCandidate | null {
  const need = SIZING_TIERS.indexOf(tier);
  const ranked = classified
    .map((candidate, order) => ({ candidate, order, rank: candidate.tier ? SIZING_TIERS.indexOf(candidate.tier) : -1 }))
    .filter(entry => entry.rank >= need)
    .sort((a, b) => a.rank - b.rank
      || (a.candidate.unitPrice ?? Infinity) - (b.candidate.unitPrice ?? Infinity)
      || (b.candidate.score ?? -Infinity) - (a.candidate.score ?? -Infinity)
      || Number(b.candidate.model === current) - Number(a.candidate.model === current)
      || a.order - b.order);
  return ranked[0]?.candidate ?? null;
}

export interface RoleProposalInput {
  readonly role: string;
  readonly model: string | null;
  readonly effort: string | null;
}

export type RoleProposal = RoleProposalInput & (
  | {
    readonly status: "proposed" | "unassigned";
    readonly tier: SizingTier;
    readonly effortIntent: SizingEffort;
    readonly domain: SizingDomain;
    readonly rationale: string;
    readonly moveUpIf: string;
    readonly moveDownIf: string;
    readonly proposedModel: string | null;
    /** Where the picked model's tier came from: a user mapping, a measured score, or price rank. */
    readonly tierSource: ClassifiedCandidate["tierSource"];
    /** The sized effort on the picked model's ladder; null only when that model has no ladder. */
    readonly proposedEffort: string | null;
    readonly reason: string | null;
  }
  | { readonly status: "unsized"; readonly reason: string }
);

export function buildRoleProposals(
  roles: readonly RoleProposalInput[],
  sizing: ReadonlyMap<string, RoleSizingOutcome>,
  classified: readonly ClassifiedCandidate[],
  classifiedByDomain: ReadonlyMap<SizingDomain, readonly ClassifiedCandidate[]> = new Map(),
): RoleProposal[] {
  return roles.map(role => {
    const outcome = sizing.get(role.role) ?? { unsized: "the role was not sized" };
    if ("unsized" in outcome) return { ...role, status: "unsized", reason: outcome.unsized };
    const { tier, effort, domain, rationale, moveUpIf, moveDownIf } = outcome.sizing;
    const pick = cheapestSufficientCandidate(classifiedByDomain.get(domain) ?? classified, tier, role.model);
    const sized = { ...role, tier, effortIntent: effort, domain, rationale, moveUpIf, moveDownIf };
    if (!pick) {
      return {
        ...sized,
        status: "unassigned",
        proposedModel: null,
        tierSource: null,
        proposedEffort: null,
        reason: `no available model is classified ${tier} or above`,
      };
    }
    const proposedEffort = mapEffortToLevel(effort, pick.efforts, pick.defaultEffort);
    return { ...sized, status: "proposed", proposedModel: pick.model, tierSource: pick.tierSource, proposedEffort, reason: null };
  });
}
