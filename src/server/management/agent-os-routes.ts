/**
 * Agent OS / Brain Universe observatory routes (read-only).
 *
 * Phase 15 rule: the system may SEE, INDEX, SEARCH, EXPLAIN — it may not
 * silently ACT. Every handler here is a GET over the local Agent OS store.
 * Mutations happen only through internal engine calls with their own policy
 * checks (Phase 05), never through an HTTP write in this file.
 */

import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import {
  listMemories,
  readMemory,
} from "../../agent-os/memory";
import { checkSkillHealth, listSkills } from "../../agent-os/skills";
import { listAgents } from "../../agent-os/registry";
import { listTasks } from "../../agent-os/tasks";
import { listNodes } from "../../agent-os/remote";
import { askPaoBrain } from "../../agent-os/ask";
import { searchAgentOs } from "../../agent-os/search";
import { summarizeCouncil } from "../../agent-os/reviews";
import { taskTimeline } from "../../agent-os/observability";
import {
  decideApproval,
  issueWritePermit,
  redeemWritePermit,
  requestWritePermit,
  revokeWritePermit,
  scopeKey,
  type PermitScope,
} from "../../agent-os/gateway";
import { addPolicy, listPolicies, removePolicy } from "../../agent-os/policy";
import { registerProject, scanProject } from "../../agent-os/brain-scanner";
import { listSessions } from "../../agent-os/brain-sessions";
import { getBrainUniverse, getProjectAtlas } from "../../agent-os/brain-graph";
import { listWebMcpCalls, recordWebMcpCall } from "../../agent-os/webmcp";

function notFound(req: Request, message: string): Response {
  return jsonResponse({ error: { code: "not_found", message } }, 404, req, {});
}

