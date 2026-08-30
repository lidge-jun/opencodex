// Phase 16 (observability slice) — Reviewer Council results, read + aggregate.
// Phase 15 spec: the system READS and PRESENTS council verdicts; it never
// silently acts on them (scoped Write Permits belong to the gateway phase).

import { randomUUID } from "node:crypto";
import { openAgentOsDb } from "./db";

export type ReviewVerdict = "pass" | "warn" | "fail";

export interface ReviewRecord {
  id: string;
  subjectKind: string;
  subjectId: string;
  reviewer: string;
  verdict: ReviewVerdict;
  score: number | null;
  notes: string;
  createdAt: string;
}

export interface CouncilSummary {
  subjectKind: string;
  subjectId: string;
  reviews: ReviewRecord[];
  final: "pass" | "needs_review" | "fail";
}

interface ReviewRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  reviewer: string;
  verdict: string;
  score: number | null;
  notes: string;
  created_at: string;
}

function rowToReview(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    reviewer: row.reviewer,
    verdict: row.verdict as ReviewVerdict,
    score: row.score,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export function recordReview(input: {
  id?: string;
  subjectKind: string;
  subjectId: string;
  reviewer: string;
  verdict: ReviewVerdict;
  score?: number | null;
  notes?: string;
}): ReviewRecord {
  const db = openAgentOsDb();
  const id = input.id ?? `rev_${randomUUID().slice(0, 8)}`;
  db.query(
    "INSERT INTO reviews (id, subject_kind, subject_id, reviewer, verdict, score, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.subjectKind, input.subjectId, input.reviewer, input.verdict, input.score ?? null, input.notes ?? "", new Date().toISOString());
  const row = db.query("SELECT * FROM reviews WHERE id = ?").get(id) as ReviewRow;
  return rowToReview(row);
}

/**
 * Deterministic council aggregation: any fail -> fail; any warn (or missing
 * expected reviewer) -> needs_review; else pass. No model calls, no ambiguity.
 */
export function summarizeCouncil(subjectKind: string, subjectId: string): CouncilSummary | null {
  const rows = openAgentOsDb()
    .query("SELECT * FROM reviews WHERE subject_kind = ? AND subject_id = ? ORDER BY created_at, id")
    .all(subjectKind, subjectId) as ReviewRow[];
  if (rows.length === 0) return null;
  const reviews = rows.map(rowToReview);
  const verdicts = reviews.map((r) => r.verdict);
  const final: CouncilSummary["final"] = verdicts.includes("fail")
    ? "fail"
    : verdicts.includes("warn")
      ? "needs_review"
      : "pass";
  return { subjectKind, subjectId, reviews, final };
}
