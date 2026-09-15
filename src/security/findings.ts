import { randomBytes } from "node:crypto";
import type {
  FindingStatus,
  SecurityFinding,
  SecurityValidationResult,
  SevenQuestionAnswers,
  ValidationDisposition,
} from "./types";

export function createFinding(input: {
  campaign_id: string;
  asset_id?: string;
  lead_id?: string;
  title: string;
  category: string;
  severity: SecurityFinding["severity"];
  confidence: number;
  impact_summary: string;
  technical_summary: string;
  scope_snapshot_id?: string;
  created_by_agent_id: string;
  now?: Date;
}): SecurityFinding {
  const now = (input.now ?? new Date()).toISOString();
  return {
    id: `fnd_${randomBytes(8).toString("hex")}`,
    campaign_id: input.campaign_id,
    asset_id: input.asset_id,
    lead_id: input.lead_id,
    title: input.title,
    category: input.category,
    severity: input.severity,
    confidence: input.confidence,
    impact_summary: input.impact_summary,
    technical_summary: input.technical_summary,
    scope_snapshot_id: input.scope_snapshot_id,
    status: "VALIDATION_PENDING",
    created_by_agent_id: input.created_by_agent_id,
    created_at: now,
    updated_at: now,
  };
}

export function evaluateSevenQuestions(answers: SevenQuestionAnswers, duplicate = false): ValidationDisposition {
  if (!answers.scope) return "FAIL_OUT_OF_SCOPE";
  if (!answers.policy) return "FAIL_POLICY";
  if (duplicate || !answers.novelty) return "FAIL_DUPLICATE";
  if (!answers.reality || !answers.evidence) return "FAIL_WEAK_EVIDENCE";
  if (!answers.reproducibility) return "FAIL_NOT_REPRODUCIBLE";
  if (!answers.impact) return "FAIL_NO_IMPACT";
  return "PASS";
}

export function applyValidation(
  finding: SecurityFinding,
  answers: SevenQuestionAnswers,
  validatedBy: string,
  notes: string,
  duplicate = false,
  now: Date = new Date(),
): { finding: SecurityFinding; validation: SecurityValidationResult } {
  const disposition = evaluateSevenQuestions(answers, duplicate);
  const validation: SecurityValidationResult = {
    id: `val_${randomBytes(8).toString("hex")}`,
    finding_id: finding.id,
    campaign_id: finding.campaign_id,
    disposition,
    answers,
    notes,
    validated_by: validatedBy,
    created_at: now.toISOString(),
  };
  let status: FindingStatus;
  if (disposition === "PASS") status = "VALIDATED";
  else if (disposition === "NEEDS_HUMAN_REVIEW") status = "HUMAN_REVIEW";
  else if (disposition === "FAIL_DUPLICATE") status = "DUPLICATE";
  else status = "REJECTED";
  return {
    finding: {
      ...finding,
      status,
      validation_result_id: validation.id,
      updated_at: now.toISOString(),
    },
    validation,
  };
}

export function canExportFinding(finding: SecurityFinding): boolean {
  return finding.status === "VALIDATED" || finding.status === "REPORT_READY" || finding.status === "SUBMITTED_EXTERNALLY";
}

export function isDuplicateFinding(
  existing: SecurityFinding[],
  candidate: Pick<SecurityFinding, "title" | "category" | "asset_id">,
): SecurityFinding | null {
  const needle = candidate.title.trim().toLowerCase();
  return existing.find(f =>
    f.category === candidate.category
    && (f.asset_id ?? "") === (candidate.asset_id ?? "")
    && f.title.trim().toLowerCase() === needle
    && f.status !== "REJECTED"
    && f.status !== "CLOSED",
  ) ?? null;
}
