// Phase 08 — Skill Store: versioned operating knowledge with health checks.

import { randomUUID } from "node:crypto";
import { openAgentOsDb } from "./db";

export type SkillStatus = "active" | "deprecated" | "missing";

export interface SkillRecord {
  id: string;
  name: string;
  version: string;
  path: string | null;
  description: string;
  status: SkillStatus;
  config: Record<string, unknown>;
  updatedAt: string;
}

export interface SkillHealthIssue {
  skillId: string;
  kind: "duplicate_name" | "missing_file" | "deprecated";
  detail: string;
}

interface SkillRow {
  id: string;
  name: string;
  version: string;
  path: string | null;
  description: string;
  status: string;
  config_json: string;
  updated_at: string;
}

function rowToSkill(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    path: row.path,
    description: row.description,
    status: row.status as SkillStatus,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    updatedAt: row.updated_at,
  };
}

export function upsertSkill(input: {
  id?: string;
  name: string;
  version?: string;
  path?: string | null;
  description?: string;
  status?: SkillStatus;
  config?: Record<string, unknown>;
}): SkillRecord {
  const db = openAgentOsDb();
  const id = input.id ?? `skill_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO skills (id, name, version, path, description, status, config_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      version = excluded.version,
      path = excluded.path,
      description = excluded.description,
      status = excluded.status,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `).run(id, input.name, input.version ?? "0", input.path ?? null, input.description ?? "", input.status ?? "active", JSON.stringify(input.config ?? {}), now);
  const row = db.query("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow;
  return rowToSkill(row);
}

export function listSkills(): SkillRecord[] {
  return (openAgentOsDb().query("SELECT * FROM skills ORDER BY name, id").all() as SkillRow[]).map(rowToSkill);
}

export function getSkill(id: string): SkillRecord | null {
  const row = openAgentOsDb().query("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
  return row ? rowToSkill(row) : null;
}

/**
 * Registry health pass: flags duplicate names, skills whose file vanished,
 * and deprecated entries. Read-only — never mutates skills.
 */
export async function checkSkillHealth(): Promise<SkillHealthIssue[]> {
  const issues: SkillHealthIssue[] = [];
  const skills = listSkills();
  const byName = new Map<string, SkillRecord[]>();
  for (const skill of skills) {
    const list = byName.get(skill.name) ?? [];
    list.push(skill);
    byName.set(skill.name, list);
  }
  for (const [name, list] of byName) {
    if (list.length > 1) {
      for (const skill of list) {
        issues.push({ skillId: skill.id, kind: "duplicate_name", detail: `name "${name}" is registered ${list.length} times` });
      }
    }
  }
  for (const skill of skills) {
    if (skill.status === "deprecated") {
      issues.push({ skillId: skill.id, kind: "deprecated", detail: skill.name });
    } else if (skill.path && !(await Bun.file(skill.path).exists())) {
      issues.push({ skillId: skill.id, kind: "missing_file", detail: skill.path });
    }
  }
  return issues;
}
