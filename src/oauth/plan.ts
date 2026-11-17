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

/** Display-only organization name: trimmed, at most 128 characters, no control or format characters. */
export function normalizeOAuthOrganizationName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(name) ? name : undefined;
}

/**
 * A fresh observation wins and an observed unknown clears it. Unlike the plan, a name claims which
 * organization a row serves, so it carries only between credentials proven to serve the same one;
 * an unknown organization on either side drops it until the next profile read names it again.
 */
export function mergeOAuthOrganizationName(fresh: OAuthCredentials, previous: OAuthCredentials): string | null | undefined {
  if (fresh.organizationName !== undefined) return normalizeOAuthOrganizationName(fresh.organizationName) ?? null;
  const organization = boundOrganization(fresh);
  if (organization === undefined || organization !== boundOrganization(previous)) return undefined;
  return previous.organizationName === null ? null : normalizeOAuthOrganizationName(previous.organizationName);
}

/** An observed unknown clears old metadata; an account replacement cannot inherit a plan. */
export function mergeOAuthPlan(fresh: OAuthCredentials, previous: OAuthCredentials): string | null | undefined {
  if (fresh.plan !== undefined) return normalizeOAuthPlan(fresh.plan) ?? null;
  if (sameAccount(fresh, previous) === false) return undefined;
  return previous.plan === null ? null : normalizeOAuthPlan(previous.plan);
}
