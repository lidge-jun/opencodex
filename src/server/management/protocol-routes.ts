/**
 * Protocol vocabulary and request-path preview for the dashboard.
 *
 * Loaded on demand from src/server/management-api.ts, like the other optional namespaces:
 * the planner reaches the router and the ingress eligibility rules, and a static import
 * would put them on every dashboard request.
 *
 * GET (optionally with `?provider=<name>`, src/protocols/provider-summary.ts) and the plan
 * preview are read-only. The preview is computed from config alone
 * (src/protocols/plan-snapshot.ts): it sends nothing upstream, advances no combo state, and
 * never logs its input. PATCH /api/protocols/settings is the one writer; it validates in
 * src/server/management/protocol-settings-patch.ts, persists through the locked
 * saveConfigPreservingClaudeCode, and answers with the fresh GET shape. Authentication is
 * inherited from the management chain.
 */
import { jsonResponse } from "../auth-cors";
import { isProtocol, PROTOCOL_CONTRACT_VERSION } from "../../protocols/contract";
import { isProtocolFeature, PROTOCOL_FEATURES, type ProtocolFeature } from "../../protocols/features";
import { previewProtocolPlan, type ProtocolPlanRequest } from "../../protocols/plan-snapshot";
import { buildProtocolProviderSummary } from "../../protocols/provider-summary";
import { protocolPolicyRevision, resolveApiSurfaceSettings, resolveProtocolSettings } from "../../protocols/settings";
import type { OcxConfig } from "../../types";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import {
  applyProtocolSettingsPatch,
  parseProtocolSettingsPatch,
  restoreProtocolSettings,
  snapshotProtocolSettings,
} from "./protocol-settings-patch";

export const PROTOCOL_PLAN_LIMITS = { modelLength: 200, features: 24 } as const;
export const PROTOCOL_PROVIDER_QUERY_LIMIT = 200;

const PLAN_BODY_KEYS = new Set(["model", "inbound", "features"]);
const INVALID_BODY = Symbol("invalid-body");

type ParsedPlanBody = { ok: true; request: ProtocolPlanRequest } | { ok: false; code: string; message: string };

function invalid(code: string, message: string): ParsedPlanBody {
  return { ok: false, code, message };
}

/** Validate a plan request body. Messages name the field, never echo its value. */
export function parseProtocolPlanBody(body: unknown): ParsedPlanBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", "body must be a JSON object");
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PLAN_BODY_KEYS.has(key)) return invalid("unknown_field", "body accepts only model, inbound and features");
  }
  const model = typeof record.model === "string" ? record.model.trim() : "";
  if (!model || model.length > PROTOCOL_PLAN_LIMITS.modelLength || /[\u0000-\u001f\u007f]/.test(model)) {
    return invalid("invalid_model", `model must be a non-empty string of at most ${PROTOCOL_PLAN_LIMITS.modelLength} characters`);
  }
  if (!isProtocol(record.inbound)) return invalid("invalid_inbound", "inbound must be responses, chat or messages");
  let features: ProtocolFeature[] = [];
  if (record.features !== undefined) {
    if (!Array.isArray(record.features) || record.features.length > PROTOCOL_PLAN_LIMITS.features) {
      return invalid("invalid_features", `features must be an array of at most ${PROTOCOL_PLAN_LIMITS.features} entries`);
    }
    if (!record.features.every(isProtocolFeature)) return invalid("invalid_features", "features contains an unknown feature");
    features = [...new Set(record.features)];
  }
  return { ok: true, request: { model, inbound: record.inbound, features } };
}

function protocolInfo(config: OcxConfig) {
  return {
    schemaVersion: 1,
    contractVersion: PROTOCOL_CONTRACT_VERSION,
    policyRevision: protocolPolicyRevision(config),
    surfaces: resolveApiSurfaceSettings(config),
    settings: resolveProtocolSettings(config),
    features: PROTOCOL_FEATURES,
  };
}

/**
 * `GET /api/protocols?provider=<name>`: the usual body plus the provider's wire summary. The
 * name is bounded and must name a configured provider; neither error echoes it back.
 */
