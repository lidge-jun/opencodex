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
