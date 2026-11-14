import type { OAuthCredentials } from "./types";

/** Display-only upstream tier; never infer a plan from normalized quota percentages. */
export function normalizeOAuthPlan(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const plan = value.trim();
  return plan.length <= 64 && /^[a-z0-9_.-]+$/.test(plan) ? plan : undefined;
}

/**
 * Same account by the strongest identifier both credentials carry, compared kind for kind
 * (Anthropic UUID, then accountId, then case-insensitive email); undefined when none overlap.
 */
function sameAccount(a: OAuthCredentials, b: OAuthCredentials): boolean | undefined {
  // One Claude account in two organizations is two subscriptions; neither inherits the other's tier.
  const orgA = boundOrganization(a);
  const orgB = boundOrganization(b);
  if (orgA !== undefined && orgB !== undefined && orgA !== orgB) return false;
  const pairs: Array<[string | undefined, string | undefined]> = [
    [a.anthropicIdentity?.accountUuid, b.anthropicIdentity?.accountUuid],
    [a.accountId, b.accountId],
    [a.email?.toLowerCase(), b.email?.toLowerCase()],
  ];
  for (const [left, right] of pairs) if (left !== undefined && right !== undefined) return left === right;
  return undefined;
}

/**
 * The proof's organization. This module is also bundled into the browser GUI, so it cannot hash
 * the bearer; callers pass store-normalized credentials, whose proofs are already bearer-bound.
 */
function boundOrganization(credential: OAuthCredentials): string | undefined {
  return credential.anthropicIdentity?.organizationUuid?.toLowerCase();
}

/** An observed unknown clears old metadata; an account replacement cannot inherit a plan. */
export function mergeOAuthPlan(fresh: OAuthCredentials, previous: OAuthCredentials): string | null | undefined {
  if (fresh.plan !== undefined) return normalizeOAuthPlan(fresh.plan) ?? null;
  if (sameAccount(fresh, previous) === false) return undefined;
  return previous.plan === null ? null : normalizeOAuthPlan(previous.plan);
}
