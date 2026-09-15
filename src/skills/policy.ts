import type { EnvironmentType, SkillPolicyDecision, SkillRiskAssessment, SkillSourceRecord } from "./types";

export interface PolicyEvaluationContext {
  environment?: EnvironmentType;
  targetAgents?: string[];
  targetNodes?: string[];
  source?: Partial<SkillSourceRecord>;
  hasApproval?: boolean;
  isAutonomousDeploy?: boolean;
}

export function evaluateSkillPolicy(
  risk: SkillRiskAssessment,
  context: PolicyEvaluationContext = {},
): SkillPolicyDecision {
  const env = context.environment ?? "dev";
  const matchedRules: string[] = [];

  // 1. Critical Risk Deny Rule for Autonomous Deployment
  if (risk.level === "critical") {
    matchedRules.push("deny-critical-autodeploy");
    if (context.isAutonomousDeploy && !context.hasApproval) {
      return {
        effect: "deny",
        reason: "Critical Skills cannot be deployed autonomously. Explicit human review and approval are required.",
        matched_rules: matchedRules,
      };
    }
    if (!context.hasApproval) {
      return {
        effect: "require_approval",
        reason: "Critical risk level detected. Human review and explicit approval required prior to deployment.",
        matched_rules: matchedRules,
        constraints: {
          allowed_environments: ["dev", "test"],
        },
      };
    }
  }

  // 2. Production Environment Rules
  if (env === "prod") {
    matchedRules.push("protect-production");
    if (risk.level === "critical" || risk.level === "high") {
      if (!context.hasApproval) {
        return {
          effect: "deny",
          reason: "High and Critical risk skills are denied in production without pre-existing executive approval.",
          matched_rules: matchedRules,
        };
      }
    }
    if (risk.inferred_capabilities.includes("process.privilege.elevated") ||
        risk.inferred_capabilities.includes("network.exfiltration")) {
      return {
        effect: "deny",
        reason: "Production policy strictly prohibits privilege elevation and data exfiltration capabilities.",
        matched_rules: matchedRules,
      };
    }
    if (!context.hasApproval && (risk.level === "medium" || risk.inferred_capabilities.includes("process.command.execute"))) {
      return {
        effect: "require_approval",
        reason: "Production deployments requiring shell command execution require explicit operator approval.",
        matched_rules: matchedRules,
      };
    }
  }

  // 3. Source Trust Rules
  if (context.source?.trust_level === "untrusted" || context.source?.trust_level === "unknown") {
    matchedRules.push("constrain-untrusted-source");
    if (!context.hasApproval && risk.level !== "low") {
      return {
        effect: "require_approval",
        reason: "Skills from untrusted or unknown sources require review before deployment.",
        matched_rules: matchedRules,
        constraints: {
          allowed_environments: ["dev"],
        },
      };
    }
  }

  // 4. High Risk in Non-Dev
  if (risk.level === "high" && env !== "dev" && !context.hasApproval) {
    matchedRules.push("require-approval-high-risk");
    return {
      effect: "require_approval",
      reason: "High risk skills require approval outside development environment.",
      matched_rules: matchedRules,
      constraints: {
        allowed_environments: ["dev", "test"],
      },
    };
  }

  // 5. Default Allow
  return {
    effect: "allow",
    reason: "Skill satisfies automated safety policy requirements.",
    matched_rules: matchedRules.length > 0 ? matchedRules : ["default-allow-low-risk"],
    constraints: {
      allowed_environments: env === "prod" ? ["prod"] : ["dev", "test", "staging"],
    },
  };
}

