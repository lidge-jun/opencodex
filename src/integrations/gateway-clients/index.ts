import { homedir } from "node:os";
import type { OcxConfig } from "../../types";
import { getConfigDir } from "../../config/paths";
import { localInferenceDestination } from "../../lib/local-destinations";
import { AGY_CONNECTOR } from "./agy";
import { ANTIGRAVITY_CONNECTOR } from "./antigravity";
import { GATEWAY_PLACEHOLDER_KEY } from "./io";
import type { GatewayClientConnector, GatewayClientContext, GatewayClientId, GatewayClientResult, GatewayClientStatus, GatewayTarget } from "./types";

export type * from "./types";
export { GATEWAY_PLACEHOLDER_KEY } from "./io";

export const GATEWAY_CLIENTS: Readonly<Record<GatewayClientId, GatewayClientConnector>> = {
  antigravity: ANTIGRAVITY_CONNECTOR,
  agy: AGY_CONNECTOR,
};

export const GATEWAY_CLIENT_IDS = Object.keys(GATEWAY_CLIENTS) as GatewayClientId[];
export const isGatewayClientId = (value: unknown): value is GatewayClientId =>
  typeof value === "string" && Object.hasOwn(GATEWAY_CLIENTS, value);

export function productionGatewayClientContext(): GatewayClientContext {
  return { home: homedir(), platform: process.platform, env: process.env, stateDir: getConfigDir() };
}

export type GatewayTargetResolution = { ok: true; target: GatewayTarget } | { ok: false; code: "requires-admission-token" | "invalid-model"; message: string };

/** The URL a local client dials plus a non-secret placeholder key; refuses binds that demand a real credential. */
export function resolveGatewayTarget(config: Pick<OcxConfig, "hostname" | "unauthenticatedLoopbackListener">, port: number, model?: string): GatewayTargetResolution {
  const destination = localInferenceDestination(config, port);
  if (destination.requiresAdmissionToken) {
    return { ok: false, code: "requires-admission-token", message: `${destination.origin} requires an opencodex data-plane credential, and OpenCodex will not write a real secret into client files. Enable \`unauthenticatedLoopbackListener\` or bind the proxy to loopback.` };
  }
  const defaultModel = model?.trim();
  // eslint-disable-next-line no-control-regex
  if (defaultModel !== undefined && (defaultModel.length === 0 || defaultModel.length > 200 || /[\x00-\x1f\x7f]/.test(defaultModel))) {
    return { ok: false, code: "invalid-model", message: "The model selector must be a non-empty single-line string of at most 200 characters." };
  }
  return { ok: true, target: { url: destination.origin, apiKey: GATEWAY_PLACEHOLDER_KEY, ...(defaultModel ? { defaultModel } : {}) } };
}

export function gatewayClientsStatus(ctx: GatewayClientContext, target?: GatewayTarget): GatewayClientStatus[] {
  return GATEWAY_CLIENT_IDS.map(id => GATEWAY_CLIENTS[id].status(ctx, target));
}

export type GatewayActionOutcome =
  | (GatewayClientResult & { id: GatewayClientId; action: "connect" | "disconnect"; status: GatewayClientStatus })
  | { ok: false; id: GatewayClientId; action: "connect"; code: "requires-admission-token" | "invalid-model"; message: string };

export function connectGatewayClient(id: GatewayClientId, ctx: GatewayClientContext, config: Pick<OcxConfig, "hostname" | "unauthenticatedLoopbackListener">, port: number, model?: string): GatewayActionOutcome {
  const resolved = resolveGatewayTarget(config, port, model);
  if (!resolved.ok) return { ok: false, id, action: "connect", code: resolved.code, message: resolved.message };
  const result = GATEWAY_CLIENTS[id].connect(ctx, resolved.target);
  return { ...result, id, action: "connect", status: GATEWAY_CLIENTS[id].status(ctx, resolved.target) };
}

export function disconnectGatewayClient(id: GatewayClientId, ctx: GatewayClientContext, target?: GatewayTarget): GatewayActionOutcome {
  const result = GATEWAY_CLIENTS[id].disconnect(ctx);
  return { ...result, id, action: "disconnect", status: GATEWAY_CLIENTS[id].status(ctx, target) };
}
