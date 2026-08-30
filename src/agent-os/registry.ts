// Phase 02 — Agent Registry: canonical agent identity, lifecycle, permissions.

import { randomUUID } from "node:crypto";
import { openAgentOsDb } from "./db";

export interface AgentPermissions {
  read: boolean;
  write: boolean;
  terminal: boolean;
  net: boolean;
}

export interface AgentRecord {
  id: string;
  name: string;
  provider: string;
  type: string;
  enabled: boolean;
  permissions: AgentPermissions;
  health: "unknown" | "idle" | "running" | "failed";
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRegistrationInput {
  id?: string;
  name: string;
  provider: string;
  type?: string;
  enabled?: boolean;
  permissions?: Partial<AgentPermissions>;
  config?: Record<string, unknown>;
}

export const DEFAULT_PERMISSIONS: AgentPermissions = {
  // Fail-closed defaults: an agent may read, nothing else, until policy says so.
  read: true,
  write: false,
  terminal: false,
  net: false,
};

interface AgentRow {
  id: string;
  name: string;
  provider: string;
  type: string;
  enabled: number;
  permissions_json: string;
  health: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

function rowToAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    type: row.type,
    enabled: row.enabled === 1,
    permissions: { ...DEFAULT_PERMISSIONS, ...(JSON.parse(row.permissions_json) as Partial<AgentPermissions>) },
    health: row.health as AgentRecord["health"],
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerAgent(input: AgentRegistrationInput): AgentRecord {
  const db = openAgentOsDb();
  const id = input.id ?? `agent_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const permissions = { ...DEFAULT_PERMISSIONS, ...input.permissions };
  db.query(`
    INSERT INTO agents (id, name, provider, type, enabled, permissions_json, health, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      provider = excluded.provider,
      type = excluded.type,
      enabled = excluded.enabled,
      permissions_json = excluded.permissions_json,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.name,
    input.provider,
    input.type ?? "generalist",
    input.enabled === false ? 0 : 1,
    JSON.stringify(permissions),
    JSON.stringify(input.config ?? {}),
    now,
    now,
  );
  const row = db.query("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow;
  return rowToAgent(row);
}

export function getAgent(id: string): AgentRecord | null {
  const row = openAgentOsDb().query("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function listAgents(options: { enabledOnly?: boolean } = {}): AgentRecord[] {
  const db = openAgentOsDb();
  const rows = (
    options.enabledOnly
      ? db.query("SELECT * FROM agents WHERE enabled = 1 ORDER BY created_at, id")
      : db.query("SELECT * FROM agents ORDER BY created_at, id")
  ).all() as AgentRow[];
  return rows.map(rowToAgent);
}

export function setAgentHealth(id: string, health: AgentRecord["health"]): boolean {
  const db = openAgentOsDb();
  const result = db
    .query("UPDATE agents SET health = ?, updated_at = ? WHERE id = ?")
    .run(health, new Date().toISOString(), id);
  return result.changes > 0;
}

export function setAgentEnabled(id: string, enabled: boolean): boolean {
  const db = openAgentOsDb();
  const result = db
    .query("UPDATE agents SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), id);
  return result.changes > 0;
}
