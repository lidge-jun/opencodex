// Phase 16 — Pao Agent Gateway + Safe Execution.
//
// The Brain Universe (Phase 15) may SEE but never silently ACT. This module is
// the only sanctioned path from observation to mutation:
//
//   1. A permit REQUEST names exactly one capability + target (project, path).
//   2. Approval is explicit and human-owned (the approvals ledger, Phase 05).
//   3. The issued permit is SHA-256-bound to the target scope + an expiry, so a
//      leaked permit string is useless against any other target or later time.
//   4. Redemption is single-use and verifies: permit digest, scope hash match,
//      expiry, policy allow, and approval. Any mismatch fails closed.
//
// There is deliberately no "auto-issue" path: code in this repo can REQUEST a
// permit, only a human can grant one.

import { createHash, randomBytes } from "node:crypto";
import { openAgentOsDb } from "./db";
import { evaluateCapability, type Capability } from "./policy";
import { recordAgentEvent } from "./events";

export type PermitScope =
  | { kind: "file"; path: string }
  | { kind: "task"; taskId: string }
  | { kind: "project"; projectId: string };

export function scopeKey(scope: PermitScope): string {
  return scope.kind === "file" ? `file:${scope.path}` : scope.kind === "task" ? `task:${scope.taskId}` : `project:${scope.projectId}`;
}

export function scopeHash(scope: PermitScope): string {
  return createHash("sha256").update(scopeKey(scope)).digest("hex");
}

export interface WritePermit {
  id: string;
  capability: Capability;
  scope: PermitScope;
  /** Hex digest of the secret permit token — the token itself is never stored. */
  tokenDigest: string;
  issuedAtMs: number;
  expiresAtMs: number;
  status: "issued" | "redeemed" | "expired" | "revoked";
}

interface PermitRow {
  id: string;
  capability: string;
  scope_json: string;
  scope_hash: string;
  token_digest: string;
  issued_at_ms: number;
  expires_at_ms: number;
  status: string;
}

const DEFAULT_TTL_MS = 10 * 60_000;

export interface PermitRequestInput {
  capability: Capability;
  scope: PermitScope;
  reason: string;
  taskId?: string | null;
  ttlMs?: number;
  /** Workflow linkage: the decision endpoint resumes the run after deciding. */
  workflowRunId?: string;
  stepIndex?: number;
}

/**
 * Request a permit. Creates a PENDING approval row (human gate) and returns the
 * approval id. No permit exists until that approval is granted and the permit
 * is issued against it.
 */
