import { randomBytes } from "node:crypto";
import { computeLeadPriority } from "./scope";
import type { LeadScoreComponents, SecurityLead } from "./types";

export function scoreLead(components: LeadScoreComponents): number {
  return computeLeadPriority(components);
}

export function createLead(input: {
  campaign_id: string;
  asset_id?: string;
  source: string;
  category: string;
  title: string;
  summary: string;
  confidence: number;
  assigned_agent_id?: string;
  score_components: LeadScoreComponents;
  now?: Date;
}): SecurityLead {
  const now = (input.now ?? new Date()).toISOString();
  return {
    id: `lead_${randomBytes(8).toString("hex")}`,
    campaign_id: input.campaign_id,
    asset_id: input.asset_id,
    source: input.source,
    category: input.category,
    title: input.title,
    summary: input.summary,
    priority: scoreLead(input.score_components),
    confidence: input.confidence,
    status: "NEW",
    assigned_agent_id: input.assigned_agent_id,
    evidence_count: 0,
    memory_refs: [],
    score_components: input.score_components,
    created_at: now,
    updated_at: now,
    last_touched_at: now,
  };
}

export function isDuplicateLead(existing: SecurityLead[], candidate: Pick<SecurityLead, "title" | "category" | "asset_id">): SecurityLead | null {
  const needle = candidate.title.trim().toLowerCase();
  return existing.find(lead =>
    lead.category === candidate.category
    && (lead.asset_id ?? "") === (candidate.asset_id ?? "")
    && lead.title.trim().toLowerCase() === needle
    && lead.status !== "DISMISSED",
  ) ?? null;
}
