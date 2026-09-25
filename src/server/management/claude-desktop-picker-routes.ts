/**
 * Claude Desktop picker mode over the management API, and the transition helpers every Desktop
 * mode change uses.
 *
 * While this server runs a picker controller (src/claude/desktop-picker.ts), every picker
 * mutation goes through it, serialized by its lock. With no controller (intercept disabled, client
 * role, a failed bind), `runPickerTransition` runs the same code with offline ops that only remove
 * leftover picker artifacts, and enabling reports `proxy_unavailable`.
 */
import type { OcxConfig } from "../../types";
import type { DesktopPickerController, DesktopPickerOps, DesktopPickerStatus } from "../../claude/desktop-picker";
import { loadConfig } from "../../config";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import { isPlainRecord } from "./shared";

export async function currentPickerController(): Promise<DesktopPickerController | null> {
  const { getClaudePickerController } = await import("../../claude/intercept/runtime");
  return getClaudePickerController();
}

/** Picker status for status payloads: the controller's, or the static offline status. */
export async function pickerStatusFor(config: OcxConfig): Promise<DesktopPickerStatus> {
  const controller = await currentPickerController();
  if (controller) return controller.status();
  const { offlinePickerStatus } = await import("../../claude/desktop-picker");
  return offlinePickerStatus(config);
}

/** Run a Desktop mode change under the picker lock (or with offline ops when no controller runs). */
export async function runPickerTransition<T>(config: OcxConfig, fn: (ops: DesktopPickerOps) => Promise<T>): Promise<T> {
  const [controller, { runDesktopTransition }] = await Promise.all([
    currentPickerController(),
    import("../../claude/desktop-picker"),
  ]);
  return runDesktopTransition(controller, fn, { config });
}

/** First-party turns the picker on unless the operator said `claudeCode.intercept.picker: false`. */
export function pickerPreferenceOn(config: Pick<OcxConfig, "claudeCode">): boolean {
  return config.claudeCode?.intercept?.picker !== false;
}

const PICKER_BODY_KEYS = new Set(["enabled", "persist", "trustedLocally", "callerAddedTrust"]);
/** Enable outcomes that are progress, not refusal: on, waiting for a Desktop restart, or for the keychain step. */
const ENABLE_ACCEPTED = new Set(["active", "restart_required", "trust_pending"]);

interface PickerRequestBody { enabled: boolean; persist: boolean; trustedLocally?: boolean; callerAddedTrust?: boolean }

function parsePickerBody(raw: unknown): PickerRequestBody | string {
  if (!isPlainRecord(raw)) return "JSON body must be an object";
  for (const key of Object.keys(raw)) if (!PICKER_BODY_KEYS.has(key)) return `unknown field: ${key}`;
  if (typeof raw.enabled !== "boolean") return "enabled must be a boolean";
  if (typeof raw.persist !== "boolean") return "persist must be a boolean";
  for (const key of ["trustedLocally", "callerAddedTrust"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") return `${key} must be a boolean`;
  }
  return raw as unknown as PickerRequestBody;
}

export async function handleClaudeDesktopPickerRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;

  if (url.pathname === "/api/claude-desktop/picker" && req.method === "GET") {
    return jsonResponse({ ok: true, picker: await pickerStatusFor(loadConfig()) });
  }

  if (url.pathname === "/api/claude-desktop/picker" && req.method === "PUT") {
    let raw: unknown;
    try {
      raw = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    const body = parsePickerBody(raw);
    if (typeof body === "string") return jsonResponse({ error: body }, 400);
    const controller = await currentPickerController();
    if (body.enabled) {
      if (!controller) {
        const { offlinePickerStatus } = await import("../../claude/desktop-picker");
        return jsonResponse({
          ok: false,
          code: "picker_proxy_unavailable",
          error: "Picker mode needs the Claude Desktop picker proxy, which is not running in this server.",
          picker: offlinePickerStatus(loadConfig()),
        }, 503);
      }
      const picker = await controller.enable({
        persist: body.persist,
        context: body.trustedLocally ? "cli-trusted" : "server",
        ...(body.callerAddedTrust !== undefined ? { callerAddedTrust: body.callerAddedTrust } : {}),
      });
      if (ENABLE_ACCEPTED.has(picker.reason) && !picker.residual?.length) return jsonResponse({ ok: true, picker });
      return jsonResponse({
        ok: false,
        code: "picker_enable_refused",
        reason: picker.reason,
        error: `Picker mode was not enabled (${picker.reason}).`,
        picker,
      }, 409);
    }
    if (controller) {
      const picker = await controller.disable({ persist: body.persist });
      if (!picker.residual?.length) return jsonResponse({ ok: true, picker });
      return jsonResponse({
        ok: false,
        code: "picker_disable_incomplete",
        error: `Picker mode cleanup is incomplete (${picker.residual.join(", ")}).`,
        picker,
      }, 500);
    }
    // No controller: nothing can terminate claude.ai here, so cleanup is local.
    if (body.persist) {
      const { createPickerPreferenceWriter } = await import("../../claude/intercept/runtime");
      if (!(await createPickerPreferenceWriter(ctx.config))(false)) {
        return jsonResponse({ ok: false, error: "The picker preference could not be saved; nothing was removed." }, 500);
      }
    }
    const { offlinePickerStatus, removeDesktopPickerArtifacts } = await import("../../claude/desktop-picker");
    const removed = await removeDesktopPickerArtifacts({});
    const picker = { ...offlinePickerStatus(loadConfig()), ...(removed.residual?.length ? { residual: removed.residual } : {}) };
    return jsonResponse({ ok: removed.ok, picker }, removed.ok ? 200 : 500);
  }

  return null;
}
