/**
 * Operator view of the in-memory workflow-budget ledger, plus a targeted clear.
 *
 * Loaded on demand from src/server/management-api.ts, which is the FOURTH entry in the protected
 * set of tests/core-lab-boundary.test.ts — added precisely because eagerly importing handlers
 * there put ~70 modules on every dashboard request. A static import here would make this
 * subsystem the next instance of that bug.
 *
 * Authentication is inherited: every /api route passes through requireManagementAuth before the
 * chain runs, so these handlers add no auth code of their own. The GET spends no user identity.
 * The POST clears one root's windowed count ceilings; it does not spend identity, and the
 * underlying ledger leaves in-flight concurrency and the token spend record untouched.
 */

import { jsonResponse } from "../auth-cors";
import type { OcxConfig } from "../../types";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import {
  clearWorkflowBudgetForRoot,
  listTrackedWorkflowRoots,
  listWorkflowBudgetEvents,
  workflowBudgetSnapshot,
  WORKFLOW_EVENT_CAPACITY,
} from "../../lib/workflow-budget";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = WORKFLOW_EVENT_CAPACITY;
const MAX_ROOT_ID_LENGTH = 200;

/**
 * A root id is an opaque caller-thread token, not a path. Without a length cap a client
 * could POST a multi-megabyte string that we would then store as a map key and echo back
 * in events; 200 is well above any thread id we have seen and small enough to put in a URL.
 */
function parseRootId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_ROOT_ID_LENGTH) return null;
  return trimmed;
}

function invalidRootResponse(req: Request, config: OcxConfig): Response {
  return jsonResponse(
    { error: { code: "invalid_root", message: "root must be a non-empty string of at most 200 characters" } },
    400,
    req,
    config,
  );
}

function parseLimitParam(rawLimit: string | null): { ok: true; limit: number } | { ok: false } {
  if (rawLimit !== null && !/^\d+$/.test(rawLimit)) return { ok: false };
  return {
    ok: true,
    limit: rawLimit === null ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Number.parseInt(rawLimit, 10)),
  };
}

export async function handleWorkflowBudgetRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;

  if (url.pathname === "/api/workflow-budget") {
    if (req.method !== "GET") return null;

    const parsedLimit = parseLimitParam(url.searchParams.get("limit"));
    if (!parsedLimit.ok) {
      return jsonResponse(
        { error: { code: "invalid_limit", message: "limit must be a non-negative integer" } },
        400,
        req,
        config,
      );
    }
    const { limit } = parsedLimit;

    const rawRoot = url.searchParams.get("root");
    if (rawRoot !== null) {
      const rootId = parseRootId(rawRoot);
      if (rootId === null) return invalidRootResponse(req, config);
      const snapshot = workflowBudgetSnapshot(rootId);
      // An unknown id is a 200 with `root: null`, not a 404: the operator asked what this
      // process currently holds for that token, and "nothing" is a legitimate answer. POST
      // /clear is the opposite — claiming to forgive a ceiling that was never tracked would
      // report a success that did not happen.
      return jsonResponse(
        {
          root: snapshot ? { rootId, ...snapshot } : null,
          events: listWorkflowBudgetEvents(WORKFLOW_EVENT_CAPACITY)
            .filter((event) => event.rootId === rootId)
            .slice(0, limit),
        },
        200,
        req,
        config,
      );
    }

    return jsonResponse(
      {
        roots: listTrackedWorkflowRoots(limit),
        events: listWorkflowBudgetEvents(limit),
      },
      200,
      req,
      config,
    );
  }

  if (url.pathname === "/api/workflow-budget/clear") {
    if (req.method !== "POST") return null;

    const body = await readManagementJsonBodyOr(req, {});
    const rawRoot = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { root?: unknown }).root
      : undefined;
    const rootId = parseRootId(rawRoot);
    if (rootId === null) return invalidRootResponse(req, config);

    const before = clearWorkflowBudgetForRoot(rootId);
    if (!before) {
      return jsonResponse(
        { error: { code: "unknown_root", message: "root is not currently tracked" } },
        404,
        req,
        config,
      );
    }
    return jsonResponse({ cleared: true, root: rootId, before }, 200, req, config);
  }

  return null;
}
