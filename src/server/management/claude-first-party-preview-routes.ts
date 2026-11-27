/**
 * `GET /api/claude-code/first-party/preview` — what the CLI first-party switch would change in
 * the default Claude home's settings.json (catch-up 010, G-002). Key names and change kinds
 * only; read-only. `?enabled=true|false` names the switch value; absent means the flip of the
 * current value, which is what the dashboard switch sends.
 */
import { displayPath } from "../../lib/display-path";
import { jsonResponse } from "../auth-cors";
import { persistedConfigOr } from "./connection-status-routes";
import type { ManagementContext } from "./context";

export async function handleClaudeFirstPartyPreviewRoute(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname === "/api/claude-code/first-party/preview" && ctx.req.method === "GET") return previewResponse(ctx);
  return null;
}

async function previewResponse(ctx: ManagementContext): Promise<Response> {
  const { req, url, config } = ctx;
  const raw = url.searchParams.get("enabled");
  if (raw !== null && raw !== "true" && raw !== "false") {
    return jsonResponse({ error: "enabled must be true or false", code: "invalid_enabled" }, 400, req, config);
  }
  const enabled = raw === null ? config.claudeCode?.cliFirstParty !== true : raw === "true";
  try {
    const { previewClaudeFirstPartySettings } = await import("../../claude/first-party-preview");
    const preview = previewClaudeFirstPartySettings({ live: config, persisted: persistedConfigOr(config), enabled });
    if (!preview.ok) {
      return jsonResponse({
        error: "Claude first-party switch would be refused", code: preview.reason, enabled, path: displayPath(preview.path),
      }, preview.reason === "unreadable" ? 500 : 409, req, config);
    }
    return jsonResponse({
      enabled, path: displayPath(preview.path), changes: preview.changes, applyChecks: preview.applyChecks,
    }, 200, req, config);
  } catch {
    // A fixed body: an error message can carry a path or a settings value.
    return jsonResponse({ error: "first-party preview could not be computed", code: "preview_failed" }, 500, req, config);
  }
}