export function requestWritePermit(input: PermitRequestInput): { approvalId: string } {
  const db = openAgentOsDb();
  const approvalId = `apr_${randomBytes(6).toString("hex")}`;
  const contextJson = JSON.stringify({ workflowRunId: input.workflowRunId, stepIndex: input.stepIndex });
  db.query(
    "INSERT INTO approvals (id, task_id, capability, reason, status, requested_ms) VALUES (?, ?, ?, ?, 'pending', ?)",
  ).run(approvalId, input.taskId ?? null, input.capability, `[permit] ${scopeKey(input.scope)} — ${input.reason}`, Date.now());
  db.query(
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(`approval_context:${approvalId}`, contextJson);
  recordAgentEvent({ taskId: input.taskId ?? null, kind: "permit.requested", payload: { approvalId, capability: input.capability, scope: scopeKey(input.scope) } });
  return { approvalId };
}

/**
 * Issue a permit for a GRANTED approval. Called by the approval flow once a
 * human grants it — never callable for a pending/denied approval.
 */
export function issueWritePermit(approvalId: string, scope: PermitScope, ttlMs = DEFAULT_TTL_MS): { permit: WritePermit; token: string } | { error: string } {
  const db = openAgentOsDb();
  const approval = db.query("SELECT * FROM approvals WHERE id = ?").get(approvalId) as
    | { id: string; capability: string; status: string }
    | undefined;
  if (!approval) return { error: "approval_not_found" };
  if (approval.status !== "granted") return { error: `approval_${approval.status}` };

  const token = `wp_${randomBytes(24).toString("hex")}`;
  const tokenDigest = createHash("sha256").update(token).digest("hex");
  const id = `wp_${randomBytes(6).toString("hex")}`;
  const now = Date.now();
  db.query(`
    INSERT INTO write_permits (id, approval_id, capability, scope_json, scope_hash, token_digest, issued_at_ms, expires_at_ms, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued')
  `).run(id, approvalId, approval.capability, JSON.stringify(scope), scopeHash(scope), tokenDigest, now, now + ttlMs);
  recordAgentEvent({ kind: "permit.issued", payload: { permitId: id, capability: approval.capability, scope: scopeKey(scope) } });
  return {
    permit: {
      id,
      capability: approval.capability as Capability,
      scope,
      tokenDigest,
      issuedAtMs: now,
      expiresAtMs: now + ttlMs,
      status: "issued",
    },
    token,
  };
}

export interface RedemptionResult {
  ok: boolean;
  code: "redeemed" | "not_found" | "bad_token" | "expired" | "revoked" | "already_used" | "scope_mismatch" | "policy_denied" | "approval_required";
}

/**
 * Redeem a permit to perform one mutation attempt. Single-use: success flips the
 * row to 'redeemed' inside the same transaction as the event record. Fail closed
 * on every mismatch.
 */
export function redeemWritePermit(input: {
  permitId: string;
  token: string;
  scope: PermitScope;
  subjectType: "agent" | "task" | "global";
  subjectId: string | null;
}): RedemptionResult {
  const db = openAgentOsDb();
  const row = db.query("SELECT * FROM write_permits WHERE id = ?").get(input.permitId) as PermitRow | undefined;
  if (!row) return { ok: false, code: "not_found" };
  if (row.status === "revoked") return { ok: false, code: "revoked" };
  if (row.status === "redeemed") return { ok: false, code: "already_used" };
  if (row.expires_at_ms < Date.now()) {
    db.query("UPDATE write_permits SET status = 'expired' WHERE id = ?").run(input.permitId);
    return { ok: false, code: "expired" };
  }
  const tokenDigest = createHash("sha256").update(input.token).digest("hex");
  if (tokenDigest !== row.token_digest) return { ok: false, code: "bad_token" };
  if (scopeHash(input.scope) !== row.scope_hash) return { ok: false, code: "scope_mismatch" };

  const policy = evaluateCapability(input.subjectType, input.subjectId, row.capability as Capability);
  if (!policy.allowed) return { ok: false, code: policy.reason === "approval_required" ? "approval_required" : "policy_denied" };

  // Single-use flip; the conditional UPDATE is the concurrency fence.
  const flip = db
    .query("UPDATE write_permits SET status = 'redeemed' WHERE id = ? AND status = 'issued'")
    .run(input.permitId);
  if (flip.changes === 0) return { ok: false, code: "already_used" };
  recordAgentEvent({ kind: "permit.redeemed", payload: { permitId: input.permitId, scope: scopeKey(input.scope) } });
  return { ok: true, code: "redeemed" };
}

export function revokeWritePermit(permitId: string): boolean {
  const result = openAgentOsDb()
    .query("UPDATE write_permits SET status = 'revoked' WHERE id = ? AND status = 'issued'")
    .run(permitId);
  return result.changes > 0;
}

export function getWritePermit(permitId: string): WritePermit | null {
  const row = openAgentOsDb().query("SELECT * FROM write_permits WHERE id = ?").get(permitId) as PermitRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    capability: row.capability as Capability,
    scope: JSON.parse(row.scope_json) as PermitScope,
    tokenDigest: row.token_digest,
    issuedAtMs: row.issued_at_ms,
    expiresAtMs: row.expires_at_ms,
    status: row.status as WritePermit["status"],
  };
}

/**
 * Phase 16 completion: bridge the human decision on an approval to any
 * workflow step waiting on it. The workflow run records the decision in its
 * state (grantWorkflowApproval) and the pump resumes it. This keeps ONE
 * decision surface for humans — the approvals ledger — whether the gated thing
 * is a raw permit or a workflow step.
 */
export function decideApproval(
  approvalId: string,
  decision: "granted" | "denied",
  decidedBy: string,
  context?: { workflowRunId?: string; stepIndex?: number },
): { ok: boolean; workflowResumed?: boolean } {
  const db = openAgentOsDb();
  const result = db
    .query("UPDATE approvals SET status = ?, decided_ms = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
    .run(decision, Date.now(), decidedBy, approvalId);
  if (result.changes === 0) return { ok: false };
  recordAgentEvent({ kind: decision === "granted" ? "approval.granted" : "approval.denied", payload: { approvalId, decidedBy } });
  if (context?.workflowRunId !== undefined && context.stepIndex !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { grantWorkflowApproval } = require("./workflow") as { grantWorkflowApproval: (id: string, i: number, g: boolean) => unknown };
    grantWorkflowApproval(context.workflowRunId, context.stepIndex, decision === "granted");
    return { ok: true, workflowResumed: decision === "granted" };
  }
  return { ok: true };
}
