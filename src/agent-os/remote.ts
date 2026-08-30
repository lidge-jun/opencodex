// Phase 12 — Remote Nodes: register/heartbeat/capability-route for external
// executors. Registration is deny-by-default; nodes never receive write access
// implicitly and this module only tracks them (no dispatch in this phase).

import { randomUUID } from "node:crypto";
import { openAgentOsDb } from "./db";

export type RemoteNodeStatus = "online" | "stale" | "offline";

export interface RemoteNode {
  id: string;
  name: string;
  capabilities: string[];
  maxParallel: number;
  lastHeartbeatMs: number;
  status: RemoteNodeStatus;
}

interface RemoteNodeRow {
  id: string;
  name: string;
  capabilities_json: string;
  max_parallel: number;
  last_heartbeat_ms: number;
}

function rowToNode(row: RemoteNodeRow, now: number): RemoteNode {
  const staleAfterMs = 90_000;
  const offlineAfterMs = 300_000;
  const age = now - row.last_heartbeat_ms;
  const status: RemoteNodeStatus = age < staleAfterMs ? "online" : age < offlineAfterMs ? "stale" : "offline";
  return {
    id: row.id,
    name: row.name,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    maxParallel: row.max_parallel,
    lastHeartbeatMs: row.last_heartbeat_ms,
    status,
  };
}

export function registerNode(input: { id?: string; name: string; capabilities: string[]; maxParallel?: number }): RemoteNode {
  const db = openAgentOsDb();
  const id = input.id ?? `node_${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  db.query(`
    INSERT INTO remote_nodes (id, name, capabilities_json, max_parallel, last_heartbeat_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      capabilities_json = excluded.capabilities_json,
      max_parallel = excluded.max_parallel,
      last_heartbeat_ms = excluded.last_heartbeat_ms
  `).run(id, input.name, JSON.stringify(input.capabilities), input.maxParallel ?? 1, now);
  const row = db.query("SELECT * FROM remote_nodes WHERE id = ?").get(id) as RemoteNodeRow;
  return rowToNode(row, now);
}

export function heartbeatNode(id: string): boolean {
  const result = openAgentOsDb()
    .query("UPDATE remote_nodes SET last_heartbeat_ms = ? WHERE id = ?")
    .run(Date.now(), id);
  return result.changes > 0;
}

export function listNodes(): RemoteNode[] {
  const now = Date.now();
  return (openAgentOsDb().query("SELECT * FROM remote_nodes ORDER BY name, id").all() as RemoteNodeRow[]).map((row) => rowToNode(row, now));
}

/** Nodes whose declared capabilities cover the requested one and are alive. */
export function nodesForCapability(capability: string): RemoteNode[] {
  return listNodes().filter((node) => node.status === "online" && node.capabilities.includes(capability));
}
