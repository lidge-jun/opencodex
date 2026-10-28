/**
 * Per-role model for omo (Codex / LazyCodex): `$CODEX_HOME/agents/<role>.toml` plus LazyCodex's
 * `"[codex]".agents.<role>` model and reasoning mirror in omo.jsonc. Both halves exist only when LazyCodex is
 * detected; Pi-based and OpenCode-based omo are never read here.
 *
 * Loaded on demand from `src/server/management-api.ts`, like the quota-reset handler, so a
 * dashboard request that never opens the omo tab loads neither writer.
 */
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

const ROLE_PATH_PREFIX = "/api/codex-agent-roles/";
const AUTO_ASSIGN_PATH = "/api/codex-agent-roles/auto-assign";

function lazycodexNotDetected(ctx: ManagementContext): Response {
  return jsonResponse({
    error: "omo (Codex / LazyCodex) is not installed in this CODEX_HOME",
    code: "lazycodex_not_detected",
  }, 409, ctx.req, ctx.config);
}

export async function handleCodexAgentRoleRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps } = ctx;
  const [{ getCodexHome }, roles, omo, { detectLazyCodex }, history] = await Promise.all([
    import("../../codex/paths"),
    import("../../codex/agent-role-models"),
    import("../../clients/omo-role-models"),
    import("../../clients/lazycodex"),
    import("../../codex/role-model-history"),
  ]);

  if (url.pathname === "/api/codex-agent-roles" && req.method === "GET") {
    const codexHome = getCodexHome();
    const lazycodex = detectLazyCodex(codexHome);
    if (!lazycodex.detected) return jsonResponse({ lazycodex, omoJsonc: null, roles: [] }, 200, req, config);
    const omoState = omo.readOmoRoleModels(omo.omoJsoncPath());
    const omoModels = omoState.state === "present" ? omoState.models : {};
    // History is optional: a file that cannot be read costs the Restore list, never role editing.
    let changes: import("../../codex/role-model-history").RoleModelChange[] = [];
    let historyUnavailable = false;
    try {
      changes = history.listRoleModelChanges(codexHome);
    } catch (error) {
      console.error(`[codex-agent-roles] could not read the change history: ${String(error)}`);
      historyUnavailable = true;
    }
    return jsonResponse({
      lazycodex,
      omoJsonc: { state: omoState.state },
      roles: roles.listCodexAgentRoleModels(codexHome).map(entry => ({
        ...entry,
        effort: roles.readCodexAgentRoleEffort(entry.role, codexHome),
        omoJsoncModel: omoModels[entry.role] ?? null,
      })),
      history: changes,
      ...(historyUnavailable ? { historyUnavailable } : {}),
    }, 200, req, config);
  }

  if (url.pathname === AUTO_ASSIGN_PATH && req.method === "POST") {
    const codexHome = getCodexHome();
    if (!detectLazyCodex(codexHome).detected) return lazycodexNotDetected(ctx);
    let body: { model?: unknown };
    try {
      body = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
    }
    if (body?.model !== undefined && typeof body.model !== "string") {
      return jsonResponse({ error: "model must be a string", code: "invalid_model" }, 400, req, config);
    }
    const [{ proposeCodexRoleModels, NoSizingModelError }, { fetchAllModels }] = await Promise.all([
      import("./codex-role-auto-assign"),
      import("./shared"),
    ]);
    try {
      return jsonResponse(await proposeCodexRoleModels({
        config,
        codexHome,
        ...(typeof body?.model === "string" ? { sizingModel: body.model } : {}),
        fetchAllModels: deps.fetchAllModels ?? fetchAllModels,
        ...(deps.completeCodexRoleSizing ? { completeRoleSizing: deps.completeCodexRoleSizing } : {}),
      }), 200, req, config);
    } catch (error) {
      if (error instanceof NoSizingModelError) {
        return jsonResponse({ error: error.message, code: "no_sizing_model" }, 409, req, config);
      }
      throw error;
    }
  }

  if (!url.pathname.startsWith(ROLE_PATH_PREFIX) || req.method !== "PUT") return null;
  const codexHome = getCodexHome();
  if (!detectLazyCodex(codexHome).detected) return lazycodexNotDetected(ctx);
  let role: string;
  try {
    role = decodeURIComponent(url.pathname.slice(ROLE_PATH_PREFIX.length));
  } catch {
    return jsonResponse({ error: "role must be URL-encoded", code: "invalid_role" }, 400, req, config);
  }
  let body: { model?: unknown; effort?: unknown; batch?: unknown; restores?: unknown };
  try {
    body = await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
  }

  // An omitted model leaves the role's model pin (or its inheritance) alone, an omitted effort
  // keeps the effort, and an effort of null clears it. A body with neither changes nothing, which
  // is a client mistake rather than a save, so it is refused before any role file is read.
  if (body?.model === undefined && body?.effort === undefined) {
    return jsonResponse({ error: "send a model, an effort, or both", code: "empty_update" }, 400, req, config);
  }
  if (body.batch !== undefined && !history.isRoleHistoryBatch(body.batch)) {
    return jsonResponse({ error: "batch must be 1 to 64 letters, digits or dashes", code: "invalid_batch" }, 400, req, config);
  }
  if (body.restores !== undefined && !history.isRoleHistoryBatch(body.restores)) {
    return jsonResponse({ error: "restores must be 1 to 64 letters, digits or dashes", code: "invalid_restores" }, 400, req, config);
  }
  // A write without `batch` starts a batch and the response names it; a later write joins it only
  // while it is this home's newest batch, up to the listing size. History is optional: a file that
  // cannot be read does not block saves, and such a save is simply not recorded.
  let slot: import("../../codex/role-model-history").BatchSlot | null = null;
  try {
    const claimed = history.claimBatchRow(codexHome, body.batch);
    if (claimed === "batch_closed") {
      return jsonResponse({ error: "this batch takes no more changes; leave batch out to start a new one", code: "batch_closed" }, 409, req, config);
    }
    if (claimed === "batch_full") {
      return jsonResponse({ error: `a batch holds at most ${history.ROLE_HISTORY_LIMIT} changes`, code: "batch_full" }, 409, req, config);
    }
    slot = claimed;
  } catch (error) {
    console.error(`[codex-agent-roles] could not read the change history: ${String(error)}`);
  }
  let model: string | undefined;
  let effort: string | null | undefined;
  let toml: { status: "written" | "unchanged" };
  let before: import("../../codex/role-model-history").RoleSetting = { model: null, effort: null };
  try {
    model = body?.model === undefined ? undefined : roles.validateAgentRoleModel(body.model);
    effort = body?.effort === undefined ? undefined : body.effort === null ? null : roles.validateAgentRoleEffort(body.effort);
  } catch (error) {
    if (error instanceof roles.AgentRoleModelError) return jsonResponse({ error: error.message, code: error.code }, 400, req, config);
    throw error;
  }
  // A Restore names the batch it puts back, and only this Codex home's history can vouch for it: the
  // write must be that role's earliest `before` in the batch, so a stale page cannot carry models
  // across homes. A role that had no model pin is restored without a model, since a save keeps a pin.
  if (typeof body.restores === "string") {
    let allowed: import("../../codex/role-model-history").RoleSetting | null;
    try {
      allowed = history.restorableSetting(codexHome, body.restores, role);
    } catch {
      allowed = null;
    }
    if (!allowed || model !== (allowed.model ?? undefined) || effort !== allowed.effort) {
      return jsonResponse({ error: "this Codex home's change history has no such change to restore", code: "restore_not_in_history" }, 409, req, config);
    }
  }
  try {
    before = {
      model: roles.listCodexAgentRoleModels(codexHome).find(entry => entry.role === role)?.model ?? null,
      effort: roles.readCodexAgentRoleEffort(role, codexHome),
    };
    toml = roles.writeCodexAgentRoleModel(role, model, codexHome, effort);
  } catch (error) {
    if (error instanceof roles.AgentRoleModelError) {
      const status = error.code === "unknown_role" ? 404 : error.code === "invalid_model" || error.code === "invalid_effort" ? 400 : 409;
      return jsonResponse({ error: error.message, code: error.code }, status, req, config);
    }
    // Filesystem and ownership errors carry absolute paths and UIDs; keep them out of the response.
    return jsonResponse({ error: "could not write the role file", code: "write_failed" }, 500, req, config);
  }
  let recorded: string | undefined;
  if (toml.status === "written" && slot) {
    try {
      history.recordRoleModelChange(codexHome, {
        at: new Date().toISOString(),
        batch: slot.batch,
        n: slot.n,
        role,
        before,
        after: { model: model ?? before.model, effort: effort === undefined ? before.effort : effort },
        ...(typeof body.restores === "string" ? { restores: body.restores } : {}),
      });
      recorded = slot.batch;
    } catch (error) {
      // The write already stands; a lost history row only costs the Restore button for it.
      console.error(`[codex-agent-roles] could not record the change: ${String(error)}`);
    }
  }

  // The role TOML is what Codex obeys, so its write stands even when the omo mirror cannot follow.
  let omoStatus: ReturnType<typeof omo.writeOmoRoleModel> | "write_failed";
  try {
    const reasoning = effort === undefined ? undefined : effort === null ? null : omo.omoReasoningFor(effort);
    omoStatus = omo.writeOmoRoleModel(role, model, omo.omoJsoncPath(), reasoning);
  } catch {
    omoStatus = "write_failed";
  }
  return jsonResponse({
    ok: true,
    role,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    toml,
    omoJsonc: { status: omoStatus },
    ...(recorded ? { batch: recorded } : {}),
  }, 200, req, config);
}
