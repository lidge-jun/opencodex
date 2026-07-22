export type CloudflareTunnelStatus = "stopped" | "starting" | "running" | "stopping" | "error";
export type CloudflareTunnelMode = "quick" | "named";
export type CloudflareTunnelSetupMethod = "api" | "token";

export interface CloudflareTunnelState {
  status: CloudflareTunnelStatus;
  mode: CloudflareTunnelMode;
  publicUrl: string | null;
  supportsSse: boolean;
  enabled: boolean;
  canEnable: boolean;
  canConfigure: boolean;
  configured: boolean;
  setupRequired: boolean;
  configurationSource: string | null;
  configurationEditable: boolean;
  configuredPublicUrl: string | null;
  originUrl: string | null;
  setupError?: string;
  error?: string;
}

export const STOPPED_CLOUDFLARE_TUNNEL: CloudflareTunnelState = {
  status: "stopped",
  mode: "named",
  publicUrl: null,
  supportsSse: true,
  enabled: false,
  canEnable: false,
  canConfigure: false,
  configured: false,
  setupRequired: true,
  configurationSource: null,
  configurationEditable: true,
  configuredPublicUrl: null,
  originUrl: null,
};

export interface CloudflareTunnelApiSetupInput {
  accountId: string;
  zoneId: string;
  hostname: string;
  apiToken: string;
  tunnelName?: string;
  replaceExisting?: boolean;
}

export interface CloudflareTunnelTokenSetupInput {
  publicUrl: string;
  tunnelToken: string;
}

export type CloudflareTunnelSetupRequest =
  | ({ method: "api"; enable: true } & CloudflareTunnelApiSetupInput)
  | ({ method: "token"; enable: true } & CloudflareTunnelTokenSetupInput);

