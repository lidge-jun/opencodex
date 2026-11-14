/**
 * Dashboard and CLI routes that point Google's Antigravity clients (desktop app, `agy`)
 * at this proxy. Adapter only: what is written, stashed and restored lives in
 * `src/integrations/gateway-clients`. Auth and origin checks run before dispatch, so a
 * mutation here is gated like every other management POST.
 */
import { GATEWAY_CLIENT_IDS, connectGatewayClient, gatewayActionBody, disconnectGatewayClient, gatewayClientsStatus, isGatewayClientId, productionGatewayClientContext, resolveGatewayTarget, type GatewayClientContext } from "../../integrations/gateway-clients";
import { jsonResponse } from "../auth-cors";
import { readOptionalManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { managementInferencePort, type ManagementContext } from "./context";

const COLLECTION_PATH = "/api/gateway-clients";
const ACTION_PATH = /^\/api\/gateway-clients\/([^/]+)\/(connect|disconnect)$/;

function refusal(ctx: ManagementContext, status: number, code: string, message: string): Response {
  return jsonResponse({ ok: false, code, message }, status, ctx.req, ctx.config);
}

async function connectModel(ctx: ManagementContext): Promise<{ model?: string } | Response> {
  let body: unknown;
  try { body = await readOptionalManagementJsonBody(ctx.req); } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return refusal(ctx, 400, "invalid-body", "The request body must be a JSON object.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return refusal(ctx, 400, "invalid-body", "The request body must be a JSON object.");
  const model = (body as { model?: unknown }).model;
  if (model === undefined || model === null) return {};
  if (typeof model !== "string") return refusal(ctx, 400, "invalid-body", "model must be a string.");
  return { model };
}

export async function handleGatewayClientRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps } = ctx;
  const clientCtx: GatewayClientContext = deps.gatewayClientContext?.() ?? productionGatewayClientContext();
  if (url.pathname === "/api/gateway-clients" && req.method === "GET") {
    const resolved = resolveGatewayTarget(config, managementInferencePort(ctx));
    return jsonResponse({ clients: gatewayClientsStatus(clientCtx, resolved.ok ? resolved.target : undefined) }, 200, req, config);
  }
  const match = req.method === "POST" ? ACTION_PATH.exec(url.pathname) : null;
  if (!match) return null;
  const id = match[1]!;
  if (!isGatewayClientId(id)) {
    return refusal(ctx, 404, "unknown-client", `Unknown gateway client "${id.slice(0, 40)}". Known: ${GATEWAY_CLIENT_IDS.join(", ")}.`);
  }
  try {
    if (match[2] === "disconnect") {
      const resolved = resolveGatewayTarget(config, managementInferencePort(ctx));
      const outcome = disconnectGatewayClient(id, clientCtx, resolved.ok ? resolved.target : undefined);
      return jsonResponse(gatewayActionBody(outcome), outcome.ok ? 200 : 409, req, config);
    }
    const parsed = await connectModel(ctx);
    if (parsed instanceof Response) return parsed;
    const outcome = connectGatewayClient(id, clientCtx, config, managementInferencePort(ctx), parsed.model);
    return jsonResponse(gatewayActionBody(outcome), outcome.ok ? 200 : 409, req, config);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return refusal(ctx, 409, "io-error", `Could not update the client files: ${error instanceof Error ? error.message : String(error)}`);
  }
}
