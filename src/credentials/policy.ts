import type {
  CredentialPolicy,
  CredentialRecord,
  CredentialRole,
  PolicyEvaluation,
  ProviderRecord,
  SensitiveAction,
} from "./types";
import { canCreateLease } from "./rbac";

export interface PolicyContext {
  credential: CredentialRecord;
  provider: ProviderRecord;
  agentId?: string | null;
  model?: string | null;
  purpose?: string | null;
  requiredScope?: string | null;
  estimatedCost?: number | null;
  remainingBudget?: number | null;
  actorRole?: CredentialRole;
  circuitOpen?: boolean;
  action?: SensitiveAction | "lease";
}

function matches(policy: CredentialPolicy, ctx: PolicyContext): boolean {
  const match = policy.policy.match ?? {};
  if (match.provider && match.provider !== ctx.provider.slug) return false;
  if (match.environment && match.environment !== ctx.credential.environment) return false;
  if (match.credential_type && match.credential_type !== ctx.credential.credential_type) return false;
  return true;
}

export function evaluateCredentialPolicy(policies: CredentialPolicy[], ctx: PolicyContext): PolicyEvaluation {
  const reasons: string[] = [];
  if (!ctx.provider.enabled) {
    return { decision: "deny", policy_id: null, reasons: ["provider-disabled"] };
  }
  if (ctx.circuitOpen) {
    return { decision: "deny", policy_id: null, reasons: ["circuit-open"] };
  }
  if (ctx.credential.status === "quarantined") {
    return { decision: "deny", policy_id: null, reasons: ["credential-quarantined"] };
  }
  if (ctx.credential.status === "revoked") {
    return { decision: "deny", policy_id: null, reasons: ["credential-revoked"] };
  }
  if (ctx.credential.status === "expired") {
    return { decision: "deny", policy_id: null, reasons: ["credential-expired"] };
  }
  if (ctx.credential.status === "disabled") {
    return { decision: "deny", policy_id: null, reasons: ["credential-disabled"] };
  }
  if (ctx.action === "lease" && ctx.actorRole && !canCreateLease(ctx.actorRole)) {
    return { decision: "deny", policy_id: null, reasons: ["rbac-lease-denied"] };
  }
  if (ctx.action && ctx.action !== "lease") {
    return { decision: "approval_required", policy_id: null, reasons: ["default-deny-sensitive"] };
  }

  const ranked = [...policies].filter(p => p.enabled).sort((a, b) => a.priority - b.priority);
  const applicable = ranked.filter(p => matches(p, ctx));
  if (applicable.length === 0) {
    reasons.push("default-allow-no-matching-policy");
    return { decision: "allow", policy_id: null, reasons };
  }

  for (const policy of applicable) {
    const req = policy.policy.requirements ?? {};
    if (req.status && req.status.length > 0 && !req.status.includes(ctx.credential.status)) {
      return { decision: "deny", policy_id: policy.id, reasons: ["credential-status-mismatch"] };
    }
    if (typeof req.minimum_health_score === "number" && ctx.credential.health_score < req.minimum_health_score) {
      return { decision: "deny", policy_id: policy.id, reasons: ["health-score-fail"] };
    }
    if (req.allowed_agents && ctx.agentId && !req.allowed_agents.includes(ctx.agentId)) {
      return { decision: "deny", policy_id: policy.id, reasons: ["agent-not-allowed"] };
    }
    if (req.denied_agents && ctx.agentId && req.denied_agents.includes(ctx.agentId)) {
      return { decision: "deny", policy_id: policy.id, reasons: ["agent-denied"] };
    }
    if (req.denied_models && ctx.model && req.denied_models.includes(ctx.model)) {
      return { decision: "deny", policy_id: policy.id, reasons: ["model-denied"] };
    }
    if (req.allowed_models && ctx.model && !req.allowed_models.includes(ctx.model)) {
      return { decision: "deny", policy_id: policy.id, reasons: ["model-not-allowed"] };
    }
    if (req.required_scopes && ctx.requiredScope && !req.required_scopes.includes(ctx.requiredScope) && !ctx.credential.scopes.includes(ctx.requiredScope)) {
      return { decision: "deny", policy_id: policy.id, reasons: ["scope-missing"] };
    }
    if (typeof req.minimum_budget === "number") {
      const remaining = ctx.remainingBudget ?? ctx.credential.remaining_budget;
      if (remaining != null && remaining < req.minimum_budget) {
        return { decision: "deny", policy_id: policy.id, reasons: ["budget-exhausted"] };
      }
    }
  }

  reasons.push("credential-active", "health-score-pass", "agent-allowed");
  return { decision: "allow", policy_id: applicable[0]?.id ?? null, reasons };
}

export function routingScore(input: {
  healthScore: number;
  quotaFactor: number;
  budgetFactor: number;
  reliabilityFactor: number;
  policyFactor: number;
}): number {
  return Number((
    (input.healthScore / 100)
    * input.quotaFactor
    * input.budgetFactor
    * input.reliabilityFactor
    * input.policyFactor
    * 100
  ).toFixed(1));
}

