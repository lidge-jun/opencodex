/**
 * Wire types for the Antigravity and agy connect routes
 * (src/server/management/gateway-client-routes.ts). Every note, override and refusal carries a
 * code; the page translates the code and never shows the server's English sentence.
 */
import { readJsonIfOk } from "../../fetch-json";

export type GatewayClientId = "antigravity" | "agy";
export type GatewayClientState = "connected" | "disconnected" | "drifted";
export type GatewayClientAction = "connect" | "disconnect";
export type GatewayNoteCode =
  | "restart-app" | "no-google-sign-in" | "agy-follows-app" | "settings-not-json" | "settings-not-object"
  | "no-restore-record" | "new-terminal" | "agy-version" | "windows-unverified" | "agy-env-exported";
export type GatewayOverrideCode = "admin-gateway" | "admin-unreadable" | "env-gateway";

export interface GatewayClientStatus {
  id: GatewayClientId;
  label: string;
  state: GatewayClientState;
  files: { path: string; role: string; exists: boolean }[];
  overrides: { source: "admin_settings" | "env"; code: GatewayOverrideCode; detail: string }[];
  notes: { code: GatewayNoteCode; text: string }[];
  defaultModel?: string;
}

/**
 * `reached` is false when the request never produced a readable answer from the proxy. A refusal
 * carries `code` (and `message` for an I/O error, whose text is the operating system's);
 * a success carries what was done: `changed` and, for a disconnect, `restore`.
 */
export interface GatewayClientActionOutcome {
  reached: boolean;
  ok: boolean;
  code: string | null;
  message: string | null;
  changed: boolean;
  restore: "exact" | "path-wise" | "none" | null;
}

export async function loadGatewayClients(apiBase: string, signal?: AbortSignal): Promise<GatewayClientStatus[] | null> {
  try {
    const response = await fetch(`${apiBase}/api/gateway-clients`, { signal });
    const body = await readJsonIfOk<{ clients?: unknown }>(response);
    return Array.isArray(body?.clients) ? body.clients as GatewayClientStatus[] : null;
  } catch {
    return null;
  }
}

const RESTORES = new Set(["exact", "path-wise", "none"]);

/** A refusal (409, 400, 404) carries its own code, so it is read rather than discarded. */
export async function runGatewayClientAction(
  apiBase: string,
  id: GatewayClientId,
  action: GatewayClientAction,
  model?: string,
): Promise<GatewayClientActionOutcome> {
  try {
    const response = await fetch(`${apiBase}/api/gateway-clients/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(model ? { model } : {}),
    });
    const body = await response.json() as { ok?: unknown; code?: unknown; message?: unknown; changed?: unknown; restore?: unknown };
    return {
      reached: true,
      ok: response.ok && body.ok === true,
      code: typeof body.code === "string" ? body.code : null,
      message: typeof body.message === "string" && body.message ? body.message : null,
      changed: body.changed === true,
      restore: typeof body.restore === "string" && RESTORES.has(body.restore) ? body.restore as GatewayClientActionOutcome["restore"] : null,
    };
  } catch {
    return { reached: false, ok: false, code: null, message: null, changed: false, restore: null };
  }
}
