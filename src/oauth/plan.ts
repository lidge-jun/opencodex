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
  const pairs: Array<[string | undefined, string | undefined]> = [
    [a.anthropicIdentity?.accountUuid, b.anthropicIdentity?.accountUuid],
    [a.accountId, b.accountId],
    [a.email?.toLowerCase(), b.email?.toLowerCase()],
  ];
  for (const [left, right] of pairs) if (left !== undefined && right !== undefined) return left === right;
  return undefined;
}

/** An observed unknown clears old metadata; an account replacement cannot inherit a plan. */
export function mergeOAuthPlan(fresh: OAuthCredentials, previous: OAuthCredentials): string | null | undefined {
  if (fresh.plan !== undefined) return normalizeOAuthPlan(fresh.plan) ?? null;
  if (sameAccount(fresh, previous) === false) return undefined;
  return previous.plan === null ? null : normalizeOAuthPlan(previous.plan);
}