const STATUSES = new Set<CloudflareTunnelStatus>(["stopped", "starting", "running", "stopping", "error"]);
const MODES = new Set<CloudflareTunnelMode>(["quick", "named"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

/** Accepts both the nested /api/keys shape and the direct tunnel endpoint shape. */
export function tunnelFromApiPayload(
  payload: unknown,
  fallback: CloudflareTunnelState = STOPPED_CLOUDFLARE_TUNNEL,
): CloudflareTunnelState {
  const root = asRecord(payload);
  const candidate = asRecord(root?.tunnel) ?? root;
  if (!candidate) return { ...fallback };

  const status = typeof candidate.status === "string" && STATUSES.has(candidate.status as CloudflareTunnelStatus)
    ? candidate.status as CloudflareTunnelStatus
    : fallback.status;
  const mode = typeof candidate.mode === "string" && MODES.has(candidate.mode as CloudflareTunnelMode)
    ? candidate.mode as CloudflareTunnelMode
    : fallback.mode;
  const publicUrl = typeof candidate.publicUrl === "string" || candidate.publicUrl === null
    ? candidate.publicUrl
    : fallback.publicUrl;
  const supportsSse = typeof candidate.supportsSse === "boolean"
    ? candidate.supportsSse
    : fallback.supportsSse;
  const enabled = typeof candidate.enabled === "boolean"
    ? candidate.enabled
    : status === "starting" || status === "running" || status === "stopping" || publicUrl !== null
      ? true
      : fallback.enabled;
  const canEnable = typeof candidate.canEnable === "boolean"
    ? candidate.canEnable
    : fallback.canEnable;
  const canConfigure = typeof candidate.canConfigure === "boolean"
    ? candidate.canConfigure
    : typeof candidate.canEnable === "boolean"
      ? candidate.canEnable
      : fallback.canConfigure;
  const configuredPublicUrl = typeof candidate.configuredPublicUrl === "string" || candidate.configuredPublicUrl === null
    ? candidate.configuredPublicUrl
    : fallback.configuredPublicUrl;
  const originUrl = typeof candidate.originUrl === "string" || candidate.originUrl === null
    ? candidate.originUrl
    : fallback.originUrl;
  const configurationSource = typeof candidate.configurationSource === "string" && candidate.configurationSource.trim()
    ? candidate.configurationSource.trim()
    : candidate.configurationSource === null
      ? null
      : fallback.configurationSource;
  const configurationEditable = typeof candidate.configurationEditable === "boolean"
    ? candidate.configurationEditable
    : fallback.configurationEditable;
  const configured = typeof candidate.configured === "boolean"
    ? candidate.configured
    : mode === "quick" || (mode === "named" && (configuredPublicUrl !== null || publicUrl !== null))
      ? true
      : fallback.configured;
  const setupRequired = typeof candidate.setupRequired === "boolean"
    ? candidate.setupRequired
    : !configured;
  const error = typeof candidate.error === "string" && candidate.error.trim()
    ? candidate.error.trim()
    : undefined;
  const setupError = typeof candidate.setupError === "string" && candidate.setupError.trim()
    ? candidate.setupError.trim()
    : undefined;

  return {
    status,
    mode,
    publicUrl,
    supportsSse,
    enabled,
    canEnable,
    canConfigure,
    configured,
    setupRequired,
    configurationSource,
    configurationEditable,
    configuredPublicUrl,
    originUrl,
    ...(error ? { error } : {}),
    ...(setupError ? { setupError } : {}),
  };
}

export function buildCloudflareTunnelSetupRequest(
  method: "api",
  input: CloudflareTunnelApiSetupInput,
): CloudflareTunnelSetupRequest;
export function buildCloudflareTunnelSetupRequest(
  method: "token",
  input: CloudflareTunnelTokenSetupInput,
): CloudflareTunnelSetupRequest;
export function buildCloudflareTunnelSetupRequest(
  method: CloudflareTunnelSetupMethod,
  input: CloudflareTunnelApiSetupInput | CloudflareTunnelTokenSetupInput,
): CloudflareTunnelSetupRequest {
  if (method === "api") {
    const api = input as CloudflareTunnelApiSetupInput;
    const tunnelName = api.tunnelName?.trim();
    return {
      method,
      accountId: api.accountId.trim(),
      zoneId: api.zoneId.trim(),
      hostname: api.hostname.trim(),
      apiToken: api.apiToken.trim(),
      ...(tunnelName ? { tunnelName } : {}),
      ...(api.replaceExisting ? { replaceExisting: true } : {}),
      enable: true,
    };
  }

  const token = input as CloudflareTunnelTokenSetupInput;
  return {
    method,
    publicUrl: token.publicUrl.trim(),
    tunnelToken: token.tunnelToken.trim(),
    enable: true,
  };
}

/** The management API is the only authority for the currently advertised endpoint. */
export function endpointFromApiPayload(payload: unknown, fallback = ""): string {
  const endpoint = asRecord(payload)?.endpoint;
  return typeof endpoint === "string" && endpoint.trim() ? endpoint : fallback;
}

export function isTunnelTransitioning(status: CloudflareTunnelStatus): boolean {
  return status === "starting" || status === "stopping";
}

export function isTunnelEnabled(tunnel: CloudflareTunnelState): boolean {
  return tunnel.enabled;
}

export function canToggleTunnel(
  tunnel: CloudflareTunnelState,
  requestPending: boolean,
): boolean {
  if (requestPending || isTunnelTransitioning(tunnel.status)) return false;
  if (isTunnelEnabled(tunnel)) return true;
  return shouldOpenTunnelSetup(tunnel) ? tunnel.canConfigure : tunnel.canEnable;
}

export function shouldOpenTunnelSetup(tunnel: CloudflareTunnelState): boolean {
  return !isTunnelEnabled(tunnel) && (tunnel.setupRequired || !tunnel.configured);
}

export function canReconfigureTunnel(tunnel: CloudflareTunnelState, requestPending: boolean): boolean {
  return tunnel.configured
    && !isTunnelEnabled(tunnel)
    && tunnel.configurationSource !== "environment"
    && tunnel.canConfigure
    && tunnel.configurationEditable
    && !requestPending;
}

export function tunnelStatusTone(
  status: CloudflareTunnelStatus,
): "green" | "amber" | "red" | "muted" {
  if (status === "running") return "green";
  if (status === "starting" || status === "stopping") return "amber";
  if (status === "error") return "red";
  return "muted";
}
