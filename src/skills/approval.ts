import { randomUUID } from "node:crypto";
import type {
  ApprovalStatus,
  ResolvedSkillTarget,
  SkillApprovalRecord,
  SkillPolicyDecision,
  SkillRiskAssessment,
  SkillVersionRecord,
} from "./types";

export interface CreateApprovalInput {
  skillVersionId: string;
  contentSha256: string;
  requestedAction?: "deploy" | "publish" | "sync";
  requestedTargets?: ResolvedSkillTarget[];
  policySnapshot?: SkillPolicyDecision;
  riskSnapshot?: SkillRiskAssessment;
  requestedBy: string;
  expiresInSeconds?: number;
}

export function createApprovalRequest(input: CreateApprovalInput): SkillApprovalRecord {
  const now = new Date();
  const expiresAt = input.expiresInSeconds
    ? new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString()
    : undefined;

  return {
    id: `appr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    skill_version_id: input.skillVersionId,
    requested_action: input.requestedAction ?? "deploy",
    requested_targets: input.requestedTargets,
    policy_snapshot: input.policySnapshot,
    risk_snapshot: input.riskSnapshot,
    status: "PENDING",
    requested_by: input.requestedBy,
    content_sha256: input.contentSha256,
    created_at: now.toISOString(),
    expires_at: expiresAt,
  };
}

export function decideApproval(
  record: SkillApprovalRecord,
  decision: "APPROVED" | "REJECTED",
  reviewer: string,
  reason: string,
  constraints?: Record<string, unknown>,
): { record: SkillApprovalRecord; error?: string } {
  // Separation of duties rule: An actor cannot approve their own elevated request
  const riskLevel = record.risk_snapshot?.level ?? "low";
  if (record.requested_by === reviewer && riskLevel !== "low") {
    return {
      record,
      error: `Self-approval rejected: User/Agent "${reviewer}" cannot approve their own request for elevated risk (${riskLevel}) skill.`,
    };
  }

  // Check expiration
  if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) {
    return {
      record: {
        ...record,
        status: "EXPIRED",
      },
      error: "Approval request has already expired.",
    };
  }

  const updated: SkillApprovalRecord = {
    ...record,
    status: decision,
    reviewed_by: reviewer,
    decision_reason: reason,
    constraints: constraints ?? record.constraints,
    decided_at: new Date().toISOString(),
  };

  return { record: updated };
}

/**
 * Validates whether an approval record remains valid for a given skill version.
 * If the content SHA-256 has changed, or the approval has expired or was revoked,
 * it returns false.
 */
export function isApprovalValidForVersion(
  approval: SkillApprovalRecord | null | undefined,
  version: SkillVersionRecord,
): boolean {
  if (!approval) return false;
  if (approval.status !== "APPROVED") return false;
  if (approval.skill_version_id !== version.id) return false;

  // Exact content hash binding
  if (approval.content_sha256 !== version.content_sha256) {
    return false;
  }

  // Expiration check
  if (approval.expires_at && new Date(approval.expires_at).getTime() < Date.now()) {
    return false;
  }

  return true;
}

