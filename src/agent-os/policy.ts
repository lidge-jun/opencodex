// Phase 05 — Sandbox & permission policy: deny-by-default capability checks.
//
// A capability is allowed only when an explicit allow policy matches the
// subject. Everything else is denied. shell.exec / fs.write / deploy-class
// capabilities additionally require a granted approval record.

import { openAgentOsDb } from "./db";

export type Capability =
  | "fs.read"
  | "fs.write"
  | "net.fetch"
  | "shell.exec"
  | "git.push"
  | "deploy";

/** Capabilities that can never be granted by policy alone — approval required. */
const APPROVAL_REQUIRED: ReadonlySet<Capability> = new Set<Capability>([
  "fs.write",
  "shell.exec",
  "git.push",
  "deploy",
]);

export interface PolicyDecision {
  allowed: boolean;
  reason: "policy_allow" | "policy_deny" | "default_deny" | "approval_required" | "approval_denied";
}

export function evaluateCapability(
  subjectType: "agent" | "task" | "global",
  subjectId: string | null,
  capability: Capability,
): PolicyDecision {
  const db = openAgentOsDb();
  // A global policy row carries subject_type = 'global' (subject_id NULL) and
  // applies to EVERY subject. Subject-scoped rows match only their exact type+id.
  const globalRows = db
    .query(
      "SELECT id, effect FROM policies WHERE subject_type = 'global' AND capability = ?",
    )
    .all(capability) as { id: string; effect: string }[];
  const specificRows = subjectId
    ? (db
        .query("SELECT id, effect FROM policies WHERE subject_type = ? AND subject_id = ? AND capability = ?")
        .all(subjectType, subjectId, capability) as { id: string; effect: string }[])
    : [];
  // Most specific first (subject match beats global). Deny wins over allow at
  // equal specificity.
  const deny = specificRows.find((r) => r.effect === "deny") ?? globalRows.find((r) => r.effect === "deny");
  if (deny) return { allowed: false, reason: "policy_deny" };
  const allow = specificRows.find((r) => r.effect === "allow") ?? globalRows.find((r) => r.effect === "allow");
  if (!allow) return { allowed: false, reason: "default_deny" };
  if (APPROVAL_REQUIRED.has(capability)) {
    const approval = db
      .query("SELECT status FROM approvals WHERE capability = ? AND status = 'granted' ORDER BY decided_ms DESC LIMIT 1")
      .get(capability) as { status: string } | undefined;
    if (!approval) return { allowed: false, reason: "approval_required" };
  }
  return { allowed: true, reason: "policy_allow" };
}

export function addPolicy(input: {
  id?: string;
  subjectType: "agent" | "task" | "global";
  subjectId?: string | null;
  capability: Capability;
  effect: "allow" | "deny";
  scope?: Record<string, unknown>;
}): string {
  const db = openAgentOsDb();
  const id = input.id ?? `pol_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.query(
    "INSERT OR REPLACE INTO policies (id, subject_type, subject_id, capability, effect, scope_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.subjectType, input.subjectId ?? null, input.capability, input.effect, JSON.stringify(input.scope ?? {}), new Date().toISOString());
  return id;
}

export function clearPolicies(): void {
  openAgentOsDb().exec("DELETE FROM policies");
}

export interface PolicyRecord {
  id: string;
  subjectType: "agent" | "task" | "global";
  subjectId: string | null;
  capability: string;
  effect: "allow" | "deny";
  createdAt: string;
}

export function listPolicies(): PolicyRecord[] {
  return (openAgentOsDb()
    .query("SELECT id, subject_type, subject_id, capability, effect, created_at FROM policies ORDER BY created_at DESC, id")
    .all() as { id: string; subject_type: string; subject_id: string | null; capability: string; effect: string; created_at: string }[])
    .map((row) => ({
      id: row.id,
      subjectType: row.subject_type as PolicyRecord["subjectType"],
      subjectId: row.subject_id,
      capability: row.capability,
      effect: row.effect as "allow" | "deny",
      createdAt: row.created_at,
    }));
}

export function removePolicy(policyId: string): boolean {
  const result = openAgentOsDb().query("DELETE FROM policies WHERE id = ?").run(policyId);
  return result.changes > 0;
}
