import { RISK_ORDER, SECURITY_POLICY_VERSION, STRICT_DEFAULTS } from "./constants";
import { isAuthorizationExecutable } from "./authorization";
import type {
  PolicyDecisionKind,
  RiskTier,
  SecurityAuthorization,
  SecurityCapability,
  SecurityPolicyProfile,
  ScopeMatch,
} from "./types";

export interface PolicyEvaluationInput {
  capability?: SecurityCapability;
  requestedTier?: RiskTier;
  authorization?: SecurityAuthorization | null;
  scopeMatch: ScopeMatch;
  hasScopeToken: boolean;
  hasValidApproval: boolean;
  campaignStatus?: string;
  agentMaxTier?: RiskTier;
  breakerOpen?: boolean;
  profile: SecurityPolicyProfile;
  now?: Date;
}

export interface PolicyEvaluation {
  decision: PolicyDecisionKind;
  reason_code: string;
  policy_version: string;
  risk_tier: RiskTier;
}

export function classifyCapabilityRisk(capability: SecurityCapability): RiskTier {
  if (capability.restricted) return "R3";
  return capability.risk_tier;
}

export function evaluateSecurityPolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  const now = input.now ?? new Date();
  const version = SECURITY_POLICY_VERSION;
  const capability = input.capability;
  const risk: RiskTier = input.requestedTier ?? (capability ? classifyCapabilityRisk(capability) : "R3");

  if (input.breakerOpen) {
    return { decision: "DENY", reason_code: "CIRCUIT_BREAKER_OPEN", policy_version: version, risk_tier: risk };
  }

  if (input.campaignStatus === "PAUSED" || input.campaignStatus === "CANCELLED" || input.campaignStatus === "CLOSED" || input.campaignStatus === "FAILED") {
    if (risk !== "R0") {
      return { decision: "DENY", reason_code: "CAMPAIGN_NOT_EXECUTABLE", policy_version: version, risk_tier: risk };
    }
  }

  if (input.campaignStatus === "BLOCKED_POLICY" || input.campaignStatus === "BLOCKED_SCOPE") {
    return { decision: "DENY", reason_code: "CAMPAIGN_BLOCKED", policy_version: version, risk_tier: risk };
  }

  if (!capability) {
    return { decision: "DENY", reason_code: "UNCLASSIFIED_CAPABILITY", policy_version: version, risk_tier: "R3" };
  }

  if (!capability.enabled || capability.restricted) {
    return { decision: "DENY", reason_code: capability.restricted ? "RESTRICTED_CAPABILITY" : "CAPABILITY_DISABLED", policy_version: version, risk_tier: risk };
  }

  // Restricted capabilities already returned above. After that branch, R3 is
  // still blocked by default — profile.block_r3 and STRICT_DEFAULTS.r3 are
  // the documented fail-closed knobs even if a future profile tried to lift them.
  if (risk === "R3") {
    return { decision: "DENY", reason_code: "R3_BLOCKED", policy_version: version, risk_tier: "R3" };
  }

  if (input.agentMaxTier && RISK_ORDER[risk] > RISK_ORDER[input.agentMaxTier]) {
    // Human-approved R2 may run even when the agent's standing ceiling is R0/R1.
    // Approval never lifts R3 (blocked above).
    if (!(risk === "R2" && input.profile.r2_requires_approval !== false)) {
      return { decision: "DENY", reason_code: "AGENT_TIER_EXCEEDED", policy_version: version, risk_tier: risk };
    }
  }

  if (risk === "R0") {
    return { decision: "ALLOW", reason_code: "R0_LOCAL", policy_version: version, risk_tier: "R0" };
  }

  if (input.profile.require_authorization !== false) {
    if (!input.authorization) {
      return { decision: "DENY", reason_code: "NO_AUTHORIZATION", policy_version: version, risk_tier: risk };
    }
    if (!isAuthorizationExecutable(input.authorization, now)) {
      return { decision: "DENY", reason_code: "AUTHORIZATION_NOT_ACTIVE", policy_version: version, risk_tier: risk };
    }
  }

  if (input.scopeMatch === "EXPIRED") {
    return { decision: "DENY", reason_code: "SCOPE_EXPIRED", policy_version: version, risk_tier: risk };
  }
  if (input.scopeMatch === "EXCLUDED") {
    return { decision: "DENY", reason_code: "ASSET_EXCLUDED", policy_version: version, risk_tier: risk };
  }
  if (input.scopeMatch === "UNKNOWN") {
    return { decision: "DENY", reason_code: "UNKNOWN_ASSET", policy_version: version, risk_tier: risk };
  }

  if (capability.requires_scope && input.profile.require_scope_token && !input.hasScopeToken) {
    return { decision: "DENY", reason_code: "SCOPE_TOKEN_REQUIRED", policy_version: version, risk_tier: risk };
  }

  if (risk === "R2" || capability.requires_approval) {
    if (input.profile.r2_requires_approval !== false && !input.hasValidApproval) {
      return { decision: "APPROVAL_REQUIRED", reason_code: "R2_APPROVAL_REQUIRED", policy_version: version, risk_tier: "R2" };
    }
  }

  if (RISK_ORDER[risk] > RISK_ORDER[input.profile.default_risk_ceiling] && risk !== "R2") {
    return { decision: "DENY", reason_code: "RISK_CEILING_EXCEEDED", policy_version: version, risk_tier: risk };
  }

  return { decision: "ALLOW", reason_code: risk === "R1" ? "R1_SCOPED" : "POLICY_ALLOW", policy_version: version, risk_tier: risk };
}
