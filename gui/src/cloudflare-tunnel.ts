export type CloudflareTunnelStatus = "stopped" | "starting" | "running" | "stopping" | "error";
export type CloudflareTunnelMode = "quick" | "named";

export interface CloudflareTunnelState {
  status: CloudflareTunnelStatus;
  mode: CloudflareTunnelMode;
  publicUrl: string | null;
  supportsSse: boolean;
  enabled: boolean;
  canEnable: boolean;
  error?: string;
}

export const STOPPED_CLOUDFLARE_TUNNEL: CloudflareTunnelState = {
  status: "stopped",
  mode: "quick",
  publicUrl: null,
  supportsSse: false,
  enabled: false,
  canEnable: false,
};

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
  const error = typeof candidate.error === "string" && candidate.error.trim()
    ? candidate.error.trim()
    : undefined;

  return {
    status,
    mode,
    publicUrl,
    supportsSse,
    enabled,
    canEnable,
    ...(error ? { error } : {}),
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
  return isTunnelEnabled(tunnel) || tunnel.canEnable;
}

export function tunnelStatusTone(
  status: CloudflareTunnelStatus,
): "green" | "amber" | "red" | "muted" {
  if (status === "running") return "green";
  if (status === "starting" || status === "stopping") return "amber";
  if (status === "error") return "red";
  return "muted";
}
