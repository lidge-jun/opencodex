// Phase 15 (WebMCP) — Audit for tool calls.
//
// Every WebMCP tool execution records one event here. The registry (browser
// side) posts a summary; the server computes the input hash itself so raw tool
// input is never persisted, only its SHA-256 digest and a safe redacted
// summary. Read path is the same audit trail the Agent Activity UI shows.

import { createHash } from "node:crypto";
import { openAgentOsDb } from "./db";

export type WebMcpRiskTier = "R0" | "R1" | "R2" | "R3" | "R4";

export interface WebMcpAuditInput {
  tool: string;
  actor?: string;
  projectId?: string | null;
  input?: Record<string, unknown>;
  result: "success" | "error" | "denied";
  errorCode?: string | null;
  durationMs?: number;
  approvalId?: string | null;
  riskTier?: WebMcpRiskTier;
}

export interface WebMcpAuditRecord {
  id: number;
  tsMs: number;
  tool: string;
  actor: string;
  riskTier: WebMcpRiskTier;
  projectId: string | null;
  inputHash: string;
  inputSummary: string;
  result: "success" | "error" | "denied";
  errorCode: string | null;
  durationMs: number;
  approvalId: string | null;
}

function redactValue(value: unknown): string {
  if (typeof value === "string") {
    if (/^(sk-|ghp_|gho_|github_pat_|xoxb-|AKIA)/i.test(value)) return "***";
    if (value.length > 80) return value.slice(0, 77) + "...";
    return value;
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value).slice(0, 160);
  return String(value).slice(0, 160);
}

export function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input || Object.keys(input).length === 0) return "";
  return Object.entries(input)
    .slice(0, 8)
    .map(([key, value]) => key + "=" + redactValue(value))
    .join("; ");
}

export function hashToolInput(input: Record<string, unknown> | undefined): string {
  return createHash("sha256").update(JSON.stringify(input ?? {})).digest("hex");
}

export function recordWebMcpCall(input: WebMcpAuditInput): WebMcpAuditRecord {
  const db = openAgentOsDb();
  const tsMs = Date.now();
  const riskTier = input.riskTier ?? "R0";
  const result = db
    .query("INSERT INTO agent_events (ts_ms, task_id, agent_id, kind, payload_json) VALUES (?, NULL, ?, ?, ?)")
    .run(
      tsMs,
      "webmcp:" + (input.actor ?? "agent"),
      "webmcp.tool_call",
      JSON.stringify({
        tool: input.tool,
        riskTier,
        projectId: input.projectId ?? null,
        inputHash: hashToolInput(input.input),
        inputSummary: summarizeToolInput(input.input),
        result: input.result,
        errorCode: input.errorCode ?? null,
        durationMs: input.durationMs ?? 0,
        approvalId: input.approvalId ?? null,
      }),
    );
  return {
    id: Number(result.lastInsertRowid),
    tsMs,
    tool: input.tool,
    actor: input.actor ?? "agent",
    riskTier,
    projectId: input.projectId ?? null,
    inputHash: hashToolInput(input.input),
    inputSummary: summarizeToolInput(input.input),
    result: input.result,
    errorCode: input.errorCode ?? null,
    durationMs: input.durationMs ?? 0,
    approvalId: input.approvalId ?? null,
  };
}

export function listWebMcpCalls(limit = 100): WebMcpAuditRecord[] {
  const rows = openAgentOsDb()
    .query("SELECT id, ts_ms, agent_id, kind, payload_json FROM agent_events WHERE kind = 'webmcp.tool_call' ORDER BY ts_ms DESC, id DESC LIMIT ?")
    .all(Math.min(limit, 500)) as { id: number; ts_ms: number; agent_id: string | null; payload_json: string }[];
  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as {
      tool: string; riskTier: WebMcpRiskTier; projectId: string | null;
      inputHash: string; inputSummary: string; result: "success" | "error" | "denied";
      errorCode: string | null; durationMs: number; approvalId: string | null;
    };
    return {
      id: row.id,
      tsMs: row.ts_ms,
      tool: payload.tool,
      actor: (row.agent_id ?? 'webmcp:agent').replace('webmcp:', ''),
      riskTier: payload.riskTier,
      projectId: payload.projectId,
      inputHash: payload.inputHash,
      inputSummary: payload.inputSummary,
      result: payload.result,
      errorCode: payload.errorCode,
      durationMs: payload.durationMs,
      approvalId: payload.approvalId,
    };
  });
}
