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
  const [{ getCodexHome }, roles, omo, { detectLazyCodex }] = await Promise.all([
    import("../../codex/paths"),
    import("../../codex/agent-role-models"),
    import("../../clients/omo-role-models"),
    import("../../clients/lazycodex"),
  ]);

  if (url.pathname === "/api/codex-agent-roles" && req.method === "GET") {
    const codexHome = getCodexHome();
    const lazycodex = detectLazyCodex(codexHome);
    if (!lazycodex.detected) return jsonResponse({ lazycodex, omoJsonc: null, roles: [] }, 200, req, config);
    const omoState = omo.readOmoRoleModels(omo.omoJsoncPath());
    const omoModels = omoState.state === "present" ? omoState.models : {};
    return jsonResponse({
      lazycodex,
      omoJsonc: { state: omoState.state },
      roles: roles.listCodexAgentRoleModels(codexHome).map(entry => ({
        ...entry,
        effort: roles.readCodexAgentRoleEffort(entry.role, codexHome),
        omoJsoncModel: omoModels[entry.role] ?? null,
      })),
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
  let body: { model?: unknown; effort?: unknown };
  try {
    body = await readManagementJsonBody(req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
  }

  let model: string;
  let effort: string | null | undefined;
  let toml: { status: "written" | "unchanged" };
  try {
    model = roles.validateAgentRoleModel(body?.model);
    effort = body?.effort === undefined ? undefined : body.effort === null ? null : roles.validateAgentRoleEffort(body.effort);
    toml = roles.writeCodexAgentRoleModel(role, model, codexHome, effort);
  } catch (error) {
    if (error instanceof roles.AgentRoleModelError) {
      const status = error.code === "unknown_role" ? 404 : error.code === "invalid_model" || error.code === "invalid_effort" ? 400 : 409;
      return jsonResponse({ error: error.message, code: error.code }, status, req, config);
    }
    // Filesystem and ownership errors carry absolute paths and UIDs; keep them out of the response.
    return jsonResponse({ error: "could not write the role file", code: "write_failed" }, 500, req, config);
  }

  // The role TOML is what Codex obeys, so its write stands even when the omo mirror cannot follow.
  let omoStatus: ReturnType<typeof omo.writeOmoRoleModel> | "write_failed";
  try {
    const reasoning = effort === undefined ? undefined : effort === null ? null : omo.omoReasoningFor(effort);
    omoStatus = omo.writeOmoRoleModel(role, model, omo.omoJsoncPath(), reasoning);
  } catch {
    omoStatus = "write_failed";
  }
  return jsonResponse({ ok: true, role, model, ...(effort !== undefined ? { effort } : {}), toml, omoJsonc: { status: omoStatus } }, 200, req, config);
}
