/**
 * GET / PUT /api/advisor/settings — the advisor sidecar's management surface.
 *
 * GET answers the RESOLVED settings (defaults applied, sources marked) plus availability, so the
 * GUI/CLI show real runtime state rather than stored fields. PUT is a strict partial patch:
 * unknown keys and wrong types are refused, values are validated against the same resolver the
 * runtime reads, and the patch persists through the locked config writer with the snapshot-
 * restore discipline used by PATCH /api/protocols/settings — a refused or failed write never
 * leaves the live config serving a state the file does not hold.
 */
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBodyOr } from "./body";
import type { ManagementContext } from "./context";
import {
  ADVISOR_EFFORTS,
  advisorRunnable,
  isValidAdvisorEffort,
  isValidAdvisorPolicy,
  resolveAdvisorSettings,
  type AdvisorEffort,
  type AdvisorPolicy,
} from "../../advisor/settings";

const INVALID_BODY = Symbol("invalid-body");

interface AdvisorPatch {
  enabled?: boolean;
  model?: string;
  effort?: AdvisorEffort;
  policy?: AdvisorPolicy;
  timeoutMs?: number;
  reset?: boolean;
}

type ParsedPatch = { ok: true; patch: AdvisorPatch } | { ok: false; code: string; message: string };

const PATCH_KEYS = new Set(["enabled", "model", "effort", "policy", "timeoutMs", "reset"]);

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Strict: unknown keys and wrong types are refused; messages name the field, never the value. */
export function parseAdvisorSettingsPatch(body: unknown): ParsedPatch {
  if (!isRec(body)) return { ok: false, code: "invalid_body", message: "body must be a JSON object" };
  if (Object.keys(body).length === 0) return { ok: false, code: "empty_body", message: "body must set at least one of enabled, model, effort, policy, timeoutMs or reset" };
  for (const key of Object.keys(body)) {
    if (!PATCH_KEYS.has(key)) return { ok: false, code: "unknown_field", message: "body accepts only enabled, model, effort, policy, timeoutMs and reset" };
  }
  const patch: AdvisorPatch = {};
  if (body.reset !== undefined) {
    if (body.reset !== true) return { ok: false, code: "invalid_reset", message: "reset must be true when present" };
    patch.reset = true;
    return { ok: true, patch };
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { ok: false, code: "invalid_enabled", message: "enabled must be a boolean" };
    patch.enabled = body.enabled;
  }
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || body.model.trim().length > 200) {
      return { ok: false, code: "invalid_model", message: "model must be a non-empty routable model string (at most 200 chars)" };
    }
    patch.model = body.model.trim();
  }
  if (body.effort !== undefined) {
    if (!isValidAdvisorEffort(body.effort)) {
      return { ok: false, code: "invalid_effort", message: `effort must be one of ${ADVISOR_EFFORTS.join(", ")}` };
    }
    patch.effort = body.effort;
  }
  if (body.policy !== undefined) {
    if (!isValidAdvisorPolicy(body.policy)) {
      return { ok: false, code: "invalid_policy", message: 'policy must be "manual" or "preflight"' };
    }
    patch.policy = body.policy;
  }
  if (body.timeoutMs !== undefined) {
    if (typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs) || body.timeoutMs < 1_000 || body.timeoutMs > 600_000) {
      return { ok: false, code: "invalid_timeout", message: "timeoutMs must be a number between 1000 and 600000" };
    }
    patch.timeoutMs = Math.floor(body.timeoutMs);
  }
  return { ok: true, patch };
}

function advisorInfo(config: ManagementContext["config"]): Record<string, unknown> {
  const settings = resolveAdvisorSettings(config);
  return {
    settings,
    runnable: advisorRunnable(settings),
    // A configured-but-empty model is the common "enabled but not set up" state; surface it
    // instead of making the GUI guess from sources.
    ...(settings.enabled && !advisorRunnable(settings) ? { warning: "advisor_enabled_without_model" } : {}),
  };
}

function applyPatchInMemory(config: ManagementContext["config"], patch: AdvisorPatch): void {
  if (patch.reset) {
    delete config.advisor;
    return;
  }
  const current: Rec = isRec(config.advisor) ? { ...config.advisor } : {};
  if (patch.enabled !== undefined) current.enabled = patch.enabled;
  if (patch.model !== undefined) current.model = patch.model;
  if (patch.effort !== undefined) current.effort = patch.effort;
  if (patch.policy !== undefined) current.policy = patch.policy;
  if (patch.timeoutMs !== undefined) current.timeoutMs = patch.timeoutMs;
  config.advisor = current as ManagementContext["config"]["advisor"];
}

function isConfigLockContention(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code !== "CONFIG_MUTATION_LOCK_UNAVAILABLE") return false;
  return (error as { cause?: { code?: unknown } }).cause?.code === "SQLITE_BUSY";
}

export async function handleAdvisorRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;
  if (url.pathname !== "/api/advisor/settings") return null;

  if (req.method === "GET") return jsonResponse(advisorInfo(config), 200, req, config);
  if (req.method === "PUT") return putAdvisorSettings(ctx);
  return null;
}

async function putAdvisorSettings(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;

  const body = await readManagementJsonBodyOr(req, INVALID_BODY);
  const parsed = body === INVALID_BODY
    ? { ok: false as const, code: "invalid_json", message: "body must be valid JSON" }
    : parseAdvisorSettingsPatch(body);
  if (!parsed.ok) return jsonResponse({ error: { code: parsed.code, message: parsed.message } }, 400, req, config);

  const snapshot = isRec(config.advisor) ? { ...config.advisor } : undefined;
  applyPatchInMemory(config, parsed.patch);
  // `deps.` first: route tests with an in-memory fixture must never write the real config.
  const persist = ctx.deps.saveConfigPreservingClaudeCode
    ?? (await import("../../config")).saveConfigPreservingClaudeCode;
  try {
    persist(config);
  } catch (error) {
    // Undo in memory too: a live config that serves a state the file does not hold would
    // mislead every GET until the next restart.
    if (snapshot === undefined) delete config.advisor;
    else config.advisor = snapshot as ManagementContext["config"]["advisor"];
    return isConfigLockContention(error)
      ? jsonResponse({ error: { code: "config_busy", message: "Another process is saving the configuration. Try again in a moment." } }, 409, req, config)
      : jsonResponse({ error: { code: "write_failed", message: "The configuration could not be saved." } }, 500, req, config);
  }
  return jsonResponse(advisorInfo(config), 200, req, config);
}
