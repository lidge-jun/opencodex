import { homedir } from "node:os";
import type { OcxConfig } from "../../types";
import { assertClientLifecycleHeld, withClientLifecycleSync, type ClientLifecycleHeld } from "../../client/lifecycle-lock";
import { getConfigDir } from "../../config/paths";
import { localInferenceDestination } from "../../lib/local-destinations";
import { AGY_CONNECTOR } from "./agy";
import { ANTIGRAVITY_CONNECTOR } from "./antigravity";
import { GATEWAY_PLACEHOLDER_KEY, clientRefusal, hasStash } from "./io";
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
  const hasControlChar = defaultModel !== undefined && [...defaultModel].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (defaultModel !== undefined && (defaultModel.length === 0 || defaultModel.length > 200 || hasControlChar)) {
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

function withGatewayLifecycle(ctx: GatewayClientContext, work: () => GatewayClientResult): GatewayClientResult {
  try { return withClientLifecycleSync(work, { lockPath: ctx.lifecycleLockPath }); }
  catch (error) { return clientRefusal((error as Error).message); }
}

/** Uninstall keeps the lifecycle lease through both restoration and config removal. */
export function disconnectRecordedGatewayClients(ctx: GatewayClientContext, held: ClientLifecycleHeld): void {
  assertClientLifecycleHeld(held);
  for (const id of GATEWAY_CLIENT_IDS) {
    if (!hasStash(ctx, id)) continue;
    const result = GATEWAY_CLIENTS[id].disconnect(ctx);
    if (!result.ok) throw new Error(`Gateway client cleanup refused for ${id}: ${result.message}`);
  }
}

export function connectGatewayClient(id: GatewayClientId, ctx: GatewayClientContext, config: Pick<OcxConfig, "hostname" | "unauthenticatedLoopbackListener">, port: number, model?: string): GatewayActionOutcome {
  const resolved = resolveGatewayTarget(config, port, model);
  if (!resolved.ok) return { ok: false, id, action: "connect", code: resolved.code, message: resolved.message };
  const result = withGatewayLifecycle(ctx, () => GATEWAY_CLIENTS[id].connect(ctx, resolved.target));
  return { ...result, id, action: "connect", status: GATEWAY_CLIENTS[id].status(ctx, resolved.target) };
}

export function disconnectGatewayClient(id: GatewayClientId, ctx: GatewayClientContext, target?: GatewayTarget): GatewayActionOutcome {
  const result = withGatewayLifecycle(ctx, () => GATEWAY_CLIENTS[id].disconnect(ctx));
  return { ...result, id, action: "disconnect", status: GATEWAY_CLIENTS[id].status(ctx, target) };
}

/** The JSON both the management route and `ocx connect agy` return for an action. */
export function gatewayActionBody(outcome: GatewayActionOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    const files = "changedFiles" in outcome ? outcome.changedFiles : [];
    return { ok: false, code: outcome.code, message: outcome.message, ...(files.length ? { changedFiles: files } : {}) };
  }
  const { ok, id, action, changed, changedFiles, restore, message, notes, status } = outcome;
  return { ok, id, action, changed, changedFiles, ...(restore ? { restore } : {}), message, notes, status };
}