export async function handleAgentOsRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req } = ctx;
  if (!url.pathname.startsWith("/api/agent-os/")) return null;
  const path = url.pathname.slice("/api/agent-os/".length);

  // --- Phase 16 gateway surface (the ONLY write paths, and they never mutate
  // a project directly: they request/issue/redeem permits against the approval
  // ledger, which a human owns). ---
  if (path === "permits/request" && req.method === "POST") {
    const body = await req.json().catch(() => null) as
      | { capability?: string; scope?: PermitScope; reason?: string; taskId?: string; workflowRunId?: string; stepIndex?: number }
      | null;
    if (!body?.capability || !body?.scope || !body?.reason) {
      return jsonResponse({ error: { code: "invalid_body", message: "capability, scope, and reason are required" } }, 400, req, {});
    }
    const { approvalId } = requestWritePermit({
      capability: body.capability as never,
      scope: body.scope,
      reason: body.reason,
      taskId: body.taskId ?? null,
      workflowRunId: body.workflowRunId,
      stepIndex: body.stepIndex,
    });
    return jsonResponse({ approvalId, status: "pending", note: "A human must grant this approval before any permit is issued." }, 202, req, {});
  }
  if (path === "permits/issue" && req.method === "POST") {
    const body = await req.json().catch(() => null) as { approvalId?: string; scope?: PermitScope; ttlMs?: number } | null;
    if (!body?.approvalId || !body?.scope) {
      return jsonResponse({ error: { code: "invalid_body", message: "approvalId and scope are required" } }, 400, req, {});
    }
    const result = issueWritePermit(body.approvalId, body.scope, body.ttlMs);
    if ("error" in result) {
      return jsonResponse({ error: { code: result.error, message: "permit issuance refused — approval is not granted" } }, 409, req, {});
    }
    return jsonResponse({ permitId: result.permit.id, token: result.token, expiresAtMs: result.permit.expiresAtMs }, 201, req, {});
  }
  if (path === "permits/redeem" && req.method === "POST") {
    const body = await req.json().catch(() => null) as
      | { permitId?: string; token?: string; scope?: PermitScope; subjectType?: "agent" | "task" | "global"; subjectId?: string | null }
      | null;
    if (!body?.permitId || !body?.token || !body?.scope || !body?.subjectType) {
      return jsonResponse({ error: { code: "invalid_body", message: "permitId, token, scope, and subjectType are required" } }, 400, req, {});
    }
    const result = redeemWritePermit({
      permitId: body.permitId,
      token: body.token,
      scope: body.scope,
      subjectType: body.subjectType,
      subjectId: body.subjectId ?? null,
    });
    return jsonResponse(result, result.ok ? 200 : 403, req, {});
  }
  if (path === "permits/revoke" && req.method === "POST") {
    const body = await req.json().catch(() => null) as { permitId?: string } | null;
    if (!body?.permitId) return jsonResponse({ error: { code: "invalid_body", message: "permitId is required" } }, 400, req, {});
    const revoked = revokeWritePermit(body.permitId);
    return jsonResponse({ revoked }, revoked ? 200 : 409, req, {});
  }
  if (path === "permits/decide" && req.method === "POST") {
    // The human decision endpoint: flips a PENDING approval. Everything
    // downstream (permit issuance, workflow resumption) keys off this.
    const body = await req.json().catch(() => null) as {
      approvalId?: string;
      decision?: "granted" | "denied";
      decidedBy?: string;
      workflowRunId?: string;
      stepIndex?: number;
    } | null;
    if (!body?.approvalId || (body.decision !== "granted" && body.decision !== "denied")) {
      return jsonResponse({ error: { code: "invalid_body", message: "approvalId and decision (granted|denied) are required" } }, 400, req, {});
    }
    const result = decideApproval(body.approvalId, body.decision, body.decidedBy ?? "dashboard-operator", {
      workflowRunId: body.workflowRunId,
      stepIndex: body.stepIndex,
    });
    return jsonResponse(result, result.ok ? 200 : 409, req, {});
  }
  if (path === "policies" && req.method === "GET") {
    return jsonResponse({ policies: listPolicies() }, 200, req, {});
  }
  if (path === "projects" && req.method === "GET") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = require("../../agent-os/db").openAgentOsDb();
    const projects = db.query("SELECT id, name, root_path AS rootPath, scan_enabled AS scanEnabled, scan_mode AS scanMode FROM brain_projects ORDER BY name").all();
    return jsonResponse({ projects }, 200, req, {});
  }
  if (path === "projects" && req.method === "POST") {
    const body = await req.json().catch(() => null) as
      | { name?: string; rootPath?: string; scanMode?: "quick" | "standard" | "deep" }
      | null;
    if (!body?.name || !body?.rootPath) {
      return jsonResponse({ error: { code: "invalid_body", message: "name and rootPath are required" } }, 400, req, {});
    }
    const project = registerProject({ name: body.name, rootPath: body.rootPath, scanMode: body.scanMode });
    return jsonResponse({ project }, 201, req, {});
  }
  const scanMatch = path.match(/^projects\/([^\/]+)\/scan$/);
  const atlasMatch = path.match(/^projects\/([^/]+)\/atlas$/);
  if (atlasMatch && req.method === "GET") {
    const atlas = getProjectAtlas(atlasMatch[1]);
    return atlas
      ? jsonResponse(atlas, 200, req, {})
      : jsonResponse({ error: { code: "atlas_not_found", message: "project or scan not found" } }, 404, req, {});
  }
  if (path === "universe" && req.method === "GET") {
    return jsonResponse(getBrainUniverse(), 200, req, {});
  }
  if (scanMatch && req.method === "POST") {
    // Read-only scanner: indexes metadata only, never writes into the project.
    try {
      const mode = url.searchParams.get("mode") as "quick" | "standard" | "deep" | null;
      const result = scanProject(scanMatch[1], mode ?? undefined);
      return jsonResponse({
        projectId: result.projectId,
        mode: result.mode,
        coverage: result.coverage,
        detected: result.detected,
      }, 200, req, {});
    } catch (error) {
      return jsonResponse({ error: { code: "scan_failed", message: error instanceof Error ? error.message : "scan failed" } }, 404, req, {});
    }
  }
  if (path === "sessions" && req.method === "GET") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    return jsonResponse({ sessions: listSessions(projectId) }, 200, req, {});
  }
  if (path === "audit" && req.method === "GET") {
    return jsonResponse({ events: listWebMcpCalls(Number(url.searchParams.get("limit") ?? 100)) }, 200, req, {});
  }
  if (path === "audit" && req.method === "POST") {
    const body = await req.json().catch(() => null) as {
      tool?: string; actor?: string; projectId?: string | null; input?: Record<string, unknown>;
      result?: "success" | "error" | "denied"; errorCode?: string | null; durationMs?: number;
      approvalId?: string | null; riskTier?: "R0" | "R1" | "R2" | "R3" | "R4";
    } | null;
    if (!body?.tool || !body?.result || !["success", "error", "denied"].includes(body.result)) {
      return jsonResponse({ error: { code: "invalid_body", message: "tool and result (success|error|denied) are required" } }, 400, req, {});
    }
    const record = recordWebMcpCall({
      tool: body.tool,
      actor: body.actor ?? "agent",
      projectId: body.projectId ?? null,
      input: body.input,
      result: body.result,
      errorCode: body.errorCode ?? null,
      durationMs: body.durationMs ?? 0,
      approvalId: body.approvalId ?? null,
      riskTier: body.riskTier,
    });
    return jsonResponse({ event: record }, 201, req, {});
  }
  if (path === "policies" && req.method === "POST") {
    // Admin-owned policy management: the dashboard operator decides which
    // subjects may hold which capabilities. Effect allow for approval-required
    // capabilities still needs the approval ledger at redemption time.
    const body = await req.json().catch(() => null) as {
      subjectType?: "agent" | "task" | "global";
      subjectId?: string | null;
      capability?: string;
      effect?: "allow" | "deny";
    } | null;
    if (!body?.subjectType || !body?.capability || (body.effect !== "allow" && body.effect !== "deny")) {
      return jsonResponse({ error: { code: "invalid_body", message: "subjectType, capability, and effect (allow|deny) are required" } }, 400, req, {});
    }
    const id = addPolicy({
      subjectType: body.subjectType,
      subjectId: body.subjectId ?? null,
      capability: body.capability as never,
      effect: body.effect,
    });
    return jsonResponse({ policyId: id }, 201, req, {});
  }
  if (path?.startsWith("policies/") && req.method === "DELETE") {
    const policyId = path.slice("policies/".length);
    const removed = removePolicy(policyId);
    return jsonResponse({ removed }, removed ? 200 : 404, req, {});
  }

  // --- Observatory: read-only ---
  if (req.method !== "GET") {
    return jsonResponse({ error: { code: "read_only", message: "Agent OS observatory routes are read-only; use the permit gateway for controlled actions" } }, 405, req, {});
  }

  if (path === "agents") return jsonResponse({ agents: listAgents() }, 200, req, {});
  if (path === "tasks") {
    const status = url.searchParams.get("status");
    return jsonResponse({ tasks: listTasks(status as never) }, 200, req, {});
  }
  if (path === "skills") {
    return jsonResponse({ skills: listSkills(), issues: await checkSkillHealth() }, 200, req, {});
  }
  if (path === "memory") {
    const id = url.searchParams.get("id");
    if (id) {
      const memory = readMemory(id);
      return memory ? jsonResponse(memory, 200, req, {}) : notFound(req, "memory not found");
    }
    const scope = url.searchParams.get("scope") as never;
    return jsonResponse({ memories: listMemories({ scope }) }, 200, req, {});
  }
  if (path === "nodes") return jsonResponse({ nodes: listNodes() }, 200, req, {});
  if (path === "reviews") {
    const subjectKind = url.searchParams.get("subjectKind") ?? "";
    const subjectId = url.searchParams.get("subjectId") ?? "";
    if (!subjectKind || !subjectId) return notFound(req, "subjectKind and subjectId are required");
    const summary = summarizeCouncil(subjectKind, subjectId);
    return summary ? jsonResponse(summary, 200, req, {}) : notFound(req, "no reviews for subject");
  }
  if (path === "task-timeline") {
    const taskId = url.searchParams.get("taskId") ?? "";
    const timeline = taskTimeline(taskId);
    return timeline ? jsonResponse(timeline, 200, req, {}) : notFound(req, "task not found");
  }
  if (path === "search") {
    const q = url.searchParams.get("q") ?? "";
    return jsonResponse({ query: q, hits: searchAgentOs(q) }, 200, req, {});
  }
  if (path === "permits/pending") {
    const approvals = openAgentOsApprovalRows();
    return jsonResponse({ approvals }, 200, req, {});
  }
  if (path === "ask") {
    const q = url.searchParams.get("q") ?? "";
    return jsonResponse(askPaoBrain(q), 200, req, {});
  }
  return notFound(req, "unknown agent-os route");
}

function openAgentOsApprovalRows(): { id: string; capability: string; reason: string; status: string; requestedMs: number }[] {
  // Local import to avoid widening the module surface for tests that stub db.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const db = require("../../agent-os/db").openAgentOsDb();
  return db.query("SELECT id, capability, reason, status, requested_ms AS requestedMs FROM approvals WHERE status = 'pending' ORDER BY requested_ms").all() as never;
}
