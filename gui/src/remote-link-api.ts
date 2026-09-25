export const LINK_ERROR_CODES = [
  "admission_timeout",
  "compensation_failed",
  "fingerprint_failed",
  "forbidden",
  "host_confirmation_expired",
  "host_fingerprint_mismatch",
  "host_not_confirmed",
  "invalid_alias",
  "invalid_body",
  "invalid_link_id",
  "key_issue_failed",
  "key_revoke_failed",
  "link_apply_failed",
  "link_exists",
  "link_not_found",
  "link_remove_failed",
  "link_unavailable",
  "listener_unavailable",
  "probe_failed",
  "remote_connect_failed",
  "remote_disconnect_failed",
  "remote_port_failed",
  "tailscale_session_refused",
  "version_probe_failed",
] as const;

export type LinkErrorCode = typeof LINK_ERROR_CODES[number];

export type LinkWireDirection = "hub-initiated" | "client-initiated";
export type LinkWireState = "connecting" | "connected" | "reconnecting" | "failed" | "idle";
export type LinkListenerState = "off" | "listening" | "failed";

export interface LinkCandidateView { alias: string; source: string }
export interface LinkProbeView { alias: string; fingerprint: string; keyType: string }
export interface LinkConfirmHostView { alias: string; fingerprint: string; ocxVersion: string }
export interface LinkRowWire { id: string; alias: string; direction: LinkWireDirection; state: LinkWireState; since: string; reason: string | null; tunnelPort: number }
export interface RemoteLinkStatusWire {
  role: "standalone" | "home" | "child";
  listener: { state: LinkListenerState; port: number | null };
  links: LinkRowWire[];
  child: null | { alias: string; state: LinkWireState; since: string; reason: string | null };
}

const LINK_STATES: readonly LinkWireState[] = ["connecting", "connected", "reconnecting", "failed", "idle"];
const LINK_ROLES = ["standalone", "home", "child"] as const;

export class LinkApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "LinkApiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isLinkState(value: unknown): value is LinkWireState { return typeof value === "string" && LINK_STATES.includes(value as LinkWireState); }

export function parseRemoteLinkStatus(value: unknown): RemoteLinkStatusWire {
  if (!isRecord(value) || !LINK_ROLES.includes(value.role as typeof LINK_ROLES[number])) throw new Error("invalid status");
  const listener = value.listener;
  if (!isRecord(listener) || !["off", "listening", "failed"].includes(String(listener.state)) || (listener.port !== null && typeof listener.port !== "number")) throw new Error("invalid listener");
  if (!Array.isArray(value.links)) throw new Error("invalid links");
  const links = value.links.map(item => {
    if (!isRecord(item) || !nonEmpty(item.id) || !nonEmpty(item.alias) || !["hub-initiated", "client-initiated"].includes(String(item.direction)) || !isLinkState(item.state) || !nonEmpty(item.since) || (item.reason !== null && typeof item.reason !== "string") || typeof item.tunnelPort !== "number") throw new Error("invalid link");
    return { id: item.id, alias: item.alias, direction: item.direction as LinkWireDirection, state: item.state, since: item.since, reason: item.reason as string | null, tunnelPort: item.tunnelPort };
  });
  let child: RemoteLinkStatusWire["child"] = null;
  if (value.child !== null) {
    if (!isRecord(value.child) || !nonEmpty(value.child.alias) || !isLinkState(value.child.state) || !nonEmpty(value.child.since) || (value.child.reason !== null && typeof value.child.reason !== "string")) throw new Error("invalid child");
    child = { alias: value.child.alias, state: value.child.state, since: value.child.since, reason: value.child.reason as string | null };
  }
  return { role: value.role as RemoteLinkStatusWire["role"], listener: { state: listener.state as LinkListenerState, port: listener.port as number | null }, links, child };
}

/** Read link-route JSON and preserve the server's machine-readable error code. */
export async function readLinkJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch { /* malformed response is handled by the success-body guard below */ }

  if (!response.ok) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : null;
    const code = error && typeof error.code === "string" ? error.code : "unknown";
    throw new LinkApiError(code, response.status);
  }
  if (body === null || body === undefined) throw new LinkApiError("invalid_body", response.status);
  return body as T;
}

export async function requestLinkJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...init, cache: "no-store" });
  return readLinkJson<T>(response);
}
