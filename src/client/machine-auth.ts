import type { OcxConfig } from "../types";
import {
  managementPrincipal,
  requireManagementAuth,
  type ManagementAuthState,
} from "../server/management-auth";

export const MACHINE_SESSION_HEADER = "x-opencodex-machine-session";
export const MACHINE_GUI_ORIGIN_HEADER = "x-opencodex-machine-gui-origin";
export const MACHINE_CSRF_HEADER = "x-opencodex-machine-csrf-token";
export const MACHINE_RELAY_EXPECTED_ORIGIN_HEADER = "x-opencodex-relay-expected-origin";
export const MACHINE_RELAY_EXPECTED_CONNECTION_HEADER = "x-opencodex-relay-expected-connection";

const MACHINE_AUTH_HEADERS = [
  MACHINE_SESSION_HEADER,
  MACHINE_GUI_ORIGIN_HEADER,
  MACHINE_CSRF_HEADER,
  MACHINE_RELAY_EXPECTED_ORIGIN_HEADER,
  MACHINE_RELAY_EXPECTED_CONNECTION_HEADER,
] as const;

function machinePrincipalRequest(req: Request): Request {
  const headers = new Headers(req.headers);
  const token = headers.get(MACHINE_SESSION_HEADER);
  const browserOrigin = headers.get(MACHINE_GUI_ORIGIN_HEADER);
  const csrf = headers.get(MACHINE_CSRF_HEADER);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("x-opencodex-api-key");
  headers.delete("x-opencodex-gui-origin");
  headers.delete("x-opencodex-csrf-token");
  if (token) headers.set("x-opencodex-api-key", token);
  if (browserOrigin) {
    headers.set("x-opencodex-gui-origin", browserOrigin);
    headers.set("Origin", browserOrigin);
  }
  if (csrf) headers.set("x-opencodex-csrf-token", csrf);
  return new Request(req.url, { method: req.method, headers, signal: req.signal });
}

export function requireMachineAuth(
  req: Request,
  state: ManagementAuthState,
  config: OcxConfig,
): Response | null {
  const synthetic = machinePrincipalRequest(req);
  const error = requireManagementAuth(synthetic, state, config);
  if (error) return error;
  return managementPrincipal(synthetic, state, config) === "gui-session"
    ? null
    : Response.json({ error: "opencodex machine GUI session required" }, { status: 401 });
}

export function stripMachineAuthHeaders(headers: Headers): Headers {
  const stripped = new Headers(headers);
  for (const name of MACHINE_AUTH_HEADERS) stripped.delete(name);
  return stripped;
}
