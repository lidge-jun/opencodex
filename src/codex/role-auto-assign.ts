/**
 * Turns a role's sized tier and effort into a concrete model and reasoning level. Deterministic:
 * the sizing model never names a model, and nothing here asks one.
 *
 * Tier of a candidate model, first rule that applies:
 * 1. codexRoleTiers in the opencodex config lists it under fast, standard or frontier.
 * 2. It has a known price. Priced candidates are ranked by input plus output USD per 1M tokens.
 *    Three or more split evenly across the three tiers by rank, cheapest in fast. Fewer than three
 *    cannot fill every tier, so the ranking is anchored at the top: the dearest is frontier,
 *    because it is the strongest model on offer, and each cheaper one sits one tier lower. One
 *    priced model is frontier; two are standard and frontier. The tier left empty is fast, so a
 *    fast role steps up to the cheapest model and a standard role keeps it instead of jumping to
 *    the dearest, which keeps every role on the cheapest sufficient model on offer.
 * 3. Otherwise it is unclassified and never proposed.
 *
 * A role gets the cheapest sufficient model: the lowest tier at or above what it was sized for,
 * then the lowest price, then the picker's own order.
 *
 * Effort binds to positions on the chosen model's ladder: glance is the floor, measured is the
 * model's default or the middle rung, exhaustive is the ceiling, and thorough is the rung above
 * measured when that rung is not the ceiling. When no such interior rung exists, thorough
 * collapses to the nearer of measured and the ceiling; the two are equally near, and the one
 * above wins because thorough asks for more than the everyday setting. Nothing resolves outside
 * the ladder.
 */
import { SIZING_TIERS, type RoleSizingOutcome, type SizingEffort, type SizingTier } from "./role-sizing";
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
  readonly tierSource: "mapping" | "price" | null;
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

export function classifyRoleModelCandidates(
  candidates: readonly RoleModelCandidate[],
  mapping: RoleTierMapping = {},
): ClassifiedCandidate[] {
  const mapped = new Map<string, SizingTier>();
  for (const tier of SIZING_TIERS) {
    for (const model of mapping[tier] ?? []) if (!mapped.has(model)) mapped.set(model, tier);
  }
  const priced = candidates
    .map((candidate, order) => ({ candidate, order }))
    .filter(({ candidate }) => !mapped.has(candidate.model) && candidate.unitPrice !== null)
    .sort((a, b) => a.candidate.unitPrice! - b.candidate.unitPrice! || a.order - b.order);
  const byPrice = new Map<string, SizingTier>();
  priced.forEach(({ candidate }, rank) => {
    const top = SIZING_TIERS.length - 1;
    const index = priced.length < SIZING_TIERS.length
      ? top - (priced.length - 1 - rank)
      : Math.round((rank * top) / (priced.length - 1));
    byPrice.set(candidate.model, SIZING_TIERS[index]!);
  });
  return candidates.map(candidate => {
    const fromMapping = mapped.get(candidate.model);
    if (fromMapping) return { ...candidate, tier: fromMapping, tierSource: "mapping" as const };
    const fromPrice = byPrice.get(candidate.model);
    return fromPrice
      ? { ...candidate, tier: fromPrice, tierSource: "price" as const }
      : { ...candidate, tier: null, tierSource: null };
  });
}

export function cheapestSufficientCandidate(
  classified: readonly ClassifiedCandidate[],
  tier: SizingTier,
): ClassifiedCandidate | null {
  const need = SIZING_TIERS.indexOf(tier);
  const ranked = classified
    .map((candidate, order) => ({ candidate, order, rank: candidate.tier ? SIZING_TIERS.indexOf(candidate.tier) : -1 }))
    .filter(entry => entry.rank >= need)
    .sort((a, b) => a.rank - b.rank
      || (a.candidate.unitPrice ?? Infinity) - (b.candidate.unitPrice ?? Infinity)
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
    readonly rationale: string;
    readonly moveUpIf: string;
    readonly moveDownIf: string;
    readonly proposedModel: string | null;
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
): RoleProposal[] {
  return roles.map(role => {
    const outcome = sizing.get(role.role) ?? { unsized: "the role was not sized" };
    if ("unsized" in outcome) return { ...role, status: "unsized", reason: outcome.unsized };
    const { tier, effort, rationale, moveUpIf, moveDownIf } = outcome.sizing;
    const pick = cheapestSufficientCandidate(classified, tier);
    const sized = { ...role, tier, effortIntent: effort, rationale, moveUpIf, moveDownIf };
    if (!pick) {
      return {
        ...sized,
        status: "unassigned",
        proposedModel: null,
        proposedEffort: null,
        reason: `no available model is classified ${tier} or above`,
      };
    }
    const proposedEffort = mapEffortToLevel(effort, pick.efforts, pick.defaultEffort);
    return { ...sized, status: "proposed", proposedModel: pick.model, proposedEffort, reason: null };
  });
}
