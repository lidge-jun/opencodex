import { randomBytes } from "node:crypto";
import { DEFAULT_APPROVAL_TTL_MINUTES } from "./constants";
import type { ApprovalDecisionKind, SecurityApproval, SecurityPolicyProfile } from "./types";

export function createApprovalRequest(input: {
  campaign_id: string;
  capability_id: string;
  target: string;
  risk_tier: SecurityApproval["risk_tier"];
  requested_by: string;
  requested_agent_id?: string;
  task_id?: string;
  execution_id?: string;
  expected_effect: string;
  policy_rule: string;
  parameters?: Record<string, unknown>;
  request_volume?: number;
  max_duration_seconds?: number;
  ttlMinutes?: number;
  now?: Date;
}): SecurityApproval {
  const now = input.now ?? new Date();
  const ttl = input.ttlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES;
  return {
    id: `sap_${randomBytes(8).toString("hex")}`,
    campaign_id: input.campaign_id,
    task_id: input.task_id,
    execution_id: input.execution_id,
    capability_id: input.capability_id,
    target: input.target,
    risk_tier: input.risk_tier,
    requested_by: input.requested_by,
    requested_agent_id: input.requested_agent_id,
    request_volume: input.request_volume ?? 1,
    max_duration_seconds: input.max_duration_seconds ?? 300,
    expected_effect: input.expected_effect,
    policy_rule: input.policy_rule,
    parameters_json: JSON.stringify(input.parameters ?? {}),
    status: "PENDING",
    expires_at: new Date(now.getTime() + ttl * 60_000).toISOString(),
    created_at: now.toISOString(),
  };
}

export function decideApproval(
  record: SecurityApproval,
  decision: ApprovalDecisionKind,
  reviewer: string,
  reason: string,
  profile: Pick<SecurityPolicyProfile, "self_approval">,
  now: Date = new Date(),
): { record: SecurityApproval; error?: string } {
  if (record.status !== "PENDING") {
    return { record, error: "Approval is no longer pending." };
  }
  if (Date.parse(record.expires_at) <= now.getTime()) {
    return { record: { ...record, status: "EXPIRED" }, error: "Approval request has already expired." };
  }
  if (!profile.self_approval && record.requested_by === reviewer) {
    return { record, error: `Self-approval rejected: "${reviewer}" cannot approve their own security request.` };
  }
  if (record.requested_agent_id && record.requested_agent_id === reviewer) {
    return { record, error: "Agents cannot approve their own elevated requests." };
  }

  const granted = decision === "APPROVE_ONCE" || decision === "APPROVE_FOR_TASK";
  return {
    record: {
      ...record,
      status: granted ? "GRANTED" : decision === "CANCEL_CAMPAIGN" ? "CANCELLED" : "DENIED",
      decision,
      decided_by: reviewer,
      decision_reason: reason,
      decided_at: now.toISOString(),
    },
  };
}

export function isApprovalValid(
  record: SecurityApproval | null | undefined,
  expected: { campaign_id: string; capability_id: string; target?: string },
  now: Date = new Date(),
): boolean {
  if (!record) return false;
  if (record.status !== "GRANTED") return false;
  if (Date.parse(record.expires_at) <= now.getTime()) return false;
  if (record.campaign_id !== expected.campaign_id) return false;
  if (record.capability_id !== expected.capability_id) return false;
  if (expected.target && record.target !== expected.target && record.decision !== "APPROVE_FOR_TASK") return false;
  return true;
}
