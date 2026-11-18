/** Display metadata only: subscription names never prove identity, entitlement or capacity. */
import { normalizeOAuthPlan } from "../oauth/plan";

const knownPlans = ["pro", "max_5x", "max_20x", "team", "enterprise", "ultra"] as const;

/** Canonicalize known aliases only; retain an unfamiliar validated tier verbatim. */
export function normalizeAnthropicPlan(value: unknown): string | undefined {
  const raw = normalizeOAuthPlan(value === "Ultra" ? "ultra" : value);
  if (!raw) return undefined;
  const short = raw.replace(/^(?:default_)?claude_/, "");
  return knownPlans.some(plan => plan === short) ? short : raw;
}

export function anthropicSubscriptionLabel(value: unknown): string | undefined {
  const plan = normalizeAnthropicPlan(value);
  switch (plan) {
    case "pro": return "Pro";
    case "max_5x": return "Max 5x";
    case "ultra":
    case "max_20x": return "Ultra";
    case "team": return "Team";
    case "enterprise": return "Enterprise";
    default: return plan;
  }
}
