/**
 * Protocol vocabulary and request-path preview for the dashboard.
 *
 * Loaded on demand from src/server/management-api.ts, like the other optional namespaces:
 * the planner reaches the router and the ingress eligibility rules, and a static import
 * would put them on every dashboard request.
 *
 * Both routes are read-only. The preview is computed from config alone
 * (src/protocols/plan-snapshot.ts): it sends nothing upstream, advances no combo state, and
 * never logs its input. Authentication is inherited from the management chain.
 */
import { jsonResponse } from "../auth-cors";
import { isProtocol, PROTOCOL_CONTRACT_VERSION } from "../../protocols/contract";
import { isProtocolFeature, PROTOCOL_FEATURES, type ProtocolFeature } from "../../protocols/features";
import { previewProtocolPlan, type ProtocolPlanRequest } from "../../protocols/plan-snapshot";
import { protocolPolicyRevision, resolveApiSurfaceSettings, resolveProtocolSettings } from "../../protocols/settings";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";

export const PROTOCOL_PLAN_LIMITS = { modelLength: 200, features: 24 } as const;

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

export async function handleProtocolRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;

  if (url.pathname === "/api/protocols") {
    if (req.method !== "GET") return null;
    return jsonResponse({
      schemaVersion: 1,
      contractVersion: PROTOCOL_CONTRACT_VERSION,
      policyRevision: protocolPolicyRevision(config),
      surfaces: resolveApiSurfaceSettings(config),
      settings: resolveProtocolSettings(config),
      features: PROTOCOL_FEATURES,
    }, 200, req, config);
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
