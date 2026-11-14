/**
 * Wire types for the Antigravity and agy connect routes
 * (src/server/management/gateway-client-routes.ts).
 */
import { readJsonIfOk } from "../../fetch-json";

export type GatewayClientId = "antigravity" | "agy";
export type GatewayClientState = "connected" | "disconnected" | "drifted";
export type GatewayClientAction = "connect" | "disconnect";

export interface GatewayClientStatus {
  id: GatewayClientId;
  label: string;
  state: GatewayClientState;
  files: { path: string; role: string; exists: boolean }[];
  overrides: { source: "admin_settings" | "env"; detail: string }[];
  notes: string[];
}

/** `message` is null when the request never produced a readable answer from the proxy. */
export interface GatewayClientActionOutcome {
  ok: boolean;
  message: string | null;
  notes: string[];
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

/** A refusal (409, 400, 404) carries its own message, so it is read rather than discarded. */
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
    const body = await response.json() as { ok?: unknown; message?: unknown; notes?: unknown };
    return {
      ok: response.ok && body.ok === true,
      message: typeof body.message === "string" && body.message ? body.message : null,
      notes: Array.isArray(body.notes) ? body.notes.filter((note): note is string => typeof note === "string") : [],
    };
  } catch {
    return { ok: false, message: null, notes: [] };
  }
}