function protocolInfoForProvider(ctx: ManagementContext, values: string[]): Response {
  const { req, config } = ctx;
  const name = values.length === 1 ? values[0]!.trim() : "";
  if (!name || name.length > PROTOCOL_PROVIDER_QUERY_LIMIT || /[\u0000-\u001f\u007f]/.test(name)) {
    const message = `provider must be one non-empty name of at most ${PROTOCOL_PROVIDER_QUERY_LIMIT} characters`;
    return jsonResponse({ error: { code: "invalid_provider", message } }, 400, req, config);
  }
  const provider = buildProtocolProviderSummary(config, name);
  if (!provider) return jsonResponse({ error: { code: "unknown_provider", message: "no provider with that name" } }, 404, req, config);
  return jsonResponse({ ...protocolInfo(config), provider }, 200, req, config);
}

/** Only SQLITE_BUSY is contention worth retrying; any other lock failure repeats forever. */
function isConfigLockContention(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code !== "CONFIG_MUTATION_LOCK_UNAVAILABLE") return false;
  return (error as { cause?: { code?: unknown } }).cause?.code === "SQLITE_BUSY";
}

async function patchProtocolSettings(ctx: ManagementContext): Promise<Response> {
  const { req, config } = ctx;
  const body = await readManagementJsonBodyOr(req, INVALID_BODY);
  const parsed = body === INVALID_BODY
    ? { ok: false as const, code: "invalid_json", message: "body must be valid JSON" }
    : parseProtocolSettingsPatch(body);
  if (!parsed.ok) return jsonResponse({ error: { code: parsed.code, message: parsed.message } }, 400, req, config);

  const snapshot = snapshotProtocolSettings(config);
  const applied = applyProtocolSettingsPatch(config, parsed.patch);
  if (!applied.ok) {
    restoreProtocolSettings(config, snapshot);
    return jsonResponse({ error: { code: applied.code, message: applied.message } }, 400, req, config);
  }
  // `deps.` first: route tests with an in-memory fixture must never write the real config.
  const persist = ctx.deps.saveConfigPreservingClaudeCode
    ?? (await import("../../config")).saveConfigPreservingClaudeCode;
  try {
    persist(config);
  } catch (error) {
    // Undo in memory too: a live config that serves a state the file does not hold would
    // reopen (or keep closed) the surface only until the next restart.
    restoreProtocolSettings(config, snapshot);
    return isConfigLockContention(error)
      ? jsonResponse({ error: { code: "config_busy", message: "Another process is saving the configuration. Try again in a moment." } }, 409, req, config)
      : jsonResponse({ error: { code: "write_failed", message: "The configuration could not be saved." } }, 500, req, config);
  }
  // Closing Messages also turned the Claude integration off; prune its agent definitions the
  // way the Claude page toggle does.
  if (applied.claudeCodeChanged) await ctx.syncClaudeAgentDefsBestEffort?.();
  return jsonResponse(protocolInfo(config), 200, req, config);
}

export async function handleProtocolRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;

  if (url.pathname === "/api/protocols") {
    if (req.method !== "GET") return null;
    if (!url.searchParams.has("provider")) return jsonResponse(protocolInfo(config), 200, req, config);
    return protocolInfoForProvider(ctx, url.searchParams.getAll("provider"));
  }

  if (url.pathname === "/api/protocols/settings") {
    if (req.method !== "PATCH") return null;
    return patchProtocolSettings(ctx);
  }

  if (url.pathname === "/api/protocols/plan") {
    if (req.method !== "POST") return null;
    const body = await readManagementJsonBodyOr(req, INVALID_BODY);
    const parsed = body === INVALID_BODY ? invalid("invalid_json", "body must be valid JSON") : parseProtocolPlanBody(body);
    if (!parsed.ok) {
      return jsonResponse({ error: { code: parsed.code, message: parsed.message } }, 400, req, config);
    }
    return jsonResponse(previewProtocolPlan(config, parsed.request), 200, req, config);
  }

  return null;
}
