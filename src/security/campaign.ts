import type { CampaignStatus } from "./types";

const ALLOWED: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: ["SCOPE_CHECK", "CANCELLED"],
  SCOPE_CHECK: ["READY", "BLOCKED_SCOPE", "BLOCKED_POLICY", "CANCELLED"],
  READY: ["RECON_RUNNING", "PAUSED", "CANCELLED", "BLOCKED_POLICY"],
  RECON_RUNNING: ["TRIAGE", "WAITING_APPROVAL", "PAUSED", "BLOCKED_POLICY", "BLOCKED_SCOPE", "FAILED", "CANCELLED"],
  TRIAGE: ["VALIDATION", "WAITING_APPROVAL", "PAUSED", "FAILED", "CANCELLED"],
  VALIDATION: ["HUMAN_REVIEW", "REPORT_READY", "WAITING_APPROVAL", "PAUSED", "FAILED", "CANCELLED"],
  HUMAN_REVIEW: ["REPORT_READY", "VALIDATION", "PAUSED", "CANCELLED"],
  REPORT_READY: ["CLOSED", "HUMAN_REVIEW", "CANCELLED"],
  CLOSED: [],
  PAUSED: ["READY", "RECON_RUNNING", "TRIAGE", "VALIDATION", "HUMAN_REVIEW", "CANCELLED"],
  BLOCKED_POLICY: ["PAUSED", "CANCELLED"],
  BLOCKED_SCOPE: ["SCOPE_CHECK", "CANCELLED"],
  WAITING_APPROVAL: ["RECON_RUNNING", "TRIAGE", "VALIDATION", "PAUSED", "CANCELLED", "BLOCKED_POLICY"],
  CANCELLED: [],
  FAILED: ["CANCELLED"],
};

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  if (from === to) return true;
  return (ALLOWED[from] ?? []).includes(to);
}

export function transitionCampaign(from: CampaignStatus, to: CampaignStatus): CampaignStatus {
  if (!canTransitionCampaign(from, to)) {
    throw new Error(`Illegal campaign transition ${from} → ${to}`);
  }
  return to;
}

export const EXECUTABLE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  "READY",
  "RECON_RUNNING",
  "TRIAGE",
  "VALIDATION",
  "HUMAN_REVIEW",
  "WAITING_APPROVAL",
];
