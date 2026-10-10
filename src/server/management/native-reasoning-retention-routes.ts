import {
  nativeReasoningRetentionSchema,
  resolveNativeReasoningRetention,
} from "../../config/schema/native-reasoning-retention";
import { captureConfigTopLevelRollback, deleteConfigTopLevelKey } from "../../config/rebase-provenance";
import { ConfigWritePublishedError } from "../../config/persist-unlocked";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBodyOr } from "./body";
import type { ManagementContext } from "./context";

const INVALID_BODY = Symbol("invalid-body");

/** Partial PUTs preserve omitted allowances; null resets the entire block to defaults. */
export async function handleNativeReasoningRetentionRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname === "/api/native-reasoning-retention" && req.method === "GET") {
    return jsonResponse(resolveNativeReasoningRetention(config), 200, req, config);
  }
  if (url.pathname === "/api/native-reasoning-retention" && req.method === "PUT") {
    const body = await readManagementJsonBodyOr(req, INVALID_BODY);
    const parsed = body === null ? null : nativeReasoningRetentionSchema.safeParse(body);
    if (parsed !== null && !parsed.success) {
      return jsonResponse({ error: "body must be null or an object containing only boolean modelSwitch and accountSwitch fields" }, 400, req, config);
    }
    // Resolve the saver before changing the live object: no await may interleave mutation/save.
    const persist = ctx.deps.saveConfigPreservingClaudeCode
      ?? (await import("../../config")).saveConfigPreservingClaudeCode;
    const restore = captureConfigTopLevelRollback(config, ["nativeReasoningRetention"]);
    try {
      if (parsed === null) deleteConfigTopLevelKey(config, "nativeReasoningRetention");
      else config.nativeReasoningRetention = { ...config.nativeReasoningRetention, ...parsed.data };
      persist(config);
    } catch (error) {
      // Published bytes remain authoritative even if later bookkeeping failed.
      if (!(error instanceof ConfigWritePublishedError)) restore();
      throw error;
    }
    return jsonResponse(resolveNativeReasoningRetention(config), 200, req, config);
  }
  return null;
}
